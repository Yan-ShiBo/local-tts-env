"""
server.py — Kokoro TTS 本地 API 服务器

启动后在 127.0.0.1:5000 暴露 TTS 接口，
接收英文文本，返回高质量 WAV 音频流。

用法：
    python server.py
    或双击 start.bat
"""

import asyncio
import io
import math
import os
import sys
import time
import warnings
from typing import Optional

# Suppress harmless PyTorch / HuggingFace warnings
warnings.filterwarnings("ignore", message="dropout option adds dropout")
warnings.filterwarnings("ignore", message=".*weight_norm.*deprecated.*")
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

import numpy as np
import soundfile as sf
import torch
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

# ════════════════════════════════════════════════════════════════
#  配置区（按需修改）
# ════════════════════════════════════════════════════════════════

HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "5000"))

# 默认声音（阳光年轻女性）
# 可选：am_adam, am_liam, am_michael, am_eric, am_echo, am_fenrir
#       af_heart, af_bella, af_sky, af_nova, af_jessica
#       bf_emma (英式女声)
VOICE = os.environ.get("KOKORO_VOICE", "af_bella")
DEFAULT_SPEED = float(os.environ.get("KOKORO_SPEED", "0.8"))

# 推理设备：auto（自动检测）、cuda、cpu
DEVICE = os.environ.get("KOKORO_DEVICE", "auto")

SAMPLE_RATE = 24000
SEGMENT_SILENCE_MS = int(os.environ.get("KOKORO_SEGMENT_SILENCE_MS", "0"))
FADE_MS = int(os.environ.get("KOKORO_FADE_MS", "0"))
WARMUP_ENABLED = os.environ.get("KOKORO_WARMUP", "1") != "0"

VOICE_CATALOG = {
    "american_male": [
        {"id": "am_adam", "desc": "年轻清晰（推荐）"},
        {"id": "am_liam", "desc": "温暖阳光"},
        {"id": "am_michael", "desc": "成熟稳重"},
        {"id": "am_eric", "desc": "活力感"},
        {"id": "am_echo", "desc": "自然流畅"},
        {"id": "am_fenrir", "desc": "低沉有力"},
    ],
    "american_female": [
        {"id": "af_heart", "desc": "温暖"},
        {"id": "af_bella", "desc": "甜美（默认）"},
        {"id": "af_sky", "desc": "明亮活泼"},
        {"id": "af_nova", "desc": "自然清晰"},
        {"id": "af_jessica", "desc": "专业"},
        {"id": "af_alloy", "desc": "中性"},
        {"id": "af_aoede", "desc": "典雅"},
        {"id": "af_kore", "desc": "清脆"},
        {"id": "af_nicole", "desc": "柔和"},
        {"id": "af_river", "desc": "流畅"},
    ],
    "british_female": [
        {"id": "bf_emma", "desc": "标准英式"},
    ],
}
AVAILABLE_VOICES = {
    voice["id"]
    for group in VOICE_CATALOG.values()
    for voice in group
}

if VOICE not in AVAILABLE_VOICES:
    raise ValueError(f"Unsupported KOKORO_VOICE: {VOICE}")
if not math.isfinite(DEFAULT_SPEED) or not 0.5 <= DEFAULT_SPEED <= 2.0:
    raise ValueError("KOKORO_SPEED must be a finite number between 0.5 and 2.0")
if SEGMENT_SILENCE_MS < 0 or FADE_MS < 0:
    raise ValueError("Audio timing values cannot be negative")

# ════════════════════════════════════════════════════════════════
#  全局变量
# ════════════════════════════════════════════════════════════════

pipeline = None
british_pipeline = None
inference_lock = asyncio.Lock()
actual_device = None


def resolve_device(device_cfg: str) -> str:
    """解析设备配置。"""
    if device_cfg == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return device_cfg


