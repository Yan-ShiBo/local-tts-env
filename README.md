# 本地划词听译助手 - Local Selection Read & Translate

> Select text in Chrome, then read it aloud locally with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) or translate it locally through Ollama. Your selected text stays on your machine.

[![CI](https://github.com/Yan-ShiBo/local-tts-env/actions/workflows/ci.yml/badge.svg)](https://github.com/Yan-ShiBo/local-tts-env/actions/workflows/ci.yml)

<p align="center">
  <strong>Local read-aloud · Local translation · Privacy-first</strong>
</p>

---

## ✨ Features

- **Selection read-aloud** — Select text on any webpage → click the floating button → hear natural English speech
- **Streaming playback** — Chrome uses `/tts/stream` with MediaSource + WebM/Opus for long text, while older browsers fall back to OGG/Opus
- **Small audio payloads** — `/tts` can return OGG/Opus with `Accept: audio/ogg` or `?format=ogg`; WAV remains the default for compatibility
- **17 voices** — American male/female + British female, easily switchable
- **System tray app** — Runs silently in the background, right-click to control, with optional login auto-start
- **Browser settings panel** — Change voice, speed and translation model from a floating gear icon
- **Local translation** — Select text and translate it locally through Ollama (`qwen3:14b` by default, switchable to `translategemma:4b` or a custom local model)
- **Playback progress** — Floating button shows a horizontal progress fill; streaming mode shows played seconds until final duration is known
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
git clone https://github.com/Yan-ShiBo/local-tts-env.git
cd local-tts-env

# Double-click setup.bat, or run manually:
conda create -n kokoro-tts python=3.10 -y
conda activate kokoro-tts
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
```

### 3. Start the Server

**Option A: System tray app** (recommended)
- Double-click `Kokoro TTS.pyw` — runs silently in the system tray

**Option B: Terminal mode**
- Double-click `start.bat` — shows a console window with logs

For local translation, install [Ollama](https://ollama.com/) and pull a model:

```powershell
ollama pull qwen3:14b
# optional faster model
ollama pull translategemma:4b
```

The default translation model is `qwen3:14b`. Override it with `OLLAMA_TRANSLATE_MODEL`, or change it in the browser settings panel. The settings panel separates TTS and Translation controls, shows whether the selected Ollama model is installed/running, and includes a translation test button.

### 4. Install the Browser Script

1. Install [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) in Chrome
2. Install the published script from Greasy Fork, or open the [GitHub raw userscript](https://raw.githubusercontent.com/Yan-ShiBo/local-tts-env/main/tts-userscript.js) for the development version
3. Confirm installation in Tampermonkey

### 5. Use it!

1. Open any webpage
2. **Select text** → floating `Read` and `Translate` buttons appear
3. Click `Read` for local TTS, or `Translate` for local Ollama translation

> ⌨️ Shortcut: `Ctrl+Shift+S` to read selected text directly.

## Greasy Fork Publishing

The script metadata includes:

- `@homepageURL`: GitHub project page, shown as the script homepage
- `@supportURL`: GitHub Issues, shown as the feedback/support link
- `@license`: MIT

When publishing on Greasy Fork, paste the Markdown from [`docs/greasyfork-additional-info.md`](docs/greasyfork-additional-info.md) into the script's additional info field. The GitHub repository should be linked both through `@homepageURL` and in that additional info section.

## 🎭 Available Voices

The canonical voice and speed list lives in
[`config/tts_catalog.json`](config/tts_catalog.json). The API, tray menu,
browser script and built-in test page are generated from this catalog.

## 📁 Project Files

| File | Description |
|------|-------------|
| `server.py` | FastAPI server with Kokoro TTS inference |
| `audio_encoding.py` | Bundled FFmpeg helpers for OGG/Opus and WebM/Opus |
| `tray_app.py` | System tray application (background mode) |
| `windows_startup.py` | Windows Startup shortcut management for tray auto-start |
| `Kokoro TTS.pyw` | No-console launcher for tray app |
| `tts-userscript.js` | Tampermonkey script for local selection read-aloud and translation |
| `docs/greasyfork-additional-info.md` | Markdown content for the Greasy Fork additional info field |
| `setup.bat` | One-click environment setup |
| `start.bat` | Terminal-mode server launcher |
| `requirements.txt` | Python dependencies |
| `requirements-test.txt` | Lightweight CI/test dependencies (no Torch/Kokoro) |
| `config/tts_catalog.json` | Canonical voices, speeds and defaults |
| `scripts/sync_catalog.py` | Synchronizes the catalog into the userscript |
| `.github/workflows/ci.yml` | Windows CI |

## 🔌 API

### `POST /tts`

```json
{ "text": "Hello, how are you?", "voice": "af_bella", "speed": 0.8 }
```

Returns `audio/wav` by default. Use `Accept: audio/ogg` or `?format=ogg` for OGG/Opus.

### `POST /tts/stream`

```json
{ "text": "Long text can start playing before generation finishes.", "voice": "af_bella", "speed": 0.8 }
```

Returns `audio/webm; codecs="opus"` as a continuous stream for MediaSource playback.

### `POST /translate`

```json
{
  "text": "Hello, how are you?",
  "target_language": "Simplified Chinese",
  "model": "qwen3:14b"
}
```

Returns JSON with `translated_text`, `model`, `target_language` and `elapsed`.

### `GET /translate/health?model=qwen3:14b`

Checks local Ollama without starting a generation. Returns whether Ollama is reachable, whether the model is installed, and whether it is currently running.

### `GET /health` — Server status
### `GET /voices` — Available voices
### `GET /` — Built-in test page

## ✅ Tests

```powershell
conda run -n kokoro-tts python -m pytest tests -v
node --test tests/userscript-core.test.cjs
python scripts/sync_catalog.py --check
python -c "from audio_encoding import validate_ffmpeg; validate_ffmpeg()"
```

The default suite uses a fake pipeline and does not load Kokoro or CUDA.
The detailed expert review is in `docs/expert-review-2026-06-15.md`.

## License

MIT
