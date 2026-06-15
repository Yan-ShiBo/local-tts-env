// ==UserScript==
// @name         Kokoro TTS 划词朗读
// @namespace    https://github.com/Yan-ShiBo/local-tts-env
// @version      1.2.0
// @description  选中英文文本，一键使用本地 Kokoro TTS 进行高质量朗读
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-end
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ════════════════════════════════════════════════════════
  //  Configuration
  // ════════════════════════════════════════════════════════

  const API_BASE = "http://127.0.0.1:5000";
  const API_URL = API_BASE + "/tts";
  const SHORTCUT = { ctrl: true, shift: true, key: "S" }; // Ctrl+Shift+S

  // Default settings (overridden by localStorage)
  const DEFAULTS = {
    voice: "af_bella",
    speed: 0.8,
  };

  // Voice catalog
  const VOICES = [
    { group: "American Female", voices: [
      { id: "af_bella",   label: "af_bella - Sweet" },
      { id: "af_heart",   label: "af_heart - Warm" },
      { id: "af_sky",     label: "af_sky - Bright" },
      { id: "af_nova",    label: "af_nova - Clear" },
      { id: "af_jessica", label: "af_jessica - Pro" },
      { id: "af_alloy",   label: "af_alloy - Neutral" },
      { id: "af_aoede",   label: "af_aoede - Elegant" },
      { id: "af_kore",    label: "af_kore - Crisp" },
      { id: "af_nicole",  label: "af_nicole - Soft" },
      { id: "af_river",   label: "af_river - Smooth" },
    ]},
    { group: "American Male", voices: [
      { id: "am_adam",    label: "am_adam - Clear" },
      { id: "am_liam",    label: "am_liam - Warm" },
      { id: "am_michael", label: "am_michael - Mature" },
      { id: "am_eric",    label: "am_eric - Energetic" },
      { id: "am_echo",    label: "am_echo - Natural" },
      { id: "am_fenrir",  label: "am_fenrir - Deep" },
    ]},
    { group: "British Female", voices: [
      { id: "bf_emma", label: "bf_emma - British" },
    ]},
  ];

  const SPEEDS = [
    { value: 0.6, label: "0.6x" },
    { value: 0.7, label: "0.7x" },
    { value: 0.8, label: "0.8x (default)" },
    { value: 0.9, label: "0.9x" },
    { value: 1.0, label: "1.0x" },
    { value: 1.1, label: "1.1x" },
    { value: 1.2, label: "1.2x" },
  ];

  // ════════════════════════════════════════════════════════
  //  State
  // ════════════════════════════════════════════════════════

  let floatingBtn = null;
  let currentAudio = null;
  let currentRequest = null;
  let requestGeneration = 0;
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

    panel.querySelector("#tts-test-btn").addEventListener("click", () => {
      const testText = "Hello, nice to meet you! This is a test of the Kokoro text to speech system.";
      speak(testText, null);
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
      currentAudio.pause();
      currentAudio.src = "";
      if (currentAudio._blobUrl) {
        URL.revokeObjectURL(currentAudio._blobUrl);
        currentAudio._blobUrl = null;
      }
      currentAudio = null;
    }
  }

  function cancelRequest() {
    requestGeneration += 1;
    if (currentRequest) {
      currentRequest.abort();
      currentRequest = null;
    }
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
  async function speak(text, btnElement) {
    cancelRequest();
    stopAudio();
    isLoading = true;
    const generation = requestGeneration;
    const buttonContainer = btnElement
      ? btnElement.closest(".tts-float-container")
      : null;

    if (btnElement) {
      btnElement.className = "tts-speak-btn loading";
      btnElement.innerHTML =
        '<span class="tts-icon">\u23F9</span><span class="tts-label">Cancel</span>';
    }

    try {
      const audioBlob = await new Promise((resolve, reject) => {
        currentRequest = GM_xmlhttpRequest({
          method: "POST",
          url: API_URL,
          headers: { "Content-Type": "application/json" },
          data: JSON.stringify({
            text: text,
            voice: settings.voice,
            speed: settings.speed,
          }),
          responseType: "blob",
          timeout: 60000,
          onload: (response) => {
            if (generation !== requestGeneration) return;
            if (response.status >= 200 && response.status < 300) {
              resolve(response.response);
            } else {
              reject(
                new Error(
                  `Server returned ${response.status}: ${response.statusText}`
                )
              );
            }
          },
          onerror: () => {
            if (generation !== requestGeneration) return;
            reject(
              new Error(
                "Cannot connect to TTS server. Run start.bat first."
              )
            );
          },
          ontimeout: () => {
            if (generation !== requestGeneration) return;
            reject(new Error("Request timeout. Text may be too long."));
          },
          onabort: () => reject(new Error("Request cancelled.")),
        });
      });

      if (generation !== requestGeneration) return;
      currentRequest = null;
      const blobUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(blobUrl);
      audio._blobUrl = blobUrl;
      currentAudio = audio;

      if (btnElement) {
        btnElement.className = "tts-speak-btn playing";
        btnElement.innerHTML =
          '<span class="tts-icon">\uD83D\uDD0A</span><span class="tts-label">Playing...</span>';
      }

      audio.addEventListener("ended", () => {
        if (audio._blobUrl) {
          URL.revokeObjectURL(audio._blobUrl);
          audio._blobUrl = null;
        }
        if (currentAudio === audio) currentAudio = null;
        if (btnElement) {
          btnElement.className = "tts-speak-btn";
          btnElement.innerHTML =
            '<span class="tts-icon">\u2705</span><span class="tts-label">Done</span>';
          setTimeout(() => removeSpecificButton(buttonContainer), 2000);
        }
      });

      audio.addEventListener("error", () => {
        if (audio._blobUrl) {
          URL.revokeObjectURL(audio._blobUrl);
          audio._blobUrl = null;
        }
        if (currentAudio === audio) currentAudio = null;
        if (btnElement) {
          btnElement.className = "tts-speak-btn error";
          btnElement.innerHTML =
            '<span class="tts-icon">\u274C</span><span class="tts-label">Play failed</span>';
        }
      });

      await audio.play();
    } catch (err) {
      if (generation !== requestGeneration) return;
      console.error("[Kokoro TTS]", err);
      stopAudio();
      if (btnElement) {
        btnElement.className = "tts-speak-btn error";
        btnElement.innerHTML = `<span class="tts-icon">\u274C</span><span class="tts-label">${err.message.substring(0, 30)}</span>`;
        setTimeout(() => removeSpecificButton(buttonContainer), 4000);
      }
    } finally {
      if (generation === requestGeneration) {
        currentRequest = null;
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
