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
import json
import math
import os
import re
import sys
import threading
import time
import warnings
from pathlib import Path
from typing import Optional
from urllib import error as urllib_error
from urllib import request as urllib_request

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
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_TRANSLATE_MODEL = os.environ.get("OLLAMA_TRANSLATE_MODEL", "translategemma:4b")
OLLAMA_FORMULA_MODEL = os.environ.get("OLLAMA_FORMULA_MODEL", "translategemma:4b")
OLLAMA_READ_MODEL = os.environ.get("OLLAMA_READ_MODEL", "translategemma:4b")
OLLAMA_TRANSLATE_TIMEOUT = float(os.environ.get("OLLAMA_TRANSLATE_TIMEOUT", "90"))
MATH_GLOSSARY_FILE = Path(__file__).resolve().parent / "config" / "math_glossary.json"
_GLOSSARY_SYMBOL_ALIASES = {
    "double_arrow": "right_double_arrow",
    "tilde": "tilde_accent",
}
_GLOSSARY_CANDIDATE_ALIASES = {
    ("right_arrow", "mapping"): "function_type",
    ("right_arrow", "derives"): "informal_derivation",
    ("right_arrow", "data_construction"): "informal_derivation",
    ("right_arrow", "points_to"): "literal",
    ("mapsto", "mapping"): "element_mapping",
    ("equals", "defined_as"): "definition_by_context",
    ("tuple", "tuple"): "ordered_tuple",
    ("sqrt", "sqrt"): "square_root",
}

if VOICE not in AVAILABLE_VOICES:
    raise ValueError(f"Unsupported KOKORO_VOICE: {VOICE}")
if not math.isfinite(DEFAULT_SPEED) or not 0.5 <= DEFAULT_SPEED <= 2.0:
    raise ValueError("KOKORO_SPEED must be a finite number between 0.5 and 2.0")
if SEGMENT_SILENCE_MS < 0 or FADE_MS < 0:
    raise ValueError("Audio timing values cannot be negative")
if OLLAMA_TRANSLATE_TIMEOUT <= 0:
    raise ValueError("OLLAMA_TRANSLATE_TIMEOUT must be positive")


def _load_math_glossary() -> dict:
    try:
        with MATH_GLOSSARY_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"version": 0, "symbols": []}
    if not isinstance(data, dict):
        raise ValueError("math_glossary.json must contain an object")
    symbols = data.get("symbols", [])
    if not isinstance(symbols, list):
        raise ValueError("math_glossary.json symbols must be a list")
    for item in symbols:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise ValueError("Each math glossary symbol must have an id")
    return data


MATH_GLOSSARY = _load_math_glossary()


def _glossary_symbol(symbol_id: str) -> dict:
    for item in MATH_GLOSSARY.get("symbols", []):
        if item.get("id") == symbol_id:
            return item
    alias = _GLOSSARY_SYMBOL_ALIASES.get(symbol_id)
    if alias:
        for item in MATH_GLOSSARY.get("symbols", []):
            if item.get("id") == alias:
                return item
    return {}


def _glossary_candidate(symbol_id: str, candidate_id: str | None = None, lang: str = "zh") -> str:
    symbol = _glossary_symbol(symbol_id)
    if not symbol:
        return ""
    selected_id = candidate_id or symbol.get("default_candidate") or symbol.get("semantic_default")
    for candidate in symbol.get("candidates", []):
        if candidate.get("id") == selected_id:
            return str(candidate.get(lang) or "")
    alias = _GLOSSARY_CANDIDATE_ALIASES.get((symbol.get("id", symbol_id), selected_id or ""))
    if alias:
        for candidate in symbol.get("candidates", []):
            if candidate.get("id") == alias:
                return str(candidate.get(lang) or "")
    if not candidate_id:
        read_aloud = symbol.get("read_aloud") or {}
        default_key = "default_zh" if lang == "zh" else "default_en"
        if read_aloud.get(default_key):
            return str(read_aloud[default_key])
    direct = symbol.get("direct", {})
    return str(direct.get(lang) or "")


def _glossary_direct(symbol_id: str, lang: str = "zh") -> str:
    symbol = _glossary_symbol(symbol_id)
    direct = symbol.get("direct", {}) if symbol else {}
    return str(direct.get(lang) or "")


def _math_glossary_prompt(lang: str = "zh", max_symbols: int = 40) -> str:
    lines = [
        "Math glossary. Choose the reading that best fits the formula and nearby context; use the direct reading when semantics are unclear.",
    ]
    for item in MATH_GLOSSARY.get("symbols", [])[:max_symbols]:
        forms = ", ".join(item.get("forms", [])[:4])
        direct = (item.get("direct") or {}).get(lang, "")
        read_aloud = item.get("read_aloud") or {}
        default_key = "default_zh" if lang == "zh" else "default_en"
        default = read_aloud.get(default_key) or _glossary_candidate(item.get("id", ""), None, lang)
        candidate_parts = []
        for candidate in item.get("candidates", [])[:8]:
            reading = candidate.get(lang)
            if reading:
                candidate_parts.append(f"{candidate.get('id')}={reading}")
        candidates = "; ".join(candidate_parts)
        category = item.get("category", "")
        label = f"{category}; " if category else ""
        lines.append(f"- {forms}: {label}direct={direct}; default={default}; candidates={candidates}")
    return "\n".join(lines)

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

def _start_watchdog():
    tray_pid_str = os.environ.get("KOKORO_TRAY_PID")
    if not tray_pid_str:
        return
    try:
        tray_pid = int(tray_pid_str)
    except ValueError:
        return

    def watchdog_loop():
        import ctypes
        kernel32 = ctypes.windll.kernel32
        PROCESS_QUERY_INFORMATION = 0x0400
        while True:
            time.sleep(5)
            h_process = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, tray_pid)
            if not h_process:
                print(f"\\n[WATCHDOG] Parent tray process {tray_pid} is dead. Exiting server.")
                os._exit(0)
            else:
                kernel32.CloseHandle(h_process)

    t = threading.Thread(target=watchdog_loop, daemon=True)
    t.start()
    print(f"[WATCHDOG] Monitoring parent process PID: {tray_pid}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用启动时加载模型，关闭时释放。"""
    global pipeline, british_pipeline, actual_device

    _start_watchdog()

    validate_ffmpeg()

    if torch is None:
        raise RuntimeError("PyTorch is required to start the TTS model")
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
    version="1.7.6",
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

class TranslateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=12000)
    context: Optional[str] = Field(default=None, max_length=12000)
    model: Optional[str] = Field(default=None, max_length=120)
    target_language: Optional[str] = Field(default="Simplified Chinese", max_length=80)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value):
        if value is None:
            return value
        model = value.strip()
        if not model:
            raise ValueError("model cannot be blank")
        if any(ch.isspace() for ch in model):
            raise ValueError("model cannot contain whitespace")
        return model

    @field_validator("target_language")
    @classmethod
    def validate_target_language(cls, value):
        if value is None:
            return "Simplified Chinese"
        target_language = value.strip()
        if not target_language:
            raise ValueError("target_language cannot be blank")
        return target_language


