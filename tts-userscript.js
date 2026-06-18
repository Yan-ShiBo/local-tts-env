// ==UserScript==
// @name         本地划词听译助手
// @name:zh-CN   本地划词听译助手
// @name:en      Local Selection Read & Translate
// @namespace    https://github.com/Yan-ShiBo/local-tts-env
// @version      1.10.1
// @description  选中文本即可本地朗读或翻译：Kokoro TTS 负责语音朗读，Ollama 模型负责本地翻译，文本不上传云端。
// @description:en Select text on any page to read aloud locally with Kokoro TTS or translate locally through Ollama.
// @author       Yan-ShiBo
// @license      MIT
// @match        *://*/*
// @homepageURL  https://github.com/Yan-ShiBo/local-tts-env
// @supportURL   https://github.com/Yan-ShiBo/local-tts-env/issues
// @downloadURL  https://raw.githubusercontent.com/Yan-ShiBo/local-tts-env/main/tts-userscript.js
// @updateURL    https://raw.githubusercontent.com/Yan-ShiBo/local-tts-env/main/tts-userscript.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
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
      .replace(/\^2\b/g, " squared")
      .replace(/\^3\b/g, " cubed")
      .replace(/\^\{([^{}]+)\}/g, " to the power of $1")
      .replace(/_(\w+)\b/g, " sub $1")
      .replace(/_\{([^{}]+)\}/g, " sub $1")
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

  function replaceFormulaDelimiters(text, formulas = null) {
    const replaceFormula = (_, body) => {
      const spoken = verbalizeSimpleFormula(body);
      return ` ${spoken === "formula omitted" ? formulaFallback(formulas, body) : spoken} `;
    };
    return String(text || "")
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

  function stripUnreadableReadText(text, formulas = null) {
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

    value = replaceFormulaDelimiters(value, formulas);

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
        line = spoken === "formula omitted" ? formulaFallback(formulas, line) : spoken;
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
    createAppendQueue,
    createRequestGate,
    formatPlaybackProgress,
    isUnsupportedMediaError,
    normalizeAudioBuffer,
    normalizeAudioBlob,
    normalizeLlmSourceText,
    prepareTextForRead,
    prepareTextForReadPlan,
    releaseAudio,
    selectBlobAudioFormat,
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

  // ════════════════════════════════════════════════════════
  //  Configuration
  // ════════════════════════════════════════════════════════

  const API_BASE = "http://127.0.0.1:5000";
  const API_ORIGIN = new URL(API_BASE).origin;
  const API_URL = API_BASE + "/tts";
  const API_STREAM_URL = API_BASE + "/tts/stream";
  const API_TRANSLATE_URL = API_BASE + "/translate";
  const API_TRANSLATE_HEALTH_URL = API_BASE + "/translate/health";
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ════════════════════════════════════════════════════════
  //  Styles
  // ════════════════════════════════════════════════════════

  GM_addStyle(`
    /* -- Floating button container -- */
    .tts-float-container {
      position: absolute;
      z-index: 2147483647;
      pointer-events: auto;
      animation: tts-fade-in 0.2s ease-out;
    }

    .tts-float-actions {
      display: flex;
      align-items: center;
      gap: 8px;
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
    .tts-translate-btn {
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
    .tts-translate-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.55),
                  0 2px 6px rgba(0, 0, 0, 0.2);
    }

    .tts-speak-btn:active,
    .tts-translate-btn:active {
      transform: translateY(0);
    }

    /* -- Loading state -- */
    .tts-speak-btn.loading,
    .tts-translate-btn.loading {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      cursor: pointer;
    }

    .tts-speak-btn.loading .tts-icon,
    .tts-translate-btn.loading .tts-icon {
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
    .tts-translate-btn.error {
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

    // Build voice options HTML
    let voiceOptions = "";
    for (const group of VOICES) {
      voiceOptions += `<optgroup label="${group.group}">`;
      for (const v of group.voices) {
        const sel = v.id === settings.voice ? " selected" : "";
        voiceOptions += `<option value="${v.id}"${sel}>${v.label}</option>`;
      }
      voiceOptions += `</optgroup>`;
    }

    // Build speed options HTML
    let speedOptions = "";
    for (const s of SPEEDS) {
      const sel = s.value === settings.speed ? " selected" : "";
      speedOptions += `<option value="${s.value}"${sel}>${s.label}</option>`;
    }

    let translateModelOptions = "";
    const hasSavedTranslateModel = TRANSLATION_MODELS.some(
      (model) => model.value === settings.translateModel
    );
    for (const model of TRANSLATION_MODELS) {
      const sel = model.value === settings.translateModel ? " selected" : "";
      translateModelOptions +=
        `<option value="${escapeHtml(model.value)}"${sel}>${escapeHtml(model.label)}</option>`;
    }
    if (!hasSavedTranslateModel) {
      translateModelOptions +=
        `<option value="${escapeHtml(settings.translateModel)}" selected>Custom: ${escapeHtml(settings.translateModel)}</option>`;
    }

    panel.innerHTML = `
      <h3>Local Read & Translate</h3>
      <div class="tts-settings-grid">
        <div class="tts-settings-column">
          <h4>TTS</h4>
          <div class="tts-settings-status">
            <span class="tts-status-dot checking" id="tts-status-dot"></span>
            <span id="tts-status-text">Checking...</span>
          </div>
          <label>Voice</label>
          <select id="tts-voice-select">${voiceOptions}</select>
          <label>Speed</label>
          <select id="tts-speed-select">${speedOptions}</select>
          <button class="tts-test-btn" id="tts-test-btn">Test: "Hello, nice to meet you!"</button>
        </div>
        <div class="tts-settings-column">
          <h4>Translation</h4>
          <div class="tts-settings-status">
            <span class="tts-status-dot checking" id="tts-translate-status-dot"></span>
            <span id="tts-translate-status-text">Checking model...</span>
          </div>
          <label>Translate model</label>
          <select id="tts-translate-model-select">${translateModelOptions}</select>
          <label>Custom model</label>
          <input type="text" id="tts-translate-model-input" value="${escapeHtml(settings.translateModel)}" spellcheck="false">
          <label>Target language</label>
          <input type="text" id="tts-target-language-input" value="${escapeHtml(settings.targetLanguage)}" spellcheck="false">
          <button class="tts-test-btn" id="tts-translate-test-btn">Test translation</button>
          <div class="tts-test-output" id="tts-translate-test-output">No translation test yet.</div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    settingsPanel = panel;

    // Event listeners
    panel.querySelector("#tts-voice-select").addEventListener("change", (e) => {
      settings.voice = e.target.value;
      saveSettings(settings);
    });

    panel.querySelector("#tts-speed-select").addEventListener("change", (e) => {
      settings.speed = parseFloat(e.target.value);
      saveSettings(settings);
    });

    panel.querySelector("#tts-translate-model-select").addEventListener("change", (e) => {
      settings.translateModel = e.target.value.trim() || DEFAULTS.translateModel;
      const input = panel.querySelector("#tts-translate-model-input");
      if (input) input.value = settings.translateModel;
      saveSettings(settings);
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
      saveSettings(settings);
      checkTranslationStatus();
    });

    panel.querySelector("#tts-target-language-input").addEventListener("change", (e) => {
      settings.targetLanguage = e.target.value.trim() || DEFAULTS.targetLanguage;
      e.target.value = settings.targetLanguage;
      saveSettings(settings);
    });

    panel.querySelector("#tts-test-btn").addEventListener("click", (e) => {
      const testText = "Hello, nice to meet you! This is a test of the Kokoro text to speech system.";
      speak(testText, e.currentTarget);
    });

    panel.querySelector("#tts-translate-test-btn").addEventListener("click", (e) => {
      testTranslation(e.currentTarget);
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

  function syncInstalledTranslationModels(models) {
    const select = document.getElementById("tts-translate-model-select");
    if (!select || !Array.isArray(models)) return;
    for (const model of models) {
      if (typeof model !== "string" || !model.trim()) continue;
      if (Array.from(select.options).some((option) => option.value === model)) {
        continue;
      }
      select.appendChild(new Option(`Installed: ${model}`, model));
    }
    select.value = settings.translateModel;
  }

  function checkTranslationStatus() {
    const dot = document.getElementById("tts-translate-status-dot");
    const text = document.getElementById("tts-translate-status-text");
    if (!dot || !text) return;

    dot.className = "tts-status-dot checking";
    text.textContent = "Checking model...";
    text.style.color = "#f0c040";

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
          dot.className = "tts-status-dot offline";
          text.textContent = "Ollama offline";
          text.style.color = "#e57373";
        } else if (payload.model_running) {
          syncInstalledTranslationModels(payload.available_models);
          dot.className = "tts-status-dot online";
          text.textContent = `${payload.model} running`;
          text.style.color = "#81c784";
        } else if (payload.model_available) {
          syncInstalledTranslationModels(payload.available_models);
          dot.className = "tts-status-dot warning";
          text.textContent = `${payload.model} installed, not loaded`;
          text.style.color = "#f0c040";
        } else {
          syncInstalledTranslationModels(payload.available_models);
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
  gearBtn.innerHTML = "\u2699\uFE0F";
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
      .replace(/\s*(->|→|\\to|\\mapsto)\s*/g, " \\to ")
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
    return ["data-latex", "data-tex", "data-math", "data-mathml"].some((name) =>
      element.hasAttribute && element.hasAttribute(name)
    );
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
    const common = range.commonAncestorContainer;
    if (!common) return range;
    const root = common.nodeType === 1 ? common : (common.parentElement || common.parentNode);
    if (!root || typeof root.querySelectorAll !== "function") return range;

    const mathSelector = 'math, mjx-container, script[type^="math/tex"], .MathJax, [data-latex], [data-tex], [data-math], [data-mathml]';
    let mathElements = [];
    try {
      mathElements = Array.from(root.querySelectorAll(mathSelector));
      if (typeof root.matches === "function" && root.matches(mathSelector)) {
        mathElements.push(root);
      }
    } catch (e) {
      return range;
    }

    const newRange = range.cloneRange();
    for (const mathEl of mathElements) {
      try {
        if (newRange.intersectsNode(mathEl)) {
          if (mathEl.contains(newRange.startContainer)) {
            newRange.setStartBefore(mathEl);
          }
          if (mathEl.contains(newRange.endContainer)) {
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

  function removeButton() {
    cancelTranslationRequest();
    if (floatingBtn) {
      floatingBtn.style.animation = "tts-fade-out 0.15s ease-in forwards";
      const btn = floatingBtn;
      setTimeout(() => btn.remove(), 150);
      floatingBtn = null;
    }
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

  function showButton(x, y, text) {
    removeButton();
    cancelRequest();
    cancelTranslationRequest();
    stopAudio();

    const container = document.createElement("div");
    container.className = "tts-float-container";
    const actions = document.createElement("div");
    actions.className = "tts-float-actions";

    const btn = document.createElement("button");
    btn.className = "tts-speak-btn";
    btn.innerHTML = '<span class="tts-icon">\uD83D\uDD0A</span><span class="tts-label">Read</span>';

    btn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();

      if (btn.classList.contains("playing")) {
        cancelRequest();
        stopAudio();
        btn.className = "tts-speak-btn";
        btn.innerHTML =
          '<span class="tts-icon">\uD83D\uDD0A</span><span class="tts-label">Read</span>';
        return;
      }

      if (btn.classList.contains("loading")) {
        cancelRequest();
        btn.className = "tts-speak-btn";
        btn.innerHTML =
          '<span class="tts-icon">\uD83D\uDD0A</span><span class="tts-label">Read</span>';
        return;
      }

      speak(text, btn);
    });

    const translateBtn = document.createElement("button");
    translateBtn.className = "tts-translate-btn";
    translateBtn.innerHTML = '<span class="tts-icon">\uD83C\uDF10</span><span class="tts-label">Translate</span>';

    translateBtn.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();

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

    actions.appendChild(btn);
    actions.appendChild(translateBtn);
    container.appendChild(actions);

    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;

    container.style.left = x + scrollX + "px";
    container.style.top = y + scrollY + 10 + "px";

    document.body.appendChild(container);
    floatingBtn = container;

    requestAnimationFrame(() => {
      const rect = container.getBoundingClientRect();
      if (rect.right > window.innerWidth - 10) {
        container.style.left =
          window.innerWidth - rect.width - 10 + scrollX + "px";
      }
    });
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
        name !== "tts-translate-btn"
      );
    btnElement.className = [baseClass, ...stateClasses].join(" ");
    btnElement.style.removeProperty("--tts-progress");
    btnElement.innerHTML =
      `<span class="tts-icon">${icon}</span><span class="tts-label">${label}</span>`;
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
    btnElement.innerHTML =
      `<span class="tts-icon">\uD83D\uDD0A</span><span class="tts-label">${progress.label}</span>`;
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
          "tts-speak-btn",
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

  async function fetchTranslation(text, generation) {
    return new Promise((resolve, reject) => {
      const sourceText = KokoroTTSCore.normalizeLlmSourceText(text);
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_TRANSLATE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: sourceText,
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

  async function fetchReadPreparation(text, generation) {
    return new Promise((resolve, reject) => {
      const sourceText = KokoroTTSCore.normalizeLlmSourceText(text);
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_READ_PREPARE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: sourceText,
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

  async function fetchReadTranslationFallback(text, generation) {
    return new Promise((resolve, reject) => {
      const sourceText = KokoroTTSCore.normalizeLlmSourceText(text);
      const request = GM_xmlhttpRequest({
        method: "POST",
        url: API_TRANSLATE_URL,
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text: sourceText,
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

  async function prepareReadableTextForSpeak(text, generation) {
    let readPreparationError = null;
    let englishTranslationError = null;

    try {
      const payload = await fetchReadPreparation(text, generation);
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
      const payload = await fetchReadTranslationFallback(text, generation);
      if (!requestGate.isCurrent(generation)) {
        return { text: "", formulas: [], changed: false, empty: true };
      }
      const translatedText = String(payload && payload.translated_text ? payload.translated_text : "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (translatedText) {
        return {
          text: translatedText,
          formulas: [],
          changed: translatedText !== String(text || "").trim(),
          removedChinese: /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(text || "")) &&
            !/[\u3400-\u9FFF\uF900-\uFAFF]/.test(translatedText),
          empty: false,
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
    const verbalizations = await fetchFormulaVerbalizations(
      plan.formulas,
      text,
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

  function removeTranslationCard(container) {
    if (!container) return;
    const card = container.querySelector(".tts-translation-card");
    if (card) card.remove();
  }

  function copyTextToClipboard(text) {
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
    body.textContent = payload.translated_text || "";

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
  }

  async function translateSelectedText(text, btnElement, buttonContainer) {
    isTranslating = true;
    const generation = translationGate.begin();
    removeTranslationCard(buttonContainer);

    if (btnElement) {
      setButtonHtml(
        btnElement,
        "tts-translate-btn loading",
        "\u23F9",
        "Cancel"
      );
    }

    try {
      const payload = await fetchTranslation(text, generation);
      if (!translationGate.isCurrent(generation)) return;
      showTranslationCard(buttonContainer, payload);
      if (btnElement) {
        setButtonHtml(
          btnElement,
          "tts-translate-btn",
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
          "tts-speak-btn",
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

    if (btnElement) {
      setButtonHtml(
        btnElement,
        "tts-speak-btn loading",
        "\u23F9",
        "Cancel"
      );
    }

    try {
      const readPlan = await prepareReadableTextForSpeak(text, generation);
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
      const text = getSelectedText();

      if (text.length > 1) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          showButton(rect.left, rect.bottom, text);
        }
      } else {
        removeButton();
      }
    }, 10);
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
      const text = getSelectedText();
      if (text.length > 1) {
        e.preventDefault();
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          showButton(rect.left, rect.bottom, text);
          const btn = floatingBtn.querySelector(".tts-speak-btn");
          if (btn) speak(text, btn);
        }
      }
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
    "%c[Local Read & Translate] Script loaded. Select text to read or translate, or press Ctrl+Shift+S to read.",
    "color: #667eea; font-weight: bold;"
  );
})();
}
