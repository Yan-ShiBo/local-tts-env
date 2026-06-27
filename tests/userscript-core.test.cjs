const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");


test("userscript core can be imported without browser globals", () => {
  let core;
  assert.doesNotThrow(() => {
    core = require("../tts-userscript.js");
  });
  assert.equal(typeof core.createRequestGate, "function");
  assert.equal(typeof core.releaseAudio, "function");
  assert.equal(typeof core.supportsWebMOpus, "function");
  assert.equal(typeof core.formatPlaybackProgress, "function");
  assert.equal(typeof core.createAppendQueue, "function");
  assert.equal(typeof core.selectBlobAudioFormat, "function");
  assert.equal(typeof core.normalizeAudioBlob, "function");
  assert.equal(typeof core.normalizeAudioBuffer, "function");
  assert.equal(typeof core.normalizeCopyTextWithLatex, "function");
  assert.equal(typeof core.normalizeLlmSourceText, "function");
  assert.equal(typeof core.prepareTextForReadPlan, "function");
  assert.equal(typeof core.applyFormulaVerbalizations, "function");
  assert.equal(typeof core.splitLatexSegments, "function");
});

test("userscript avoids Trusted Types blocked HTML sinks", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "tts-userscript.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /\binnerHTML\b/);
  assert.doesNotMatch(source, /\binsertAdjacentHTML\b/);
  assert.doesNotMatch(source, /\bcreateContextualFragment\b/);
});


test("starting a new request aborts the previous generation", () => {
  const { createRequestGate } = require("../tts-userscript.js");
  const gate = createRequestGate();
  let firstAborts = 0;
  let secondAborts = 0;

  const first = gate.begin();
  gate.attach(first, { abort: () => { firstAborts += 1; } });
  const second = gate.begin();
  gate.attach(second, { abort: () => { secondAborts += 1; } });

  assert.equal(firstAborts, 1);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.finish(first);
  assert.equal(gate.isCurrent(second), true);

  gate.cancel();
  assert.equal(secondAborts, 1);
  assert.equal(gate.isCurrent(second), false);
});


test("request generation is invalidated before synchronous abort callbacks", () => {
  const { createRequestGate } = require("../tts-userscript.js");
  const gate = createRequestGate();
  const first = gate.begin();
  let wasCurrentDuringAbort = null;

  gate.attach(first, {
    abort: () => {
      wasCurrentDuringAbort = gate.isCurrent(first);
    },
  });

  gate.begin();

  assert.equal(wasCurrentDuringAbort, false);
});


test("audio blob URL is revoked at most once", () => {
  const { releaseAudio } = require("../tts-userscript.js");
  const revoked = [];
  const audio = {
    _blobUrl: "blob:test",
    src: "blob:test",
    pauseCalls: 0,
    pause() { this.pauseCalls += 1; },
  };
  const urlApi = { revokeObjectURL: (url) => revoked.push(url) };

  releaseAudio(audio, urlApi);
  releaseAudio(audio, urlApi);

  assert.deepEqual(revoked, ["blob:test"]);
  assert.equal(audio._blobUrl, null);
  assert.equal(audio.src, "");
});


test("audio cleanup hook is called at most once", () => {
  const { releaseAudio } = require("../tts-userscript.js");
  let cleanups = 0;
  const audio = {
    _cleanup: () => { cleanups += 1; },
    _blobUrl: null,
    src: "blob:test",
    pause() {},
  };

  releaseAudio(audio);
  releaseAudio(audio);

  assert.equal(cleanups, 1);
});


