// ==UserScript==
// @name         本地划词听译助手
// @name:zh-CN   本地划词听译助手
// @name:en      Local Selection Read & Translate
// @namespace    https://github.com/Yan-ShiBo/LocalReadTranslate
// @version      1.12.8
// @description  选中文本即可本地朗读或翻译：Kokoro TTS 负责语音朗读，Ollama 模型负责本地翻译，文本不上传云端。
// @description:en Select text on any page to read aloud locally with Kokoro TTS or translate locally through Ollama.
// @author       Yan-ShiBo
// @license      MIT
// @match        *://*/*
// @homepageURL  https://github.com/Yan-ShiBo/LocalReadTranslate
// @supportURL   https://github.com/Yan-ShiBo/LocalReadTranslate/issues
// @downloadURL  https://raw.githubusercontent.com/Yan-ShiBo/LocalReadTranslate/main/tts-userscript.js
// @updateURL    https://raw.githubusercontent.com/Yan-ShiBo/LocalReadTranslate/main/tts-userscript.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @compatible   chrome Requires Tampermonkey and the local API server.
// @compatible   edge Requires Tampermonkey and the local API server.
// @compatible   brave Requires Tampermonkey and the local API server.
// @run-at       document-end
// @noframes
// ==/UserScript==

const KokoroTTSCore = (() => {
  const WEBM_OPUS_MIME = 'audio/webm; codecs="opus"';
  const OGG_OPUS_MIME = 'audio/ogg; codecs="opus"';
  const OGG_MIME = "audio/ogg";
  const WAV_MIME = "audio/wav";
  const CJK_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/;
  const FORMULA_PLACEHOLDER_PREFIX = "__LOCAL_READ_FORMULA_";

  function createRequestGate() {
    let generation = 0;
    let request = null;

    function abortRequest() {
      if (request) {
        request.abort();
        request = null;
      }
    }

    return {
      begin() {
        generation += 1;
        abortRequest();
        return generation;
      },
      attach(id, nextRequest) {
        if (id !== generation) {
          nextRequest.abort();
          return false;
        }
        request = nextRequest;
        return true;
      },
      isCurrent(id) {
        return id === generation;
      },
      finish(id) {
        if (id === generation) request = null;
      },
      cancel() {
        generation += 1;
        abortRequest();
      },
    };
  }

  function releaseAudio(audio, urlApi = URL) {
    if (!audio) return;
    if (audio._cleanup) {
      const cleanup = audio._cleanup;
      audio._cleanup = null;
      cleanup();
    }
    audio.pause();
    audio.src = "";
    if (audio._blobUrl) {
      urlApi.revokeObjectURL(audio._blobUrl);
      audio._blobUrl = null;
    }
  }

  function supportsWebMOpus(mediaSourceApi) {
    if (
      !mediaSourceApi ||
      typeof mediaSourceApi.isTypeSupported !== "function"
    ) {
      return false;
    }
    try {
      return mediaSourceApi.isTypeSupported(WEBM_OPUS_MIME) === true;
    } catch {
      return false;
    }
  }

  function sameOrigin(currentOrigin, apiOrigin) {
    return !!currentOrigin && !!apiOrigin && currentOrigin === apiOrigin;
  }

  function choosePlaybackMode(mediaSourceApi, currentOrigin, apiOrigin) {
    if (!sameOrigin(currentOrigin, apiOrigin)) return "ogg";
    return supportsWebMOpus(mediaSourceApi) ? "stream" : "ogg";
  }

  function mergeTranslationModelOptions(baseOptions, payload, selectedValue) {
    const merged = [];
    const seen = new Set();

    function add(value, label) {
      const cleanValue = String(value || "").trim();
      if (!cleanValue || seen.has(cleanValue)) return;
      seen.add(cleanValue);
      merged.push({ value: cleanValue, label: String(label || cleanValue) });
    }

    for (const option of Array.isArray(baseOptions) ? baseOptions : []) {
      add(option.value, option.label);
    }

    const remoteOptions =
      payload && Array.isArray(payload.available_model_options)
        ? payload.available_model_options
        : [];
    for (const option of remoteOptions) {
      add(option.value, option.label);
    }

    const installedModels =
      payload && Array.isArray(payload.available_models)
        ? payload.available_models
        : [];
    for (const model of installedModels) {
      add(model, `Installed: ${model}`);
    }

    if (selectedValue) {
      add(selectedValue, `Custom: ${selectedValue}`);
    }

    return merged;
  }

  function formatPlaybackProgress({ currentTime = 0, duration = 0, streamEnded = false } = {}) {
    const seconds = Math.max(0, Math.floor(Number(currentTime) || 0));
    if (!streamEnded || !Number.isFinite(duration) || duration <= 0) {
      return { determinate: false, label: `${seconds}s`, percent: 0 };
    }

    const rawPercent = ((Number(currentTime) || 0) / duration) * 100;
    const percent = Math.max(0, Math.min(100, Math.round(rawPercent)));
    return { determinate: true, label: `${percent}%`, percent };
  }

  function canPlayAudioType(audioProbe, mime) {
    if (!audioProbe || typeof audioProbe.canPlayType !== "function") {
      return false;
    }
    try {
      const result = audioProbe.canPlayType(mime);
      return result === "probably" || result === "maybe";
    } catch {
      return false;
    }
  }

  function selectBlobAudioFormat(audioProbe) {
    if (
      canPlayAudioType(audioProbe, OGG_OPUS_MIME) ||
      canPlayAudioType(audioProbe, OGG_MIME)
    ) {
      return { format: "ogg", accept: OGG_MIME, mime: OGG_MIME };
    }
    return { format: "wav", accept: WAV_MIME, mime: WAV_MIME };
  }

  function normalizeAudioBlob(payload, mime) {
    if (typeof Blob === "undefined") return payload;
    if (
      payload instanceof Blob ||
      (payload && typeof payload.slice === "function" && typeof payload.size === "number")
    ) {
      if (payload.type === mime) return payload;
      return payload.slice(0, payload.size, mime);
    }
    return new Blob([payload], { type: mime });
  }

  async function normalizeAudioBuffer(payload) {
    if (payload instanceof ArrayBuffer) {
      return payload;
    }
    if (ArrayBuffer.isView(payload)) {
      return payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength
      );
    }
    if (payload && typeof payload.arrayBuffer === "function") {
      return payload.arrayBuffer();
    }
    throw new Error("Unsupported audio response payload");
  }

  function isUnsupportedMediaError(error) {
    const name = error && error.name ? String(error.name) : "";
    const message = error && error.message ? String(error.message) : "";
    return (
      name === "NotSupportedError" ||
      /not supported|no supported source|failed to load/i.test(message)
    );
  }

  function countMatches(text, pattern) {
    const matches = String(text || "").match(pattern);
    return matches ? matches.length : 0;
  }

  function cjkRatio(text) {
    const normalized = String(text || "").replace(/\s+/g, "");
    if (!normalized) return 0;
    return countMatches(normalized, /[\u3400-\u9FFF\uF900-\uFAFF]/g) / normalized.length;
  }

  function normalizeLlmSourceText(text) {
    const value = String(text || "")
      .replace(/[\u200B-\u200F\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n");
    return value
      .split(/\n\s*\n+/)
      .map((paragraph) =>
        paragraph
          .replace(/[ \t]*\n[ \t]*/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean)
      .join("\n\n");
  }

  function normalizeDisplayMathWrappers(text) {
    return String(text || "").replace(
      /\[\[MATH:\s*([\s\S]*?)\s*\]\]/g,
      (_match, formula) => {
        const value = String(formula || "").trim();
        return value ? `$${value}$` : "";
      }
    );
  }

  function normalizeCopyTextWithLatex(text) {
    return normalizeDisplayMathWrappers(text)
      .replace(/[\u200B-\u200F\uFEFF]/g, "")
      .replace(/[ \t]*\n[ \t]*/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
      .replace(/([([{（])\s+/g, "$1")
      .replace(/\s+([)\]}）])/g, "$1")
      .trim();
  }

  function splitLatexSegments(text) {
    const value = normalizeDisplayMathWrappers(text);
    const pattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+\$)/g;
    const segments = [];
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index > lastIndex) {
        segments.push({
          type: "text",
          value: value.slice(lastIndex, match.index),
          block: false,
        });
      }
      const formula = match[0];
      segments.push({
        type: "latex",
        value: formula,
        block: formula.startsWith("$$") || formula.startsWith("\\["),
      });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < value.length) {
      segments.push({
        type: "text",
        value: value.slice(lastIndex),
        block: false,
      });
    }
    return segments.length ? segments : [{ type: "text", value, block: false }];
  }

  const READABLE_LATEX_SYMBOLS = Object.freeze({
    "\\alpha": "α",
    "\\beta": "β",
    "\\gamma": "γ",
    "\\delta": "δ",
    "\\epsilon": "ε",
    "\\lambda": "λ",
    "\\mu": "μ",
    "\\pi": "π",
    "\\sigma": "σ",
    "\\theta": "θ",
    "\\Theta": "Θ",
    "\\omega": "ω",
    "\\Omega": "Ω",
    "\\rightarrow": "→",
    "\\to": "→",
    "\\mapsto": "↦",
    "\\Rightarrow": "⇒",
    "\\leq": "≤",
    "\\le": "≤",
    "\\geq": "≥",
    "\\ge": "≥",
    "\\neq": "≠",
    "\\ne": "≠",
    "\\approx": "≈",
    "\\times": "×",
    "\\cdot": "·",
    "\\in": "∈",
    "\\sum": "∑",
    "\\int": "∫",
    "\\infty": "∞",
    "\\partial": "∂",
    "\\nabla": "∇",
  });

  function stripLatexDelimiters(formula) {
    let value = String(formula || "").trim();
    if ((value.startsWith("$$") && value.endsWith("$$")) || (value.startsWith("$") && value.endsWith("$"))) {
      value = value.replace(/^\$\$?/, "").replace(/\$\$?$/, "");
    } else if (
      (value.startsWith("\\(") && value.endsWith("\\)")) ||
      (value.startsWith("\\[") && value.endsWith("\\]"))
    ) {
      value = value.slice(2, -2);
    }
    return value.trim();
  }

  function latexToReadableFormula(formula) {
    let value = stripLatexDelimiters(formula);
    if (!value) return "";

    value = value
      .replace(/\\(?:left|right)\b/g, "")
      .replace(/\\[,;!]/g, " ");

    value = value.replace(/\\(?:widehat|hat)\s*\{?([A-Za-zΑ-Ωα-ω])\}?/g, "$1\u0302");
    value = value.replace(/\\(?:overline|bar)\s*\{?([A-Za-zΑ-Ωα-ω])\}?/g, "$1\u0304");
    value = value.replace(/\\(?:widetilde|tilde)\s*\{?([A-Za-zΑ-Ωα-ω])\}?/g, "$1\u0303");

    Object.entries(READABLE_LATEX_SYMBOLS)
      .sort((a, b) => b[0].length - a[0].length)
      .forEach(([latex, symbol]) => {
        value = value.split(latex).join(symbol);
      });

    value = value.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "($1)/($2)");
    value = value.replace(/\\sqrt\{([^{}]+)\}/g, "√($1)");
    value = value.replace(/_\{([^{}]+)\}/g, "_$1");
    value = value.replace(/\^\{([^{}]+)\}/g, "^$1");
    value = value.replace(/\\\{/g, "{").replace(/\\\}/g, "}");
    value = value.replace(/\\([A-Za-z]+)/g, "$1");
    value = value.replace(/\s+/g, " ");
    value = value.replace(/\s*([=,+*/(){}])\s*/g, "$1");
    value = value.replace(/\s*(→|↦|⇒|≤|≥|≠|≈|∈)\s*/g, " $1 ");
    return value.trim();
  }

  function escapeFormulaHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readFormulaScriptArgument(value, startIndex) {
    if (value[startIndex] === "{") {
      let depth = 0;
      for (let index = startIndex; index < value.length; index += 1) {
        const char = value[index];
        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;
        if (depth === 0) {
          return {
            arg: value.slice(startIndex + 1, index),
            nextIndex: index + 1,
          };
        }
      }
    }

    const nextChar = value[startIndex] || "";
    return {
      arg: nextChar,
      nextIndex: startIndex + (nextChar ? 1 : 0),
    };
  }

  function formulaTextToHtml(value) {
    let html = "";
    let buffer = "";

    function flushBuffer() {
      if (buffer) {
        html += escapeFormulaHtml(buffer);
        buffer = "";
      }
    }

    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if ((char === "_" || char === "^") && index + 1 < value.length) {
        flushBuffer();
        const { arg, nextIndex } = readFormulaScriptArgument(value, index + 1);
        const tag = char === "_" ? "sub" : "sup";
        html += `<${tag}>${formulaTextToHtml(arg)}</${tag}>`;
        index = nextIndex - 1;
        continue;
      }
      buffer += char;
    }
    flushBuffer();
    return html;
  }

  function formulaToReadableHtml(formula) {
    const readable = latexToReadableFormula(formula);
    return formulaTextToHtml(readable);
  }

  function readableTranslationText(text) {
    return splitLatexSegments(text)
      .map((segment) => (segment.type === "latex" ? latexToReadableFormula(segment.value) : segment.value))
      .join("");
  }

  function verbalizeSimpleFormula(formula) {
    let spoken = String(formula || "").trim();
    if (!spoken || spoken.length > 120) return "formula omitted";

    spoken = spoken
      .replace(/^(\$\$?|\s)+|(\$\$?|\s)+$/g, "")
      .replace(/^\\\(|\\\)$/g, "")
      .replace(/^\\\[|\\\]$/g, "");

    if (/\\begin|\\matrix|\\cases|\\left|\\right/.test(spoken)) {
      return "formula omitted";
    }

    spoken = spoken
      .replace(/\\(?:widehat|hat)\s*\{?([A-Za-z][A-Za-z0-9]*)\}?/g, "$1 hat")
      .replace(/\\(?:overline|bar)\s*\{?([A-Za-z][A-Za-z0-9]*)\}?/g, "$1 bar")
      .replace(/\\(?:widetilde|tilde)\s*\{?([A-Za-z][A-Za-z0-9]*)\}?/g, "$1 tilde")
      .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1 over $2")
      .replace(/\\sqrt\{([^{}]+)\}/g, "square root of $1")
      .replace(/\\sum/g, "summation")
      .replace(/\\int/g, "integral")
      .replace(/\\alpha/g, "alpha")
      .replace(/\\beta/g, "beta")
      .replace(/\\gamma/g, "gamma")
      .replace(/\\delta/g, "delta")
      .replace(/\\lambda/g, "lambda")
      .replace(/\\mu/g, "mu")
      .replace(/\\pi/g, "pi")
      .replace(/\\theta/g, "theta")
      .replace(/\\rightarrow/g, "to")
      .replace(/\\to/g, "to")
      .replace(/\\mapsto/g, "maps to")
      .replace(/\\Rightarrow/g, "implies")
      .replace(/\^2\b/g, " squared")
      .replace(/\^3\b/g, " cubed")
      .replace(/\^\{([^{}]+)\}/g, " to the power of $1")
      .replace(/_(\w+)\b/g, " sub $1")
      .replace(/_\{([^{}]+)\}/g, " sub $1")
      .replace(/([A-Za-z](?: [a-z]+ [A-Za-z0-9]+)?(?: hat| bar| tilde)?)\s*\(([^()]+)\)/g, "$1 of $2")
      .replace(/=/g, " equals ")
      .replace(/\+/g, " plus ")
      .replace(/(?<=\S)-(?=\S)/g, " minus ")
      .replace(/\*/g, " times ")
      .replace(/\//g, " over ")
      .replace(/[{}\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!spoken || spoken.length > 160 || /[^\w\s.,+\-*/=()]/.test(spoken)) {
      return "formula omitted";
    }
    return `formula: ${spoken}`;
  }

  function formulaPlaceholder(index) {
    return `${FORMULA_PLACEHOLDER_PREFIX}${index}__`;
  }

  function formulaFallback(formulas, body) {
    if (!formulas) return "formula omitted";
    const normalized = String(body || "").trim();
    if (!normalized) return "formula omitted";
    const index = formulas.length;
    formulas.push(normalized);
    return formulaPlaceholder(index);
  }

  function replaceFormulaDelimiters(text, formulas = null, options = {}) {
    const forcePlaceholders = Boolean(options && options.forcePlaceholders);
    const replaceFormula = (_, body) => {
      if (forcePlaceholders) {
        return ` ${formulaFallback(formulas, body)} `;
      }
      const spoken = verbalizeSimpleFormula(body);
      return ` ${spoken === "formula omitted" ? formulaFallback(formulas, body) : spoken} `;
    };
    return String(text || "")
      .replace(/\[\[MATH:\s*([\s\S]*?)\s*\]\]/g, replaceFormula)
      .replace(/\$\$([\s\S]*?)\$\$/g, replaceFormula)
      .replace(/\\\[([\s\S]*?)\\\]/g, replaceFormula)
      .replace(/\\\(([\s\S]*?)\\\)/g, replaceFormula)
      .replace(/\$([^$\n]{2,160})\$/g, replaceFormula);
  }

  function looksLikeMathLine(line) {
    const value = String(line || "").trim();
    if (value.includes(FORMULA_PLACEHOLDER_PREFIX)) return false;
    if (value.length < 3 || value.length > 160) return false;
    if (/\\(?:begin|matrix|cases|left|right|frac|sqrt|sum|int|alpha|beta|gamma|delta|lambda|mu|pi|theta)\b/.test(value)) {
      return true;
    }
    const mathMarks = countMatches(value, /[=^_∑Σ√∫≈≤≥÷×]/g);
    return mathMarks >= 1 && /[A-Za-z0-9]/.test(value);
  }

  function stripUnreadableReadText(text, formulas = null, options = {}) {
    const forceFormulaPlaceholders = Boolean(options && options.forceFormulaPlaceholders);
    let value = String(text || "");
    value = value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      .replace(/\[([^\]\n]{1,80})\]\((?:https?:\/\/|mailto:)[^)]+\)/g, "$1")
      .replace(/\bhttps?:\/\/\S+/gi, " ")
      .replace(/\bwww\.\S+/gi, " ")
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
      .replace(/\[\d+(?:,\s*\d+)*\]/g, " ")
      .replace(/\(\s*(?:fig|figure|table|eq|equation)\.?\s*\d+\s*\)/gi, " ");

    value = replaceFormulaDelimiters(value, formulas, {
      forcePlaceholders: forceFormulaPlaceholders,
    });

    const lines = value.split(/\r?\n/);
    const kept = [];
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line) {
        kept.push("");
        continue;
      }
      if (/^\s*>/.test(line) || (line.match(/\|/g) || []).length >= 2) {
        continue;
      }
      if (cjkRatio(line) >= 0.25) {
        continue;
      }
      if (looksLikeMathLine(line)) {
        const spoken = verbalizeSimpleFormula(line);
        line = forceFormulaPlaceholders || spoken === "formula omitted"
          ? formulaFallback(formulas, line)
          : spoken;
      }
      line = line
        .replace(/[\u3400-\u9FFF\uF900-\uFAFF]+/g, " ")
        .replace(/[•◆◇■□●○★☆※→←↑↓↔↗↘↙↖]+/g, " ")
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim();
      if (line) kept.push(line);
    }

    return kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function prepareTextForRead(text) {
    const plan = prepareTextForReadPlan(text);
    const readableText = applyFormulaVerbalizations(
      plan.text,
      plan.formulas.map(() => "formula omitted")
    );
    return { ...plan, text: readableText, empty: readableText.length === 0 };
  }

  function prepareTextForReadPlan(text) {
    const original = String(text || "");
    const formulas = [];
    const readableText = stripUnreadableReadText(original, formulas);
    return {
      text: readableText,
      formulas,
      changed: readableText !== original.trim(),
      removedChinese: CJK_PATTERN.test(original) && !CJK_PATTERN.test(readableText),
      empty: readableText.length === 0,
    };
  }

  function splitSpeechTextChunks(text, maxChars = 260) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return [];
    const sentences = value.match(/[^.!?]+[.!?]*/g) || [value];
    const chunks = [];
    let current = "";

    function pushCurrent() {
      const cleaned = current
        .replace(/^[\s,;:]+/g, "")
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim();
      if (cleaned && !/[A-Za-z0-9]/.test(cleaned)) {
        current = "";
        return;
      }
      if (cleaned) chunks.push(cleaned);
      current = "";
    }

    for (const sentence of sentences) {
      const part = sentence.trim();
      if (!part) continue;
      if ((current + " " + part).trim().length <= maxChars) {
        current = (current ? `${current} ${part}` : part).trim();
        continue;
      }
      pushCurrent();
      if (part.length <= maxChars) {
        current = part;
      } else {
        const words = part.split(/\s+/);
        for (const word of words) {
          if ((current + " " + word).trim().length > maxChars) {
            pushCurrent();
          }
          current = (current ? `${current} ${word}` : word).trim();
        }
      }
    }
    pushCurrent();
    return chunks;
  }

  function splitReadTextByFormulaPlaceholders(text, formulas = []) {
    const segments = [];
    const pattern = new RegExp(`${FORMULA_PLACEHOLDER_PREFIX}(\\d+)__`, "g");
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text || "")) !== null) {
      if (match.index > lastIndex) {
        for (const chunk of splitSpeechTextChunks(String(text).slice(lastIndex, match.index))) {
          segments.push({ type: "text", text: chunk });
        }
      }
      const index = Number.parseInt(match[1], 10);
      if (Number.isFinite(index) && index >= 0 && index < formulas.length) {
        segments.push({ type: "formula", index, formula: formulas[index] });
      }
      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < String(text || "").length) {
      for (const chunk of splitSpeechTextChunks(String(text).slice(lastIndex))) {
        segments.push({ type: "text", text: chunk });
      }
    }
    return segments;
  }

  function prepareProgressiveReadPlan(text) {
    const original = String(text || "");
    const formulas = [];
    const readableText = stripUnreadableReadText(original, formulas, {
      forceFormulaPlaceholders: true,
    });
    const segments = splitReadTextByFormulaPlaceholders(readableText, formulas);
    return {
      text: readableText,
      formulas,
      segments,
      changed: readableText !== original.trim(),
      removedChinese: CJK_PATTERN.test(original) && !CJK_PATTERN.test(readableText),
      empty: segments.length === 0,
    };
  }

  function applyFormulaVerbalizations(text, verbalizations = []) {
    let result = String(text || "");
    for (let index = 0; index < verbalizations.length; index += 1) {
      const spoken = String(verbalizations[index] || "formula omitted").trim() || "formula omitted";
      result = result.split(formulaPlaceholder(index)).join(spoken);
    }
    return result.replace(new RegExp(`${FORMULA_PLACEHOLDER_PREFIX}\\d+__`, "g"), "formula omitted").trim();
  }

  function createAppendQueue(sourceBuffer, mediaSource) {
    const queue = [];
    const endWaiters = [];
    let pending = null;
    let ending = false;
    let ended = false;
    let closed = false;

    function removeListeners() {
      if (typeof sourceBuffer.removeEventListener === "function") {
        sourceBuffer.removeEventListener("updateend", onUpdateEnd);
        sourceBuffer.removeEventListener("error", onError);
      }
    }

    function rejectWaiters(error) {
      while (queue.length) {
        queue.shift().reject(error);
      }
      if (pending) {
        pending.reject(error);
        pending = null;
      }
      while (endWaiters.length) {
        endWaiters.shift().reject(error);
      }
    }

    function finishEndWaiters() {
      while (endWaiters.length) {
        endWaiters.shift().resolve();
      }
    }

    function settleEndIfReady() {
      if (!ending || ended || pending || sourceBuffer.updating || queue.length) {
        return;
      }

      try {
        if (mediaSource && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
        ended = true;
        removeListeners();
        finishEndWaiters();
      } catch (error) {
        closed = true;
        removeListeners();
        rejectWaiters(error);
      }
    }

    function pump() {
      if (closed || pending || sourceBuffer.updating || queue.length === 0) {
        settleEndIfReady();
        return;
      }

      pending = queue.shift();
      try {
        sourceBuffer.appendBuffer(pending.data);
      } catch (error) {
        const failed = pending;
        pending = null;
        failed.reject(error);
        closed = true;
        removeListeners();
        rejectWaiters(error);
      }
    }

    function onUpdateEnd() {
      if (pending) {
        pending.resolve();
        pending = null;
      }
      pump();
    }

    function onError(event) {
      const error =
        event instanceof Error ? event : new Error("MediaSource append failed");
      closed = true;
      removeListeners();
      rejectWaiters(error);
    }

    sourceBuffer.addEventListener("updateend", onUpdateEnd);
    sourceBuffer.addEventListener("error", onError);

    return {
      append(data) {
        if (closed) {
          return Promise.reject(new Error("Append queue is closed"));
        }
        return new Promise((resolve, reject) => {
          queue.push({ data, resolve, reject });
          pump();
        });
      },
      end() {
        ending = true;
        return new Promise((resolve, reject) => {
          endWaiters.push({ resolve, reject });
          settleEndIfReady();
        });
      },
      close() {
        if (closed) return;
        closed = true;
        removeListeners();
        rejectWaiters(new Error("Append queue is closed"));
      },
    };
  }

  return {
    WEBM_OPUS_MIME,
    applyFormulaVerbalizations,
    choosePlaybackMode,
    cjkRatio,
    createAppendQueue,
    createRequestGate,
    formatPlaybackProgress,
    formulaToReadableHtml,
    isUnsupportedMediaError,
    latexToReadableFormula,
    mergeTranslationModelOptions,
    normalizeAudioBuffer,
    normalizeAudioBlob,
    normalizeCopyTextWithLatex,
    normalizeDisplayMathWrappers,
    normalizeLlmSourceText,
    prepareProgressiveReadPlan,
    prepareTextForRead,
    prepareTextForReadPlan,
    releaseAudio,
    replaceFormulaDelimiters,
    selectBlobAudioFormat,
    splitReadTextByFormulaPlaceholders,
    splitLatexSegments,
    splitSpeechTextChunks,
    stripUnreadableReadText,
    supportsWebMOpus,
    verbalizeSimpleFormula,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = KokoroTTSCore;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
(function () {
  "use strict";

  const MATH_SELECTOR = 'math, mjx-container, script[type^="math/tex"], .MathJax, .katex, .katex-display, [data-latex], [data-tex], [data-math], [data-mathml]';

  // ════════════════════════════════════════════════════════
  //  Configuration
  // ════════════════════════════════════════════════════════

  const API_BASE = "http://127.0.0.1:5000";
  const API_ORIGIN = new URL(API_BASE).origin;
  const API_URL = API_BASE + "/tts";
  const API_STREAM_URL = API_BASE + "/tts/stream";
  const API_TRANSLATE_URL = API_BASE + "/translate";
  const API_TRANSLATE_HEALTH_URL = API_BASE + "/translate/health";
  const API_TRANSLATE_KEEPALIVE_URL = API_BASE + "/translate/model/keepalive";
  const API_TRANSLATE_UNLOAD_URL = API_BASE + "/translate/model/unload";
  const API_READ_PREPARE_URL = API_BASE + "/read/prepare";
  const API_FORMULA_VERBALIZE_URL = API_BASE + "/formula/verbalize";
  const SHORTCUT = { ctrl: true, shift: true, key: "S" }; // Ctrl+Shift+S

  /* CATALOG:START */
  const TTS_CATALOG = {"default_voice":"af_bella","default_speed":0.8,"speeds":[0.6,0.7,0.8,0.9,1.0,1.1,1.2],"groups":[{"id":"american_female","label_en":"American Female","label_zh":"美式女声","lang_code":"a","voices":[{"id":"af_bella","label_en":"Sweet","label_zh":"甜美"},{"id":"af_heart","label_en":"Warm","label_zh":"温暖"},{"id":"af_sky","label_en":"Bright","label_zh":"明亮活泼"},{"id":"af_nova","label_en":"Clear","label_zh":"自然清晰"},{"id":"af_jessica","label_en":"Professional","label_zh":"专业"},{"id":"af_alloy","label_en":"Neutral","label_zh":"中性"},{"id":"af_aoede","label_en":"Elegant","label_zh":"典雅"},{"id":"af_kore","label_en":"Crisp","label_zh":"清脆"},{"id":"af_nicole","label_en":"Soft","label_zh":"柔和"},{"id":"af_river","label_en":"Smooth","label_zh":"流畅"}]},{"id":"american_male","label_en":"American Male","label_zh":"美式男声","lang_code":"a","voices":[{"id":"am_adam","label_en":"Clear","label_zh":"年轻清晰"},{"id":"am_liam","label_en":"Warm","label_zh":"温暖阳光"},{"id":"am_michael","label_en":"Mature","label_zh":"成熟稳重"},{"id":"am_eric","label_en":"Energetic","label_zh":"活力感"},{"id":"am_echo","label_en":"Natural","label_zh":"自然流畅"},{"id":"am_fenrir","label_en":"Deep","label_zh":"低沉有力"}]},{"id":"british_female","label_en":"British Female","label_zh":"英式女声","lang_code":"b","voices":[{"id":"bf_emma","label_en":"British","label_zh":"标准英式"}]}]};
  /* CATALOG:END */

  // Default settings (overridden by GM storage)
  const DEFAULTS = {
    settingsVersion: 2,
    voice: TTS_CATALOG.default_voice,
    speed: TTS_CATALOG.default_speed,
    translateModel: "translategemma:4b",
    targetLanguage: "Simplified Chinese",
  };

  const VOICES = TTS_CATALOG.groups.map((group) => ({
    group: group.label_en,
    voices: group.voices.map((voice) => ({
      id: voice.id,
      label: `${voice.id} - ${voice.label_en}`,
    })),
  }));

  const SPEEDS = TTS_CATALOG.speeds.map((value) => ({
    value,
    label: `${value}x${value === DEFAULTS.speed ? " (default)" : ""}`,
  }));

  const TRANSLATION_MODELS = [
    { value: "translategemma:4b", label: "translategemma:4b - default" },
    { value: "qwen3:14b", label: "qwen3:14b - accurate" },
    { value: "qwen3:4b", label: "qwen3:4b - lightweight" },
    { value: "glm4:9b", label: "glm4:9b" },
    { value: "zhou-xingmei:latest", label: "zhou-xingmei:latest" },
  ];

  // ════════════════════════════════════════════════════════
  //  State
  // ════════════════════════════════════════════════════════

  let floatingBtn = null;
  let currentAudio = null;
  const requestGate = KokoroTTSCore.createRequestGate();
  const translationGate = KokoroTTSCore.createRequestGate();
  let isLoading = false;
  let isTranslating = false;
  let settingsPanel = null;
  let settingsVisible = false;

  // Load saved settings
  function loadSettings() {
    try {
      const saved = GM_getValue("kokoro-tts-settings", DEFAULTS);
      const voiceExists = VOICES.some((group) =>
        group.voices.some((voice) => voice.id === saved.voice)
      );
      const speedExists = SPEEDS.some((speed) => speed.value === saved.speed);
      const savedVersion = Number(saved.settingsVersion) || 0;
      let translateModel =
        typeof saved.translateModel === "string" && saved.translateModel.trim()
          ? saved.translateModel.trim()
          : DEFAULTS.translateModel;
      if (savedVersion < 2 && translateModel === "qwen3:14b") {
        translateModel = DEFAULTS.translateModel;
      }
      const targetLanguage =
        typeof saved.targetLanguage === "string" && saved.targetLanguage.trim()
          ? saved.targetLanguage.trim()
          : DEFAULTS.targetLanguage;
      return {
        voice: voiceExists ? saved.voice : DEFAULTS.voice,
        speed: speedExists ? saved.speed : DEFAULTS.speed,
        translateModel,
        targetLanguage,
        settingsVersion: DEFAULTS.settingsVersion,
      };
    } catch { return { ...DEFAULTS }; }
  }

  function saveSettings(settings) {
    try {
      GM_setValue("kokoro-tts-settings", settings);
    } catch (err) {
      console.error("[Kokoro TTS] Cannot save settings", err);
    }
  }

  let settings = loadSettings();
  saveSettings(settings);

  function syncSettingsFromPanel(panel = settingsPanel) {
    if (!panel) {
      saveSettings(settings);
      return;
    }

    const voiceSelect = panel.querySelector("#tts-voice-select");
    const speedSelect = panel.querySelector("#tts-speed-select");
    const modelSelect = panel.querySelector("#tts-translate-model-select");
    const modelInput = panel.querySelector("#tts-translate-model-input");
    const targetInput = panel.querySelector("#tts-target-language-input");

    if (voiceSelect) {
      settings.voice = voiceSelect.value || DEFAULTS.voice;
    }
    if (speedSelect) {
      const speed = parseFloat(speedSelect.value);
      settings.speed = Number.isFinite(speed) ? speed : DEFAULTS.speed;
    }
    if (modelInput) {
      settings.translateModel = modelInput.value.trim() || DEFAULTS.translateModel;
      modelInput.value = settings.translateModel;
    } else if (modelSelect) {
      settings.translateModel = modelSelect.value.trim() || DEFAULTS.translateModel;
    }
    if (targetInput) {
      settings.targetLanguage = targetInput.value.trim() || DEFAULTS.targetLanguage;
      targetInput.value = settings.targetLanguage;
    }
    settings.settingsVersion = DEFAULTS.settingsVersion;

    if (modelSelect) {
      let option = Array.from(modelSelect.options).find(
        (item) => item.value === settings.translateModel
      );
      if (!option) {
        option = new Option(`Custom: ${settings.translateModel}`, settings.translateModel);
        modelSelect.appendChild(option);
      }
      modelSelect.value = settings.translateModel;
    }

    saveSettings(settings);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function appendLabeledControl(parent, labelText, control) {
    const label = document.createElement("label");
    label.textContent = labelText;
    parent.appendChild(label);
    parent.appendChild(control);
    return control;
  }

  function createStatusRow(dotId, textId, initialText) {
    const row = document.createElement("div");
    row.className = "tts-settings-status";
    const dot = document.createElement("span");
    dot.className = "tts-status-dot checking";
    dot.id = dotId;
    const text = document.createElement("span");
    text.id = textId;
    text.textContent = initialText;
    row.appendChild(dot);
    row.appendChild(text);
    return row;
  }

  function createSettingsButton(id, label) {
    const button = document.createElement("button");
    button.className = "tts-test-btn";
    button.id = id;
    button.type = "button";
    button.textContent = label;
    return button;
  }

  function createVoiceSelect() {
    const select = document.createElement("select");
    select.id = "tts-voice-select";
    for (const group of VOICES) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group.group;
      for (const voice of group.voices) {
        const option = new Option(voice.label, voice.id);
        option.selected = voice.id === settings.voice;
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
    return select;
  }

  function createSpeedSelect() {
    const select = document.createElement("select");
    select.id = "tts-speed-select";
    for (const speed of SPEEDS) {
      const option = new Option(speed.label, String(speed.value));
      option.selected = speed.value === settings.speed;
      select.appendChild(option);
    }
    return select;
  }

  function createTranslateModelSelect() {
    const select = document.createElement("select");
    select.id = "tts-translate-model-select";
    let hasSavedTranslateModel = false;
    for (const model of TRANSLATION_MODELS) {
      const option = new Option(model.label, model.value);
      option.selected = model.value === settings.translateModel;
      if (option.selected) hasSavedTranslateModel = true;
      select.appendChild(option);
    }
    if (!hasSavedTranslateModel) {
      const option = new Option(`Custom: ${settings.translateModel}`, settings.translateModel);
      option.selected = true;
      select.appendChild(option);
    }
    return select;
  }

  function createTextInput(id, value) {
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = value;
    input.spellcheck = false;
    return input;
  }

  // ════════════════════════════════════════════════════════
  //  Styles
  // ════════════════════════════════════════════════════════

  GM_addStyle(`
    /* -- Floating button container -- */
    .tts-float-container {
      position: fixed;
      z-index: 2147483647;
      pointer-events: auto;
      animation: tts-fade-in 0.2s ease-out;
      max-width: calc(100vw - 24px);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }

    .tts-float-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-start;
    }

    @keyframes tts-fade-in {
      from { opacity: 0; transform: translateY(6px) scale(0.92); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes tts-fade-out {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(0.9); }
    }

    /* -- Main button -- */
    .tts-speak-btn,
    .tts-translate-btn,
    .tts-copy-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 20px;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #ffffff;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4),
                  0 1px 3px rgba(0, 0, 0, 0.15);
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
      user-select: none;
      -webkit-user-select: none;
      line-height: 1;
      overflow: hidden;
      --tts-progress: 0%;
    }

    .tts-translate-btn {
      background: linear-gradient(135deg, #0f9b8e 0%, #2f80ed 100%);
      box-shadow: 0 4px 15px rgba(47, 128, 237, 0.32),
                  0 1px 3px rgba(0, 0, 0, 0.15);
    }

    .tts-copy-btn {
      background: linear-gradient(135deg, #46566f 0%, #6f7f95 100%);
      box-shadow: 0 4px 15px rgba(92, 112, 138, 0.32),
                  0 1px 3px rgba(0, 0, 0, 0.15);
    }

    .tts-speak-btn.with-progress::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: var(--tts-progress);
      border-radius: inherit;
      background: rgba(255, 255, 255, 0.22);
      pointer-events: none;
      transition: width 0.18s ease;
    }

    .tts-speak-btn.with-progress.buffering::before {
      left: -42%;
      width: 42%;
      background: linear-gradient(90deg,
        rgba(255, 255, 255, 0.04) 0%,
        rgba(255, 255, 255, 0.28) 50%,
        rgba(255, 255, 255, 0.04) 100%);
      animation: tts-buffer-bar 1.15s ease-in-out infinite;
    }

    .tts-speak-btn.with-progress .tts-icon,
    .tts-speak-btn.with-progress .tts-label {
      position: relative;
      z-index: 1;
    }

    @keyframes tts-buffer-bar {
      from { left: -42%; }
      to   { left: 100%; }
    }

    .tts-speak-btn:hover,
    .tts-translate-btn:hover,
    .tts-copy-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.55),
                  0 2px 6px rgba(0, 0, 0, 0.2);
    }

    .tts-speak-btn:active,
    .tts-translate-btn:active,
    .tts-copy-btn:active {
      transform: translateY(0);
    }

    /* -- Loading state -- */
    .tts-speak-btn.loading,
    .tts-translate-btn.loading,
    .tts-copy-btn.loading {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      cursor: pointer;
    }

    .tts-speak-btn.loading .tts-icon,
    .tts-translate-btn.loading .tts-icon,
    .tts-copy-btn.loading .tts-icon {
      animation: tts-pulse 1s ease-in-out infinite;
    }

    @keyframes tts-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.4; }
    }

    /* -- Playing state -- */
    .tts-speak-btn.playing {
      background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
      cursor: pointer;
    }

    .tts-speak-btn.playing .tts-icon {
      animation: tts-bounce 0.6s ease-in-out infinite alternate;
    }

    @keyframes tts-bounce {
      from { transform: scale(1); }
      to   { transform: scale(1.2); }
    }

    /* -- Error state -- */
    .tts-speak-btn.error,
    .tts-translate-btn.error,
    .tts-copy-btn.error {
      background: linear-gradient(135deg, #fc5c7d 0%, #6a82fb 100%);
    }

    .tts-translate-btn:hover {
      box-shadow: 0 6px 20px rgba(47, 128, 237, 0.48),
                  0 2px 6px rgba(0, 0, 0, 0.2);
    }

    .tts-translation-card {
      box-sizing: border-box;
      width: min(420px, calc(100vw - 24px));
      margin-top: 8px;
      padding: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      background: rgba(20, 24, 34, 0.96);
      color: #e8eef7;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.35);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      line-height: 1.55;
    }

    .tts-float-container.tts-placement-above .tts-translation-card {
      order: -1;
      margin-top: 0;
      margin-bottom: 8px;
    }

    .tts-translation-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
      color: #8ea3bd;
      font-size: 11px;
    }

    .tts-copy-translation-btn {
      flex: 0 0 auto;
      padding: 4px 8px;
      border: 1px solid rgba(47, 128, 237, 0.35);
      border-radius: 7px;
      background: rgba(47, 128, 237, 0.12);
      color: #b8d4ff;
      font-size: 11px;
      cursor: pointer;
    }

    .tts-translation-text {
      max-height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 14px;
    }

    .tts-formula-rendered {
      display: inline;
      padding: 0 2px;
      color: #f1f5f9;
      font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif;
      font-size: 15px;
      line-height: 1.75;
      white-space: nowrap;
    }

    .tts-formula-rendered sub,
    .tts-formula-rendered sup {
      font-size: 0.72em;
      line-height: 0;
    }

    .tts-formula-rendered.tts-formula-block {
      display: block;
      max-width: 100%;
      margin: 7px 0;
      padding: 6px 0;
      overflow-x: auto;
      white-space: nowrap;
      word-break: normal;
      text-align: center;
    }

    /* -- Icon -- */
    .tts-icon {
      font-size: 15px;
      line-height: 1;
    }

    /* ── Settings gear button ── */
    .tts-settings-gear {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483646;
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      font-size: 18px;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
    }

    .tts-settings-gear:hover {
      opacity: 1;
      transform: scale(1.1) rotate(30deg);
      box-shadow: 0 6px 25px rgba(102, 126, 234, 0.6);
    }

    .tts-settings-gear.active {
      opacity: 1;
      background: linear-gradient(135deg, #764ba2 0%, #667eea 100%);
    }

    /* ── Settings panel ── */
    .tts-settings-panel {
      position: fixed;
      bottom: 70px;
      right: 20px;
      z-index: 2147483646;
      width: 640px;
      max-width: calc(100vw - 40px);
      background: #1a1a2e;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      color: #e0e0e0;
      animation: tts-panel-in 0.25s ease-out;
    }

    @keyframes tts-panel-in {
      from { opacity: 0; transform: translateY(10px) scale(0.95); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .tts-settings-panel h3 {
      margin: 0 0 14px 0;
      font-size: 14px;
      font-weight: 700;
      background: linear-gradient(135deg, #667eea, #764ba2);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .tts-settings-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }

    .tts-settings-column {
      min-width: 0;
    }

    .tts-settings-column h4 {
      margin: 0 0 10px 0;
      font-size: 12px;
      font-weight: 700;
      color: #c7d0ff;
      letter-spacing: 0;
    }

    .tts-settings-status {
      min-height: 34px;
      padding: 9px 10px;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      font-size: 12px;
      line-height: 1.35;
      color: #888;
    }

    .tts-settings-panel .tts-test-output {
      min-height: 42px;
      margin-top: 10px;
      padding: 9px 10px;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: #c9d5e8;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow: auto;
    }

    @media (max-width: 680px) {
      .tts-settings-grid {
        grid-template-columns: 1fr;
      }
    }

    .tts-settings-panel label {
      display: block;
      font-size: 12px;
      color: #888;
      margin-bottom: 4px;
      margin-top: 12px;
    }

    .tts-settings-panel label:first-of-type {
      margin-top: 0;
    }

    .tts-settings-panel select,
    .tts-settings-panel input[type="text"] {
      width: 100%;
      padding: 8px 10px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 13px;
      outline: none;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
    }

    .tts-settings-panel input[type="text"] {
      box-sizing: border-box;
      cursor: text;
    }

    .tts-settings-panel select:focus,
    .tts-settings-panel input[type="text"]:focus {
      border-color: #667eea;
    }

    .tts-settings-panel select option {
      background: #1a1a2e;
      color: #e0e0e0;
    }

    .tts-settings-panel select optgroup {
      background: #1a1a2e;
      color: #888;
      font-style: normal;
    }

    .tts-settings-panel .tts-speed-display {
      font-size: 12px;
      color: #667eea;
      float: right;
      margin-top: -16px;
    }

    .tts-settings-panel .tts-test-btn {
      width: 100%;
      margin-top: 16px;
      padding: 8px;
      border: 1px solid rgba(102, 126, 234, 0.3);
      border-radius: 8px;
      background: rgba(102, 126, 234, 0.1);
      color: #98a8f8;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .tts-settings-panel .tts-model-actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 8px;
      margin-top: 12px;
    }

    .tts-settings-panel .tts-model-actions .tts-test-btn {
      margin-top: 0;
      min-height: 34px;
    }

    .tts-settings-panel .tts-test-btn:disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }

    .tts-settings-panel .tts-test-btn:hover {
      background: rgba(102, 126, 234, 0.2);
      border-color: rgba(102, 126, 234, 0.5);
    }

    .tts-settings-panel .tts-test-btn.loading {
      color: #f7b2c0;
      border-color: rgba(245, 87, 108, 0.45);
      background: rgba(245, 87, 108, 0.12);
    }

    .tts-settings-panel .tts-test-btn.playing {
      color: #9af2bd;
      border-color: rgba(56, 239, 125, 0.45);
      background: rgba(56, 239, 125, 0.12);
    }

    .tts-settings-panel .tts-test-btn.error {
      color: #ff9eae;
      border-color: rgba(252, 92, 125, 0.5);
      background: rgba(252, 92, 125, 0.12);
    }

    .tts-settings-panel .tts-status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }

    .tts-settings-panel .tts-status-dot.online { background: #38ef7d; }
    .tts-settings-panel .tts-status-dot.offline { background: #f5576c; }
    .tts-settings-panel .tts-status-dot.checking { background: #f0c040; }
    .tts-settings-panel .tts-status-dot.warning { background: #f0c040; }
  `);

  // ════════════════════════════════════════════════════════
  //  Settings panel
  // ════════════════════════════════════════════════════════

  function createSettingsPanel() {
    const panel = document.createElement("div");
    panel.className = "tts-settings-panel";

    const title = document.createElement("h3");
    title.textContent = "Local Read & Translate";
    panel.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "tts-settings-grid";

    const ttsColumn = document.createElement("div");
    ttsColumn.className = "tts-settings-column";
    const ttsTitle = document.createElement("h4");
    ttsTitle.textContent = "TTS";
    ttsColumn.appendChild(ttsTitle);
    ttsColumn.appendChild(createStatusRow("tts-status-dot", "tts-status-text", "Checking..."));
    appendLabeledControl(ttsColumn, "Voice", createVoiceSelect());
    appendLabeledControl(ttsColumn, "Speed", createSpeedSelect());
    ttsColumn.appendChild(
      createSettingsButton("tts-test-btn", 'Test: "Hello, nice to meet you!"')
    );

    const translationColumn = document.createElement("div");
    translationColumn.className = "tts-settings-column";
    const translationTitle = document.createElement("h4");
    translationTitle.textContent = "Translation";
    translationColumn.appendChild(translationTitle);
    translationColumn.appendChild(
      createStatusRow("tts-translate-status-dot", "tts-translate-status-text", "Checking model...")
    );
    appendLabeledControl(translationColumn, "Translate model", createTranslateModelSelect());
    appendLabeledControl(
      translationColumn,
      "Custom model",
      createTextInput("tts-translate-model-input", settings.translateModel)
    );
    appendLabeledControl(
      translationColumn,
      "Target language",
      createTextInput("tts-target-language-input", settings.targetLanguage)
    );

    const modelActions = document.createElement("div");
    modelActions.className = "tts-model-actions";
    modelActions.appendChild(createSettingsButton("tts-model-keepalive-btn", "Keep loaded"));
    modelActions.appendChild(createSettingsButton("tts-model-unload-btn", "Unload"));
    translationColumn.appendChild(modelActions);
    translationColumn.appendChild(createSettingsButton("tts-translate-test-btn", "Test translation"));
    const output = document.createElement("div");
    output.className = "tts-test-output";
    output.id = "tts-translate-test-output";
    output.textContent = "No translation test yet.";
    translationColumn.appendChild(output);

    grid.appendChild(ttsColumn);
    grid.appendChild(translationColumn);
    panel.appendChild(grid);

    document.body.appendChild(panel);
    settingsPanel = panel;

    // Event listeners
    panel.querySelector("#tts-voice-select").addEventListener("change", (e) => {
      settings.voice = e.target.value;
      syncSettingsFromPanel(panel);
    });

    panel.querySelector("#tts-speed-select").addEventListener("change", (e) => {
      settings.speed = parseFloat(e.target.value);
      syncSettingsFromPanel(panel);
    });

    panel.querySelector("#tts-translate-model-select").addEventListener("change", (e) => {
      settings.translateModel = e.target.value.trim() || DEFAULTS.translateModel;
      const input = panel.querySelector("#tts-translate-model-input");
      if (input) input.value = settings.translateModel;
      syncSettingsFromPanel(panel);
      checkTranslationStatus();
    });

    panel.querySelector("#tts-translate-model-input").addEventListener("change", (e) => {
      settings.translateModel = e.target.value.trim() || DEFAULTS.translateModel;
      e.target.value = settings.translateModel;
      const select = panel.querySelector("#tts-translate-model-select");
      if (select) {
        let option = Array.from(select.options).find(
          (item) => item.value === settings.translateModel
        );
        if (!option) {
          option = new Option(`Custom: ${settings.translateModel}`, settings.translateModel);
          select.appendChild(option);
        }
        select.value = settings.translateModel;
      }
      syncSettingsFromPanel(panel);
      checkTranslationStatus();
    });

    panel.querySelector("#tts-translate-model-input").addEventListener("input", (e) => {
      settings.translateModel = e.target.value.trim() || DEFAULTS.translateModel;
      settings.settingsVersion = DEFAULTS.settingsVersion;
      saveSettings(settings);
    });

    panel.querySelector("#tts-target-language-input").addEventListener("change", (e) => {
      settings.targetLanguage = e.target.value.trim() || DEFAULTS.targetLanguage;
      e.target.value = settings.targetLanguage;
      syncSettingsFromPanel(panel);
    });

    panel.querySelector("#tts-target-language-input").addEventListener("input", (e) => {
      settings.targetLanguage = e.target.value.trim() || DEFAULTS.targetLanguage;
      settings.settingsVersion = DEFAULTS.settingsVersion;
      saveSettings(settings);
    });

    panel.querySelector("#tts-test-btn").addEventListener("click", (e) => {
      const testText = "Hello, nice to meet you! This is a test of the Kokoro text to speech system.";
      speak(testText, e.currentTarget);
    });

    panel.querySelector("#tts-translate-test-btn").addEventListener("click", (e) => {
      testTranslation(e.currentTarget);
    });

    panel.querySelector("#tts-model-keepalive-btn").addEventListener("click", (e) => {
      keepTranslationModelLoaded(e.currentTarget);
    });

    panel.querySelector("#tts-model-unload-btn").addEventListener("click", (e) => {
      unloadTranslationModel(e.currentTarget);
    });

    // Check server status
    checkServerStatus();
    checkTranslationStatus();
  }

  function checkServerStatus() {
    const dot = document.getElementById("tts-status-dot");
    const text = document.getElementById("tts-status-text");
    if (!dot || !text) return;

    GM_xmlhttpRequest({
      method: "GET",
      url: API_BASE + "/health",
      timeout: 3000,
      onload: (resp) => {
        if (resp.status === 200) {
          dot.className = "tts-status-dot online";
          text.textContent = "Server online";
          text.style.color = "#81c784";
        } else {
          dot.className = "tts-status-dot offline";
          text.textContent = "Server error";
          text.style.color = "#e57373";
        }
      },
      onerror: () => {
        dot.className = "tts-status-dot offline";
        text.textContent = "Server offline - run start.bat";
        text.style.color = "#e57373";
      },
      ontimeout: () => {
        dot.className = "tts-status-dot offline";
        text.textContent = "Server timeout";
        text.style.color = "#e57373";
      },
    });
  }

  function syncInstalledTranslationModels(payloadOrModels) {
    const select = document.getElementById("tts-translate-model-select");
    if (!select) return;
    const payload = Array.isArray(payloadOrModels)
      ? { available_models: payloadOrModels }
      : payloadOrModels || {};
    const options = KokoroTTSCore.mergeTranslationModelOptions(
      TRANSLATION_MODELS,
      payload,
      settings.translateModel
    );
    select.textContent = "";
    for (const option of options) {
      const item = new Option(option.label, option.value);
      item.selected = option.value === settings.translateModel;
      select.appendChild(item);
    }
    select.value = settings.translateModel;
  }

  function updateTranslationModelControls(payload) {
    const keepBtn = document.getElementById("tts-model-keepalive-btn");
    const unloadBtn = document.getElementById("tts-model-unload-btn");
    if (!keepBtn || !unloadBtn) return;

    const reachable = Boolean(payload && payload.ollama_reachable);
    const available = Boolean(payload && payload.model_available);
    const running = Boolean(payload && payload.model_running);
    const pinned = Boolean(payload && payload.model_pinned);
    const canLoad = reachable && available;

    keepBtn.disabled = !canLoad;
    unloadBtn.disabled = !reachable || !running;

    if (pinned) {
      setButtonHtml(keepBtn, "tts-test-btn playing", "\u2705", "Kept loaded");
    } else {
      setButtonHtml(keepBtn, "tts-test-btn", "\uD83D\uDCCC", running ? "Keep loaded" : "Load & keep");
    }

    if (running) {
      setButtonHtml(unloadBtn, "tts-test-btn", "\u23CF", "Unload");
    } else {
      setButtonHtml(unloadBtn, "tts-test-btn", "\u23CF", "Not loaded");
    }
  }

  function requestTranslationModelResidency(url, body, timeout = 180000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify(body),
        responseType: "json",
        timeout,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            try {
              resolve(response.response || JSON.parse(response.responseText || "{}"));
            } catch (error) {
              reject(error);
            }
          } else {
            let detail = response.statusText || "Model residency request failed";
            try {
              const payload = JSON.parse(response.responseText || "{}");
              if (payload.detail) detail = payload.detail;
            } catch {}
            reject(new Error(`Server returned ${response.status}: ${detail}`));
          }
        },
        onerror: () => reject(new Error("Cannot connect to local TTS server. Run start.bat first.")),
        ontimeout: () => reject(new Error("Model residency request timeout.")),
      });
    });
  }

  function checkTranslationStatus() {
    const dot = document.getElementById("tts-translate-status-dot");
    const text = document.getElementById("tts-translate-status-text");
    if (!dot || !text) return;

    dot.className = "tts-status-dot checking";
    text.textContent = "Checking model...";
    text.style.color = "#f0c040";
    updateTranslationModelControls(null);

    GM_xmlhttpRequest({
      method: "GET",
      url: `${API_TRANSLATE_HEALTH_URL}?model=${encodeURIComponent(settings.translateModel)}`,
      timeout: 5000,
      onload: (resp) => {
        if (resp.status !== 200) {
          dot.className = "tts-status-dot offline";
          text.textContent = "Translation health check failed";
          text.style.color = "#e57373";
          return;
        }
        let payload = null;
        try {
          payload = JSON.parse(resp.responseText || "{}");
        } catch {
          dot.className = "tts-status-dot offline";
          text.textContent = "Invalid translation status";
          text.style.color = "#e57373";
          return;
        }

        if (!payload.ollama_reachable) {
          updateTranslationModelControls(payload);
          dot.className = "tts-status-dot offline";
          text.textContent = "Ollama offline";
          text.style.color = "#e57373";
        } else if (payload.model_running) {
          syncInstalledTranslationModels(payload);
          updateTranslationModelControls(payload);
          dot.className = "tts-status-dot online";
          text.textContent = payload.model_pinned
            ? `${payload.model} kept loaded`
            : `${payload.model} running`;
          text.style.color = "#81c784";
        } else if (payload.model_available) {
          syncInstalledTranslationModels(payload);
          updateTranslationModelControls(payload);
          dot.className = "tts-status-dot warning";
          text.textContent = `${payload.model} installed, not loaded`;
          text.style.color = "#f0c040";
        } else {
          syncInstalledTranslationModels(payload);
          updateTranslationModelControls(payload);
          dot.className = "tts-status-dot offline";
          text.textContent = `${payload.model} not installed`;
          text.style.color = "#e57373";
        }
      },
      onerror: () => {
        dot.className = "tts-status-dot offline";
        text.textContent = "Server offline - run start.bat";
        text.style.color = "#e57373";
      },
      ontimeout: () => {
        dot.className = "tts-status-dot offline";
        text.textContent = "Translation status timeout";
        text.style.color = "#e57373";
      },
    });
  }

  async function keepTranslationModelLoaded(btnElement) {
    if (btnElement && btnElement.classList.contains("loading")) return;
    syncSettingsFromPanel();
    const unloadBtn = document.getElementById("tts-model-unload-btn");
    if (btnElement) {
      setButtonHtml(btnElement, "tts-test-btn loading", "\u23F3", "Loading...");
      btnElement.disabled = true;
    }
    if (unloadBtn) unloadBtn.disabled = true;

    try {
      await requestTranslationModelResidency(API_TRANSLATE_KEEPALIVE_URL, {
        model: settings.translateModel,
        keep_alive: "-1m",
      });
      if (btnElement) {
        setButtonHtml(btnElement, "tts-test-btn playing", "\u2705", "Kept loaded");
      }
      checkTranslationStatus();
    } catch (err) {
      if (btnElement) {
        setButtonHtml(btnElement, "tts-test-btn error", "\u274C", "Load failed");
        btnElement.disabled = false;
      }
      const output = document.getElementById("tts-translate-test-output");
      if (output) {
        output.textContent = err.message || "Cannot keep model loaded";
        output.style.color = "#e57373";
      }
    }
  }

  async function unloadTranslationModel(btnElement) {
    if (btnElement && btnElement.classList.contains("loading")) return;
    syncSettingsFromPanel();
    const keepBtn = document.getElementById("tts-model-keepalive-btn");
    if (btnElement) {
      setButtonHtml(btnElement, "tts-test-btn loading", "\u23F3", "Unloading...");
      btnElement.disabled = true;
    }
    if (keepBtn) keepBtn.disabled = true;

    try {
      await requestTranslationModelResidency(API_TRANSLATE_UNLOAD_URL, {
        model: settings.translateModel,
      }, 60000);
      if (btnElement) {
        setButtonHtml(btnElement, "tts-test-btn", "\u23CF", "Not loaded");
      }
      checkTranslationStatus();
    } catch (err) {
      if (btnElement) {
        setButtonHtml(btnElement, "tts-test-btn error", "\u274C", "Unload failed");
        btnElement.disabled = false;
      }
      const output = document.getElementById("tts-translate-test-output");
      if (output) {
        output.textContent = err.message || "Cannot unload model";
        output.style.color = "#e57373";
      }
    }
  }

  async function testTranslation(btnElement) {
    if (btnElement && btnElement.classList.contains("loading")) {
      cancelTranslationRequest();
      setButtonHtml(
        btnElement,
        "tts-test-btn",
        "\uD83C\uDF10",
        "Test translation"
      );
      return;
    }

    const output = document.getElementById("tts-translate-test-output");
    if (output) {
      output.textContent = "Translating...";
      output.style.color = "#f0c040";
    }

    syncSettingsFromPanel();
    isTranslating = true;
    const generation = translationGate.begin();
    if (btnElement) {
      setButtonHtml(
        btnElement,
        "tts-test-btn loading",
        "\u23F9",
        "Cancel"
      );
    }

    try {
      const payload = await fetchTranslation(
        "Hello, nice to meet you!",
        "",
        generation
      );
      if (!translationGate.isCurrent(generation)) return;
      if (output) {
        output.textContent = payload.translated_text || "";
        output.style.color = "#c9d5e8";
      }
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-test-btn",
          "\u2705",
          "Translation OK"
        );
      }
      checkTranslationStatus();
    } catch (err) {
      if (!translationGate.isCurrent(generation)) return;
      if (output) {
        output.textContent = err.message || "Translation failed";
        output.style.color = "#e57373";
      }
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-test-btn error",
          "\u274C",
          "Translation failed"
        );
      }
    } finally {
      if (translationGate.isCurrent(generation)) {
        translationGate.finish(generation);
        isTranslating = false;
      }
    }
  }

  function toggleSettings() {
    if (settingsVisible) {
      if (settingsPanel) {
        settingsPanel.remove();
        settingsPanel = null;
      }
      settingsVisible = false;
      gearBtn.classList.remove("active");
      gearBtn.setAttribute("aria-expanded", "false");
    } else {
      createSettingsPanel();
      settingsVisible = true;
      gearBtn.classList.add("active");
      gearBtn.setAttribute("aria-expanded", "true");
    }
  }

  // Create gear button
  const gearBtn = document.createElement("button");
  gearBtn.className = "tts-settings-gear";
  gearBtn.textContent = "\u2699\uFE0F";
  gearBtn.title = "Local Read & Translate settings";
  gearBtn.setAttribute("aria-label", "Local Read and Translate settings");
  gearBtn.setAttribute("aria-expanded", "false");
  gearBtn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSettings();
  });
  document.body.appendChild(gearBtn);

  // ════════════════════════════════════════════════════════
  //  Core logic
  // ════════════════════════════════════════════════════════

  function normalizeSelectionOutput(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeMathFormulaText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\s+/g, " ")
      .replace(/\s*([{}_^=,+*/()])\s*/g, "$1")
      .replace(/\s*(->|→|⇒|↦|\\to|\\rightarrow|\\mapsto)\s*/g, " \\to ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mathOperatorToTex(value) {
    const operator = String(value || "").trim();
    const operators = {
      "→": "\\to",
      "⇒": "\\Rightarrow",
      "↦": "\\mapsto",
      "−": "-",
      "×": "\\times",
      "÷": "\\div",
      "≤": "\\le",
      "≥": "\\ge",
      "≠": "\\ne",
      "≈": "\\approx",
      "∈": "\\in",
      "∑": "\\sum",
      "∫": "\\int",
    };
    return operators[operator] || operator;
  }

  function mathMlChildrenToTex(element) {
    return Array.from(element.childNodes || [])
      .map(mathMlNodeToTex)
      .filter(Boolean)
      .join(" ");
  }

  function mathMlNodeToTex(node) {
    if (!node) return "";
    if (node.nodeType === 3) {
      return String(node.nodeValue || "").trim();
    }
    if (node.nodeType !== 1) return "";

    const element = node;
    const tag = (element.localName || element.tagName || "").toLowerCase();
    const children = Array.from(element.childNodes || []);
    const child = (index) => mathMlNodeToTex(children[index]);

    if (tag === "annotation") return "";
    if (tag === "semantics") {
      const visible = children.find((item) => {
        const name = (item.localName || item.tagName || "").toLowerCase();
        return name !== "annotation" && name !== "annotation-xml";
      });
      return mathMlNodeToTex(visible);
    }
    if (tag === "math" || tag === "mrow" || tag === "mpadded" || tag === "mstyle") {
      return mathMlChildrenToTex(element);
    }
    if (tag === "mi" || tag === "mn" || tag === "mtext") {
      return String(element.textContent || "").trim();
    }
    if (tag === "mo") {
      return mathOperatorToTex(element.textContent);
    }
    if (tag === "msub") {
      return `${child(0)}_{${child(1)}}`;
    }
    if (tag === "msup") {
      return `${child(0)}^{${child(1)}}`;
    }
    if (tag === "msubsup") {
      return `${child(0)}_{${child(1)}}^{${child(2)}}`;
    }
    if (tag === "mfrac") {
      return `\\frac{${child(0)}}{${child(1)}}`;
    }
    if (tag === "msqrt") {
      return `\\sqrt{${mathMlChildrenToTex(element)}}`;
    }
    if (tag === "mroot") {
      return `\\sqrt[${child(1)}]{${child(0)}}`;
    }
    if (tag === "mfenced") {
      const open = element.getAttribute("open") || "(";
      const close = element.getAttribute("close") || ")";
      return `${open}${mathMlChildrenToTex(element)}${close}`;
    }
    if (tag === "mtable") {
      const rows = children.map(mathMlNodeToTex).filter(Boolean);
      return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
    }
    if (tag === "mtr" || tag === "mlabeledtr") {
      return children.map(mathMlNodeToTex).filter(Boolean).join(" & ");
    }
    if (tag === "mtd") {
      return mathMlChildrenToTex(element);
    }
    return mathMlChildrenToTex(element);
  }

  function mathJaxChtmlChildrenToTex(element) {
    return Array.from(element.childNodes || [])
      .map(mathJaxChtmlNodeToTex)
      .filter(Boolean)
      .join(" ");
  }

  function isKatexElement(element) {
    return Boolean(
      element &&
      element.nodeType === 1 &&
      element.classList &&
      (element.classList.contains("katex") || element.classList.contains("katex-display"))
    );
  }

  function closestKatexRoot(element) {
    if (!element || element.nodeType !== 1 || !element.closest) return null;
    return element.closest(".katex-display") || element.closest(".katex");
  }

  function normalizeMathGlyphChar(char) {
    if (!char) return "";
    const cp = char.codePointAt(0);
    if (cp >= 0x1d434 && cp <= 0x1d44d) return String.fromCharCode(65 + cp - 0x1d434);
    if (cp >= 0x1d44e && cp <= 0x1d467) return String.fromCharCode(97 + cp - 0x1d44e);
    if (cp >= 0x1d7ce && cp <= 0x1d7d7) return String(cp - 0x1d7ce);
    const greek = {
      "𝛼": "\\alpha", "𝛽": "\\beta", "𝛾": "\\gamma", "𝛿": "\\delta",
      "𝜃": "\\theta", "𝜆": "\\lambda", "𝜇": "\\mu", "𝜋": "\\pi",
      "𝜎": "\\sigma", "𝜔": "\\omega",
    };
    return greek[char] || char;
  }

  function mathJaxGlyphToText(element) {
    const className = String(element.getAttribute("class") || "");
    const match = className.match(/\bmjx-c([0-9A-Fa-f]+)\b/);
    if (!match) return "";
    const codePoint = Number.parseInt(match[1], 16);
    if (!Number.isFinite(codePoint)) return "";
    try {
      return normalizeMathGlyphChar(String.fromCodePoint(codePoint));
    } catch (e) {
      return "";
    }
  }

  function meaningfulMathJaxChildren(element) {
    return Array.from(element.childNodes || []).filter((child) => {
      if (!child) return false;
      if (child.nodeType === 3) return Boolean(String(child.nodeValue || "").trim());
      if (child.nodeType !== 1) return false;
      const tag = (child.localName || child.tagName || "").toLowerCase();
      return tag !== "mjx-assistive-mml" && tag !== "mjx-itable";
    });
  }

  function mathJaxChtmlNodeToTex(node) {
    if (!node) return "";
    if (node.nodeType === 3) {
      return String(node.nodeValue || "").trim();
    }
    if (node.nodeType !== 1) return "";

    const element = node;
    const tag = (element.localName || element.tagName || "").toLowerCase();
    const children = meaningfulMathJaxChildren(element);
    const child = (index) => mathJaxChtmlNodeToTex(children[index]);
    const joined = () => children.map(mathJaxChtmlNodeToTex).filter(Boolean).join(" ");

    if (tag === "mjx-c") {
      return String(element.textContent || "").trim() || mathJaxGlyphToText(element);
    }
    if (tag === "mjx-assistive-mml") return "";
    if (tag === "mjx-container" || tag === "mjx-math" || tag === "mjx-mrow" || tag === "mjx-texatom" || tag === "mjx-script" || tag === "mjx-box") {
      return joined();
    }
    if (tag === "mjx-mi" || tag === "mjx-mn" || tag === "mjx-mtext") {
      return String(element.textContent || "").trim() || joined();
    }
    if (tag === "mjx-mo") {
      return mathOperatorToTex(String(element.textContent || "").trim() || joined());
    }
    if (tag === "mjx-msub") {
      return `${child(0)}_{${child(children.length - 1)}}`;
    }
    if (tag === "mjx-msup") {
      return `${child(0)}^{${child(children.length - 1)}}`;
    }
    if (tag === "mjx-msubsup") {
      return `${child(0)}_{${child(1)}}^{${child(children.length - 1)}}`;
    }
    if (tag === "mjx-mfrac") {
      return `\\frac{${child(0)}}{${child(1)}}`;
    }
    if (tag === "mjx-msqrt") {
      return `\\sqrt{${joined()}}`;
    }
    if (tag === "mjx-mover" || tag === "mjx-over") {
      const base = child(0);
      const accent = children.slice(1).map(mathJaxChtmlNodeToTex).join(" ");
      if (/[-_‾¯]/.test(accent)) return `\\bar{${base}}`;
      if (/[~˜]/.test(accent)) return `\\tilde{${base}}`;
      return `\\hat{${base}}`;
    }
    return String(element.textContent || "").trim() || joined();
  }

  function findTexAnnotation(element) {
    const annotations = Array.from(element.querySelectorAll ? element.querySelectorAll("annotation") : []);
    for (const annotation of annotations) {
      const encoding = String(annotation.getAttribute("encoding") || "").toLowerCase();
      if (encoding.includes("tex") || encoding.includes("latex")) {
        const value = normalizeMathFormulaText(annotation.textContent);
        if (value) return value;
      }
    }
    return "";
  }

  function extractMathFormula(element) {
    if (!element || element.nodeType !== 1) return "";
    const tag = (element.localName || element.tagName || "").toLowerCase();

    if (tag === "script" && /^math\/tex/i.test(element.getAttribute("type") || "")) {
      return normalizeMathFormulaText(element.textContent);
    }

    const attributeNames = ["data-latex", "data-tex", "data-math", "data-mathml"];
    for (const name of attributeNames) {
      const value = normalizeMathFormulaText(element.getAttribute(name));
      if (value) return value;
    }

    const annotation = findTexAnnotation(element);
    if (annotation) return annotation;

    const script = element.querySelector && element.querySelector('script[type^="math/tex"]');
    if (script) {
      const value = normalizeMathFormulaText(script.textContent);
      if (value) return value;
    }

    const mathElement = tag === "math" ? element : element.querySelector && element.querySelector("math");
    if (mathElement) {
      const value = normalizeMathFormulaText(mathMlNodeToTex(mathElement));
      if (value) return value;
    }

    if (tag === "mjx-container" || (element.querySelector && element.querySelector("mjx-math, mjx-msub, mjx-msup, mjx-mover"))) {
      const value = normalizeMathFormulaText(mathJaxChtmlNodeToTex(element));
      if (value) return value;
    }

    if (isKatexElement(element) || (element.querySelector && element.querySelector(".katex-mathml, .katex-html"))) {
      const katexRoot = closestKatexRoot(element) || element;
      const mathMl = katexRoot.querySelector && katexRoot.querySelector(".katex-mathml math");
      if (mathMl) {
        const value = normalizeMathFormulaText(mathMlNodeToTex(mathMl));
        if (value) return value;
      }
      const texAnnotation = katexRoot.querySelector && katexRoot.querySelector('annotation[encoding*="TeX"], annotation[encoding*="tex"], annotation[encoding*="latex"]');
      if (texAnnotation) {
        const value = normalizeMathFormulaText(texAnnotation.textContent);
        if (value) return value;
      }
    }

    const aria = normalizeMathFormulaText(element.getAttribute("aria-label"));
    if (aria && !/^math$/i.test(aria)) return aria;

    return normalizeMathFormulaText(element.textContent);
  }

  function isSemanticMathElement(element) {
    if (!element || element.nodeType !== 1) return false;
    const tag = (element.localName || element.tagName || "").toLowerCase();
    if (tag === "math" || tag === "mjx-container") return true;
    if (tag === "script" && /^math\/tex/i.test(element.getAttribute("type") || "")) return true;
    if (element.classList && element.classList.contains("MathJax")) return true;
    if (isKatexElement(element)) return true;
    return ["data-latex", "data-tex", "data-math", "data-mathml"].some((name) =>
      element.hasAttribute && element.hasAttribute(name)
    );
  }

  function closestSemanticMathElement(node) {
    let element = null;
    if (!node) return null;
    if (node.nodeType === 1) {
      element = node;
    } else {
      element = node.parentElement || node.parentNode;
    }
    while (element && element.nodeType === 1) {
      if (isSemanticMathElement(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function rectsOverlap(a, b) {
    if (!a || !b) return false;
    if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
    const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (horizontal <= 0 || vertical <= 0) return false;
    const overlapArea = horizontal * vertical;
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    return overlapArea / Math.max(smallerArea, 1) >= 0.08;
  }

  function rangeBoundaryIsInsideElement(range, element) {
    return Boolean(
      range &&
      element &&
      (element.contains(range.startContainer) || element.contains(range.endContainer))
    );
  }

  function rangeLooksLikeMathOnly(range, mathEl) {
    if (!range || !mathEl) return false;
    const selected = String(range.toString() || "").replace(/\s+/g, "");
    const mathText = String(mathEl.textContent || "").replace(/\s+/g, "");
    if (!selected) return true;
    if (!mathText) return selected.length <= 12;
    return selected.length <= Math.max(12, Math.ceil(mathText.length * 0.55));
  }

  function serializeSelectionNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1 && node.nodeType !== 11) return "";

    if (node.nodeType === 1) {
      const element = node;
      const tag = (element.localName || element.tagName || "").toLowerCase();
      if (tag === "style" || tag === "noscript") return "";
      if (isSemanticMathElement(element)) {
        const formula = extractMathFormula(element);
        return formula ? ` [[MATH: ${formula}]] ` : "";
      }
      if (tag === "br") return "\n";
      if (tag === "script") return "";
    }

    const text = Array.from(node.childNodes || []).map(serializeSelectionNode).join("");
    if (node.nodeType !== 1) return text;

    const blockTags = new Set([
      "address", "article", "aside", "blockquote", "div", "dl", "figcaption",
      "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
      "li", "main", "nav", "ol", "p", "pre", "section", "table", "tr", "ul",
    ]);
    const tag = (node.localName || node.tagName || "").toLowerCase();
    return blockTags.has(tag) ? `\n${text}\n` : text;
  }

  function expandRangeToContainMath(range) {
    if (!range) return range;
    const newRange = range.cloneRange();
    const selectedRect = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    const startMath = closestSemanticMathElement(range.startContainer);
    const endMath = closestSemanticMathElement(range.endContainer);

    try {
      if (startMath && startMath.parentNode) {
        newRange.setStartBefore(startMath);
      }
      if (endMath && endMath.parentNode) {
        newRange.setEndAfter(endMath);
      }
    } catch (e) {
      // Continue with query-based expansion below.
    }

    const common = range.commonAncestorContainer;
    if (!common) return newRange;
    const root = common.nodeType === 1 ? common : (common.parentElement || common.parentNode);
    if (!root || typeof root.querySelectorAll !== "function") return newRange;

    let mathElements = [];
    try {
      const scanRoot = root.closest && root.closest("p, li, div, section, article, body")
        ? root.closest("p, li, div, section, article, body")
        : root;
      mathElements = Array.from(scanRoot.querySelectorAll(MATH_SELECTOR));
      if (typeof scanRoot.matches === "function" && scanRoot.matches(MATH_SELECTOR)) {
        mathElements.push(scanRoot);
      }
      if (mathElements.length === 0 && selectedRect && document.querySelectorAll) {
        mathElements = Array.from(document.querySelectorAll(MATH_SELECTOR)).filter((mathEl) => {
          try {
            return rectsOverlap(selectedRect, mathEl.getBoundingClientRect());
          } catch (e) {
            return false;
          }
        });
      }
    } catch (e) {
      return newRange;
    }

    for (const mathEl of mathElements) {
      try {
        const intersectsDom = newRange.intersectsNode(mathEl);
        const intersectsRect = selectedRect && rectsOverlap(selectedRect, mathEl.getBoundingClientRect());
        if (intersectsDom || intersectsRect) {
          if (mathEl.contains(newRange.startContainer)) {
            newRange.setStartBefore(mathEl);
          }
          if (mathEl.contains(newRange.endContainer)) {
            newRange.setEndAfter(mathEl);
          }
          if (
            intersectsRect &&
            !intersectsDom &&
            !rangeBoundaryIsInsideElement(newRange, mathEl) &&
            rangeLooksLikeMathOnly(range, mathEl)
          ) {
            newRange.setStartBefore(mathEl);
            newRange.setEndAfter(mathEl);
          }
        }
      } catch (e) {
        // Ignore errors on specific nodes
      }
    }
    return newRange;
  }

  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection) return "";
    const plainText = selection.toString().trim();
    const semanticParts = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      const expandedRange = expandRangeToContainMath(range);
      semanticParts.push(serializeSelectionNode(expandedRange.cloneContents()));
    }
    const semanticText = normalizeSelectionOutput(semanticParts.join("\n"));
    return semanticText || plainText;
  }

  function trimContextAroundSelection(contextText, selectedText, maxChars = 6000) {
    const context = KokoroTTSCore.normalizeLlmSourceText(contextText);
    const selected = KokoroTTSCore.normalizeLlmSourceText(selectedText);
    if (!context || !selected || context === selected) return "";

    const index = context.indexOf(selected);
    if (index < 0) {
      return context.length <= maxChars ? context : context.slice(0, maxChars).trim();
    }

    const before = Math.floor((maxChars - selected.length) / 2);
    const start = Math.max(0, index - Math.max(before, 400));
    const end = Math.min(context.length, index + selected.length + Math.max(before, 400));
    return context.slice(start, end).trim();
  }

  function getSelectionContext(selectedText) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return "";

    const range = expandRangeToContainMath(selection.getRangeAt(0));
    const common = range.commonAncestorContainer;
    const element = common && common.nodeType === 1
      ? common
      : common && (common.parentElement || common.parentNode);
    if (!element || element.nodeType !== 1) return "";

    const broadRoot = element.closest &&
      element.closest("article, main, section, [role='main']");
    const localRoot = element.closest &&
      element.closest("p, li, blockquote, figcaption, div");
    const root = broadRoot || (localRoot && localRoot.parentElement) || localRoot;
    if (!root) return "";

    return trimContextAroundSelection(
      serializeSelectionNode(root.cloneNode(true)),
      selectedText
    );
  }

  function removeButton() {
    cancelTranslationRequest();
    document.querySelectorAll(".tts-float-container").forEach((container) => {
      container.style.animation = "tts-fade-out 0.15s ease-in forwards";
      setTimeout(() => container.remove(), 150);
    });
    floatingBtn = null;
  }

  function stopAudio() {
    if (currentAudio) {
      KokoroTTSCore.releaseAudio(currentAudio);
      currentAudio = null;
    }
  }

  function cancelRequest() {
    requestGate.cancel();
    isLoading = false;
  }

  function cancelTranslationRequest() {
    translationGate.cancel();
    isTranslating = false;
  }

  function removeSpecificButton(container) {
    if (!container || !container.isConnected) return;
    container.style.animation = "tts-fade-out 0.15s ease-in forwards";
    setTimeout(() => {
      container.remove();
      if (floatingBtn === container) floatingBtn = null;
    }, 150);
  }

  function focusFloatingAction(container, activeButton) {
    if (!container || !activeButton) return;
    activeButton.classList.add("tts-active-action");
    requestAnimationFrame(() => {
      positionFloatingContainer(container, container._ttsSelectionRect);
    });
  }

  function normalizeSelectionRect(rect) {
    if (!rect) {
      return {
        left: 12,
        right: 12,
        top: 12,
        bottom: 12,
        width: 0,
        height: 0,
      };
    }
    return {
      left: Number.isFinite(rect.left) ? rect.left : 12,
      right: Number.isFinite(rect.right) ? rect.right : rect.left || 12,
      top: Number.isFinite(rect.top) ? rect.top : 12,
      bottom: Number.isFinite(rect.bottom) ? rect.bottom : rect.top || 12,
      width: Number.isFinite(rect.width) ? rect.width : Math.max(0, (rect.right || 0) - (rect.left || 0)),
      height: Number.isFinite(rect.height) ? rect.height : Math.max(0, (rect.bottom || 0) - (rect.top || 0)),
    };
  }

  function positionFloatingContainer(container, selectionRect) {
    if (!container || !container.isConnected) return;
    const rect = normalizeSelectionRect(selectionRect);
    const margin = 12;
    const gap = 8;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;

    container.style.left = "0px";
    container.style.top = "0px";
    container.classList.remove("tts-placement-above", "tts-placement-below");

    const ownRect = container.getBoundingClientRect();
    const actions = container.querySelector(".tts-float-actions");
    const card = container.querySelector(".tts-translation-card");
    const actionHeight = actions ? actions.getBoundingClientRect().height : ownRect.height || 0;
    const cardHeight = card ? card.getBoundingClientRect().height : 0;
    const width = Math.min(ownRect.width || 0, viewportWidth - margin * 2);
    const anchorCenter = rect.left + (rect.width || 0) / 2;
    const left = Math.max(
      margin,
      Math.min(viewportWidth - width - margin, anchorCenter - width / 2)
    );

    const topSpace = rect.top - margin;
    const bottomSpace = viewportHeight - rect.bottom - margin;
    const useAbove = Boolean(card) && bottomSpace < actionHeight + gap + cardHeight && topSpace > cardHeight + gap;
    const actionTop = Math.max(
      margin,
      Math.min(viewportHeight - actionHeight - margin, rect.bottom + gap)
    );
    const top = useAbove
      ? Math.max(margin, actionTop - cardHeight - gap)
      : actionTop;

    container.classList.add(useAbove ? "tts-placement-above" : "tts-placement-below");
    container.style.left = `${Math.round(left)}px`;
    container.style.top = `${Math.round(top)}px`;
  }

  function showButton(selectionRect, text, context = "") {
    removeButton();
    cancelRequest();
    cancelTranslationRequest();
    stopAudio();

    const container = document.createElement("div");
    container.className = "tts-float-container";
    container._ttsSelectionRect = normalizeSelectionRect(selectionRect);
    container._ttsSelectionContext = context || "";
    const actions = document.createElement("div");
    actions.className = "tts-float-actions";

    const btn = document.createElement("button");
    btn.className = "tts-speak-btn";
    setButtonHtml(btn, "tts-speak-btn", "\uD83D\uDD0A", "Read");

    btn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();

      if (btn.classList.contains("done")) {
        setButtonHtml(
          btn,
          "tts-speak-btn",
          "\uD83D\uDD0A",
          "Read"
        );
        return;
      }

      if (btn.classList.contains("playing")) {
        cancelRequest();
        stopAudio();
        setButtonHtml(btn, "tts-speak-btn", "\uD83D\uDD0A", "Read");
        return;
      }

      if (btn.classList.contains("loading")) {
        cancelRequest();
        setButtonHtml(btn, "tts-speak-btn", "\uD83D\uDD0A", "Read");
        return;
      }

      speak(text, btn);
    });

    const translateBtn = document.createElement("button");
    translateBtn.className = "tts-translate-btn";
    setButtonHtml(translateBtn, "tts-translate-btn", "\uD83C\uDF10", "Translate");

    translateBtn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();

      if (translateBtn.classList.contains("done")) {
        removeTranslationCard(container);
        setButtonHtml(
          translateBtn,
          "tts-translate-btn",
          "\uD83C\uDF10",
          "Translate"
        );
        return;
      }

      if (translateBtn.classList.contains("loading")) {
        cancelTranslationRequest();
        setButtonHtml(
          translateBtn,
          "tts-translate-btn",
          "\uD83C\uDF10",
          "Translate"
        );
        return;
      }

      translateSelectedText(text, translateBtn, container);
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "tts-copy-btn";
    setButtonHtml(copyBtn, "tts-copy-btn", "\u2398", "Copy");

    copyBtn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      copySelectedTextAsLatex(text, copyBtn);
    });

    actions.appendChild(btn);
    actions.appendChild(translateBtn);
    actions.appendChild(copyBtn);
    container.appendChild(actions);

    document.body.appendChild(container);
    floatingBtn = container;

    requestAnimationFrame(() => {
      positionFloatingContainer(container, container._ttsSelectionRect);
    });
  }

  function selectionRangeIsInsideIgnoredUi(range) {
    if (!range) return false;
    const node = range.commonAncestorContainer;
    const element = node && node.nodeType === 1
      ? node
      : node && (node.parentElement || node.parentNode);
    if (!element || element.nodeType !== 1 || typeof element.closest !== "function") {
      return false;
    }
    return Boolean(
      element.closest(
        "input, textarea, [contenteditable='true'], .tts-settings-panel, .tts-settings-gear, .tts-float-container"
      )
    );
  }

  function showButtonForCurrentSelection({ autoSpeak = false } = {}) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      removeButton();
      return;
    }
    const rawRange = selection.getRangeAt(0);
    if (selectionRangeIsInsideIgnoredUi(rawRange)) {
      removeButton();
      return;
    }

    const text = getSelectedText();
    if (text.length <= 1) {
      removeButton();
      return;
    }

    const range = expandRangeToContainMath(rawRange);
    const rect = range.getBoundingClientRect();
    showButton(rect, text, getSelectionContext(text));
    if (autoSpeak && floatingBtn) {
      const btn = floatingBtn.querySelector(".tts-speak-btn");
      if (btn) speak(text, btn);
    }
  }

  /**
   * Call TTS API and play audio
   */
  function getButtonBaseClass(btnElement) {
    if (!btnElement) return "tts-speak-btn";
    if (!btnElement.dataset.ttsBaseClass) {
      if (btnElement.classList.contains("tts-test-btn")) {
        btnElement.dataset.ttsBaseClass = "tts-test-btn";
      } else if (btnElement.classList.contains("tts-translate-btn")) {
        btnElement.dataset.ttsBaseClass = "tts-translate-btn";
      } else if (btnElement.classList.contains("tts-copy-btn")) {
        btnElement.dataset.ttsBaseClass = "tts-copy-btn";
      } else {
        btnElement.dataset.ttsBaseClass = "tts-speak-btn";
      }
    }
    return btnElement.dataset.ttsBaseClass;
  }

  function setButtonHtml(btnElement, className, icon, label) {
    if (!btnElement) return;
    const baseClass = getButtonBaseClass(btnElement);
    const stateClasses = className
      .split(/\s+/)
      .filter((name) =>
        name &&
        name !== "tts-speak-btn" &&
        name !== "tts-test-btn" &&
        name !== "tts-translate-btn" &&
        name !== "tts-copy-btn"
      );
    btnElement.className = [baseClass, ...stateClasses].join(" ");
    btnElement.style.removeProperty("--tts-progress");
    const iconSpan = document.createElement("span");
    iconSpan.className = "tts-icon";
    iconSpan.textContent = icon;
    const labelSpan = document.createElement("span");
    labelSpan.className = "tts-label";
    labelSpan.textContent = label;
    btnElement.replaceChildren(iconSpan, labelSpan);
  }

  function setPlaybackProgress(btnElement, audio, streamEnded) {
    if (!btnElement) return;
    const baseClass = getButtonBaseClass(btnElement);
    const progress = KokoroTTSCore.formatPlaybackProgress({
      currentTime: audio.currentTime || 0,
      duration: audio.duration,
      streamEnded,
    });
    const progressClasses = baseClass === "tts-speak-btn"
      ? ["with-progress", progress.determinate ? "determinate" : "buffering"]
      : [];
    btnElement.className = [baseClass, "playing", ...progressClasses].join(" ");
    btnElement.style.setProperty("--tts-progress", progress.percent + "%");
    const iconSpan = document.createElement("span");
    iconSpan.className = "tts-icon";
    iconSpan.textContent = "\uD83D\uDD0A";
    const labelSpan = document.createElement("span");
    labelSpan.className = "tts-label";
    labelSpan.textContent = progress.label;
    btnElement.replaceChildren(iconSpan, labelSpan);
  }

  function attachPlaybackUi(audio, btnElement, buttonContainer, isStreamEnded) {
    const updateProgress = () => {
      if (currentAudio !== audio) return;
      setPlaybackProgress(btnElement, audio, isStreamEnded());
    };

    audio.addEventListener("timeupdate", updateProgress);
    audio.addEventListener("durationchange", updateProgress);
    audio.addEventListener("loadedmetadata", updateProgress);

    audio.addEventListener("ended", () => {
      if (currentAudio !== audio) return;
      setPlaybackProgress(btnElement, audio, true);
      KokoroTTSCore.releaseAudio(audio);
      currentAudio = null;
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-speak-btn done",
          "\u2705",
          "Done"
        );
        setTimeout(() => removeSpecificButton(buttonContainer), 2000);
      }
    });

    audio.addEventListener("error", () => {
      if (currentAudio !== audio) return;
      KokoroTTSCore.releaseAudio(audio);
      currentAudio = null;
      if (audio._suppressPlaybackErrorUi) return;
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-speak-btn error",
          "\u274C",
          "Play failed"
        );
      }
    });

    return updateProgress;
  }

  async function fetchAudioBlob(text, generation, audioFormat) {
    return new Promise((resolve, reject) => {
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: `${API_URL}?format=${audioFormat.format}`,
        headers: {
          "Accept": audioFormat.accept,
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: text,
          voice: settings.voice,
          speed: settings.speed,
        }),
        responseType: "blob",
        timeout: 60000,
        onload: (response) => {
          if (!requestGate.isCurrent(generation)) return;
          if (response.status >= 200 && response.status < 300) {
            resolve(KokoroTTSCore.normalizeAudioBlob(response.response, audioFormat.mime));
          } else {
            reject(
              new Error(
                `Server returned ${response.status}: ${response.statusText}`
              )
            );
          }
        },
        onerror: () => {
          if (!requestGate.isCurrent(generation)) return;
          reject(
            new Error(
              "Cannot connect to TTS server. Run start.bat first."
            )
          );
        },
        ontimeout: () => {
          if (!requestGate.isCurrent(generation)) return;
          reject(new Error("Request timeout. Text may be too long."));
        },
        onabort: () => reject(new Error("Request cancelled.")),
      });
      requestGate.attach(generation, request);
    });
  }

  async function fetchAudioBuffer(text, generation, audioFormat) {
    return new Promise((resolve, reject) => {
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: `${API_URL}?format=${audioFormat.format}`,
        headers: {
          "Accept": audioFormat.accept,
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: text,
          voice: settings.voice,
          speed: settings.speed,
        }),
        responseType: "arraybuffer",
        timeout: 60000,
        onload: async (response) => {
          if (!requestGate.isCurrent(generation)) return;
          if (response.status >= 200 && response.status < 300) {
            try {
              resolve(await KokoroTTSCore.normalizeAudioBuffer(response.response));
            } catch (error) {
              reject(error);
            }
          } else {
            reject(
              new Error(
                `Server returned ${response.status}: ${response.statusText}`
              )
            );
          }
        },
        onerror: () => {
          if (!requestGate.isCurrent(generation)) return;
          reject(
            new Error(
              "Cannot connect to TTS server. Run start.bat first."
            )
          );
        },
        ontimeout: () => {
          if (!requestGate.isCurrent(generation)) return;
          reject(new Error("Request timeout. Text may be too long."));
        },
        onabort: () => reject(new Error("Request cancelled.")),
      });
      requestGate.attach(generation, request);
    });
  }

  async function fetchTranslation(text, context, generation) {
    return new Promise((resolve, reject) => {
      const sourceText = KokoroTTSCore.normalizeLlmSourceText(text);
      const contextText = KokoroTTSCore.normalizeLlmSourceText(context);
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_TRANSLATE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: sourceText,
          context: contextText || undefined,
          model: settings.translateModel,
          target_language: settings.targetLanguage,
        }),
        responseType: "json",
        timeout: 120000,
        onload: (response) => {
          if (!translationGate.isCurrent(generation)) return;
          if (response.status >= 200 && response.status < 300) {
            try {
              const payload = response.response || JSON.parse(response.responseText || "{}");
              resolve(payload);
            } catch (error) {
              reject(error);
            }
          } else {
            let detail = response.statusText || "Translation failed";
            try {
              const payload = JSON.parse(response.responseText || "{}");
              if (payload.detail) detail = payload.detail;
            } catch {}
            reject(new Error(`Server returned ${response.status}: ${detail}`));
          }
        },
        onerror: () => {
          if (!translationGate.isCurrent(generation)) return;
          reject(new Error("Cannot connect to local TTS server. Run start.bat first."));
        },
        ontimeout: () => {
          if (!translationGate.isCurrent(generation)) return;
          reject(new Error("Translation timeout. Try a shorter selection or a faster model."));
        },
        onabort: () => reject(new Error("Translation cancelled.")),
      });
      translationGate.attach(generation, request);
    });
  }

  async function fetchReadPreparation(text, context, generation) {
    return new Promise((resolve, reject) => {
      const sourceText = KokoroTTSCore.normalizeLlmSourceText(text);
      const contextText = KokoroTTSCore.normalizeLlmSourceText(context);
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_READ_PREPARE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: sourceText,
          context: contextText || undefined,
          model: settings.translateModel,
        }),
        responseType: "json",
        timeout: 120000,
        onload: (response) => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          if (response.status >= 200 && response.status < 300) {
            try {
              const payload = response.response || JSON.parse(response.responseText || "{}");
              resolve(payload);
            } catch (error) {
              reject(error);
            }
          } else {
            let detail = response.statusText || "Read preparation failed";
            try {
              const payload = JSON.parse(response.responseText || "{}");
              if (payload.detail) detail = payload.detail;
            } catch {}
            reject(new Error(`Server returned ${response.status}: ${detail}`));
          }
        },
        onerror: () => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          reject(new Error("Cannot connect to read preparation server."));
        },
        ontimeout: () => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          reject(new Error("Read preparation timeout."));
        },
        onabort: () => reject(new Error("Read preparation cancelled.")),
      });
      if (!requestGate.attach(generation, request)) {
        reject(new Error("Read preparation cancelled."));
      }
    });
  }

  async function fetchReadTranslationFallback(text, context, generation) {
    return new Promise((resolve, reject) => {
      const sourceText = KokoroTTSCore.normalizeLlmSourceText(text);
      const contextText = KokoroTTSCore.normalizeLlmSourceText(context);
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_TRANSLATE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: sourceText,
          context: contextText || undefined,
          model: settings.translateModel,
          target_language: "English",
        }),
        responseType: "json",
        timeout: 120000,
        onload: (response) => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          if (response.status >= 200 && response.status < 300) {
            try {
              const payload = response.response || JSON.parse(response.responseText || "{}");
              resolve(payload);
            } catch (error) {
              reject(error);
            }
          } else {
            let detail = response.statusText || "English translation failed";
            try {
              const payload = JSON.parse(response.responseText || "{}");
              if (payload.detail) detail = payload.detail;
            } catch {}
            reject(new Error(`Server returned ${response.status}: ${detail}`));
          }
        },
        onerror: () => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          reject(new Error("Cannot connect to local translation server."));
        },
        ontimeout: () => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          reject(new Error("English translation timeout."));
        },
        onabort: () => reject(new Error("English translation cancelled.")),
      });
      if (!requestGate.attach(generation, request)) {
        reject(new Error("English translation cancelled."));
      }
    });
  }

  async function fetchFormulaVerbalizations(formulas, context, generation) {
    if (!formulas || formulas.length === 0) return [];
    return new Promise((resolve, reject) => {
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_FORMULA_VERBALIZE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          formulas,
          context: String(context || "").slice(0, 4000),
          model: settings.translateModel,
        }),
        responseType: "json",
        timeout: 120000,
        onload: (response) => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          if (response.status >= 200 && response.status < 300) {
            try {
              const payload = response.response || JSON.parse(response.responseText || "{}");
              resolve(Array.isArray(payload.verbalizations) ? payload.verbalizations : []);
            } catch (error) {
              reject(error);
            }
          } else {
            let detail = response.statusText || "Formula verbalization failed";
            try {
              const payload = JSON.parse(response.responseText || "{}");
              if (payload.detail) detail = payload.detail;
            } catch {}
            reject(new Error(`Server returned ${response.status}: ${detail}`));
          }
        },
        onerror: () => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          reject(new Error("Cannot connect to formula verbalization server."));
        },
        ontimeout: () => {
          if (!requestGate.isCurrent(generation)) return;
          requestGate.finish(generation);
          reject(new Error("Formula verbalization timeout."));
        },
        onabort: () => reject(new Error("Formula verbalization cancelled.")),
      });
      if (!requestGate.attach(generation, request)) {
        reject(new Error("Formula verbalization cancelled."));
      }
    });
  }

  async function fetchFormulaVerbalizationsBackground(formulas, context, generation) {
    if (!formulas || formulas.length === 0) return [];
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: API_FORMULA_VERBALIZE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          formulas,
          context: String(context || "").slice(0, 4000),
          model: settings.translateModel,
        }),
        responseType: "json",
        timeout: 120000,
        onload: (response) => {
          if (!requestGate.isCurrent(generation)) {
            resolve([]);
            return;
          }
          if (response.status >= 200 && response.status < 300) {
            try {
              const payload = response.response || JSON.parse(response.responseText || "{}");
              resolve(Array.isArray(payload.verbalizations) ? payload.verbalizations : []);
            } catch (error) {
              reject(error);
            }
          } else {
            let detail = response.statusText || "Formula verbalization failed";
            try {
              const payload = JSON.parse(response.responseText || "{}");
              if (payload.detail) detail = payload.detail;
            } catch {}
            reject(new Error(`Server returned ${response.status}: ${detail}`));
          }
        },
        onerror: () => {
          if (!requestGate.isCurrent(generation)) {
            resolve([]);
            return;
          }
          reject(new Error("Cannot connect to formula verbalization server."));
        },
        ontimeout: () => {
          if (!requestGate.isCurrent(generation)) {
            resolve([]);
            return;
          }
          reject(new Error("Formula verbalization timeout."));
        },
        onabort: () => resolve([]),
      });
    });
  }

  async function resolveFormulaReadPlan(plan, context, generation) {
    if (!plan.formulas || plan.formulas.length === 0) {
      return plan;
    }
    const verbalizations = await fetchFormulaVerbalizations(
      plan.formulas,
      context,
      generation
    );
    const readableText = KokoroTTSCore.applyFormulaVerbalizations(
      plan.text,
      verbalizations
    );
    return {
      ...plan,
      text: readableText,
      changed: true,
      empty: readableText.length === 0,
    };
  }

  async function prepareReadableTextForSpeak(text, context, generation) {
    let readPreparationError = null;
    let englishTranslationError = null;

    try {
      const payload = await fetchReadPreparation(text, context, generation);
      if (!requestGate.isCurrent(generation)) {
        return { text: "", formulas: [], changed: false, empty: true };
      }
      const preparedText = String(payload && payload.prepared_text ? payload.prepared_text : "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (preparedText) {
        return {
          text: preparedText,
          formulas: [],
          changed: preparedText !== String(text || "").trim(),
          removedChinese: /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(text || "")) &&
            !/[\u3400-\u9FFF\uF900-\uFAFF]/.test(preparedText),
          empty: false,
          llmPrepared: true,
        };
      }
    } catch (error) {
      if (!requestGate.isCurrent(generation)) throw error;
      readPreparationError = error;
      console.warn("[Kokoro TTS] Read preparation failed; falling back to English translation", error);
    }

    try {
      const payload = await fetchReadTranslationFallback(text, context, generation);
      if (!requestGate.isCurrent(generation)) {
        return { text: "", formulas: [], changed: false, empty: true };
      }
      const translatedText = String(payload && payload.translated_text ? payload.translated_text : "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (translatedText) {
        const translatedPlan = KokoroTTSCore.prepareTextForReadPlan(translatedText);
        const spokenPlan = await resolveFormulaReadPlan(
          translatedPlan,
          translatedText,
          generation
        );
        return {
          ...spokenPlan,
          changed: translatedText !== String(text || "").trim(),
          removedChinese: /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(text || "")) &&
            !/[\u3400-\u9FFF\uF900-\uFAFF]/.test(translatedText),
          empty: spokenPlan.empty,
          translatedForRead: true,
        };
      }
    } catch (error) {
      if (!requestGate.isCurrent(generation)) throw error;
      englishTranslationError = error;
      console.warn("[Kokoro TTS] English translation fallback failed; falling back to local cleanup", error);
    }

    const plan = KokoroTTSCore.prepareTextForReadPlan(text);
    if (plan.formulas.length === 0) {
      if (plan.empty && (readPreparationError || englishTranslationError)) {
        throw new Error("Cannot prepare English text. Restart local server and check Ollama.");
      }
      return plan;
    }
    return resolveFormulaReadPlan(plan, text, generation);
  }

  function removeTranslationCard(container) {
    if (!container) return;
    const card = container.querySelector(".tts-translation-card");
    if (card) card.remove();
  }

  function copyTextToClipboard(text) {
    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, "text");
      return Promise.resolve();
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.setAttribute("readonly", "");
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
      return Promise.resolve();
    } finally {
      area.remove();
    }
  }

  async function copySelectedTextAsLatex(text, btnElement) {
    const copyText = KokoroTTSCore.normalizeCopyTextWithLatex(text);
    if (!copyText) {
      if (btnElement) {
        setButtonHtml(btnElement, "tts-copy-btn error", "\u274C", "Empty");
        setTimeout(() => {
          setButtonHtml(btnElement, "tts-copy-btn", "\u2398", "Copy");
        }, 1200);
      }
      return;
    }

    if (btnElement) {
      setButtonHtml(btnElement, "tts-copy-btn loading", "\u23F3", "Copying");
    }
    try {
      await copyTextToClipboard(copyText);
      if (btnElement) {
        setButtonHtml(btnElement, "tts-copy-btn done", "\u2705", "Copied");
        setTimeout(() => {
          setButtonHtml(btnElement, "tts-copy-btn", "\u2398", "Copy");
        }, 1200);
      }
    } catch (error) {
      console.warn("[Kokoro TTS] Copy failed", error);
      if (btnElement) {
        setButtonHtml(btnElement, "tts-copy-btn error", "\u274C", "Failed");
        setTimeout(() => {
          setButtonHtml(btnElement, "tts-copy-btn", "\u2398", "Copy");
        }, 1500);
      }
    }
  }

  function readScriptGroup(value, start) {
    if (value[start] === "{") {
      let depth = 0;
      for (let i = start; i < value.length; i += 1) {
        const char = value[i];
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            return {
              text: value.slice(start + 1, i),
              next: i + 1,
            };
          }
        }
      }
    }
    return {
      text: value[start] || "",
      next: Math.min(value.length, start + 1),
    };
  }

  function appendReadableFormulaContent(container, formulaText) {
    const readable = KokoroTTSCore.latexToReadableFormula(formulaText);
    let buffer = "";
    function flush() {
      if (!buffer) return;
      container.appendChild(document.createTextNode(buffer));
      buffer = "";
    }

    for (let i = 0; i < readable.length; i += 1) {
      const char = readable[i];
      if ((char === "_" || char === "^") && i + 1 < readable.length) {
        const group = readScriptGroup(readable, i + 1);
        if (group.text) {
          flush();
          const node = document.createElement(char === "_" ? "sub" : "sup");
          node.textContent = group.text;
          container.appendChild(node);
          i = group.next - 1;
          continue;
        }
      }
      buffer += char;
    }
    flush();
  }

  function appendTranslationTextWithFormulas(container, text) {
    container.textContent = "";
    const segments = KokoroTTSCore.splitLatexSegments(text);
    segments.forEach((segment) => {
      if (segment.type !== "latex") {
        container.appendChild(document.createTextNode(segment.value));
        return;
      }
      const formula = document.createElement("span");
      formula.className = segment.block
        ? "tts-formula-rendered tts-formula-block"
        : "tts-formula-rendered";
      appendReadableFormulaContent(formula, segment.value);
      container.appendChild(formula);
    });
  }

  function showTranslationCard(container, payload) {
    if (!container) return;
    removeTranslationCard(container);

    const card = document.createElement("div");
    card.className = "tts-translation-card";

    const meta = document.createElement("div");
    meta.className = "tts-translation-meta";
    const metaText = document.createElement("span");
    metaText.textContent = `${payload.model || settings.translateModel} -> ${payload.target_language || settings.targetLanguage}`;
    const copyBtn = document.createElement("button");
    copyBtn.className = "tts-copy-translation-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    meta.appendChild(metaText);
    meta.appendChild(copyBtn);

    const body = document.createElement("div");
    body.className = "tts-translation-text";
    appendTranslationTextWithFormulas(body, payload.translated_text || "");

    copyBtn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      copyTextToClipboard(body.textContent).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
      }).catch(() => {
        copyBtn.textContent = "Failed";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
      });
    });

    card.appendChild(meta);
    card.appendChild(body);
    container.appendChild(card);
    requestAnimationFrame(() => {
      positionFloatingContainer(container, container._ttsSelectionRect);
    });
  }

  async function translateSelectedText(text, btnElement, buttonContainer) {
    isTranslating = true;
    const generation = translationGate.begin();
    const context = buttonContainer && buttonContainer._ttsSelectionContext
      ? buttonContainer._ttsSelectionContext
      : "";
    removeTranslationCard(buttonContainer);
    focusFloatingAction(buttonContainer, btnElement);

    if (btnElement) {
      setButtonHtml(
        btnElement,
        "tts-translate-btn loading",
        "\u23F9",
        "Cancel"
      );
    }

    try {
      const payload = await fetchTranslation(text, context, generation);
      if (!translationGate.isCurrent(generation)) return;
      showTranslationCard(buttonContainer, payload);
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-translate-btn done",
          "\u2705",
          "Done"
        );
      }
    } catch (err) {
      if (!translationGate.isCurrent(generation)) return;
      console.error("[Kokoro TTS translation]", err);
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-translate-btn error",
          "\u274C",
          err.message.substring(0, 30)
        );
      }
    } finally {
      if (translationGate.isCurrent(generation)) {
        translationGate.finish(generation);
        isTranslating = false;
      }
    }
  }

  async function playBlobAudioFormat(
    text,
    generation,
    btnElement,
    buttonContainer,
    audioFormat
  ) {
    const audioBlob = await fetchAudioBlob(text, generation, audioFormat);
    if (!requestGate.isCurrent(generation)) return;

    const blobUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(blobUrl);
    audio._blobUrl = blobUrl;
    audio._suppressPlaybackErrorUi = true;
    currentAudio = audio;

    const updateProgress = attachPlaybackUi(
      audio,
      btnElement,
      buttonContainer,
      () => true
    );
    updateProgress();

    await audio.play();
    audio._suppressPlaybackErrorUi = false;
  }

  async function playBlobAudio(text, generation, btnElement, buttonContainer) {
    const preferredFormat = KokoroTTSCore.selectBlobAudioFormat(new Audio());
    try {
      await playBlobAudioFormat(
        text,
        generation,
        btnElement,
        buttonContainer,
        preferredFormat
      );
    } catch (error) {
      if (
        preferredFormat.format !== "ogg" ||
        !KokoroTTSCore.isUnsupportedMediaError(error) ||
        !requestGate.isCurrent(generation)
      ) {
        throw error;
      }
      console.warn("[Kokoro TTS] OGG playback failed; falling back to WAV", error);
      stopAudio();
      await playBlobAudioFormat(
        text,
        generation,
        btnElement,
        buttonContainer,
        { format: "wav", accept: "audio/wav", mime: "audio/wav" }
      );
    }
  }

  async function playDecodedWavAudio(text, generation, btnElement, buttonContainer) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      await playBlobAudioFormat(
        text,
        generation,
        btnElement,
        buttonContainer,
        { format: "wav", accept: "audio/wav", mime: "audio/wav" }
      );
      return;
    }

    const payload = await fetchAudioBuffer(
      text,
      generation,
      { format: "wav", accept: "audio/wav", mime: "audio/wav" }
    );
    if (!requestGate.isCurrent(generation)) return;

    const audioContext = new AudioContextClass();
    if (audioContext.state === "suspended" && audioContext.resume) {
      await audioContext.resume();
    }

    const audioBuffer = await audioContext.decodeAudioData(payload.slice(0));
    if (!requestGate.isCurrent(generation)) {
      if (audioContext.close) audioContext.close().catch(() => {});
      return;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);

    const startedAt = audioContext.currentTime;
    let stopped = false;
    let progressTimer = null;
    const playbackHandle = {
      src: "",
      _blobUrl: null,
      duration: audioBuffer.duration,
      get currentTime() {
        return Math.min(
          this.duration,
          Math.max(0, audioContext.currentTime - startedAt)
        );
      },
      pause() {
        if (stopped) return;
        stopped = true;
        if (progressTimer) clearInterval(progressTimer);
        try { source.stop(0); } catch {}
        if (audioContext.close) audioContext.close().catch(() => {});
      },
      _cleanup() {
        this.pause();
      },
    };

    currentAudio = playbackHandle;
    const updateProgress = () => {
      if (currentAudio !== playbackHandle) return;
      setPlaybackProgress(btnElement, playbackHandle, true);
    };

    source.onended = () => {
      if (stopped || currentAudio !== playbackHandle) return;
      stopped = true;
      if (progressTimer) clearInterval(progressTimer);
      updateProgress();
      currentAudio = null;
      if (audioContext.close) audioContext.close().catch(() => {});
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-speak-btn done",
          "\u2705",
          "Done"
        );
        setTimeout(() => removeSpecificButton(buttonContainer), 2000);
      }
    };

    updateProgress();
    progressTimer = setInterval(updateProgress, 250);
    source.start(0);
  }

  function markReadDone(btnElement, buttonContainer) {
    if (btnElement) {
      setButtonHtml(
        btnElement,
        "tts-speak-btn done",
        "\u2705",
        "Done"
      );
      setTimeout(() => removeSpecificButton(buttonContainer), 2000);
    }
  }

  function fallbackFormulaSpeech(formula) {
    const spoken = KokoroTTSCore.verbalizeSimpleFormula(formula);
    return spoken && spoken !== "formula omitted"
      ? spoken.replace(/^formula:\s*/i, "").trim()
      : "formula omitted";
  }

  function isSmallOllamaModel(model) {
    const matches = String(model || "").toLowerCase().match(/(\d+(?:\.\d+)?)\s*b\b/g);
    if (!matches || matches.length === 0) return false;
    const last = matches[matches.length - 1].match(/(\d+(?:\.\d+)?)/);
    const size = last ? Number.parseFloat(last[1]) : Number.NaN;
    return Number.isFinite(size) && size <= 4.5;
  }

  function normalizeFormulaSpeech(value, formula) {
    let text = String(value || "").trim();
    if (!text || /\[\[|\]\]|\bMATH\b/i.test(text)) {
      text = fallbackFormulaSpeech(formula);
    }
    const cleaned = KokoroTTSCore.prepareTextForRead(text).text;
    if (cleaned && !/\[\[|\]\]|\bMATH\b/i.test(cleaned)) {
      return cleaned;
    }
    return fallbackFormulaSpeech(formula);
  }

  function shouldUseProgressiveReadPlan(sourceText, plan) {
    return Boolean(
      plan &&
      plan.formulas &&
      plan.formulas.length > 0 &&
      plan.segments &&
      plan.segments.length > 0 &&
      KokoroTTSCore.cjkRatio(sourceText) < 0.15
    );
  }

  async function playQueuedBlobSegment(text, generation, btnElement, audioFormat) {
    const audioBlob = await fetchAudioBlob(text, generation, audioFormat);
    if (!requestGate.isCurrent(generation)) return;

    const blobUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(blobUrl);
    audio._blobUrl = blobUrl;
    audio._suppressPlaybackErrorUi = true;
    currentAudio = audio;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("timeupdate", updateProgress);
        audio.removeEventListener("durationchange", updateProgress);
        audio.removeEventListener("loadedmetadata", updateProgress);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        KokoroTTSCore.releaseAudio(audio);
        if (currentAudio === audio) currentAudio = null;
        resolve();
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        KokoroTTSCore.releaseAudio(audio);
        if (currentAudio === audio) currentAudio = null;
        reject(error);
      };
      const updateProgress = () => {
        if (currentAudio !== audio) return;
        setPlaybackProgress(btnElement, audio, true);
      };
      const onEnded = () => finish();
      const onError = () => fail(new Error("Play failed"));

      audio._cleanup = () => fail(new Error("Playback cancelled."));
      audio.addEventListener("timeupdate", updateProgress);
      audio.addEventListener("durationchange", updateProgress);
      audio.addEventListener("loadedmetadata", updateProgress);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      updateProgress();
      audio.play().catch(fail);
    });
  }

  async function playQueuedDecodedSegment(text, generation, btnElement) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      await playQueuedBlobSegment(
        text,
        generation,
        btnElement,
        { format: "wav", accept: "audio/wav", mime: "audio/wav" }
      );
      return;
    }

    const payload = await fetchAudioBuffer(
      text,
      generation,
      { format: "wav", accept: "audio/wav", mime: "audio/wav" }
    );
    if (!requestGate.isCurrent(generation)) return;

    const audioContext = new AudioContextClass();
    if (audioContext.state === "suspended" && audioContext.resume) {
      await audioContext.resume();
    }
    const audioBuffer = await audioContext.decodeAudioData(payload.slice(0));
    if (!requestGate.isCurrent(generation)) {
      if (audioContext.close) audioContext.close().catch(() => {});
      return;
    }

    return new Promise((resolve, reject) => {
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      const startedAt = audioContext.currentTime;
      let settled = false;
      let progressTimer = null;
      const playbackHandle = {
        src: "",
        _blobUrl: null,
        duration: audioBuffer.duration,
        get currentTime() {
          return Math.min(
            this.duration,
            Math.max(0, audioContext.currentTime - startedAt)
          );
        },
        pause() {
          fail(new Error("Playback cancelled."));
        },
        _cleanup() {
          this.pause();
        },
      };

      function cleanup() {
        if (progressTimer) clearInterval(progressTimer);
        try { source.stop(0); } catch {}
        if (audioContext.close) audioContext.close().catch(() => {});
        if (currentAudio === playbackHandle) currentAudio = null;
      }

      function finish() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }

      currentAudio = playbackHandle;
      const updateProgress = () => {
        if (currentAudio !== playbackHandle) return;
        setPlaybackProgress(btnElement, playbackHandle, true);
      };
      source.onended = finish;
      updateProgress();
      progressTimer = setInterval(updateProgress, 250);
      source.start(0);
    });
  }

  async function playQueuedAudioSegment(text, generation, btnElement) {
    const value = String(text || "").trim();
    if (!value || !requestGate.isCurrent(generation)) return;
    await playQueuedDecodedSegment(value, generation, btnElement);
  }

  async function playProgressiveReadPlan(plan, context, generation, btnElement, buttonContainer) {
    let formulasReady = false;
    let formulaVerbalizations = [];
    const localFormulaVerbalizations = plan.formulas.map(fallbackFormulaSpeech);
    const useLocalFormulaRules = isSmallOllamaModel(settings.translateModel) &&
      localFormulaVerbalizations.every((value) => value && value !== "formula omitted");
    const formulaPromise = useLocalFormulaRules
      ? Promise.resolve(localFormulaVerbalizations).then((values) => {
          formulasReady = true;
          formulaVerbalizations = values;
          return formulaVerbalizations;
        })
      : fetchFormulaVerbalizationsBackground(
          plan.formulas,
          context,
          generation
        ).then((values) => {
          formulasReady = true;
          formulaVerbalizations = Array.isArray(values) ? values : [];
          return formulaVerbalizations;
        }).catch((error) => {
          formulasReady = true;
          formulaVerbalizations = [];
          console.warn("[Kokoro TTS] Background formula verbalization failed", error);
          return [];
        });

    for (const segment of plan.segments) {
      if (!requestGate.isCurrent(generation)) return;
      if (segment.type === "formula") {
        if (!formulasReady && btnElement) {
          setButtonHtml(
            btnElement,
            "tts-speak-btn loading",
            "\u2211",
            "Formula"
          );
        }
        const values = await formulaPromise;
        if (!requestGate.isCurrent(generation)) return;
        const formulaSpeech = normalizeFormulaSpeech(
          values[segment.index],
          segment.formula
        );
        await playQueuedAudioSegment(formulaSpeech, generation, btnElement);
        continue;
      }
      await playQueuedAudioSegment(segment.text, generation, btnElement);
    }

    if (requestGate.isCurrent(generation)) {
      markReadDone(btnElement, buttonContainer);
    }
  }

  function waitForSourceOpen(mediaSource) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        mediaSource.removeEventListener("sourceopen", onOpen);
        mediaSource.removeEventListener("sourceclose", onClose);
      }
      function onOpen() {
        cleanup();
        resolve();
      }
      function onClose() {
        cleanup();
        reject(new Error("MediaSource closed before opening."));
      }
      mediaSource.addEventListener("sourceopen", onOpen);
      mediaSource.addEventListener("sourceclose", onClose);
    });
  }

  async function playStreamingAudio(text, generation, btnElement, buttonContainer) {
    const mediaSource = new MediaSource();
    const controller = new AbortController();
    let reader = null;
    let appendQueue = null;
    let streamEnded = false;
    let playPromise = null;

    if (!requestGate.attach(generation, {
      abort() {
        controller.abort();
      },
    })) {
      return;
    }

    const sourceOpenPromise = waitForSourceOpen(mediaSource);
    const blobUrl = URL.createObjectURL(mediaSource);
    const audio = new Audio(blobUrl);
    audio._blobUrl = blobUrl;
    audio._suppressPlaybackErrorUi = true;
    audio._cleanup = () => {
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
      if (appendQueue) appendQueue.close();
    };
    currentAudio = audio;

    const updateProgress = attachPlaybackUi(
      audio,
      btnElement,
      buttonContainer,
      () => streamEnded
    );
    updateProgress();

    await sourceOpenPromise;
    if (!requestGate.isCurrent(generation)) return;

    const sourceBuffer = mediaSource.addSourceBuffer(KokoroTTSCore.WEBM_OPUS_MIME);
    appendQueue = KokoroTTSCore.createAppendQueue(sourceBuffer, mediaSource);

    playPromise = audio.play();
    playPromise.catch(() => {});

    const response = await fetch(API_STREAM_URL, {
      method: "POST",
      headers: {
        "Accept": KokoroTTSCore.WEBM_OPUS_MIME,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text,
        voice: settings.voice,
        speed: settings.speed,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("Streaming response is not supported by this browser.");
    }

    reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        await appendQueue.append(value);
        updateProgress();
      }
    }

    streamEnded = true;
    updateProgress();
    await appendQueue.end();
    updateProgress();
    await playPromise;
    audio._suppressPlaybackErrorUi = false;
  }

  async function speak(text, btnElement) {
    stopAudio();
    isLoading = true;
    const generation = requestGate.begin();
    const buttonContainer = btnElement
      ? btnElement.closest(".tts-float-container")
      : null;
    const context = buttonContainer && buttonContainer._ttsSelectionContext
      ? buttonContainer._ttsSelectionContext
      : "";
    focusFloatingAction(buttonContainer, btnElement);

    if (btnElement) {
      setButtonHtml(
        btnElement,
        "tts-speak-btn loading",
        "\u23F9",
        "Cancel"
      );
    }

    try {
      const progressivePlan = KokoroTTSCore.prepareProgressiveReadPlan(text);
      if (shouldUseProgressiveReadPlan(text, progressivePlan)) {
        await playProgressiveReadPlan(
          progressivePlan,
          context,
          generation,
          btnElement,
          buttonContainer
        );
        return;
      }

      const readPlan = await prepareReadableTextForSpeak(text, context, generation);
      if (!requestGate.isCurrent(generation)) return;
      if (readPlan.empty) {
        throw new Error("Cannot prepare English text for reading.");
      }
      const readText = readPlan.text;
      const playbackMode = KokoroTTSCore.choosePlaybackMode(
        window.MediaSource,
        window.location.origin,
        API_ORIGIN
      );
      if (playbackMode === "stream" && typeof fetch === "function") {
        try {
          await playStreamingAudio(readText, generation, btnElement, buttonContainer);
        } catch (streamError) {
          if (!requestGate.isCurrent(generation)) return;
          console.warn("[Kokoro TTS] Streaming failed; falling back to decoded WAV", streamError);
          stopAudio();
          await playDecodedWavAudio(readText, generation, btnElement, buttonContainer);
        }
      } else {
        await playDecodedWavAudio(readText, generation, btnElement, buttonContainer);
      }
    } catch (err) {
      if (!requestGate.isCurrent(generation)) return;
      if (err && err.name === "AbortError") return;
      console.error("[Kokoro TTS]", err);
      stopAudio();
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-speak-btn error",
          "\u274C",
          err.message.substring(0, 30)
        );
        setTimeout(() => removeSpecificButton(buttonContainer), 4000);
      }
    } finally {
      if (requestGate.isCurrent(generation)) {
        requestGate.finish(generation);
        isLoading = false;
      }
    }
  }

  // ════════════════════════════════════════════════════════
  //  Event listeners
  // ════════════════════════════════════════════════════════

  // Text selection -> show button
  document.addEventListener("mouseup", (e) => {
    if (!e.isTrusted) return;
    if (
      floatingBtn &&
      (floatingBtn.contains(e.target) || e.target.closest(".tts-float-container"))
    ) {
      return;
    }
    // Ignore clicks on settings
    if (e.target.closest(".tts-settings-panel") || e.target.closest(".tts-settings-gear")) {
      return;
    }
    // 忽略输入框、文本域和富文本编辑器的选词，避免干扰用户正常输入行为
    if (e.target.closest("input, textarea, [contenteditable='true']")) {
      removeButton();
      return;
    }

    setTimeout(() => {
      showButtonForCurrentSelection();
    }, 10);
  });

  let selectionChangeTimer = null;
  document.addEventListener("selectionchange", () => {
    if (selectionChangeTimer) clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(() => {
      if (currentAudio || isLoading || isTranslating) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !String(selection.toString() || "").trim()) {
        if (floatingBtn) removeButton();
        return;
      }
      showButtonForCurrentSelection();
    }, 120);
  });

  // Click elsewhere -> remove button
  document.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return;
    if (
      floatingBtn &&
      !floatingBtn.contains(e.target) &&
      !e.target.closest(".tts-float-container")
    ) {
      removeButton();
    }
    // Click outside settings panel -> close it
    if (
      settingsVisible &&
      settingsPanel &&
      !settingsPanel.contains(e.target) &&
      !gearBtn.contains(e.target)
    ) {
      toggleSettings();
    }
  });

  // Keyboard shortcut Ctrl+Shift+S
  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (
      e.ctrlKey === SHORTCUT.ctrl &&
      e.shiftKey === SHORTCUT.shift &&
      e.key.toUpperCase() === SHORTCUT.key
    ) {
      e.preventDefault();
      showButtonForCurrentSelection({ autoSpeak: true });
    }
  });

  // Scroll -> remove button
  let scrollTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (floatingBtn && !currentAudio && !isTranslating) {
          removeButton();
        }
      }, 200);
    },
    { passive: true }
  );

  window.addEventListener("beforeunload", () => {
    cancelRequest();
    cancelTranslationRequest();
    stopAudio();
  });

  console.log(
    "%c[Local Read & Translate] Script loaded. Select text to read, translate, or copy as LaTeX; press Ctrl+Shift+S to read.",
    "color: #667eea; font-weight: bold;"
  );
})();
}