# ════════════════════════════════════════════════════════════════
#  应用生命周期
# ════════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时加载模型，关闭时释放。"""
    global pipeline, british_pipeline, actual_device

    actual_device = resolve_device(DEVICE)

    print()
    print("=" * 60)
    print("[LOADING] Kokoro TTS model...")
    print(f"   Device: {actual_device}")
    if actual_device == "cuda":
        gpu_name = torch.cuda.get_device_name(0)
        gpu_mem = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        print(f"   GPU: {gpu_name} ({gpu_mem:.1f} GB)")
    print(f"   Default voice: {VOICE}")
    print("=" * 60)
    print()

    t0 = time.time()

    try:
        from kokoro import KPipeline

        # Initialize Kokoro pipeline ('a' = American English)
        pipeline = KPipeline(
            lang_code="a",
            repo_id="hexgrad/Kokoro-82M",
            device=actual_device,
        )
        british_pipeline = KPipeline(
            lang_code="b",
            repo_id="hexgrad/Kokoro-82M",
            model=pipeline.model,
            device=actual_device,
        )

    except ImportError:
        print("[ERROR] Cannot import kokoro. Please install: pip install kokoro>=0.9.4")
        raise
    except Exception as e:
        print(f"[ERROR] Model loading failed: {e}")
        raise

    if WARMUP_ENABLED:
        print("[WARMUP] Running initial inference...")
        warmup_started = time.time()
        _run_inference("Hello.", VOICE, DEFAULT_SPEED)
        print(f"[WARMUP] Done in {time.time() - warmup_started:.2f}s")

    elapsed = time.time() - t0

    print()
    print("=" * 60)
    print(f"[OK] Model loaded in {elapsed:.1f}s")
    print(f"[READY] Server: http://{HOST}:{PORT}")
    print(f"[TEST]  Page:   http://{HOST}:{PORT}/")
    print(f"[HEALTH] Check: http://{HOST}:{PORT}/health")
    print("=" * 60)
    print()

    try:
        yield
    finally:
        print("[STOP] Releasing model resources...")
        pipeline = None
        british_pipeline = None
        if actual_device == "cuda":
            torch.cuda.empty_cache()


# ════════════════════════════════════════════════════════════════
#  FastAPI 应用
# ════════════════════════════════════════════════════════════════

app = FastAPI(
    title="Kokoro TTS 本地服务",
    description="本地运行的高质量英文 TTS 服务（Kokoro 82M）",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — 允许来自浏览器任意页面的请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://{HOST}:{PORT}",
        f"http://localhost:{PORT}",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# ════════════════════════════════════════════════════════════════
#  数据模型
# ════════════════════════════════════════════════════════════════

class TTSRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=10000)
    voice: Optional[str] = None
    speed: Optional[float] = Field(default=DEFAULT_SPEED, ge=0.5, le=2.0)

    @field_validator("voice")
    @classmethod
    def validate_voice(cls, value):
        if value is not None and value not in AVAILABLE_VOICES:
            raise ValueError(f"不支持的声音：{value}")
        return value


# ════════════════════════════════════════════════════════════════
#  推理逻辑
# ════════════════════════════════════════════════════════════════

