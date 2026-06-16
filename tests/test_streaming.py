import asyncio
import threading
import time

import numpy as np
import pytest
import warnings

warnings.filterwarnings(
    "ignore",
    message="Using `httpx` with `starlette.testclient` is deprecated",
)
from fastapi.testclient import TestClient

import server
from audio_encoding import AudioEncodingError


class BlockingPipeline:
    def __init__(self):
        self.release_second_segment = threading.Event()
        self.finished = False
        self.calls = []

    def __call__(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        yield None, None, np.ones(16, dtype=np.float32)
        self.release_second_segment.wait(timeout=2)
        yield None, None, np.ones(16, dtype=np.float32)
        self.finished = True


class FakePipeline:
    def __init__(self, segments=None):
        self.segments = segments or [
            np.ones(16, dtype=np.float32),
            np.zeros(16, dtype=np.float32),
        ]
        self.calls = []

    def __call__(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        for segment in self.segments:
            yield None, None, segment


class FakeWebMEncoder:
    instances = []

    def __init__(self, sample_rate=server.SAMPLE_RATE):
        self.sample_rate = sample_rate
        self.closed = False
        self.input_closed = False
        self.writes = []
        self._chunks = []
        self._condition = threading.Condition()
        FakeWebMEncoder.instances.append(self)

    def write(self, audio):
        with self._condition:
            self.writes.append(np.asarray(audio, dtype=np.float32).copy())
            if len(self.writes) == 1:
                self._chunks.append(b"\x1aE\xdf\xa3OpusHead")
            else:
                self._chunks.append(b"ClusterData")
            self._condition.notify_all()

    def close_input(self):
        with self._condition:
            self.input_closed = True
            self._condition.notify_all()

    def read(self, size=16384):
        deadline = time.monotonic() + 2
        with self._condition:
            while not self._chunks and not self.input_closed and not self.closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return b""
                self._condition.wait(timeout=remaining)
            if self._chunks:
                return self._chunks.pop(0)
            return b""

    def wait(self, timeout=10.0):
        return None

    def close(self):
        with self._condition:
            self.closed = True
            self.input_closed = True
            self._condition.notify_all()


class InvalidFirstChunkEncoder(FakeWebMEncoder):
    def write(self, audio):
        with self._condition:
            self.writes.append(np.asarray(audio, dtype=np.float32).copy())
            self._chunks.append(b"not-webm")
            self._condition.notify_all()


def test_stream_session_prefetches_first_webm_chunk_before_pipeline_finishes():
    pipeline = BlockingPipeline()
    encoder = FakeWebMEncoder()
    session = server.TTSStreamSession(
        pipeline=pipeline,
        text="Long streaming text",
        voice="af_bella",
        speed=0.8,
        encoder_factory=lambda sample_rate: encoder,
    )

    session.start()
    first = session.read_first_chunk()

    assert first.startswith(b"\x1aE\xdf\xa3")
    assert pipeline.finished is False
    pipeline.release_second_segment.set()
    session.close()
    assert encoder.closed is True


def test_stream_session_rejects_invalid_first_chunk_before_pipeline_finishes():
    pipeline = BlockingPipeline()
    encoder = InvalidFirstChunkEncoder()
    session = server.TTSStreamSession(
        pipeline=pipeline,
        text="Long streaming text",
        voice="af_bella",
        speed=0.8,
        encoder_factory=lambda sample_rate: encoder,
    )

    session.start()
    with pytest.raises(AudioEncodingError, match="WebM encoding failed"):
        session.read_first_chunk()

    pipeline.release_second_segment.set()
    session.close()


def test_stream_session_writes_silence_only_between_segments():
    pipeline = FakePipeline(
        [
            np.array([1.0, 2.0], dtype=np.float32),
            np.array([3.0], dtype=np.float32),
        ]
    )
    encoder = FakeWebMEncoder()
    session = server.TTSStreamSession(
        pipeline=pipeline,
        text="Segmented text",
        voice="af_bella",
        speed=0.8,
        encoder_factory=lambda sample_rate: encoder,
        sample_rate=1000,
        silence_ms=100,
        fade_ms=0,
    )

    session.start()
    session.read_first_chunk()
    while session.read_chunk():
        pass
    session.finish()
    session.close()

    assert [len(write) for write in encoder.writes] == [2, 100, 1]
    np.testing.assert_array_equal(encoder.writes[1], np.zeros(100))


def test_stream_endpoint_returns_webm_headers(monkeypatch):
    FakeWebMEncoder.instances = []
    fake_pipeline = FakePipeline()
    monkeypatch.setattr(server, "pipeline", fake_pipeline)
    monkeypatch.setattr(server, "british_pipeline", FakePipeline())
    monkeypatch.setattr(
        server,
        "WebMOpusEncoder",
        lambda sample_rate: FakeWebMEncoder(sample_rate),
    )

    client = TestClient(server.app)
    response = client.post("/tts/stream", json={"text": "Hello stream"})

    assert response.status_code == 200
    assert response.headers["content-type"] == 'audio/webm; codecs="opus"'
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-audio-format"] == "webm-opus"
    assert response.content.startswith(b"\x1aE\xdf\xa3")
    assert fake_pipeline.calls == [("Hello stream", "af_bella", 0.8)]
    assert FakeWebMEncoder.instances[-1].closed is True


def test_stream_endpoint_rejects_format_query(monkeypatch):
    monkeypatch.setattr(server, "pipeline", FakePipeline())
    client = TestClient(server.app)

    response = client.post("/tts/stream?format=ogg", json={"text": "Hello"})

    assert response.status_code == 406


def test_stream_endpoint_returns_429_when_lock_is_busy(monkeypatch):
    monkeypatch.setattr(server, "pipeline", FakePipeline())

    async def exercise():
        await server.inference_lock.acquire()
        try:
            client = TestClient(server.app)
            response = client.post("/tts/stream", json={"text": "Hello"})
        finally:
            server.inference_lock.release()
        return response

    response = asyncio.run(exercise())

    assert response.status_code == 429
