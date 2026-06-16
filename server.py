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
import threading
import time
import warnings
from typing import Optional

# Suppress harmless PyTorch / HuggingFace warnings
warnings.filterwarnings("ignore", message="dropout option adds dropout")
warnings.filterwarnings("ignore", message=".*weight_norm.*deprecated.*")
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

import numpy as np
import soundfile as sf
try:
    import torch
except ImportError:
    torch = None
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from audio_encoding import (
    AudioEncodingError,
    WebMOpusEncoder,
    encode_ogg_opus,
    validate_ffmpeg,
)
from tts_catalog import (
    AVAILABLE_VOICES,
    CATALOG as TTS_CATALOG,
    DEFAULT_SPEED as CATALOG_DEFAULT_SPEED,
    DEFAULT_VOICE,
    SPEEDS,
    VOICE_GROUPS,
    VOICE_LANG_CODES,
)

# ════════════════════════════════════════════════════════════════
#  配置区（按需修改）
# ════════════════════════════════════════════════════════════════

HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "5000"))

VOICE = os.environ.get("KOKORO_VOICE", DEFAULT_VOICE)
DEFAULT_SPEED = float(os.environ.get("KOKORO_SPEED", str(CATALOG_DEFAULT_SPEED)))

# 推理设备：auto（自动检测）、cuda、cpu
DEVICE = os.environ.get("KOKORO_DEVICE", "auto")

SAMPLE_RATE = 24000
SEGMENT_SILENCE_MS = int(os.environ.get("KOKORO_SEGMENT_SILENCE_MS", "0"))
FADE_MS = int(os.environ.get("KOKORO_FADE_MS", "0"))
WARMUP_ENABLED = os.environ.get("KOKORO_WARMUP", "1") != "0"
SUPPORTED_AUDIO_FORMATS = {"wav", "ogg"}
STREAM_CHUNK_BYTES = 16384

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
        return "cuda" if torch and torch.cuda.is_available() else "cpu"
    return device_cfg


# ════════════════════════════════════════════════════════════════
#  应用生命周期
# ════════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时加载模型，关闭时释放。"""
    global pipeline, british_pipeline, actual_device

    if torch is None:
        raise RuntimeError("PyTorch is required to start the TTS model")

    validate_ffmpeg()
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
        if actual_device == "cuda" and torch:
            torch.cuda.empty_cache()


# ════════════════════════════════════════════════════════════════
#  FastAPI 应用
# ════════════════════════════════════════════════════════════════