test("webm opus support uses MediaSource codec probe", () => {
  const { WEBM_OPUS_MIME, supportsWebMOpus, choosePlaybackMode } = require("../tts-userscript.js");
  const supported = {
    seen: [],
    isTypeSupported(mime) {
      this.seen.push(mime);
      return mime === WEBM_OPUS_MIME;
    },
  };
  const throwing = {
    isTypeSupported() {
      throw new Error("probe failed");
    },
  };

  assert.equal(supportsWebMOpus(supported), true);
  assert.deepEqual(supported.seen, [WEBM_OPUS_MIME]);
  assert.equal(supportsWebMOpus(throwing), false);
  assert.equal(supportsWebMOpus(null), false);
  assert.equal(
    choosePlaybackMode(supported, "http://127.0.0.1:5000", "http://127.0.0.1:5000"),
    "stream"
  );
  assert.equal(
    choosePlaybackMode(supported, "https://example.com", "http://127.0.0.1:5000"),
    "ogg"
  );
  assert.equal(choosePlaybackMode(null, "http://127.0.0.1:5000", "http://127.0.0.1:5000"), "ogg");
});


test("playback progress shows seconds while streaming and percent after duration is known", () => {
  const { formatPlaybackProgress } = require("../tts-userscript.js");

  assert.deepEqual(
    formatPlaybackProgress({ currentTime: 7.42, duration: Number.NaN, streamEnded: false }),
    { determinate: false, label: "7s", percent: 0 }
  );
  assert.deepEqual(
    formatPlaybackProgress({ currentTime: 10, duration: 40, streamEnded: true }),
    { determinate: true, label: "25%", percent: 25 }
  );
  assert.deepEqual(
    formatPlaybackProgress({ currentTime: 50, duration: 40, streamEnded: true }),
    { determinate: true, label: "100%", percent: 100 }
  );
});


test("append queue preserves source buffer order and ends after pending updates", async () => {
  const { createAppendQueue } = require("../tts-userscript.js");
  const listeners = new Map();
  const appended = [];
  const sourceBuffer = {
    updating: false,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    appendBuffer(data) {
      this.updating = true;
      appended.push(Buffer.from(data).toString("utf8"));
    },
  };
  const mediaSource = {
    readyState: "open",
    endCalls: 0,
    endOfStream() {
      this.endCalls += 1;
    },
  };

  const queue = createAppendQueue(sourceBuffer, mediaSource);
  const first = queue.append(Buffer.from("first"));
  const second = queue.append(Buffer.from("second"));
  assert.deepEqual(appended, ["first"]);

  sourceBuffer.updating = false;
  listeners.get("updateend")();
  await first;
  assert.deepEqual(appended, ["first", "second"]);

  const end = queue.end();
  assert.equal(mediaSource.endCalls, 0);
  sourceBuffer.updating = false;
  listeners.get("updateend")();
  await second;
  await end;

  assert.deepEqual(appended, ["first", "second"]);
  assert.equal(mediaSource.endCalls, 1);
});


test("blob playback prefers ogg only when the browser reports support", () => {
  const { selectBlobAudioFormat } = require("../tts-userscript.js");

  assert.deepEqual(
    selectBlobAudioFormat({ canPlayType: (mime) => mime.includes("opus") ? "probably" : "" }),
    { format: "ogg", accept: "audio/ogg", mime: "audio/ogg" }
  );
  assert.deepEqual(
    selectBlobAudioFormat({ canPlayType: () => "" }),
    { format: "wav", accept: "audio/wav", mime: "audio/wav" }
  );
  assert.deepEqual(
    selectBlobAudioFormat(null),
    { format: "wav", accept: "audio/wav", mime: "audio/wav" }
  );
});


test("audio blob normalization preserves bytes and assigns playable mime type", async () => {
  const { normalizeAudioBlob } = require("../tts-userscript.js");
  const original = new Blob([Buffer.from("OggS")], { type: "" });

  const normalized = normalizeAudioBlob(original, "audio/ogg");

  assert.equal(normalized.type, "audio/ogg");
  assert.equal(Buffer.from(await normalized.arrayBuffer()).toString("utf8"), "OggS");
});


test("audio buffer normalization accepts array buffers, typed arrays, and blobs", async () => {
  const { normalizeAudioBuffer } = require("../tts-userscript.js");
  const direct = new Uint8Array([1, 2, 3]).buffer;
  const typed = new Uint8Array([4, 5, 6]);
  const blob = new Blob([Buffer.from([7, 8, 9])]);

  assert.deepEqual([...new Uint8Array(await normalizeAudioBuffer(direct))], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await normalizeAudioBuffer(typed))], [4, 5, 6]);
  assert.deepEqual([...new Uint8Array(await normalizeAudioBuffer(blob))], [7, 8, 9]);
  await assert.rejects(() => normalizeAudioBuffer("bad"), /Unsupported audio response/);
});