class TranslateResponse(BaseModel):
    text: str
    translated_text: str
    model: str
    target_language: str
    elapsed: float


class ReadPrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(max_length=12000)
    model: Optional[str] = Field(default=None, max_length=120)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value):
        if value is None:
            return value
        model = value.strip()
        if not model:
            raise ValueError("model cannot be blank")
        if any(ch.isspace() for ch in model):
            raise ValueError("model cannot contain whitespace")
        return model


class ReadPrepareResponse(BaseModel):
    text: str
    prepared_text: str
    model: str
    elapsed: float


class FormulaVerbalizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    formulas: list[str] = Field(min_length=1, max_length=20)
    context: Optional[str] = Field(default=None, max_length=4000)
    model: Optional[str] = Field(default=None, max_length=120)

    @field_validator("formulas")
    @classmethod
    def validate_formulas(cls, value):
        cleaned = []
        for formula in value:
            if not isinstance(formula, str):
                raise ValueError("formula must be text")
            formula = formula.strip()
            if not formula:
                raise ValueError("formula cannot be blank")
            if len(formula) > 1000:
                raise ValueError("formula is too long")
            cleaned.append(formula)
        return cleaned

    @field_validator("model")
    @classmethod
    def validate_model(cls, value):
        if value is None:
            return value
        model = value.strip()
        if not model:
            raise ValueError("model cannot be blank")
        if any(ch.isspace() for ch in model):
            raise ValueError("model cannot contain whitespace")
        return model


class FormulaVerbalizeResponse(BaseModel):
    verbalizations: list[str]
    model: str
    elapsed: float


class TranslateHealthResponse(BaseModel):
    status: str
    ollama_reachable: bool
    model: str
    model_available: bool
    model_running: bool
    available_models: list[str]
    running_models: list[str]
    error: Optional[str] = None


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


def _clean_translation_response(text: str) -> str:
    cleaned = re.sub(r"(?is)<think>.*?</think>", "", text or "").strip()
    if cleaned.startswith("```") and cleaned.endswith("```"):
        lines = cleaned.splitlines()
        if len(lines) >= 2:
            cleaned = "\n".join(lines[1:-1]).strip()
    return cleaned.strip().strip('"').strip()


def _normalize_llm_source_text(text: str) -> str:
    value = re.sub(r"[\u200b-\u200f\ufeff]", "", text or "")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = []
    for paragraph in re.split(r"\n\s*\n+", value):
        normalized = re.sub(r"[ \t]*\n[ \t]*", " ", paragraph)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if normalized:
            paragraphs.append(normalized)
    return "\n\n".join(paragraphs)


def _normalize_translation_context(context: Optional[str], selected_text: str) -> Optional[str]:
    normalized = _normalize_llm_source_text((context or "").strip())
    selected = _normalize_llm_source_text(selected_text)
    if not normalized or normalized == selected:
        return None
    if selected and selected in normalized:
        normalized = normalized.replace(selected, "[SELECTED_TEXT]", 1)
    if len(normalized) > 4000:
        normalized = normalized[:4000].rsplit(" ", 1)[0].strip() or normalized[:4000].strip()
    return normalized