def _apply_fade(audio: np.ndarray, sample_rate: int, fade_ms: int) -> np.ndarray:
    """Apply a short fade at both ends without mutating the input."""
    result = np.asarray(audio, dtype=np.float32).reshape(-1).copy()
    fade_samples = min(len(result) // 2, int(sample_rate * fade_ms / 1000))
    if fade_samples <= 0:
        return result
    result[:fade_samples] *= np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
    result[-fade_samples:] *= np.linspace(1.0, 0.0, fade_samples, dtype=np.float32)
    return result


def _combine_audio_segments(
    audio_segments,
    sample_rate: int = SAMPLE_RATE,
    silence_ms: int = SEGMENT_SILENCE_MS,
    fade_ms: int = FADE_MS,
) -> np.ndarray:
    """Join model segments with silence and smooth the final boundaries."""
    normalized = [
        np.asarray(segment, dtype=np.float32).reshape(-1)
        for segment in audio_segments
        if segment is not None and np.asarray(segment).size > 0
    ]
    if not normalized:
        raise RuntimeError("模型未生成任何音频")

    silence_samples = max(0, int(sample_rate * silence_ms / 1000))
    if len(normalized) > 1 and silence_samples:
        silence = np.zeros(silence_samples, dtype=np.float32)
        parts = []
        for index, segment in enumerate(normalized):
            parts.append(segment)
            if index < len(normalized) - 1:
                parts.append(silence)
        full_audio = np.concatenate(parts)
    else:
        full_audio = np.concatenate(normalized)

    return _apply_fade(full_audio, sample_rate, fade_ms)


def _run_inference(text: str, voice: str, speed: float):
    """同步执行 Kokoro TTS 推理（在线程池中运行）。"""
    selected_pipeline = british_pipeline if voice.startswith("bf_") else pipeline
    if selected_pipeline is None:
        raise RuntimeError("模型尚未就绪")

    # 使用 pipeline 生成音频
    # KPipeline 会自动处理长文本分块
    audio_segments = []
    for _, _, audio in selected_pipeline(text, voice=voice, speed=speed):
        if audio is not None:
            audio_segments.append(audio.numpy() if hasattr(audio, 'numpy') else audio)

    return _combine_audio_segments(audio_segments), SAMPLE_RATE


# ════════════════════════════════════════════════════════════════
#  API 端点
# ════════════════════════════════════════════════════════════════

@app.post(
    "/tts",
    response_class=Response,
    responses={
        200: {
            "content": {"audio/wav": {}},
            "description": "PCM 16-bit WAV audio",
        }
    },
)
async def tts_endpoint(request: TTSRequest):
    """
    文本转语音。

    接收 JSON {"text": "...", "voice": "am_adam", "speed": 1.0}
    返回 WAV 音频流。
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="文本不能为空")

    voice = request.voice or VOICE
    speed = request.speed if request.speed is not None else DEFAULT_SPEED

    try:
        try:
            await asyncio.wait_for(inference_lock.acquire(), timeout=0.05)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=429, detail="服务器正忙，请稍后重试")

        try:
            loop = asyncio.get_running_loop()
            t0 = time.perf_counter()
            inference_future = loop.run_in_executor(
                None, _run_inference, text, voice, speed
            )
            try:
                wav, sr = await asyncio.shield(inference_future)
            except asyncio.CancelledError:
                await inference_future
                raise
            elapsed = time.perf_counter() - t0
            duration = len(wav) / sr
            realtime_factor = duration / max(elapsed, 1e-9)
            print(f"[TTS] {len(text)} chars -> {duration:.1f}s audio, took {elapsed:.2f}s ({realtime_factor:.1f}x realtime)")
        finally:
            inference_lock.release()

    except HTTPException:
        raise
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[ERROR] Inference failed: {e}")
        raise HTTPException(status_code=500, detail="语音生成失败")

    # 将 numpy 数组写入 WAV 格式的内存缓冲区
    buffer = io.BytesIO()
    sf.write(buffer, wav, sr, format="WAV", subtype="PCM_16")

    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'inline; filename="speech.wav"',
            "X-Inference-Time": f"{elapsed:.2f}",
            "X-Audio-Duration": f"{duration:.2f}",
        },
    )


@app.get("/health")
async def health_check():
    """健康检查端点。"""
    return {
        "status": "ok",
        "service": "kokoro-tts",
        "version": app.version,
        "pid": os.getpid(),
        "ready": pipeline is not None,
        "model": "Kokoro-82M",
        "device": actual_device,
        "gpu": torch.cuda.get_device_name(0) if actual_device == "cuda" else "N/A",
        "default_voice": VOICE,
        "default_speed": DEFAULT_SPEED,
    }


@app.get("/voices")
async def list_voices():
    """返回可用声音列表。"""
    return VOICE_CATALOG


@app.get("/", response_class=HTMLResponse)
async def test_page():
    """内置测试页面。"""
    return """
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kokoro TTS 本地测试</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    background: #0f0f1a;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 20px;
    padding: 40px;
    width: 600px;
    max-width: 92vw;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  h1 {
    font-size: 24px;
    font-weight: 700;
    background: linear-gradient(135deg, #667eea, #764ba2);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
  }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
  label { display: block; color: #aaa; font-size: 13px; margin-bottom: 6px; margin-top: 16px; }
  textarea, select {
    width: 100%;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    color: #e0e0e0;
    padding: 14px;
    font-size: 15px;
    line-height: 1.6;
    outline: none;
    transition: border-color 0.2s;
  }
  textarea { min-height: 120px; resize: vertical; }
  select { padding: 10px 14px; cursor: pointer; appearance: none; }
  textarea:focus, select:focus { border-color: #667eea; }
  .row { display: flex; gap: 12px; }
  .row > * { flex: 1; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 20px;
    padding: 13px 28px;
    width: 100%;
    background: linear-gradient(135deg, #667eea, #764ba2);
    color: #fff;
    border: none;
    border-radius: 12px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 8px 25px rgba(102,126,234,0.35); }
  .btn:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .status {
    margin-top: 14px;
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13px;
    display: none;
  }
  .status.show { display: block; }
  .status.loading { background: rgba(102,126,234,0.15); color: #98a8f8; }
  .status.success { background: rgba(76,175,80,0.15); color: #81c784; }
  .status.error   { background: rgba(244,67,54,0.15);  color: #e57373; }
  audio { width: 100%; margin-top: 14px; border-radius: 10px; }
</style>
</head>
<body>
<div class="card">
  <h1>🎙️ Kokoro TTS 本地测试</h1>
  <p class="subtitle">输入英文文本，选择声音，点击朗读</p>

  <label for="text">英文文本</label>
  <textarea id="text" placeholder="Type English text here...">Hello! Welcome to the Kokoro text-to-speech system. This lightweight model delivers amazingly natural English pronunciation with near real-time speed.</textarea>

  <div class="row">
    <div>
      <label for="voice">声音</label>
      <select id="voice">
        <optgroup label="美式男声">
          <option value="am_adam">am_adam — 年轻清晰</option>
          <option value="am_liam">am_liam — 温暖阳光</option>
          <option value="am_michael">am_michael — 成熟稳重</option>
          <option value="am_eric">am_eric — 活力感</option>
          <option value="am_echo">am_echo — 自然流畅</option>
          <option value="am_fenrir">am_fenrir — 低沉有力</option>
        </optgroup>
        <optgroup label="美式女声">
          <option value="af_heart">af_heart — 温暖</option>
          <option value="af_bella" selected>af_bella — 甜美 (默认)</option>
          <option value="af_sky">af_sky — 明亮活泼</option>
          <option value="af_nova">af_nova — 自然清晰</option>
          <option value="af_jessica">af_jessica — 专业</option>
        </optgroup>
        <optgroup label="英式女声">
          <option value="bf_emma">bf_emma — 标准英式</option>
        </optgroup>
      </select>
    </div>
    <div>
      <label for="speed">语速</label>
      <select id="speed">
        <option value="0.7">0.7x 慢速</option>
        <option value="0.8" selected>0.8x 默认</option>
        <option value="0.9">0.9x 稍快</option>
        <option value="1.0">1.0x 正常</option>
        <option value="1.1">1.1x 稍快</option>
        <option value="1.2">1.2x 快速</option>
      </select>
    </div>
  </div>

  <button class="btn" id="speakBtn" onclick="speak()">🔊 朗读</button>
  <div class="status" id="status"></div>
  <audio id="player" controls style="display:none"></audio>
</div>
<script>
async function speak() {
  const text = document.getElementById('text').value.trim();
  if (!text) return;
  const voice = document.getElementById('voice').value;
  const speed = parseFloat(document.getElementById('speed').value);
  const btn = document.getElementById('speakBtn');
  const status = document.getElementById('status');
  const player = document.getElementById('player');
  btn.disabled = true;
  btn.textContent = '⏳ 生成中...';
  status.className = 'status show loading';
  status.textContent = '正在推理，请稍候...';
  player.style.display = 'none';
  try {
    const t0 = performance.now();
    const resp = await fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
    });
    if (!resp.ok) { const e = await resp.json(); throw new Error(e.detail || resp.statusText); }
    const blob = await resp.blob();
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const inferTime = resp.headers.get('X-Inference-Time') || '?';
    const audioDur = resp.headers.get('X-Audio-Duration') || '?';
    const url = URL.createObjectURL(blob);
    player.src = url;
    player.style.display = 'block';
    player.play();
    status.className = 'status show success';
    status.textContent = `✅ 完成！推理 ${inferTime}s → 音频 ${audioDur}s（总耗时 ${elapsed}s）`;
  } catch (e) {
    status.className = 'status show error';
    status.textContent = '❌ 错误：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔊 朗读';
  }
}
</script>
</body>
</html>
"""


# ════════════════════════════════════════════════════════════════
#  启动入口
# ════════════════════════════════════════════════════════════════

def check_port(host: str, port: int) -> bool:
    """Check if a port is available. Returns True if available."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


if __name__ == "__main__":
    import uvicorn

    print()
    print("[START] Kokoro TTS local server starting...")
    print()

    # Check if port is already in use
    if not check_port(HOST, PORT):
        print(f"[WARNING] Port {PORT} is already in use!")
        print(f"          This usually means the server is already running.")
        print()
        print(f"  Option 1: Visit http://{HOST}:{PORT}/ to check")
        print(f"  Option 2: Kill the old process:")
        print(f"            PowerShell: Stop-Process -Id (Get-NetTCPConnection -LocalPort {PORT}).OwningProcess -Force")
        print(f"  Option 3: Change PORT in server.py")
        print()

        print("[ERROR] The API port is fixed because browser clients use it.")
        sys.exit(1)

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="warning",
    )