test("read preparation removes Chinese, URLs, code blocks, and table fragments", () => {
  const { prepareTextForRead } = require("../tts-userscript.js");
  const prepared = prepareTextForRead(`
中文段落应该被清洗掉。
English text should remain. Visit https://example.com for details [12].
\`\`\`
const noisy = true;
\`\`\`
| a | b |
`);

  assert.equal(prepared.text, "English text should remain. Visit for details.");
  assert.equal(prepared.removedChinese, true);
  assert.equal(prepared.empty, false);
});


test("LLM source normalization collapses formula selection line breaks", () => {
  const { normalizeLlmSourceText } = require("../tts-userscript.js");
  const normalized = normalizeLlmSourceText(`
前两阶段是:

B
0
(x)
->
D
w
=
{(x
i
,
B
0
(x
i
),
w
i
)}
`);

  assert.equal(
    normalized,
    "前两阶段是:\n\nB 0 (x) -> D w = {(x i , B 0 (x i ), w i )}"
  );
});


test("translation display renders LaTeX formulas as readable math", () => {
  const { formulaToReadableHtml, latexToReadableFormula, normalizeDisplayMathWrappers, splitLatexSegments } = require("../tts-userscript.js");
  const segments = splitLatexSegments("使用 $D_w \\to \\hat{B}(x)$，并保持 $$x^2+y^2=z^2$$。");

  assert.deepEqual(
    segments.map((segment) => [segment.type, segment.block]),
    [
      ["text", false],
      ["latex", false],
      ["text", false],
      ["latex", true],
      ["text", false],
    ]
  );
  assert.equal(segments[1].value, "$D_w \\to \\hat{B}(x)$");
  assert.equal(segments[3].value, "$$x^2+y^2=z^2$$");
  assert.equal(latexToReadableFormula("$B_\\theta(x)$"), "B_θ(x)");
  assert.equal(formulaToReadableHtml("$B_\\theta(x)$"), "B<sub>θ</sub>(x)");
  assert.equal(
    formulaToReadableHtml("$D_w \\to \\hat{B}(x)$"),
    "D<sub>w</sub> → B̂(x)"
  );
  assert.equal(
    normalizeDisplayMathWrappers("记为 [[MATH: D_I]] 和 [[MATH: D_U]]。"),
    "记为 $D_I$ 和 $D_U$。"
  );
  assert.equal(
    splitLatexSegments("记为 [[MATH: D_I]]。")[1].value,
    "$D_I$"
  );
});

