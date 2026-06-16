// ==UserScript==
// @name         Kokoro TTS 划词朗读
// @namespace    https://github.com/Yan-ShiBo/local-tts-env
// @version      1.4.2
// @description  选中英文文本，一键使用本地 Kokoro TTS 进行高质量朗读
// @author       Yan-ShiBo
// @match        *://*/*
// @downloadURL  https://raw.githubusercontent.com/Yan-ShiBo/local-tts-env/main/tts-userscript.js
// @updateURL    https://raw.githubusercontent.com/Yan-ShiBo/local-tts-env/main/tts-userscript.js
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-end
// @noframes
// ==/UserScript==

const KokoroTTSCore = (() => {
  const WEBM_OPUS_MIME = 'audio/webm; codecs="opus"';
  const OGG_OPUS_MIME = 'audio/ogg; codecs="opus"';
  const OGG_MIME = "audio/ogg";
  const WAV_MIME = "audio/wav";

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

  function isUnsupportedMediaError(error) {
    const name = error && error.name ? String(error.name) : "";
    const message = error && error.message ? String(error.message) : "";
    return (
      name === "NotSupportedError" ||
      /not supported|no supported source|failed to load/i.test(message)
    );
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
    choosePlaybackMode,
    createAppendQueue,
    createRequestGate,
    formatPlaybackProgress,
    isUnsupportedMediaError,
    normalizeAudioBlob,
    releaseAudio,
    selectBlobAudioFormat,
    supportsWebMOpus,
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
  const SHORTCUT = { ctrl: true, shift: true, key: "S" }; // Ctrl+Shift+S

  /* CATALOG:START */
  const TTS_CATALOG = {"default_voice":"af_bella","default_speed":0.8,"speeds":[0.6,0.7,0.8,0.9,1.0,1.1,1.2],"groups":[{"id":"american_female","label_en":"American Female","label_zh":"美式女声","lang_code":"a","voices":[{"id":"af_bella","label_en":"Sweet","label_zh":"甜美"},{"id":"af_heart","label_en":"Warm","label_zh":"温暖"},{"id":"af_sky","label_en":"Bright","label_zh":"明亮活泼"},{"id":"af_nova","label_en":"Clear","label_zh":"自然清晰"},{"id":"af_jessica","label_en":"Professional","label_zh":"专业"},{"id":"af_alloy","label_en":"Neutral","label_zh":"中性"},{"id":"af_aoede","label_en":"Elegant","label_zh":"典雅"},{"id":"af_kore","label_en":"Crisp","label_zh":"清脆"},{"id":"af_nicole","label_en":"Soft","label_zh":"柔和"},{"id":"af_river","label_en":"Smooth","label_zh":"流畅"}]},{"id":"american_male","label_en":"American Male","label_zh":"美式男声","lang_code":"a","voices":[{"id":"am_adam","label_en":"Clear","label_zh":"年轻清晰"},{"id":"am_liam","label_en":"Warm","label_zh":"温暖阳光"},{"id":"am_michael","label_en":"Mature","label_zh":"成熟稳重"},{"id":"am_eric","label_en":"Energetic","label_zh":"活力感"},{"id":"am_echo","label_en":"Natural","label_zh":"自然流畅"},{"id":"am_fenrir","label_en":"Deep","label_zh":"低沉有力"}]},{"id":"british_female","label_en":"British Female","label_zh":"英式女声","lang_code":"b","voices":[{"id":"bf_emma","label_en":"British","label_zh":"标准英式"}]}]};
  /* CATALOG:END */

  // Default settings (overridden by GM storage)
  const DEFAULTS = {
    voice: TTS_CATALOG.default_voice,
    speed: TTS_CATALOG.default_speed,
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

  // ════════════════════════════════════════════════════════
  //  State
  // ════════════════════════════════════════════════════════

  let floatingBtn = null;
  let currentAudio = null;
  const requestGate = KokoroTTSCore.createRequestGate();
  let isLoading = false;
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
      return {
        voice: voiceExists ? saved.voice : DEFAULTS.voice,
        speed: speedExists ? saved.speed : DEFAULTS.speed,
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

    @keyframes tts-fade-in {
      from { opacity: 0; transform: translateY(6px) scale(0.92); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes tts-fade-out {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(0.9); }
    }

    /* -- Main button -- */
    .tts-speak-btn {
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

    .tts-speak-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.55),
                  0 2px 6px rgba(0, 0, 0, 0.2);
    }

    .tts-speak-btn:active {
      transform: translateY(0);
    }

    /* -- Loading state -- */
    .tts-speak-btn.loading {
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      cursor: pointer;
    }

    .tts-speak-btn.loading .tts-icon {
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
    .tts-speak-btn.error {
      background: linear-gradient(135deg, #fc5c7d 0%, #6a82fb 100%);
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
      width: 280px;
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

    .tts-settings-panel select {
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

    .tts-settings-panel select:focus {
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

    panel.innerHTML = `
      <h3>Kokoro TTS Settings</h3>
      <div style="font-size:12px;margin-bottom:12px;">
        <span class="tts-status-dot checking" id="tts-status-dot"></span>
        <span id="tts-status-text" style="color:#888;">Checking...</span>
      </div>
      <label>Voice</label>
      <select id="tts-voice-select">${voiceOptions}</select>
      <label>Speed</label>
      <select id="tts-speed-select">${speedOptions}</select>
      <button class="tts-test-btn" id="tts-test-btn">Test: "Hello, nice to meet you!"</button>
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

    panel.querySelector("#tts-test-btn").addEventListener("click", (e) => {
      const testText = "Hello, nice to meet you! This is a test of the Kokoro text to speech system.";
      speak(testText, e.currentTarget);
    });

    // Check server status
    checkServerStatus();
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
  gearBtn.title = "Kokoro TTS Settings";
  gearBtn.setAttribute("aria-label", "Kokoro TTS settings");
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

  function getSelectedText() {
    return window.getSelection().toString().trim();
  }

  function removeButton() {
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
    stopAudio();

    const container = document.createElement("div");
    container.className = "tts-float-container";

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

    container.appendChild(btn);

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
      btnElement.dataset.ttsBaseClass = btnElement.classList.contains("tts-test-btn")
        ? "tts-test-btn"
        : "tts-speak-btn";
    }
    return btnElement.dataset.ttsBaseClass;
  }

  function setButtonHtml(btnElement, className, icon, label) {
    if (!btnElement) return;
    const baseClass = getButtonBaseClass(btnElement);
    const stateClasses = className
      .split(/\s+/)
      .filter((name) => name && name !== "tts-speak-btn" && name !== "tts-test-btn");
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
      const playbackMode = KokoroTTSCore.choosePlaybackMode(
        window.MediaSource,
        window.location.origin,
        API_ORIGIN
      );
      if (playbackMode === "stream" && typeof fetch === "function") {
        try {
          await playStreamingAudio(text, generation, btnElement, buttonContainer);
        } catch (streamError) {
          if (!requestGate.isCurrent(generation)) return;
          console.warn("[Kokoro TTS] Streaming failed; falling back to OGG", streamError);
          stopAudio();
          await playBlobAudio(text, generation, btnElement, buttonContainer);
        }
      } else {
        await playBlobAudio(text, generation, btnElement, buttonContainer);
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
        if (floatingBtn && !currentAudio) {
          removeButton();
        }
      }, 200);
    },
    { passive: true }
  );

  window.addEventListener("beforeunload", () => {
    cancelRequest();
    stopAudio();
  });

  console.log(
    "%c[Kokoro TTS] Script loaded. Select text to read, or press Ctrl+Shift+S",
    "color: #667eea; font-weight: bold;"
  );
})();
}