def _call_ollama_json(path: str, timeout: float = 5.0):
    req = urllib_request.Request(
        f"{OLLAMA_BASE_URL}{path}",
        headers={"Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib_error.HTTPError as error:
        raise RuntimeError(f"Ollama returned HTTP {error.code}") from error
    except urllib_error.URLError as error:
        raise RuntimeError("Cannot connect to Ollama") from error
    except TimeoutError as error:
        raise RuntimeError("Ollama request timed out") from error

    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ollama returned invalid JSON") from error


def _ollama_model_names(payload) -> list[str]:
    names = []
    for item in payload.get("models", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("model")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _protect_formulas(text: str) -> tuple[str, list[tuple[str, str]]]:
    formulas = []
    pattern = re.compile(
        r"(\[\[MATH:\s*(.*?)\s*\]\]|"
        r"\$\$([\s\S]*?)\$\$|"
        r"\\\[([\s\S]*?)\\\]|"
        r"\\\(([\s\S]*?)\\\)|"
        r"\$([^$\n]+?)\$)"
    )

    def replace(match):
        full_match = match.group(0)
        idx = len(formulas)
        placeholder = f"__MATH_{idx}__"
        formulas.append((placeholder, full_match))
        return placeholder

    protected_text = pattern.sub(replace, text)
    bare_pattern = re.compile(
        r"(?<![A-Za-z0-9_\\])("
        r"\\hat\s*\{?[A-Za-z][A-Za-z0-9]*\}?(?:\([^()\n]+\))?|"
        r"[A-Za-z][A-Za-z0-9]*_\{?[^{}\s,.;:，。；：)）]+\}?(?:\([^()\n]+\))?"
        r")(?![A-Za-z0-9_])"
    )
    protected_text = bare_pattern.sub(replace, protected_text)
    return protected_text, formulas


def _restore_formulas(text: str, formulas: list[tuple[str, str]]) -> str:
    result = text
    for placeholder, original in formulas:
        cleaned = original
        if cleaned.startswith("[[MATH:") and cleaned.endswith("]]"):
            content = cleaned[7:-2].strip()
            cleaned = f"${content}$"
        result = result.replace(placeholder, cleaned)
    return result


def _unwrap_formula_for_translation(formula: str) -> str:
    cleaned = (formula or "").strip()
    if cleaned.startswith("[[MATH:") and cleaned.endswith("]]"):
        return cleaned[7:-2].strip()
    if cleaned.startswith("$$") and cleaned.endswith("$$"):
        return cleaned[2:-2].strip()
    if cleaned.startswith("\\[") and cleaned.endswith("\\]"):
        return cleaned[2:-2].strip()
    if cleaned.startswith("\\(") and cleaned.endswith("\\)"):
        return cleaned[2:-2].strip()
    if cleaned.startswith("$") and cleaned.endswith("$"):
        return cleaned[1:-1].strip()
    return cleaned


_FORMULA_SYMBOL_LATEX = {
    "α": r"\alpha",
    "β": r"\beta",
    "γ": r"\gamma",
    "δ": r"\delta",
    "ε": r"\epsilon",
    "λ": r"\lambda",
    "μ": r"\mu",
    "π": r"\pi",
    "σ": r"\sigma",
    "θ": r"\theta",
    "Θ": r"\Theta",
    "ω": r"\omega",
    "Ω": r"\Omega",
    "→": r"\to",
    "↦": r"\mapsto",
    "⇒": r"\Rightarrow",
    "≤": r"\le",
    "≥": r"\ge",
    "≠": r"\ne",
    "≈": r"\approx",
    "×": r"\times",
    "·": r"\cdot",
    "∈": r"\in",
    "∑": r"\sum",
    "∫": r"\int",
    "∞": r"\infty",
    "∂": r"\partial",
    "∇": r"\nabla",
}


def _formula_content_as_latex(formula: str) -> str:
    value = _unwrap_formula_for_translation(formula)
    if not value:
        return ""

    value = value.replace("\u00a0", " ")
    value = re.sub(
        r"([A-Za-zΑ-Ωα-ω])\u0302",
        lambda match: rf"\hat{{{match.group(1)}}}",
        value,
    )
    value = re.sub(
        r"([A-Za-zΑ-Ωα-ω])\u0304",
        lambda match: rf"\bar{{{match.group(1)}}}",
        value,
    )
    value = re.sub(
        r"([A-Za-zΑ-Ωα-ω])\u0303",
        lambda match: rf"\tilde{{{match.group(1)}}}",
        value,
    )
    for symbol, latex in _FORMULA_SYMBOL_LATEX.items():
        value = value.replace(symbol, latex)
    return value.strip()


def _format_formula_for_translation(formula: str) -> str:
    original = (formula or "").strip()
    content = _formula_content_as_latex(original)
    if not content:
        return original
    if original.startswith(("$$", r"\[")):
        return f"$${content}$$"
    return f"${content}$"


def _restore_formulas_for_display(text: str, formulas: list[tuple[str, str]]) -> str:
    result = text
    for placeholder, original in formulas:
        result = result.replace(placeholder, _format_formula_for_translation(original))
    return result


_FORMULA_SYMBOL_DISPLAY = {
    r"\alpha": "α",
    r"\beta": "β",
    r"\gamma": "γ",
    r"\delta": "δ",
    r"\epsilon": "ε",
    r"\varepsilon": "ε",
    r"\lambda": "λ",
    r"\mu": "μ",
    r"\pi": "π",
    r"\sigma": "σ",
    r"\theta": "θ",
    r"\Theta": "Θ",
    r"\omega": "ω",
    r"\Omega": "Ω",
    r"\rightarrow": "→",
    r"\to": "→",
    r"\mapsto": "↦",
    r"\Rightarrow": "⇒",
    r"\le": "≤",
    r"\ge": "≥",
    r"\neq": "≠",
    r"\ne": "≠",
    r"\approx": "≈",
    r"\times": "×",
    r"\cdot": "·",
    r"\in": "∈",
    r"\sum": "∑",
    r"\int": "∫",
}


_FORMULA_SYMBOL_ZH = {
    "alpha": "alpha",
    "beta": "beta",
    "gamma": "gamma",
    "delta": "delta",
    "epsilon": "epsilon",
    "lambda": "lambda",
    "mu": "mu",
    "pi": "pi",
    "sigma": "sigma",
    "theta": "theta",
    "omega": "omega",
    "α": "alpha",
    "β": "beta",
    "γ": "gamma",
    "δ": "delta",
    "ε": "epsilon",
    "λ": "lambda",
    "μ": "mu",
    "π": "pi",
    "σ": "sigma",
    "θ": "theta",
    "ω": "omega",
}


def _readable_formula_symbol(formula: str) -> str:
    value = _unwrap_formula_for_translation(formula)
    if not value:
        return formula.strip()

    value = re.sub(r"\\(?:left|right)\b", "", value)
    value = value.replace("\\,", " ").replace("\\;", " ").replace("\\!", "")

    value = re.sub(
        r"\\hat\s*\{?([A-Za-zΑ-Ωα-ω])\}?",
        lambda match: f"{match.group(1)}\u0302",
        value,
    )
    value = re.sub(
        r"\\bar\s*\{?([A-Za-zΑ-Ωα-ω])\}?",
        lambda match: f"{match.group(1)}\u0304",
        value,
    )
    value = re.sub(
        r"\\tilde\s*\{?([A-Za-zΑ-Ωα-ω])\}?",
        lambda match: f"{match.group(1)}\u0303",
        value,
    )

    for latex, symbol in _FORMULA_SYMBOL_DISPLAY.items():
        value = value.replace(latex, symbol)

    value = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1)/(\2)", value)
    value = re.sub(r"\\sqrt\{([^{}]+)\}", r"√(\1)", value)
    value = value.replace(r"\{", "{").replace(r"\}", "}")
    value = re.sub(r"\\([A-Za-z]+)", r"\1", value)
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*([=,+*/(){}])\s*", r"\1", value)
    value = re.sub(r"\s*(→|↦|⇒|≤|≥|≠|≈|∈)\s*", r" \1 ", value)
    return value.strip()


def _display_formula_for_translation(formula: str) -> str:
    return _readable_formula_symbol(formula)


def _normalize_formula_for_description(formula: str) -> str:
    value = (
        _unwrap_formula_for_translation(formula)
        .replace("\\rightarrow", "\\to")
        .replace("\\mapsto", "\\to")
        .replace("→", "\\to")
        .replace("⇒", "\\to")
        .replace(r"\{", "{")
        .replace(r"\}", "}")
        .replace("\\left", "")
        .replace("\\right", "")
        .strip()
    )
    for latex, symbol in _FORMULA_SYMBOL_DISPLAY.items():
        if latex.startswith("\\") and len(latex) > 2:
            name = latex[1:]
            if name in _FORMULA_SYMBOL_ZH:
                value = value.replace(latex, name)
    return value


def _describe_formula_token_zh(token: str) -> str:
    value = (token or "").strip().strip("{} ")
    if value.startswith("\\"):
        value = value[1:]
    return _FORMULA_SYMBOL_ZH.get(value, value)


def _choose_right_arrow_candidate(value: str, left: str, right: str) -> str:
    left_s = (left or "").strip()
    right_s = (right or "").strip()
    whole = value or ""
    if "=" in right_s or re.search(r"\\?\{.*\\?\}", right_s):
        return "data_construction"
    if re.search(r"\\hat|hat|估计|estimate", right_s, flags=re.IGNORECASE):
        return "data_construction"
    if re.search(r"^D(?:_|[A-Za-z0-9{}^])*", left_s) and re.search(
        r"[A-Za-z]|\\hat|hat",
        right_s,
        flags=re.IGNORECASE,
    ):
        return "data_construction"
    if ":" in left_s:
        return "function_type"
    if re.fullmatch(r"(?:\\?[A-Za-z]+|[A-Za-z][A-Za-z0-9_{}^]*)", left_s) and re.fullmatch(
        r"(?:0|1|-?\\d+(?:\\.\\d+)?|\\infty|infty|∞)",
        right_s,
    ):
        return "limit"
    if any(token in whole for token in ("\\forall", "\\exists", "\\land", "\\lor", "\\implies")):
        return "derives"
    if re.search(r"\b(if|then|therefore|implies)\b", whole, flags=re.IGNORECASE):
        return "derives"
    return "points_to"


def _split_top_level_commas(text: str) -> list[str]:
    parts = []
    depth = 0
    start = 0
    pairs = {"{": "}", "(": ")", "[": "]"}
    closing = set(pairs.values())
    for i, char in enumerate(text):
        if char in pairs:
            depth += 1
        elif char in closing:
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            parts.append(text[start:i].strip())
            start = i + 1
    parts.append(text[start:].strip())
    return [part for part in parts if part]


def _describe_formula_atom_zh(expr: str) -> str:
    value = _normalize_formula_for_description(expr)
    if not value:
        return ""

    if value.startswith("{") and value.endswith("}"):
        inner = value[1:-1].strip()
        inner_desc = _describe_formula_atom_zh(inner)
        set_word = _glossary_candidate("set_braces", "set", "zh") or "集合"
        return f"由{inner_desc}组成的{set_word}" if inner_desc else set_word

    if value.startswith("(") and value.endswith(")"):
        inner = value[1:-1].strip()
        parts = _split_top_level_commas(inner)
        if len(parts) >= 2:
            tuple_word = _glossary_candidate("tuple", "tuple", "zh") or "元组"
            names = {2: f"二{tuple_word}", 3: f"三{tuple_word}", 4: f"四{tuple_word}"}
            tuple_name = names.get(len(parts), f"{len(parts)}{tuple_word}")
            return f"{tuple_name}（{'、'.join(_describe_formula_atom_zh(part) for part in parts)}）"

    value = value.strip().strip("{} ")

    hat_match = re.fullmatch(r"\\hat\s*\{?([A-Za-z][A-Za-z0-9]*)\}?(?:\((.+)\))?", value)
    if hat_match:
        base, arg = hat_match.groups()
        reading = _glossary_candidate("hat", "estimate", "zh") or "估计值"
        if arg:
            return f"{_describe_formula_token_zh(base)}的估计函数在{_describe_formula_atom_zh(arg)}处的值"
        return f"{_describe_formula_token_zh(base)}的{reading}"

    sub_func = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*)_\{?([^{}()\s]+)\}?\((.+)\)", value)
    if sub_func:
        base, sub, arg = sub_func.groups()
        sub_reading = _glossary_candidate("subscript", "index", "zh") or "下角标"
        return (
            f"{_describe_formula_token_zh(base)}的{sub_reading}{_describe_formula_token_zh(sub)}"
            f"在{_describe_formula_atom_zh(arg)}处的值"
        )

    sub_match = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*)_\{?([^{}()\s]+)\}?", value)
    if sub_match:
        base, sub = sub_match.groups()
        sub_reading = _glossary_candidate("subscript", "index", "zh") or "下角标"
        return f"{_describe_formula_token_zh(base)}的{sub_reading}{_describe_formula_token_zh(sub)}"

    sup_match = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*)\^\{?([^{}()\s]+)\}?", value)
    if sup_match:
        base, sup = sup_match.groups()
        base_desc = _describe_formula_token_zh(base)
        sup_desc = _describe_formula_token_zh(sup)
        if sup == "2":
            return f"{base_desc}的{_glossary_candidate('superscript', 'square', 'zh') or '平方'}"
        if sup == "3":
            return f"{base_desc}的{_glossary_candidate('superscript', 'cube', 'zh') or '立方'}"
        if sup == "T":
            return f"{base_desc}的{_glossary_candidate('superscript', 'transpose', 'zh') or '转置'}"
        if sup == "-1":
            return f"{base_desc}的{_glossary_candidate('superscript', 'inverse', 'zh') or '逆'}"
        sup_reading = _glossary_candidate("superscript", "power", "zh") or "上角标"
        return f"{base_desc}的{sup_reading}{sup_desc}"

    func_match = re.fullmatch(r"([A-Za-z][A-Za-z0-9]*)\((.+)\)", value)
    if func_match:
        base, arg = func_match.groups()
        return f"{_describe_formula_token_zh(base)}在{_describe_formula_atom_zh(arg)}处的值"

    frac_match = re.fullmatch(r"\\frac\{(.+)\}\{(.+)\}", value)
    if frac_match:
        numerator, denominator = frac_match.groups()
        return f"{_describe_formula_atom_zh(denominator)} 分之 {_describe_formula_atom_zh(numerator)}"

    sqrt_match = re.fullmatch(r"\\sqrt\{(.+)\}", value)
    if sqrt_match:
        sqrt_reading = _glossary_direct("sqrt", "zh") or "根号"
        return f"{sqrt_reading} {_describe_formula_atom_zh(sqrt_match.group(1))}"

    return _readable_formula_symbol(value).replace("\\", "").strip()


