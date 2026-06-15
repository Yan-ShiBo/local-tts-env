import subprocess
import traceback
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


def _mock_process():
    process = Mock()
    process.stdin = Mock()
    process.stdout = Mock()
    process.stderr = Mock()
    process.poll.return_value = 0
    return process


def _install_mock_process(monkeypatch, process):
    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    monkeypatch.setattr(audio_encoding.subprocess, "Popen", Mock(return_value=process))


def test_bundled_ffmpeg_exists():
    executable = ffmpeg_executable()

    assert Path(executable).is_file()


def test_ffmpeg_executable_wraps_bundled_lookup_error(monkeypatch):
    def raise_lookup_error():
        raise OSError(r"C:\secret\ffmpeg.exe")

    monkeypatch.setattr(
        audio_encoding.imageio_ffmpeg,
        "get_ffmpeg_exe",
        raise_lookup_error,
    )

    with pytest.raises(
        AudioEncodingError,
        match="^FFmpeg is unavailable$",
    ) as raised:
        ffmpeg_executable()

    formatted = "".join(
        traceback.format_exception(raised.type, raised.value, raised.tb),
    )
    assert "secret" not in formatted


def test_ffmpeg_executable_wraps_path_resolution_error(monkeypatch):
    monkeypatch.setattr(
        audio_encoding.imageio_ffmpeg,
        "get_ffmpeg_exe",
        lambda: r"C:\secret\ffmpeg.exe",
    )

    def raise_resolution_error(self):
        raise RuntimeError(str(self))

    monkeypatch.setattr(audio_encoding.Path, "resolve", raise_resolution_error)

    with pytest.raises(AudioEncodingError, match="^FFmpeg is unavailable$"):
        ffmpeg_executable()


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


