import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np


class AudioEncodingError(RuntimeError):
    pass


def ffmpeg_executable() -> str:
    executable = Path(imageio_ffmpeg.get_ffmpeg_exe()).resolve()
    if not executable.is_file():
        raise AudioEncodingError("FFmpeg is unavailable")
    return str(executable)


def validate_ffmpeg() -> str:
    executable = ffmpeg_executable()
    try:
        completed = subprocess.run(
            [executable, "-version"],
            capture_output=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise AudioEncodingError("FFmpeg is unavailable") from error
    if completed.returncode != 0:
        raise AudioEncodingError("FFmpeg is unavailable")
    return executable


def pcm_f32le_bytes(audio: np.ndarray) -> bytes:
    return np.ascontiguousarray(audio, dtype="<f4").reshape(-1).tobytes()


def encode_ogg_opus(
    audio: np.ndarray,
    sample_rate: int,
    bitrate: str = "48k",
) -> bytes:
    completed = subprocess.run(
        [
            ffmpeg_executable(),
            "-v",
            "error",
            "-f",
            "f32le",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            "-c:a",
            "libopus",
            "-b:a",
            bitrate,
            "-application",
            "voip",
            "-f",
            "ogg",
            "pipe:1",
        ],
        input=pcm_f32le_bytes(audio),
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if (
        completed.returncode != 0
        or not completed.stdout.startswith(b"OggS")
        or b"OpusHead" not in completed.stdout[:256]
    ):
        raise AudioEncodingError("OGG encoding failed")
    return completed.stdout


class WebMOpusEncoder:
    def __init__(self, sample_rate: int, bitrate: str = "48k"):
        self._closed = False
        self._input_closed = False
        self.process = subprocess.Popen(
            [
                ffmpeg_executable(),
                "-v",
                "error",
                "-f",
                "f32le",
                "-ar",
                str(sample_rate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-c:a",
                "libopus",
                "-b:a",
                bitrate,
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
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def write(self, audio: np.ndarray) -> None:
        if self._input_closed or self.process.stdin is None:
            raise AudioEncodingError("WebM encoder input is closed")
        self.process.stdin.write(pcm_f32le_bytes(audio))

    def close_input(self) -> None:
        if not self._input_closed and self.process.stdin is not None:
            self.process.stdin.close()
            self._input_closed = True

    def read(self, size: int = 16384) -> bytes:
        if self.process.stdout is None:
            return b""
        return self.process.stdout.read(size)

    def wait(self, timeout: float = 10.0) -> None:
        return_code = self.process.wait(timeout=timeout)
        if return_code != 0:
            raise AudioEncodingError("WebM encoding failed")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.close_input()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        for pipe in (self.process.stdout, self.process.stderr):
            if pipe is not None:
                pipe.close()
