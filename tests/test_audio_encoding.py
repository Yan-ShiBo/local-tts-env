import subprocess
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

import audio_encoding
from audio_encoding import (
    AudioEncodingError,
    WebMOpusEncoder,
    encode_ogg_opus,
    ffmpeg_executable,
    pcm_f32le_bytes,
    validate_ffmpeg,
)


def test_bundled_ffmpeg_exists():
    executable = ffmpeg_executable()

    assert Path(executable).is_file()


def test_validate_ffmpeg_returns_bundled_executable():
    executable = validate_ffmpeg()

    assert executable == ffmpeg_executable()


def test_validate_ffmpeg_wraps_version_check_timeout(monkeypatch):
    def raise_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], timeout=kwargs["timeout"])

    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    monkeypatch.setattr(audio_encoding.subprocess, "run", raise_timeout)

    with pytest.raises(AudioEncodingError, match="^FFmpeg is unavailable$"):
        validate_ffmpeg()


def test_pcm_f32le_bytes_is_contiguous_little_endian():
    audio = np.array([[0.25, -0.5]], dtype=">f4")

    payload = pcm_f32le_bytes(audio)

    assert payload == np.array([0.25, -0.5], dtype="<f4").tobytes()


def test_encode_ogg_opus_produces_opus_container():
    sample_rate = 24000
    time = np.arange(sample_rate // 10, dtype=np.float32) / sample_rate
    audio = 0.1 * np.sin(2 * np.pi * 440 * time)

    encoded = encode_ogg_opus(audio, sample_rate)

    assert encoded.startswith(b"OggS")
    assert b"OpusHead" in encoded[:256]


def test_webm_encoder_streams_ebml_and_opus():
    encoder = WebMOpusEncoder(sample_rate=24000)
    try:
        encoder.write(np.zeros(24000 // 5, dtype=np.float32))
        encoder.close_input()
        content = b"".join(iter(lambda: encoder.read(4096), b""))
        encoder.wait()
    finally:
        encoder.close()

    assert content.startswith(b"\x1aE\xdf\xa3")
    assert b"OpusHead" in content


def test_webm_encoder_uses_low_latency_opus_command(monkeypatch):
    process = Mock()
    process.stdin = Mock()
    process.stdout = Mock()
    process.stderr = Mock()
    process.poll.return_value = 0
    popen = Mock(return_value=process)
    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    monkeypatch.setattr(audio_encoding.subprocess, "Popen", popen)

    encoder = WebMOpusEncoder(sample_rate=24000)
    encoder.close()

    assert popen.call_args.args[0] == [
        r"C:\bundled\ffmpeg.exe",
        "-v",
        "error",
        "-f",
        "f32le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-application",
        "voip",
        "-frame_duration",
        "20",
        "-f",
        "webm",
        "-cluster_time_limit",
        "250",
        "-cluster_size_limit",
        "0",
        "-flush_packets",
        "1",
        "pipe:1",
    ]
    assert popen.call_args.kwargs["bufsize"] == 0
    assert popen.call_args.kwargs["creationflags"] == getattr(
        subprocess,
        "CREATE_NO_WINDOW",
        0,
    )


def test_webm_encoder_close_is_idempotent_and_kills_after_timeout(monkeypatch):
    process = Mock()
    process.stdin = Mock()
    process.stdout = Mock()
    process.stderr = Mock()
    process.poll.return_value = None
    process.wait.side_effect = [
        subprocess.TimeoutExpired(["ffmpeg"], timeout=2),
        0,
    ]
    monkeypatch.setattr(audio_encoding.subprocess, "Popen", Mock(return_value=process))

    encoder = WebMOpusEncoder(sample_rate=24000)
    encoder.close()
    encoder.close()

    process.stdin.close.assert_called_once_with()
    process.terminate.assert_called_once_with()
    process.kill.assert_called_once_with()
    assert process.wait.call_count == 2
    process.stdout.close.assert_called_once_with()
    process.stderr.close.assert_called_once_with()


def test_webm_encoder_rejects_writes_after_input_close():
    encoder = WebMOpusEncoder(sample_rate=24000)
    try:
        encoder.close_input()

        with pytest.raises(
            AudioEncodingError,
            match="^WebM encoder input is closed$",
        ):
            encoder.write(np.zeros(1, dtype=np.float32))
    finally:
        encoder.close()