@pytest.mark.parametrize(
    "process_error",
    [
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_validate_ffmpeg_wraps_runtime_errors(monkeypatch, process_error):
    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    monkeypatch.setattr(
        audio_encoding.subprocess,
        "run",
        Mock(side_effect=process_error),
    )

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


@pytest.mark.parametrize(
    "process_error",
    [
        OSError(r"C:\secret\ffmpeg.exe"),
        subprocess.TimeoutExpired(["ffmpeg"], timeout=1),
        subprocess.SubprocessError(r"C:\secret\ffmpeg.exe"),
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_encode_ogg_opus_wraps_process_errors(monkeypatch, process_error):
    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    monkeypatch.setattr(
        audio_encoding.subprocess,
        "run",
        Mock(side_effect=process_error),
    )

    with pytest.raises(AudioEncodingError, match="^OGG encoding failed$"):
        encode_ogg_opus(np.zeros(1, dtype=np.float32), 24000)


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


@pytest.mark.parametrize(
    "process_error",
    [
        OSError(r"C:\secret\ffmpeg.exe"),
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_webm_encoder_wraps_process_start_error(monkeypatch, process_error):
    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    monkeypatch.setattr(
        audio_encoding.subprocess,
        "Popen",
        Mock(side_effect=process_error),
    )

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        WebMOpusEncoder(sample_rate=24000)


@pytest.mark.parametrize(
    "process_error",
    [
        BrokenPipeError(r"C:\secret\ffmpeg.exe"),
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_webm_encoder_wraps_stdin_write_error(monkeypatch, process_error):
    process = _mock_process()
    process.stdin.write.side_effect = process_error
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        encoder.write(np.zeros(1, dtype=np.float32))


@pytest.mark.parametrize(
    "process_error",
    [
        BrokenPipeError(r"C:\secret\ffmpeg.exe"),
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_webm_encoder_wraps_stdin_close_error(monkeypatch, process_error):
    process = _mock_process()
    process.stdin.close.side_effect = process_error
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        encoder.close_input()


@pytest.mark.parametrize(
    "process_error",
    [
        OSError(r"C:\secret\ffmpeg.exe"),
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_webm_encoder_wraps_stdout_read_error(monkeypatch, process_error):
    process = _mock_process()
    process.stdout.read.side_effect = process_error
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        encoder.read()


@pytest.mark.parametrize(
    "process_error",
    [
        subprocess.TimeoutExpired(["ffmpeg"], timeout=1),
        OSError(r"C:\secret\ffmpeg.exe"),
        ValueError(r"C:\secret\ffmpeg.exe"),
        RuntimeError(r"C:\secret\ffmpeg.exe"),
    ],
)
def test_webm_encoder_wraps_wait_errors(monkeypatch, process_error):
    process = _mock_process()
    process.wait.side_effect = process_error
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        encoder.wait()


def test_webm_encoder_read_after_close_is_stable_error():
    encoder = WebMOpusEncoder(sample_rate=24000)
    encoder.close()

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        encoder.read()


def test_webm_encoder_write_after_close_is_stable_error():
    encoder = WebMOpusEncoder(sample_rate=24000)
    encoder.close()

    with pytest.raises(
        AudioEncodingError,
        match="^WebM encoder input is closed$",
    ):
        encoder.write(np.zeros(1, dtype=np.float32))


@pytest.mark.parametrize("error_type", [KeyboardInterrupt, SystemExit])
@pytest.mark.parametrize("operation", ["validate", "ogg", "webm"])
def test_encoder_process_entry_points_do_not_swallow_base_exceptions(
    monkeypatch,
    operation,
    error_type,
):
    monkeypatch.setattr(
        audio_encoding,
        "ffmpeg_executable",
        lambda: r"C:\bundled\ffmpeg.exe",
    )
    if operation == "webm":
        monkeypatch.setattr(
            audio_encoding.subprocess,
            "Popen",
            Mock(side_effect=error_type()),
        )
        call = lambda: WebMOpusEncoder(sample_rate=24000)
    else:
        monkeypatch.setattr(
            audio_encoding.subprocess,
            "run",
            Mock(side_effect=error_type()),
        )
        call = (
            validate_ffmpeg
            if operation == "validate"
            else lambda: encode_ogg_opus(np.zeros(1, dtype=np.float32), 24000)
        )

    with pytest.raises(error_type):
        call()


@pytest.mark.parametrize("error_type", [KeyboardInterrupt, SystemExit])
@pytest.mark.parametrize("operation", ["write", "close_input", "read", "wait"])
def test_webm_encoder_io_does_not_swallow_base_exceptions(
    monkeypatch,
    operation,
    error_type,
):
    process = _mock_process()
    pipe_call = {
        "write": process.stdin.write,
        "close_input": process.stdin.close,
        "read": process.stdout.read,
        "wait": process.wait,
    }[operation]
    pipe_call.side_effect = error_type()
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)
    call = {
        "write": lambda: encoder.write(np.zeros(1, dtype=np.float32)),
        "close_input": encoder.close_input,
        "read": encoder.read,
        "wait": encoder.wait,
    }[operation]

    with pytest.raises(error_type):
        call()


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
    _install_mock_process(monkeypatch, process)

    encoder = WebMOpusEncoder(sample_rate=24000)
    encoder.close()
    encoder.close()

    process.stdin.close.assert_called_once_with()
    process.terminate.assert_called_once_with()
    process.kill.assert_called_once_with()
    assert process.wait.call_count == 2
    process.stdout.close.assert_called_once_with()
    process.stderr.close.assert_called_once_with()


def test_webm_encoder_close_continues_after_cleanup_errors(monkeypatch):
    process = _mock_process()
    process.poll.return_value = None
    process.stdin.close.side_effect = BrokenPipeError("stdin closed")
    process.terminate.side_effect = OSError("terminate failed")
    process.stdout.close.side_effect = OSError("stdout close failed")
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    encoder.close()
    encoder.close()

    process.stdin.close.assert_called_once_with()
    process.terminate.assert_called_once_with()
    process.kill.assert_called_once_with()
    process.wait.assert_called_once_with(timeout=2)
    process.stdout.close.assert_called_once_with()
    process.stderr.close.assert_called_once_with()


def test_webm_encoder_close_retries_stdin_after_close_input_error(monkeypatch):
    process = _mock_process()
    process.stdin.close.side_effect = [BrokenPipeError("stdin closed"), None]
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    with pytest.raises(AudioEncodingError, match="^WebM encoding failed$"):
        encoder.close_input()

    encoder.close()

    assert process.stdin.close.call_count == 2


@pytest.mark.parametrize("error_type", [KeyboardInterrupt, SystemExit])
def test_webm_encoder_close_retries_after_interrupted_cleanup(
    monkeypatch,
    error_type,
):
    process = _mock_process()
    process.stdin.close.side_effect = [error_type(), None]
    _install_mock_process(monkeypatch, process)
    encoder = WebMOpusEncoder(sample_rate=24000)

    with pytest.raises(error_type):
        encoder.close()

    encoder.close()

    assert process.stdin.close.call_count == 2
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