def _split_top_level_formula(text: str, separator: str) -> list[str]:
    parts = []
    depth = 0
    start = 0
    i = 0
    while i < len(text):
        char = text[i]
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        elif depth == 0 and text.startswith(separator, i):
            parts.append(text[start:i].strip())
            i += len(separator)
            start = i
            continue
        i += 1
    parts.append(text[start:].strip())
    return [part for part in parts if part]


def _rule_describe_formula_zh(formula: str) -> str:
    value = _normalize_formula_for_description(formula)
    if not value:
        return ""

    arrow_parts = _split_top_level_formula(value, "\\to")
    if len(arrow_parts) == 2:
        arrow_candidate = _choose_right_arrow_candidate(value, arrow_parts[0], arrow_parts[1])
        right_equals = _split_top_level_formula(arrow_parts[1], "=")
        if len(right_equals) == 2:
            target = _describe_formula_atom_zh(right_equals[0])
            definition = _describe_formula_atom_zh(right_equals[1])
            gives = _glossary_candidate("right_arrow", "data_construction", "zh") or "得到"
            defined_as = _glossary_candidate("equals", "defined_as", "zh") or "定义为"
            return (
                f"由{_describe_formula_atom_zh(arrow_parts[0])}{gives}{target}，"
                f"{target}{defined_as}{definition}"
            )
        arrow_reading = _glossary_candidate("right_arrow", arrow_candidate, "zh") or _glossary_direct("right_arrow", "zh") or "箭头"
        left_desc = _describe_formula_atom_zh(arrow_parts[0])
        right_desc = _describe_formula_atom_zh(arrow_parts[1])
        if arrow_candidate == "function_type" and ":" in arrow_parts[0]:
            name, domain = arrow_parts[0].split(":", 1)
            return (
                f"{_describe_formula_atom_zh(name)}是从"
                f"{_describe_formula_atom_zh(domain)}到{right_desc}的函数"
            )
        if arrow_candidate == "data_construction":
            return f"由{left_desc}{arrow_reading}{right_desc}"
        return (
            f"{left_desc}"
            f"{arrow_reading}{right_desc}"
        )

    equals_parts = _split_top_level_formula(value, "=")
    if len(equals_parts) == 2:
        equals_reading = _glossary_candidate("equals", "equals", "zh") or "等于"
        return (
            f"{_describe_formula_atom_zh(equals_parts[0])}"
            f"{equals_reading}{_describe_formula_atom_zh(equals_parts[1])}"
        )

    if any(token in value for token in ("\\begin", "\\sum", "\\int", "\\prod", "\\cases")):
        return ""

    return _describe_formula_atom_zh(value)