test("copy text keeps prose and converts math wrappers to LaTeX", () => {
  const { normalizeCopyTextWithLatex } = require("../tts-userscript.js");
  const copied = normalizeCopyTextWithLatex(`
The resulting sampled sets are denoted by [[MATH: D_I]], [[MATH: D_U]], and [[MATH: D_D]], respectively.
其中 [[MATH: D_w \\to \\hat{B}(x)]] 表示数据构造。
`);

  assert.equal(
    copied,
    "The resulting sampled sets are denoted by $D_I$, $D_U$, and $D_D$, respectively. 其中 $D_w \\to \\hat{B}(x)$ 表示数据构造。"
  );
  assert.doesNotMatch(copied, /\[\[MATH:/);
});


test("simple formulas are verbalized by rule before TTS", () => {
  const { prepareTextForRead } = require("../tts-userscript.js");
  const prepared = prepareTextForRead("The loss is $x^2 + y^2 = z^2$.");

  assert.match(prepared.text, /formula: x squared plus y squared equals z squared/i);
});

test("formula read rules use conservative common readings", () => {
  const { verbalizeSimpleFormula } = require("../tts-userscript.js");

  assert.equal(verbalizeSimpleFormula("D_I"), "formula: D sub I");
  assert.equal(verbalizeSimpleFormula("B_\\theta(x)"), "formula: B sub theta of x");
  assert.equal(verbalizeSimpleFormula("\\hat{B}(x)"), "formula: B hat of x");
  assert.equal(
    verbalizeSimpleFormula("D_w \\to \\hat{B}(x)"),
    "formula: D sub w to B hat of x"
  );
});


test("formula replacement preserves surrounding sentence text", () => {
  const { replaceFormulaDelimiters } = require("../tts-userscript.js");
  const formulas = [];
  const prepared = replaceFormulaDelimiters(
    "If fitting loss is used, then $\\hat{B}(x)$ is only a neural approximation.",
    formulas
  );

  assert.match(prepared, /^If fitting loss is used, then /);
  assert.match(prepared, /formula:/);
  assert.match(prepared, / is only a neural approximation\.$/);
  assert.equal(formulas.length, 0);
});

test("math wrappers are split into progressive read formula segments", () => {
  const { prepareProgressiveReadPlan, prepareTextForReadPlan } = require("../tts-userscript.js");
  const source = "The resulting sampled sets are denoted by [[MATH: D_I]], [[MATH: D_U]], and [[MATH: D_D]], respectively.";

  const legacyPlan = prepareTextForReadPlan(source);
  assert.doesNotMatch(legacyPlan.text, /\bMATH\b/);
  assert.doesNotMatch(legacyPlan.text, /\[\[/);

  const plan = prepareProgressiveReadPlan(source);
  assert.equal(plan.formulas.length, 3);
  assert.deepEqual(
    plan.segments.map((segment) => segment.type),
    ["text", "formula", "formula", "text", "formula", "text"]
  );
  assert.equal(plan.formulas[0], "D_I");
  assert.match(plan.segments[0].text, /The resulting sampled sets/);
  assert.equal(plan.segments[3].text, "and");
});


test("complex formulas are collected for LLM verbalization fallback", () => {
  const { applyFormulaVerbalizations, prepareTextForReadPlan } = require("../tts-userscript.js");
  const prepared = prepareTextForReadPlan("Use $$\\begin{matrix} a & b \\\\ c & d \\end{matrix}$$ here.");

  assert.equal(prepared.formulas.length, 1);
  assert.match(prepared.text, /__LOCAL_READ_FORMULA_0__/);
  assert.equal(
    applyFormulaVerbalizations(prepared.text, ["a two by two matrix with entries a, b, c, and d"]),
    "Use a two by two matrix with entries a, b, c, and d here."
  );
});


test("bare LaTeX formulas use rules or LLM fallback", () => {
  const { prepareTextForReadPlan } = require("../tts-userscript.js");
  const simple = prepareTextForReadPlan("\\frac{x}{y}");
  const complex = prepareTextForReadPlan("\\begin{cases} x & x > 0 \\\\ -x & x < 0 \\end{cases}");

  assert.equal(simple.formulas.length, 0);
  assert.match(simple.text, /formula: x over y/i);
  assert.equal(complex.formulas.length, 1);
  assert.match(complex.text, /__LOCAL_READ_FORMULA_0__/);
});

test("model option merge includes remote health metadata", () => {
  const { mergeTranslationModelOptions } = require("../tts-userscript.js");
  const merged = mergeTranslationModelOptions(
    [{ value: "translategemma:4b", label: "translategemma:4b - default" }],
    {
      available_models: ["translategemma:4b"],
      available_model_options: [
        {
          value: "remote:lab-server:qwen3:14b",
          label: "Lab Server / qwen3:14b",
          source: "lab-server",
          source_name: "Lab Server",
          model: "qwen3:14b",
        },
      ],
    },
    "remote:lab-server:qwen3:14b"
  );

  assert.deepEqual(merged, [
    { value: "translategemma:4b", label: "translategemma:4b - default" },
    { value: "remote:lab-server:qwen3:14b", label: "Lab Server / qwen3:14b" },
  ]);
});
