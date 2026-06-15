# 🎙️ Kokoro TTS - Local Text-to-Speech for Chrome

> Select any English text in Chrome, click to listen. Powered by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), running **100% locally** on your GPU.

<p align="center">
  <strong>Zero cloud dependency · Free & unlimited · Privacy-first</strong>
</p>

---

## ✨ Features

- **Instant read-aloud** — Select text on any webpage → click the floating button → hear natural English speech
- **17 voices** — American male/female + British female, easily switchable
- **System tray app** — Runs silently in the background, right-click to control
- **Browser settings panel** — Change voice & speed from a floating gear icon
- **GPU-accelerated** — Near real-time inference on NVIDIA GPUs
- **Fully offline** — No internet required after initial model download (~200MB)

## 📐 Architecture

```
┌──────────────────────────┐                        ┌─────────────────────────┐
│   Chrome Browser          │   POST /tts            │   Local API Server      │
│   Tampermonkey Script     │  ───────────────────►  │   FastAPI + Kokoro TTS  │
│                           │                        │   127.0.0.1:5000        │
│   ① Select English text   │  ◄───────────────────  │                         │
│   ② Click 🔊 button       │    audio/wav stream     │   ③ GPU inference       │
│   ④ HTML5 Audio plays     │                        │                         │
└──────────────────────────┘                        └─────────────────────────┘
```

## 💻 Requirements

| Item | Requirement |
|------|------------|
| OS | Windows 10/11 |
| GPU | NVIDIA GPU with CUDA support (recommended) |
| Python | Managed via Conda (Python 3.10) |
| eSpeak-NG | Required for phonemization |
| Browser | Chrome + [Tampermonkey](https://www.tampermonkey.net/) |

## 🚀 Quick Start

### 1. Install eSpeak-NG

Download from [eSpeak-NG Releases](https://github.com/espeak-ng/espeak-ng/releases), install, and **add to system PATH** (usually `C:\Program Files\eSpeak NG`).

### 2. Run Setup

```powershell
# Clone the repo
git clone https://github.com/YOUR_USERNAME/local-tts-env.git
cd local-tts-env

# Double-click setup.bat, or run manually:
conda create -n kokoro-tts python=3.10 -y
conda activate kokoro-tts
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
pip install pystray Pillow
```

### 3. Start the Server

**Option A: System tray app** (recommended)
- Double-click `Kokoro TTS.pyw` — runs silently in the system tray

**Option B: Terminal mode**
- Double-click `start.bat` — shows a console window with logs

### 4. Install the Browser Script

1. Install [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) in Chrome
2. Click Tampermonkey icon → **Create a new script**
3. Paste the contents of `tts-userscript.js` → Save (`Ctrl+S`)

### 5. Use it!

1. Open any English webpage
2. **Select text** → a floating 🔊 button appears
3. Click it → hear natural English speech!

> ⌨️ Shortcut: `Ctrl+Shift+S` to read selected text directly.

## 🎭 Available Voices

| Voice ID | Style |
|----------|-------|
| `af_bella` ⭐ | Sweet, sunny (default) |
| `af_sky` | Bright, lively |
| `af_heart` | Warm |
| `am_adam` | Young, clear |
| `am_liam` | Warm, sunny |
| `bf_emma` | British English |

_...and 11 more. See the full list in the browser settings panel or test page._

## 📁 Project Files

| File | Description |
|------|-------------|
| `server.py` | FastAPI server with Kokoro TTS inference |
| `tray_app.py` | System tray application (background mode) |
| `Kokoro TTS.pyw` | No-console launcher for tray app |
| `tts-userscript.js` | Tampermonkey script with settings panel |
| `setup.bat` | One-click environment setup |
| `start.bat` | Terminal-mode server launcher |
| `requirements.txt` | Python dependencies |

## 🔌 API

### `POST /tts`

```json
{ "text": "Hello, how are you?", "voice": "af_bella", "speed": 0.8 }
```

Returns `audio/wav` stream.

### `GET /health` — Server status
### `GET /voices` — Available voices
### `GET /` — Built-in test page

## License

MIT