def _clean_formula_verbalization_zh(value: str) -> str:
    cleaned = _clean_translation_response(value)
    cleaned = cleaned.strip("。，. \t\r\n-*")
    return cleaned or "公式"


def _parse_formula_verbalizations_zh(raw: str, expected_count: int) -> list[str]:
    cleaned = _clean_translation_response(raw)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            parsed = parsed.get("verbalizations") or parsed.get("formulas")
        if isinstance(parsed, list):
            values = [_clean_formula_verbalization_zh(str(item)) for item in parsed]
            if len(values) >= expected_count:
                return values[:expected_count]
    except json.JSONDecodeError:
        pass

    lines = []
    for line in cleaned.splitlines():
        line_s = line.strip()
        if not line_s:
            continue
        line_s = re.sub(r'^(?:\d+\.|[-*])\s*', '', line_s)
        cleaned_val = _clean_formula_verbalization_zh(line_s)
        if cleaned_val:
            lines.append(cleaned_val)
            
    if len(lines) >= expected_count:
        return lines[:expected_count]
    return lines + ["公式"] * (expected_count - len(lines))


def _call_ollama_formula_verbalization_zh_single(
    formula: str,
    model: str,
    context: Optional[str] = None,
) -> str:
    rule_desc = _rule_describe_formula_zh(formula)
    if rule_desc:
        return rule_desc

    cf = formula.strip()
    cf = _unwrap_formula_for_translation(cf)

    context_block = (context or "").strip()
    prompt = f"Formula: {cf}"
    if context_block:
        prompt = f"Context: {context_block[:4000]}\nFormula: {cf}"

    glossary_prompt = _math_glossary_prompt("zh")
    payload = {
        "model": model,
        "stream": False,
        "system": (
            "You convert a mathematical formula into a professional spoken Simplified Chinese description (口语化中文描述).\n"
            "Describe only what is written; never solve, simplify, calculate, or infer missing meanings.\n"
            "Return ONLY the spoken description, with no reasoning, notes, markdown fences, symbols, or explanations.\n\n"
            "数学术语及读法规范对照表 (Mathematical Glossary & Reading Standards):\n"
            "1. 上标/修饰符 (Superscripts/Modifiers):\n"
            "   - \\hat{x} 或 \\hat x (Hat): 读作 'x的估计量'；\\hat{B}(x) 读作 'B的估计函数在x处的值'\n"
            "   - \\bar{x} 或 \\bar x (Bar): 读作 'x的平均值' 或 'x拔'\n"
            "   - \\tilde{x} 或 \\tilde x (Tilde): 读作 'x波浪号'\n"
            "   - x^* (Conjugate): 读作 'x的共轭' 或 'x星'\n"
            "   - x^T (Transpose): 读作 'x的转置'\n"
            "   - x^{-1} (Inverse): 读作 'x的逆'\n"
            "2. 下标 (Subscripts):\n"
            "   - x_i: 读作 'x的下标i'\n"
            "   - D_w: 读作 'D的下标w'\n"
            "3. 箭头与关系符 (Arrows & Relations):\n"
            "   - \\rightarrow 或 \\to: 优先按上下文读作 '指向'、'得到'、'转为'；只有函数映射语境才读作 '映射到'\n"
            "   - \\le: 读作 '小于等于'\n"
            "   - \\ge: 读作 '大于等于'\n"
            "   - \\approx: 读作 '约等于'\n"
            "   - \\neq: 读作 '不等于'\n"
            "4. 常见数学函数与运算 (Functions & Operators):\n"
            "   - f(x): 读作 'f在x处的值'\n"
            "   - \\frac{a}{b}: 读作 'b分之a'\n"
            "   - \\sqrt{x}: 读作 '根号x'\n"
            "   - \\sum: 读作 '求和'\n"
            "   - \\partial: 读作 '偏导数'\n\n"
            "请参考上述规范，生成最符合学术和口语化标准的中文描述。\n"
            "Example: 'E = mc^2' -> 'E等于m乘以c的平方'.\n"
            "Example: 'D_w \\rightarrow \\hat{B}(x)' -> '由D的下标w得到B的估计函数在x处的值'.\n"
            "Example: 'B_\\theta(x) \\rightarrow D_w = \\{(x_i, B_\\theta(x_i), w_i)\\}' -> "
            "'由B的下标theta在x处的值得到D的下标w，D的下标w定义为由三元组组成的集合'.\n\n"
            f"{glossary_prompt}"
        ),
        "prompt": prompt,
        "options": {
            "temperature": 0.1,
            "top_p": 0.9,
        },
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib_request.Request(
        f"{OLLAMA_BASE_URL}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(req, timeout=OLLAMA_TRANSLATE_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib_error.HTTPError as error:
        raise RuntimeError(f"Ollama returned HTTP {error.code}") from error
    except urllib_error.URLError as error:
        raise RuntimeError("Cannot connect to Ollama") from error
    except TimeoutError as error:
        raise RuntimeError("Ollama formula verbalization timed out") from error

    try:
        response_payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ollama returned invalid JSON") from error

    desc = _clean_formula_verbalization_zh(response_payload.get("response", ""))
    return desc


def _call_ollama_formula_verbalization_zh(
    formulas: list[str],
    model: str,
    context: Optional[str] = None,
) -> list[str]:
    return [
        _call_ollama_formula_verbalization_zh_single(f, model, context)
        for f in formulas
    ]


def _restore_formulas_with_verbalizations(
    text: str,
    formulas: list[tuple[str, str]],
    verbalizations_zh: list[str],
) -> str:
    result = text
    for idx, (placeholder, original) in enumerate(formulas):
        cleaned = _display_formula_for_translation(original)
            
        desc = ""
        if verbalizations_zh and idx < len(verbalizations_zh):
            desc = verbalizations_zh[idx].strip()
            
        if desc and desc != "公式":
            replacement = f"{cleaned}（{desc}）"
        else:
            replacement = cleaned
            
        result = result.replace(placeholder, replacement)
    return result


def _call_ollama_translate_raw(
    protected_text: str,
    model: str,
    target_language: str,
    context: Optional[str] = None,
) -> str:
    prompt = protected_text
    if context:
        prompt = (
            "<REFERENCE_CONTEXT_DO_NOT_TRANSLATE>\n"
            f"{context}\n"
            "</REFERENCE_CONTEXT_DO_NOT_TRANSLATE>\n\n"
            "<SELECTED_TEXT_TRANSLATE_ONLY>\n"
            f"{protected_text}\n"
            "</SELECTED_TEXT_TRANSLATE_ONLY>"
        )
    payload = {
        "model": model,
        "stream": False,
        "system": (
            "You are a precise translation engine. The input contains text with placeholders "
            "like __MATH_0__, __MATH_1__, etc. which represent mathematical formulas. "
            "Use surrounding context only to choose accurate terminology, pronoun references, and domain-specific wording. "
            "The context is not part of the requested output. Translate ONLY the content inside <SELECTED_TEXT_TRANSLATE_ONLY>. "
            "Never translate or summarize anything inside <REFERENCE_CONTEXT_DO_NOT_TRANSLATE>. "
            "If the reference context contains [SELECTED_TEXT], treat it only as a location marker and never output it. "
            f"Translate the prose into {target_language}. Translate faithfully sentence by sentence; do not summarize, reinterpret, or add claims. "
            "If the selected prose is already in the target language, keep it unchanged except for Simplified/Traditional normalization and necessary term cleanup. "
            "Keep all names, numbers, and punctuation. "
            "CRITICAL: Do NOT translate, modify, omit, or change the capitalization of the placeholders (e.g. __MATH_0__). Keep them exactly as they are. "
            "Keep placeholders in the same relative positions; the server will restore them as formulas for the browser renderer, so do not create extra LaTeX yourself. "
            "Return only the translated text, with no reasoning, notes, markdown fences, or explanations."
        ),
        "prompt": prompt,
        "options": {
            "temperature": 0.1,
            "top_p": 0.9,
        },
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib_request.Request(
        f"{OLLAMA_BASE_URL}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(req, timeout=OLLAMA_TRANSLATE_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib_error.HTTPError as error:
        raise RuntimeError(f"Ollama returned HTTP {error.code}") from error
    except urllib_error.URLError as error:
        raise RuntimeError("Cannot connect to Ollama") from error
    except TimeoutError as error:
        raise RuntimeError("Ollama translation timed out") from error

    try:
        response_payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ollama returned invalid JSON") from error

    translated = _clean_translation_response(response_payload.get("response", ""))
    if not translated:
        raise RuntimeError("Ollama returned an empty translation")

    return translated


def _contains_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff\uf900-\ufaff]", text or ""))


def _remove_remaining_cjk_for_tts(text: str) -> str:
    cleaned = (text or "").replace("\u5176\u4e2d", "where ")
    cleaned = re.sub(r"[\u3400-\u9fff\uf900-\ufaff]+", " ", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned)
    return cleaned.strip()


def _call_ollama_text_generation(
    *,
    model: str,
    system: str,
    prompt: str,
    timeout_detail: str,
    empty_detail: str,
) -> str:
    payload = {
        "model": model,
        "stream": False,
        "system": system,
        "prompt": prompt,
        "options": {
            "temperature": 0.1,
            "top_p": 0.9,
        },
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib_request.Request(
        f"{OLLAMA_BASE_URL}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(req, timeout=OLLAMA_TRANSLATE_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib_error.HTTPError as error:
        raise RuntimeError(f"Ollama returned HTTP {error.code}") from error
    except urllib_error.URLError as error:
        raise RuntimeError("Cannot connect to Ollama") from error
    except TimeoutError as error:
        raise RuntimeError(timeout_detail) from error

    try:
        response_payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ollama returned invalid JSON") from error

    result = _clean_translation_response(response_payload.get("response", ""))
    if not result:
        raise RuntimeError(empty_detail)
    return result


def _call_ollama_read_prepare(text: str, model: str) -> str:
    glossary_prompt = _math_glossary_prompt("en")
    system_prompt = (
        "You prepare selected web text for English text-to-speech. The input may "
        "contain Chinese, English, LaTeX, MathJax, formula fragments, formulas wrapped "
        "as [[MATH: ...]], and artificial "
        "line breaks from web selection. Produce fluent plain English read-aloud text. "
        "Keep English prose unchanged except for spacing and obvious selection cleanup. "
        "Translate Chinese prose into natural English. Convert formulas, LaTeX, symbols, "
        "and MathJax fragments into concise spoken English descriptions. Do not copy raw "
        "formula syntax or [[MATH: ...]] wrappers into the output. If [[MATH: ...]] is present, "
        "treat the inside as the authoritative formula semantics. Choose arrow wording from "
        "the glossary, for example maps to, approaches, implies, gives, or arrow; use "
        "equals, defined as, the set of, tuples, and subscript wording only when they fit. "
        "No Chinese characters may remain in the output; translate every Chinese "
        "word, including Chinese inside mixed Chinese-English sentences. Describe only "
        "what is written; never solve, simplify, calculate determinants, "
        "or infer missing results. Remove code blocks, URLs, citation markers, table debris, "
        "and UI text when they are not meaningful prose. Preserve the original order. "
        "Example: input 'B 0 (x) -> D w = {(x i, B 0 (x i), w i)}' should become "
        "'B sub zero of x gives D sub w, which is defined as the set of tuples containing "
        "x sub i, B sub zero of x sub i, and w sub i.' Return only the final English text, "
        "with no notes, markdown fences, labels, or explanations."
        f"\n\n{glossary_prompt}"
    )
    prepared = _call_ollama_text_generation(
        model=model,
        system=system_prompt,
        prompt=text,
        timeout_detail="Ollama read preparation timed out",
        empty_detail="Ollama returned an empty read preparation",
    )
    prepared = re.sub(r"\s+\n", "\n", prepared)
    prepared = re.sub(r"\n{3,}", "\n\n", prepared)
    prepared = re.sub(r"[ \t]{2,}", " ", prepared).strip()
    if not prepared:
        raise RuntimeError("Ollama returned an empty read preparation")
    if _contains_cjk(prepared):
        repair_prompt = (
            "Rewrite the following text as English-only read-aloud text. Translate every "
            "remaining Chinese character or word into English. Keep existing English prose "
            "and spoken formula descriptions. Do not add notes or explanations. Output plain "
            "English only."
        )
        prepared = _call_ollama_text_generation(
            model=model,
            system=repair_prompt,
            prompt=prepared,
            timeout_detail="Ollama read repair timed out",
            empty_detail="Ollama returned an empty read repair",
        )
        prepared = re.sub(r"\s+\n", "\n", prepared)
        prepared = re.sub(r"\n{3,}", "\n\n", prepared)
        prepared = re.sub(r"[ \t]{2,}", " ", prepared).strip()
    if _contains_cjk(prepared):
        prepared = _remove_remaining_cjk_for_tts(prepared)
    return prepared


def _clean_formula_verbalization(value: str) -> str:
    cleaned = _clean_translation_response(value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    cleaned = cleaned.strip("-*0123456789. )(").strip()
    if not cleaned:
        return "formula omitted"
    if len(cleaned) > 220:
        cleaned = cleaned[:220].rsplit(" ", 1)[0].strip()
    return cleaned or "formula omitted"


def _parse_formula_verbalizations(raw: str, expected_count: int) -> list[str]:
    cleaned = _clean_translation_response(raw)
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            parsed = parsed.get("verbalizations") or parsed.get("formulas")
        if isinstance(parsed, list):
            values = [_clean_formula_verbalization(str(item)) for item in parsed]
            if len(values) >= expected_count:
                return values[:expected_count]
    except json.JSONDecodeError:
        pass

    lines = [
        _clean_formula_verbalization(line)
        for line in cleaned.splitlines()
        if line.strip()
    ]
    if len(lines) >= expected_count:
        return lines[:expected_count]
    return lines + ["formula omitted"] * (expected_count - len(lines))


def _call_ollama_formula_verbalization(
    formulas: list[str],
    model: str,
    context: Optional[str] = None,
) -> list[str]:
    context_block = (context or "").strip()
    glossary_prompt = _math_glossary_prompt("en")
    prompt = {
        "context": context_block[:4000],
        "formulas": formulas,
    }
    payload = {
        "model": model,
        "stream": False,
        "system": (
            "You convert math formulas into concise spoken English for text-to-speech. "
            "Describe what is written; never solve, simplify, calculate determinants, infer "
            "missing meanings, or expand beyond the formula. If the formula is a matrix, say "
            "it is a matrix and read its rows or entries. Use nearby context only to choose "
            "natural wording. Return only a JSON array of strings, one spoken description "
            "per input formula, in the same order. Avoid LaTeX, symbols, markdown, and notes. "
            "Example: input '\\begin{matrix} a & b \\\\ c & d \\end{matrix}' -> "
            "'a two by two matrix with first row a, b, and second row c, d'. "
            "Example: input '\\frac{x}{y}' -> 'x over y'."
            f"\n\n{glossary_prompt}"
        ),
        "prompt": json.dumps(prompt, ensure_ascii=False),
        "options": {
            "temperature": 0.1,
            "top_p": 0.9,
        },
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib_request.Request(
        f"{OLLAMA_BASE_URL}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib_request.urlopen(req, timeout=OLLAMA_TRANSLATE_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib_error.HTTPError as error:
        raise RuntimeError(f"Ollama returned HTTP {error.code}") from error
    except urllib_error.URLError as error:
        raise RuntimeError("Cannot connect to Ollama") from error
    except TimeoutError as error:
        raise RuntimeError("Ollama formula verbalization timed out") from error

    try:
        response_payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ollama returned invalid JSON") from error

    return _parse_formula_verbalizations(
        response_payload.get("response", ""),
        len(formulas),
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

@app.get("/translate/health", response_model=TranslateHealthResponse)
async def translate_health(model: Optional[str] = None):
    """Report whether Ollama is reachable and the selected model is loaded."""
    selected_model = (model or OLLAMA_TRANSLATE_MODEL).strip() or OLLAMA_TRANSLATE_MODEL
    try:
        available_models = _ollama_model_names(_call_ollama_json("/api/tags"))
        try:
            running_models = _ollama_model_names(_call_ollama_json("/api/ps"))
        except RuntimeError:
            running_models = []
        model_available = selected_model in available_models
        model_running = selected_model in running_models
        status = "running" if model_running else "available" if model_available else "missing"
        return TranslateHealthResponse(
            status=status,
            ollama_reachable=True,
            model=selected_model,
            model_available=model_available,
            model_running=model_running,
            available_models=available_models,
            running_models=running_models,
        )
    except Exception as error:
        print(f"[ERROR] Ollama health check failed: {error}")
        return TranslateHealthResponse(
            status="error",
            ollama_reachable=False,
            model=selected_model,
            model_available=False,
            model_running=False,
            available_models=[],
            running_models=[],
            error="Cannot connect to Ollama",
        )


@app.post("/translate", response_model=TranslateResponse)
async def translate_endpoint(request: TranslateRequest):
    """Translate text through the local Ollama API."""
    text = _normalize_llm_source_text(request.text.strip())
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    model = request.model or OLLAMA_TRANSLATE_MODEL
    target_language = request.target_language or "Simplified Chinese"
    context = _normalize_translation_context(request.context, text)

    try:
        t0 = time.perf_counter()
        # 1. 提取并保护公式，用 __MATH_N__ 占位符替代
        protected_text, formulas = _protect_formulas(text)
        
        if formulas:
            # 翻译只处理正文；公式通过占位符保护，最后恢复为前端可渲染的公式。
            translated_raw = await asyncio.to_thread(
                _call_ollama_translate_raw,
                protected_text,
                model,
                target_language,
                context,
            )
            # 2. 还原公式，并将 [[MATH: ...]] 等统一渲染为前端可渲染的公式。
            translated_text = _restore_formulas_for_display(translated_raw, formulas)
        else:
            # 无公式，常规翻译
            translated_text = await asyncio.to_thread(
                _call_ollama_translate_raw,
                protected_text,
                model,
                target_language,
                context,
            )
            
        elapsed = time.perf_counter() - t0
        print(
            f"[TRANSLATE] {len(text)} chars -> {len(translated_text)} chars, "
            f"model={model}, took {elapsed:.2f}s"
        )
    except Exception as error:
        print(f"[ERROR] Translation failed: {error}")
        raise HTTPException(status_code=502, detail="Local Ollama translation failed")

    return TranslateResponse(
        text=text,
        translated_text=translated_text,
        model=model,
        target_language=target_language,
        elapsed=round(elapsed, 3),
    )


@app.post("/read/prepare", response_model=ReadPrepareResponse)
async def read_prepare_endpoint(request: ReadPrepareRequest):
    """Prepare selected web text as clean English read-aloud text."""
    text = _normalize_llm_source_text(request.text.strip())
    if not text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    model = request.model or OLLAMA_READ_MODEL

    try:
        t0 = time.perf_counter()
        prepared_text = await asyncio.to_thread(
            _call_ollama_read_prepare,
            text,
            model,
        )
        elapsed = time.perf_counter() - t0
        print(
            f"[READ PREPARE] {len(text)} chars -> {len(prepared_text)} chars, "
            f"model={model}, took {elapsed:.2f}s"
        )
    except Exception as error:
        print(f"[ERROR] Read preparation failed: {error}")
        raise HTTPException(status_code=502, detail="Local read preparation failed")

    return ReadPrepareResponse(
        text=text,
        prepared_text=prepared_text,
        model=model,
        elapsed=round(elapsed, 3),
    )


@app.post("/formula/verbalize", response_model=FormulaVerbalizeResponse)
async def formula_verbalize_endpoint(request: FormulaVerbalizeRequest):
    """Convert formulas into concise spoken English through local Ollama."""
    model = request.model or OLLAMA_FORMULA_MODEL
    try:
        t0 = time.perf_counter()
        verbalizations = await asyncio.to_thread(
            _call_ollama_formula_verbalization,
            request.formulas,
            model,
            _normalize_llm_source_text(request.context or ""),
        )
        elapsed = time.perf_counter() - t0
        print(
            f"[FORMULA] {len(request.formulas)} formulas, model={model}, "
            f"took {elapsed:.2f}s"
        )
    except Exception as error:
        print(f"[ERROR] Formula verbalization failed: {error}")
        raise HTTPException(status_code=502, detail="Local formula verbalization failed")

    return FormulaVerbalizeResponse(
        verbalizations=verbalizations,
        model=model,
        elapsed=round(elapsed, 3),
    )


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
        if http_request and await http_request.is_disconnected():
            print("[TTS] Client disconnected before acquiring lock, aborting.")
            raise HTTPException(status_code=499, detail="Client Closed Request")
        try:
            await asyncio.wait_for(inference_lock.acquire(), timeout=1.0)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=429, detail="Server busy")

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
    http_request: Request,
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
        if await http_request.is_disconnected():
            print("[TTS] Client disconnected before acquiring lock, aborting.")
            raise HTTPException(status_code=499, detail="Client Closed Request")
        try:
            await asyncio.wait_for(inference_lock.acquire(), timeout=1.0)
            lock_acquired = True
        except asyncio.TimeoutError:
            raise HTTPException(status_code=429, detail="Server busy")

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
                if await http_request.is_disconnected():
                    print("[TTS] Client disconnected during generation, aborting.")
                    break
                chunk = await asyncio.to_thread(session.read_chunk)
                if not chunk:
                    break
                yield chunk
            if not await http_request.is_disconnected():
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
        "ollama_base_url": OLLAMA_BASE_URL,
        "default_translate_model": OLLAMA_TRANSLATE_MODEL,
        "default_formula_model": OLLAMA_FORMULA_MODEL,
        "default_read_model": OLLAMA_READ_MODEL,
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
  .option-line {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #bbb;
    margin-top: 16px;
  }
  .option-line input { width: auto; }
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

  <label class="option-line">
    <input type="checkbox" id="streamMode" checked>
    Stream mode (WebM/Opus)
  </label>

  <button class="btn" id="speakBtn" onclick="speak()">🔊 朗读</button>
  <div class="status" id="status"></div>
  <audio id="player" controls style="display:none"></audio>
</div>
<script>
const WEBM_OPUS_MIME = 'audio/webm; codecs="opus"';

function canUseStreamMode() {
  return !!(
    window.MediaSource &&
    MediaSource.isTypeSupported(WEBM_OPUS_MIME) &&
    window.fetch &&
    window.ReadableStream
  );
}

function waitForSourceOpen(mediaSource) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      mediaSource.removeEventListener('sourceopen', onOpen);
      mediaSource.removeEventListener('sourceclose', onClose);
    }
    function onOpen() { cleanup(); resolve(); }
    function onClose() { cleanup(); reject(new Error('MediaSource closed before opening.')); }
    mediaSource.addEventListener('sourceopen', onOpen);
    mediaSource.addEventListener('sourceclose', onClose);
  });
}

function appendBuffer(sourceBuffer, data) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onError);
    }
    function onEnd() { cleanup(); resolve(); }
    function onError() { cleanup(); reject(new Error('SourceBuffer append failed.')); }
    sourceBuffer.addEventListener('updateend', onEnd);
    sourceBuffer.addEventListener('error', onError);
    try {
      sourceBuffer.appendBuffer(data);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function playStream(payload, player, status) {
  const mediaSource = new MediaSource();
  const sourceOpen = waitForSourceOpen(mediaSource);
  const url = URL.createObjectURL(mediaSource);
  player.src = url;
  player.style.display = 'block';
  player.onended = () => URL.revokeObjectURL(url);

  await sourceOpen;
  const sourceBuffer = mediaSource.addSourceBuffer(WEBM_OPUS_MIME);
  const playPromise = player.play();
  playPromise.catch(() => {});

  const resp = await fetch('/tts/stream', {
    method: 'POST',
    headers: {
      'Accept': WEBM_OPUS_MIME,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.detail || resp.statusText); }
  if (!resp.body || !resp.body.getReader) {
    throw new Error('Browser does not expose a streaming response body.');
  }

  const reader = resp.body.getReader();
  let chunks = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      chunks += 1;
      await appendBuffer(sourceBuffer, value);
      status.textContent = `Streaming WebM/Opus... chunks: ${chunks}, played: ${player.currentTime.toFixed(1)}s`;
    }
  }
  if (mediaSource.readyState === 'open') mediaSource.endOfStream();
  return { mode: 'stream', chunks };
}

async function playOgg(payload, player) {
  const resp = await fetch('/tts?format=ogg', {
    method: 'POST',
    headers: {
      'Accept': 'audio/ogg',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) { const e = await resp.json(); throw new Error(e.detail || resp.statusText); }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  player.src = url;
  player.style.display = 'block';
  player.onended = () => URL.revokeObjectURL(url);
  player.play();
  return {
    mode: 'ogg',
    inferTime: resp.headers.get('X-Inference-Time') || '?',
    audioDur: resp.headers.get('X-Audio-Duration') || '?',
  };
}

async function speak() {
  const text = document.getElementById('text').value.trim();
  if (!text) return;
  const voice = document.getElementById('voice').value;
  const speed = parseFloat(document.getElementById('speed').value);
  const streamMode = document.getElementById('streamMode').checked;
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
    const payload = { text, voice, speed };
    const useStream = streamMode && canUseStreamMode();
    if (streamMode && !useStream) {
      status.textContent = 'MediaSource WebM/Opus unavailable; falling back to OGG/Opus...';
    }
    const result = useStream
      ? await playStream(payload, player, status)
      : await playOgg(payload, player);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    status.className = 'status show success';
    if (result.mode === 'stream') {
      status.textContent = `✅ Streaming ready: ${result.chunks} chunks received（setup ${elapsed}s）`;
    } else {
      status.textContent = `✅ 完成！推理 ${result.inferTime}s → 音频 ${result.audioDur}s（总耗时 ${elapsed}s）`;
    }
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
