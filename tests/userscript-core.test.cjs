const assert = require("node:assert/strict");
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