app = FastAPI(
    title="Kokoro TTS 本地服务",
    description="本地运行的高质量英文 TTS 服务（Kokoro 82M）",
    version="1.1.0",
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
    selected_pipeline = _select_pipeline_for_voice(voice)
    if selected_pipeline is None:
        raise RuntimeError("模型尚未就绪")

    # 使用 pipeline 生成音频
    # KPipeline 会自动处理长文本分块
    audio_segments = []
    for _, _, audio in selected_pipeline(text, voice=voice, speed=speed):
        if audio is not None:
            audio_segments.append(audio.numpy() if hasattr(audio, 'numpy') else audio)

    return _combine_audio_segments(audio_segments), SAMPLE_RATE


def _select_pipeline_for_voice(voice: str):
    return british_pipeline if VOICE_LANG_CODES[voice] == "b" else pipeline


def _select_audio_format(format_query: Optional[str], accept: Optional[str]) -> str:
    if format_query is not None:
        normalized = format_query.lower()
        if normalized not in SUPPORTED_AUDIO_FORMATS:
            raise HTTPException(status_code=406, detail="不支持的音频格式")
        return normalized

    normalized_accept = (accept or "*/*").lower()
    if "audio/ogg" in normalized_accept:
        return "ogg"
    if (
        "audio/wav" in normalized_accept
        or "audio/*" in normalized_accept
        or "*/*" in normalized_accept
    ):
        return "wav"

    raise HTTPException(status_code=406, detail="不支持的音频格式")


def _audio_response(wav: np.ndarray, sample_rate: int, audio_format: str) -> Response:
    if audio_format == "ogg":
        content = encode_ogg_opus(wav, sample_rate)
        return Response(
            content=content,
            media_type="audio/ogg",
            headers={"Content-Disposition": 'inline; filename="speech.ogg"'},
        )

    buffer = io.BytesIO()
    sf.write(buffer, wav, sample_rate, format="WAV", subtype="PCM_16")
    return Response(
        content=buffer.getvalue(),
        media_type="audio/wav",
        headers={"Content-Disposition": 'inline; filename="speech.wav"'},
    )


def _stream_segment_with_fade(
    segment: np.ndarray,
    sample_rate: int,
    fade_ms: int,
    fade_in: bool,
    fade_out: bool,
) -> np.ndarray:
    result = np.asarray(segment, dtype=np.float32).reshape(-1).copy()
    fade_samples = min(len(result) // 2, int(sample_rate * fade_ms / 1000))
    if fade_samples <= 0:
        return result
    if fade_in:
        result[:fade_samples] *= np.linspace(
            0.0, 1.0, fade_samples, dtype=np.float32
        )
    if fade_out:
        result[-fade_samples:] *= np.linspace(
            1.0, 0.0, fade_samples, dtype=np.float32
        )
    return result


class TTSStreamSession:
    def __init__(
        self,
        pipeline,
        text: str,
        voice: str,
        speed: float,
        encoder_factory=WebMOpusEncoder,
        sample_rate: int = SAMPLE_RATE,
        silence_ms: int = SEGMENT_SILENCE_MS,
        fade_ms: int = FADE_MS,
    ):
        self.pipeline = pipeline
        self.text = text
        self.voice = voice
        self.speed = speed
        self.encoder_factory = encoder_factory
        self.sample_rate = sample_rate
        self.silence_ms = silence_ms
        self.fade_ms = fade_ms
        self.cancel_event = threading.Event()
        self.close_lock = threading.Lock()
        self.closed = False
        self.encoder = None
        self.producer_thread = None
        self.producer_error = None

    def start(self) -> None:
        self.encoder = self.encoder_factory(self.sample_rate)
        self.producer_thread = threading.Thread(
            target=self._produce,
            name="kokoro-stream-producer",
            daemon=True,
        )
        self.producer_thread.start()

    def read_first_chunk(self) -> bytes:
        chunk = self.read_chunk()
        if not chunk or not chunk.startswith(b"\x1aE\xdf\xa3"):
            if self.producer_error is not None:
                raise AudioEncodingError("WebM encoding failed") from self.producer_error
            raise AudioEncodingError("WebM encoding failed")
        return chunk

    def read_chunk(self) -> bytes:
        if self.encoder is None:
            raise AudioEncodingError("WebM encoding failed")
        chunk = self.encoder.read(STREAM_CHUNK_BYTES)
        if not chunk and self.producer_error is not None:
            self._raise_producer_error_or_encoding_error()
        return chunk

    def iter_chunks(self, first_chunk: bytes):
        try:
            yield first_chunk
            while True:
                chunk = self.read_chunk()
                if not chunk:
                    break
                yield chunk
            self.finish()
        finally:
            self.close()

    def finish(self) -> None:
        if self.producer_thread is not None:
            self.producer_thread.join()
        if self.producer_error is not None:
            raise AudioEncodingError("WebM encoding failed") from self.producer_error
        if self.encoder is not None:
            self.encoder.wait()

    def close(self) -> None:
        with self.close_lock:
            if self.closed:
                return
            self.closed = True
            self.cancel_event.set()
            if self.encoder is not None:
                self.encoder.close()
        if (
            self.producer_thread is not None
            and self.producer_thread is not threading.current_thread()
        ):
            self.producer_thread.join(timeout=5)

    def _produce(self) -> None:
        try:
            previous = None
            wrote_segment = False
            first_segment = True
            silence = self._silence()
            needs_lookahead = self.fade_ms > 0 or (
                silence is not None and silence.size > 0
            )
            for _, _, audio in self.pipeline(
                self.text, voice=self.voice, speed=self.speed
            ):
                if self.cancel_event.is_set():
                    break
                if audio is None:
                    continue
                segment = audio.numpy() if hasattr(audio, "numpy") else audio
                segment = np.asarray(segment, dtype=np.float32).reshape(-1)
                if segment.size == 0:
                    continue

                if needs_lookahead:
                    if previous is None:
                        previous = segment
                        continue
                    self._write_segment(previous, first_segment, False)
                    wrote_segment = True
                    first_segment = False
                    self._write_silence(silence)
                    previous = segment
                else:
                    self._write_segment(segment, first_segment, False)
                    wrote_segment = True
                    first_segment = False
                    self._write_silence(silence)

            if previous is not None and not self.cancel_event.is_set():
                self._write_segment(previous, first_segment, True)
                wrote_segment = True

            if not wrote_segment and not self.cancel_event.is_set():
                raise RuntimeError("模型未生成任何音频")
        except Exception as error:
            self.producer_error = error
        finally:
            if self.encoder is not None:
                try:
                    self.encoder.close_input()
                except Exception as error:
                    if self.producer_error is None:
                        self.producer_error = error

    def _write_segment(self, segment, fade_in: bool, fade_out: bool) -> None:
        if self.encoder is None or self.cancel_event.is_set():
            return
        if self.fade_ms > 0:
            segment = _stream_segment_with_fade(
                segment, self.sample_rate, self.fade_ms, fade_in, fade_out
            )
        self.encoder.write(segment)

    def _write_silence(self, silence: Optional[np.ndarray]) -> None:
        if (
            self.encoder is not None
            and silence is not None
            and silence.size
            and not self.cancel_event.is_set()
        ):
            self.encoder.write(silence)

    def _silence(self):
        silence_samples = max(0, int(self.sample_rate * self.silence_ms / 1000))
        if silence_samples <= 0:
            return None
        return np.zeros(silence_samples, dtype=np.float32)

    def _raise_producer_error_or_encoding_error(self) -> None:
        if self.producer_error is not None:
            raise AudioEncodingError("WebM encoding failed") from self.producer_error
        if self.producer_thread is not None and self.producer_thread.is_alive():
            return
        raise AudioEncodingError("WebM encoding failed")


# ════════════════════════════════════════════════════════════════
#  API 端点
# ════════════════════════════════════════════════════════════════

@app.post(
    "/tts",
    response_class=Response,
    responses={
        200: {
            "content": {"audio/wav": {}, "audio/ogg": {}},
            "description": "PCM 16-bit WAV audio or OGG/Opus audio",
        }
    },
)
async def tts_endpoint(
    request: TTSRequest,
    http_request: Request = None,
    format: Optional[str] = None,
):
    """
    文本转语音。

    接收 JSON {"text": "...", "voice": "am_adam", "speed": 1.0}
    返回 WAV 音频流。
    """
    accept = http_request.headers.get("accept") if http_request else None
    audio_format = _select_audio_format(format, accept)

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
    except AudioEncodingError as e:
        print(f"[ERROR] Audio encoding failed: {e}")
        raise HTTPException(status_code=500, detail="语音生成失败")
    except Exception as e:
        print(f"[ERROR] Inference failed: {e}")
        raise HTTPException(status_code=500, detail="语音生成失败")

    try:
        response = _audio_response(wav, sr, audio_format)
    except AudioEncodingError as e:
        print(f"[ERROR] Audio encoding failed: {e}")
        raise HTTPException(status_code=500, detail="语音生成失败")

    response.headers["X-Inference-Time"] = f"{elapsed:.2f}"
    response.headers["X-Audio-Duration"] = f"{duration:.2f}"
    return response


@app.post(
    "/tts/stream",
    response_class=StreamingResponse,
    responses={
        200: {
            "content": {'audio/webm; codecs="opus"': {}},
            "description": "Streaming WebM/Opus audio",
        }
    },
)
async def tts_stream_endpoint(
    request: TTSRequest,
    format: Optional[str] = None,
):
    """流式文本转语音，返回 MediaSource 兼容的 WebM/Opus。"""
    if format is not None:
        raise HTTPException(status_code=406, detail="不支持的音频格式")

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="文本不能为空")

    voice = request.voice or VOICE
    speed = request.speed if request.speed is not None else DEFAULT_SPEED
    selected_pipeline = _select_pipeline_for_voice(voice)
    if selected_pipeline is None:
        raise HTTPException(status_code=500, detail="语音生成失败")

    lock_acquired = False
    session = None
    try:
        try:
            await asyncio.wait_for(inference_lock.acquire(), timeout=0.05)
            lock_acquired = True
        except asyncio.TimeoutError:
            raise HTTPException(status_code=429, detail="服务器正忙，请稍后重试")

        session = TTSStreamSession(
            pipeline=selected_pipeline,
            text=text,
            voice=voice,
            speed=speed,
            encoder_factory=WebMOpusEncoder,
        )
        session.start()
        first_chunk = await asyncio.to_thread(session.read_first_chunk)
    except HTTPException:
        if session is not None:
            await asyncio.to_thread(session.close)
        if lock_acquired:
            inference_lock.release()
        raise
    except Exception as error:
        print(f"[ERROR] Stream setup failed: {error}")
        if session is not None:
            await asyncio.to_thread(session.close)
        if lock_acquired:
            inference_lock.release()
        raise HTTPException(status_code=500, detail="语音生成失败")

    async def stream_body():
        nonlocal lock_acquired
        try:
            yield first_chunk
            while True:
                chunk = await asyncio.to_thread(session.read_chunk)
                if not chunk:
                    break
                yield chunk
            await asyncio.to_thread(session.finish)
        except AudioEncodingError as error:
            print(f"[ERROR] Stream encoding failed: {error}")
        finally:
            await asyncio.to_thread(session.close)
            if lock_acquired:
                inference_lock.release()
                lock_acquired = False

    return StreamingResponse(
        stream_body(),
        media_type='audio/webm; codecs="opus"',
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Format": "webm-opus",
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
        "gpu": (
            torch.cuda.get_device_name(0)
            if torch and actual_device == "cuda"
            else "N/A"
        ),
        "default_voice": VOICE,
        "default_speed": DEFAULT_SPEED,
    }


@app.get("/voices")
async def list_voices():
    """返回可用声音列表。"""
    return TTS_CATALOG


def _render_catalog_options():
    voice_options = []
    for group in VOICE_GROUPS:
        voice_options.append(f'<optgroup label="{group["label_zh"]}">')
        for voice in group["voices"]:
            selected = " selected" if voice["id"] == VOICE else ""
            voice_options.append(
                f'<option value="{voice["id"]}"{selected}>'
                f'{voice["id"]} — {voice["label_zh"]}</option>'
            )
        voice_options.append("</optgroup>")

    speed_options = []
    for speed in SPEEDS:
        selected = " selected" if speed == DEFAULT_SPEED else ""
        speed_options.append(
            f'<option value="{speed}"{selected}>{speed}x</option>'
        )
    return "\n".join(voice_options), "\n".join(speed_options)


@app.get("/", response_class=HTMLResponse)
async def test_page():
    """内置测试页面。"""
    page = """
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
      <select id="voice">__VOICE_OPTIONS__</select>
    </div>
    <div>
      <label for="speed">语速</label>
      <select id="speed">__SPEED_OPTIONS__</select>
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
    voice_options, speed_options = _render_catalog_options()
    return page.replace("__VOICE_OPTIONS__", voice_options).replace(
        "__SPEED_OPTIONS__", speed_options
    )


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
