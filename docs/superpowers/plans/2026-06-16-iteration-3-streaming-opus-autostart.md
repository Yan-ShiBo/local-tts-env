# Kokoro TTS Third Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add continuous WebM/Opus streaming, complete OGG/Opus responses, honest playback progress, tray login auto-start, and full boundary/concurrency coverage while preserving WAV compatibility.

**Architecture:** A new `audio_encoding.py` module owns bundled FFmpeg resolution, complete OGG encoding, and one-request WebM streaming sessions. `server.py` owns negotiation, inference locking, and HTTP lifecycle; the userscript exposes testable MediaSource queue/progress/fallback primitives before wiring them into the existing UI. Windows auto-start is isolated in `windows_startup.py`.

**Tech Stack:** Python 3.10, FastAPI, numpy, soundfile, imageio-ffmpeg 0.6.0, pytest 9.1.0, Node.js built-in test runner, Tampermonkey, MediaSource, WebM/Opus, Windows WScript shortcuts.

---

## File Map

- Create `audio_encoding.py`: FFmpeg discovery, complete OGG encoder, WebM streaming process wrapper, PCM conversion.
- Create `windows_startup.py`: current-user Startup shortcut creation, inspection, repair, and deletion.
- Create `tests/test_audio_encoding.py`: real bundled-FFmpeg unit tests without Kokoro.
- Create `tests/test_streaming.py`: fake-pipeline API streaming, cancellation, and concurrency tests.
- Create `tests/test_windows_startup.py`: shortcut behavior with injected subprocess/filesystem adapters.
- Modify `server.py`: output negotiation, `/tts/stream`, test-page stream mode, version `1.2.0`.
- Modify `tts-userscript.js`: MediaSource core, OGG fallback, horizontal progress UI, version `1.4.0`.
- Modify `tray_app.py`: auto-start setting, reconciliation, menu toggle, error reporting.
- Modify `requirements.txt`: add bundled FFmpeg.
- Modify `requirements-test.txt`: add bundled FFmpeg and pytest.
- Modify `setup.bat`: verify bundled FFmpeg.
- Modify `.github/workflows/ci.yml`: run pytest and FFmpeg verification.
- Modify `tests/test_server.py`, `tests/test_tray_app.py`, `tests/userscript-core.test.cjs`: regression and integration coverage.
- Modify `README.md`, `说明.md`, `docs/expert-review-2026-06-15.md`: user documentation and roadmap.
- Create `docs/iteration-3-2026-06-16.md`: implementation and verification record.

### Task 1: Bundled FFmpeg Encoding Layer

**Files:**
- Create: `audio_encoding.py`
- Create: `tests/test_audio_encoding.py`
- Modify: `requirements.txt`
- Modify: `requirements-test.txt`
- Modify: `setup.bat`

- [ ] **Step 1: Add test dependencies before running encoding tests**

Add exact entries:

```text
imageio-ffmpeg==0.6.0
```

to both requirements files, and add:

```text
pytest==9.1.0
```

to `requirements-test.txt`.

Install in the project environment:

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pip install imageio-ffmpeg==0.6.0 pytest==9.1.0
```

Expected: installation succeeds and pip reports no resolver error.

- [ ] **Step 2: Write failing tests for FFmpeg discovery and PCM conversion**

Create tests expressing this public API:

```python
from pathlib import Path

import numpy as np

from audio_encoding import ffmpeg_executable, pcm_f32le_bytes


def test_bundled_ffmpeg_exists():
    executable = ffmpeg_executable()
    assert Path(executable).is_file()


def test_pcm_f32le_bytes_is_contiguous_little_endian():
    audio = np.array([[0.25, -0.5]], dtype=">f4")
    payload = pcm_f32le_bytes(audio)
    assert payload == np.array([0.25, -0.5], dtype="<f4").tobytes()
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_audio_encoding.py -v
```

Expected: collection fails because `audio_encoding` does not exist.

- [ ] **Step 4: Implement FFmpeg discovery, validation, PCM conversion, and typed errors**

Implement these interfaces:

```python
class AudioEncodingError(RuntimeError):
    pass


def ffmpeg_executable() -> str:
    executable = Path(imageio_ffmpeg.get_ffmpeg_exe()).resolve()
    if not executable.is_file():
        raise AudioEncodingError("FFmpeg is unavailable")
    return str(executable)


def validate_ffmpeg() -> str:
    executable = ffmpeg_executable()
    completed = subprocess.run(
        [executable, "-version"],
        capture_output=True,
        timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise AudioEncodingError("FFmpeg is unavailable")
    return executable


def pcm_f32le_bytes(audio: np.ndarray) -> bytes:
    return np.ascontiguousarray(audio, dtype="<f4").reshape(-1).tobytes()
```

`validate_ffmpeg()` must execute `[executable, "-version"]` with hidden-window
flags on Windows and raise `AudioEncodingError("FFmpeg is unavailable")`
without exposing a path in the message.

- [ ] **Step 5: Verify the discovery tests pass**

Run the Task 1 test command.

Expected: two tests pass.

- [ ] **Step 6: Write a failing real OGG/Opus encoding test**

Add:

```python
from audio_encoding import encode_ogg_opus


def test_encode_ogg_opus_produces_opus_container():
    sample_rate = 24000
    t = np.arange(sample_rate // 10, dtype=np.float32) / sample_rate
    audio = 0.1 * np.sin(2 * np.pi * 440 * t)
    encoded = encode_ogg_opus(audio, sample_rate)
    assert encoded.startswith(b"OggS")
    assert b"OpusHead" in encoded[:256]
```

- [ ] **Step 7: Run the OGG test and verify RED**

Expected: import fails because `encode_ogg_opus` is missing.

- [ ] **Step 8: Implement complete OGG/Opus encoding**

Implement:

```python
def encode_ogg_opus(
    audio: np.ndarray,
    sample_rate: int,
    bitrate: str = "48k",
) -> bytes:
    completed = subprocess.run(
        [
            ffmpeg_executable(),
            "-v", "error",
            "-f", "f32le",
            "-ar", str(sample_rate),
            "-ac", "1",
            "-i", "pipe:0",
            "-c:a", "libopus",
            "-b:a", bitrate,
            "-application", "voip",
            "-f", "ogg",
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
```

Use a one-shot FFmpeg subprocess with:

```text
-f f32le -ar <sample_rate> -ac 1 -i pipe:0
-c:a libopus -b:a 48k -application voip
-f ogg pipe:1
```

Require zero exit status, non-empty stdout, `OggS`, and `OpusHead`; otherwise
raise `AudioEncodingError("OGG encoding failed")`.

- [ ] **Step 9: Write a failing WebM stream process test**

Add a test using:

```python
from audio_encoding import WebMOpusEncoder


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
```

- [ ] **Step 10: Run the WebM test and verify RED**

Expected: import fails because `WebMOpusEncoder` is missing.

- [ ] **Step 11: Implement the streaming encoder wrapper**

Provide:

```python
class WebMOpusEncoder:
    def __init__(self, sample_rate: int, bitrate: str = "48k"):
        self._closed = False
        self._input_closed = False
        self.process = subprocess.Popen(
            [
                ffmpeg_executable(),
                "-v", "error",
                "-f", "f32le",
                "-ar", str(sample_rate),
                "-ac", "1",
                "-i", "pipe:0",
                "-c:a", "libopus",
                "-b:a", bitrate,
                "-application", "voip",
                "-frame_duration", "20",
                "-f", "webm",
                "-cluster_time_limit", "250",
                "-cluster_size_limit", "0",
                "-flush_packets", "1",
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
```

Use binary pipes, `bufsize=0`, hidden-window flags, idempotent close, terminate
then kill on timeout, and the exact low-latency WebM/Opus command from the
design specification.

- [ ] **Step 12: Verify all encoding tests and setup validation**

Run:

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_audio_encoding.py -v
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -c "from audio_encoding import validate_ffmpeg; print(validate_ffmpeg())"
```

Expected: all tests pass and an existing bundled executable path is printed.

Update `setup.bat` import verification to import `imageio_ffmpeg` and execute
`imageio_ffmpeg.get_ffmpeg_exe()` with `-version`.

- [ ] **Step 13: Commit Task 1**

```powershell
git add audio_encoding.py tests/test_audio_encoding.py requirements.txt requirements-test.txt setup.bat
git commit -m "feat: add bundled opus encoding"
```

### Task 2: Complete WAV/OGG API Negotiation and Boundary Tests

**Files:**
- Modify: `server.py`
- Modify: `tests/test_server.py`

- [ ] **Step 1: Write failing format negotiation tests**

Add API tests:

```python
def test_ogg_query_returns_opus(self):
    response = self.client.post("/tts?format=ogg", json={"text": "Hello"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/ogg"
    assert response.content.startswith(b"OggS")
    assert b"OpusHead" in response.content[:256]


def test_accept_ogg_returns_opus(self):
    response = self.client.post(
        "/tts",
        headers={"Accept": "audio/ogg"},
        json={"text": "Hello"},
    )
    assert response.headers["content-type"] == "audio/ogg"


def test_query_format_overrides_accept(self):
    response = self.client.post(
        "/tts?format=wav",
        headers={"Accept": "audio/ogg"},
        json={"text": "Hello"},
    )
    assert response.headers["content-type"] == "audio/wav"


@pytest.mark.parametrize("path,headers", [
    ("/tts?format=mp3", {}),
    ("/tts", {"Accept": "audio/mpeg"}),
])
def test_unsupported_format_returns_406(self, path, headers):
    response = self.client.post(path, headers=headers, json={"text": "Hello"})
    assert response.status_code == 406
    assert server.pipeline.calls == []
```

- [ ] **Step 2: Run targeted tests and verify RED**

Run:

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_server.py -k "ogg or format" -v
```

Expected: OGG remains WAV or unsupported requests do not return `406`.

- [ ] **Step 3: Implement deterministic negotiation**

Add:

```python
SUPPORTED_FORMATS = {"wav", "ogg"}


def _select_audio_format(format_query: str | None, accept: str | None) -> str:
    if format_query is not None:
        normalized = format_query.lower()
        if normalized not in SUPPORTED_FORMATS:
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
```

Rules must match the specification exactly. Inject `Request` and a validated
optional `format` query into `tts_endpoint`. Validate format before acquiring
the inference lock. Use `encode_ogg_opus` only after inference completes.

- [ ] **Step 4: Verify negotiation tests pass**

Run the targeted command.

Expected: all selected tests pass.

- [ ] **Step 5: Write failing boundary pass-through tests**

Parameterize:

```python
@pytest.mark.parametrize("text", [
    "...?!",
    "I have 42 cats",
    "Visit https://example.com/docs",
    "Hello 世界 42",
])
def test_boundary_text_reaches_pipeline_unchanged(self, text):
    response = self.client.post("/tts", json={"text": text})
    assert response.status_code == 200
    assert server.pipeline.calls[-1][0] == text
```

- [ ] **Step 6: Run boundary tests and verify their result**

If they pass immediately, retain them as regression characterization because
they document existing validation behavior; no production change is needed.
If punctuation-only input produces no fake audio in the test pipeline, adjust
only the fake pipeline, not server validation.

- [ ] **Step 7: Extend OpenAPI and error-sanitization tests**

Assert both `audio/wav` and `audio/ogg` appear for `/tts`, and patch
`encode_ogg_opus` to raise `AudioEncodingError("C:\\secret\\ffmpeg.exe")`;
assert the response is `500`, says `语音生成失败`, and does not expose the path.

- [ ] **Step 8: Run server tests**

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_server.py -v
```

Expected: all server tests pass.

- [ ] **Step 9: Commit Task 2**

```powershell
git add server.py tests/test_server.py
git commit -m "feat: negotiate wav and ogg output"
```

### Task 3: Continuous WebM/Opus Streaming Endpoint

**Files:**
- Modify: `audio_encoding.py`
- Modify: `server.py`
- Create: `tests/test_streaming.py`

- [ ] **Step 1: Write failing stream-session first-byte test**

Define a fake encoder with blocking reads and a two-segment fake pipeline.
Express the server-side interface:

```python
session = server.TTSStreamSession(
    pipeline=fake_pipeline,
    text="Long text",
    voice="af_bella",
    speed=0.8,
    encoder_factory=lambda sample_rate: fake_encoder,
)
session.start()
first = session.read_first_chunk()
assert first.startswith(b"\x1aE\xdf\xa3")
assert fake_pipeline.finished is False
session.close()
```

- [ ] **Step 2: Run the test and verify RED**

Expected: `TTSStreamSession` does not exist.

- [ ] **Step 3: Implement the minimal stream session**

Implement a focused class in `server.py` with:

```python
class TTSStreamSession:
    def start(self) -> None:
        self.encoder = self.encoder_factory(SAMPLE_RATE)
        self.producer_thread = threading.Thread(
            target=self._produce,
            name="kokoro-stream-producer",
            daemon=True,
        )
        self.producer_thread.start()

    def read_first_chunk(self) -> bytes:
        first = self.encoder.read(STREAM_CHUNK_BYTES)
        if not first.startswith(b"\x1aE\xdf\xa3"):
            self._raise_producer_error_or_encoding_error()
        return first

    def iter_chunks(self, first_chunk: bytes):
        try:
            yield first_chunk
            while True:
                chunk = self.encoder.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                yield chunk
            self.producer_thread.join()
            self._raise_producer_error_or_encoding_error()
            self.encoder.wait()
        finally:
            self.close()

    def close(self) -> None:
        with self.close_lock:
            if self.closed:
                return
            self.closed = True
            self.cancel_event.set()
            self.encoder.close()
        if (
            self.producer_thread is not None
            and self.producer_thread is not threading.current_thread()
        ):
            self.producer_thread.join()
```

The producer runs in one thread, writes segments immediately, inserts
`SEGMENT_SILENCE_MS`, supports one-segment fade look-behind, captures producer
exceptions, and validates the first chunk as EBML. The constructor must create
`cancel_event`, `close_lock`, `closed`, `producer_error`, `producer_thread`,
and `encoder`; `_produce()` and `_raise_producer_error_or_encoding_error()`
must be implemented as private methods used by the shown public methods.

- [ ] **Step 4: Verify first-byte test passes**

Run the targeted test.

- [ ] **Step 5: Write failing endpoint contract tests**

Add:

```python
def test_stream_endpoint_returns_webm_headers(client):
    response = client.post("/tts/stream", json={"text": "Hello"})
    assert response.status_code == 200
    assert response.headers["content-type"] == 'audio/webm; codecs="opus"'
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-audio-format"] == "webm-opus"
    assert response.content.startswith(b"\x1aE\xdf\xa3")
```

Also assert `format=ogg` on the streaming endpoint is rejected with `406`.

- [ ] **Step 6: Run endpoint tests and verify RED**

Expected: `/tts/stream` returns `404`.

- [ ] **Step 7: Implement `/tts/stream` with prefetch**

Acquire `inference_lock` with the existing 50 ms timeout, create and start the
session, prefetch the first chunk with `asyncio.to_thread`, and return a
`StreamingResponse` whose generator yields the prefetched chunk first. Ensure
the generator `finally` closes the session and releases the lock once.

- [ ] **Step 8: Write failing cleanup and concurrency tests**

Cover:

```python
def test_stream_cleanup_terminates_encoder_and_releases_lock(stream_client):
    response = stream_client.open_stream()
    response.close()
    assert stream_client.encoder.closed is True
    assert stream_client.lock.locked() is False


@pytest.mark.parametrize("competing_path", ["/tts", "/tts/stream"])
def test_request_is_429_while_stream_owns_lock(stream_client, competing_path):
    response = stream_client.open_stream()
    competing = stream_client.client.post(
        competing_path,
        json={"text": "Competing request"},
    )
    response.close()
    assert competing.status_code == 429


def test_second_stream_is_429(stream_client):
    first = stream_client.open_stream()
    second = stream_client.client.post(
        "/tts/stream",
        json={"text": "Second stream"},
    )
    first.close()
    assert second.status_code == 429


def test_new_request_succeeds_after_cancelled_stream_cleanup(stream_client):
    response = stream_client.open_stream()
    response.close()
    follow_up = stream_client.client.post("/tts", json={"text": "After cancel"})
    assert follow_up.status_code == 200
```

Use fake encoder/session synchronization events; do not load the model.
`stream_client` is a fixture defined in `tests/test_streaming.py` that owns a
`TestClient`, the fake encoder, and the actual `server.inference_lock`.
`response.close()` represents a client disconnect before the producer reaches
end-of-stream and must exercise the response generator's `finally` cleanup.

- [ ] **Step 9: Run cleanup tests and verify RED**

Expected: at least cancellation or exact-once lock release fails.

- [ ] **Step 10: Implement idempotent cancellation and error propagation**

Track `_closed`, `_input_closed`, producer completion, cancellation event, and
thread join. Do not release the inference lock inside the session; make endpoint
ownership explicit. Producer and FFmpeg failures before first chunk become a
generic `500`; failures after first chunk terminate the stream and log safely.

- [ ] **Step 11: Add startup FFmpeg validation**

Write a lifespan test patching `validate_ffmpeg` to fail. Verify application
startup fails before readiness. Then call `validate_ffmpeg()` in lifespan
before Kokoro model initialization.

- [ ] **Step 12: Run all Python tests**

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests -v
```

Expected: all tests pass with no leaked process or thread warnings.

- [ ] **Step 13: Commit Task 3**

```powershell
git add audio_encoding.py server.py tests/test_streaming.py tests/test_server.py
git commit -m "feat: stream webm opus audio"
```

### Task 4: Testable Userscript Media Core

**Files:**
- Modify: `tts-userscript.js`
- Modify: `tests/userscript-core.test.cjs`

- [ ] **Step 1: Write failing capability and progress-state tests**

Add tests for:

```javascript
test("streaming support requires webm opus MediaSource support", () => {
  const { supportsWebMOpus } = require("../tts-userscript.js");
  assert.equal(supportsWebMOpus({ isTypeSupported: () => true }), true);
  assert.equal(supportsWebMOpus({ isTypeSupported: () => false }), false);
  assert.equal(supportsWebMOpus(null), false);
});

test("unknown duration reports elapsed time without a percentage", () => {
  const { playbackProgress } = require("../tts-userscript.js");
  assert.deepEqual(playbackProgress(8.4, Infinity, false), {
    mode: "indeterminate",
    label: "朗读中 8.4s",
    percent: null,
  });
});

test("known duration reports a bounded percentage", () => {
  const { playbackProgress } = require("../tts-userscript.js");
  assert.equal(playbackProgress(8, 13, true).percent, 62);
});
```

- [ ] **Step 2: Run Node tests and verify RED**

```powershell
node --test tests/userscript-core.test.cjs
```

Expected: exported helpers are missing.

- [ ] **Step 3: Implement pure capability and progress helpers**

Export:

```javascript
const WEBM_OPUS_MIME = 'audio/webm; codecs="opus"';
function supportsWebMOpus(mediaSourceApi) {
  return Boolean(
    mediaSourceApi
    && typeof mediaSourceApi.isTypeSupported === "function"
    && mediaSourceApi.isTypeSupported(WEBM_OPUS_MIME)
  );
}

function playbackProgress(currentTime, duration, durationKnown) {
  const elapsed = Math.max(0, Number(currentTime) || 0);
  if (!durationKnown || !Number.isFinite(duration) || duration <= 0) {
    return {
      mode: "indeterminate",
      label: `朗读中 ${elapsed.toFixed(1)}s`,
      percent: null,
    };
  }
  const percent = Math.max(
    0,
    Math.min(100, Math.round((elapsed / duration) * 100)),
  );
  return {
    mode: "determinate",
    label: `朗读中 ${percent}%`,
    percent,
  };
}
```

Clamp percentages to `0..100` and never estimate from text length.

- [ ] **Step 4: Write failing serialized append-queue tests**

Define a dependency-injected `createAppendQueue(sourceBuffer, options)` and
test:

- Only one `appendBuffer` occurs while `updating` is true.
- `updateend` appends the next chunk.
- `finish()` calls `endOfStream` only after the queue drains.
- Pending bytes never exceed the configured limit because `enqueue()` awaits
  capacity.

- [ ] **Step 5: Run append tests and verify RED**

Expected: `createAppendQueue` is missing.

- [ ] **Step 6: Implement the bounded SourceBuffer append queue**

Expose:

```javascript
function createAppendQueue(sourceBuffer, {
  maxPendingBytes = 1024 * 1024,
  endOfStream,
} = {}) {
  const chunks = [];
  const capacityWaiters = [];
  let pendingBytes = 0;
  let finishing = false;
  let cancelledError = null;

  function wakeCapacityWaiters() {
    while (pendingBytes < maxPendingBytes && capacityWaiters.length) {
      capacityWaiters.shift()();
    }
  }

  function pump() {
    if (cancelledError || sourceBuffer.updating || chunks.length === 0) {
      if (finishing && !sourceBuffer.updating && chunks.length === 0) {
        endOfStream();
      }
      return;
    }
    const chunk = chunks.shift();
    pendingBytes -= chunk.byteLength;
    sourceBuffer.appendBuffer(chunk);
    wakeCapacityWaiters();
  }

  sourceBuffer.addEventListener("updateend", pump);
  return {
    async enqueue(chunk) {
      while (
        !cancelledError
        && pendingBytes + chunk.byteLength > maxPendingBytes
      ) {
        await new Promise((resolve) => capacityWaiters.push(resolve));
      }
      if (cancelledError) throw cancelledError;
      chunks.push(chunk);
      pendingBytes += chunk.byteLength;
      pump();
    },
    finish() {
      finishing = true;
      pump();
    },
    cancel(error = new Error("Append queue cancelled")) {
      cancelledError = error;
      chunks.length = 0;
      pendingBytes = 0;
      wakeCapacityWaiters();
    },
  };
}
```

Use promises for capacity and drain notification. Reject all pending operations
on `sourceBuffer.error` or explicit `cancel(error)`.

- [ ] **Step 7: Write failing fallback and resource cleanup tests**

Test a pure decision function:

```javascript
shouldFallback({ committed: false, phase: "append" }) === true
shouldFallback({ committed: true, phase: "playback" }) === false
```

Test `createPlaybackResources({ request, reader, queue, mediaSource, audio,
urls, urlApi }).close()` twice and assert the request,
reader, queue, media source, audio, and URLs are each released once.

- [ ] **Step 8: Implement fallback decision and resource owner**

Keep browser-specific calls injected. The resource owner must integrate with
the existing request gate and make close idempotent.

- [ ] **Step 9: Run all Node tests**

```powershell
node --check tts-userscript.js
node --test tests/userscript-core.test.cjs
```

Expected: all tests pass.

- [ ] **Step 10: Commit Task 4**

```powershell
git add tts-userscript.js tests/userscript-core.test.cjs
git commit -m "feat: add media source playback core"
```

### Task 5: Userscript Streaming UI and Built-in Test Page

**Files:**
- Modify: `tts-userscript.js`
- Modify: `server.py`
- Modify: `tests/userscript-core.test.cjs`
- Modify: `tests/test_server.py`

- [ ] **Step 1: Write failing userscript request-mode tests**

Test that the browser coordinator:

- Requests `/tts/stream` with `responseType: "stream"` when supported.
- Requests `/tts?format=ogg` with `responseType: "blob"` when unsupported.
- Falls back exactly once after an early stream failure.
- Does not fall back after playback is committed.

Use a dependency-injected GM request factory and fake Audio/MediaSource objects.

- [ ] **Step 2: Run Node tests and verify RED**

Expected: stream coordinator is missing.

- [ ] **Step 3: Integrate MediaSource and OGG fallback**

Replace the existing blob-only request path with:

```javascript
async function playWithPreferredTransport(text, btnElement) {
  const generation = requestGate.begin();
  if (!KokoroTTSCore.supportsWebMOpus(window.MediaSource)) {
    return playOggFallback(text, btnElement, generation);
  }
  try {
    return await playWebMStream(text, btnElement, generation);
  } catch (error) {
    if (
      requestGate.isCurrent(generation)
      && KokoroTTSCore.shouldFallback({
        committed: playbackCommitted,
        phase: "stream",
      })
    ) {
      return playOggFallback(text, btnElement, generation);
    }
    throw error;
  }
}

async function playWebMStream(text, btnElement, generation) {
  const media = createMediaSourcePlayback(btnElement, generation);
  const stream = await requestReadableStream("/tts/stream", text, generation);
  await media.consume(stream);
  return media.audio;
}

async function playOggFallback(text, btnElement, generation) {
  renderProgress(btnElement, {
    mode: "indeterminate",
    label: "已回退 OGG",
    percent: null,
  });
  const blob = await requestAudioBlob(
    "/tts?format=ogg",
    text,
    generation,
  );
  return playCompleteBlob(blob, btnElement, generation);
}
```

Use `onloadstart` to obtain the Tampermonkey readable stream, preserve stale
generation checks, and mark playback committed on `playing` or
`currentTime > 0`.

- [ ] **Step 4: Write failing progress rendering tests**

Extract a pure view-model-to-style helper and assert:

- Connecting/buffering uses indeterminate mode.
- Unknown duration label contains elapsed seconds and no `%`.
- Known duration sets `--tts-progress` to `62%`.
- OGG fallback exposes `已回退 OGG`.

- [ ] **Step 5: Implement the horizontal fill button**

Add a positioned pseudo-element or child fill layer behind button content.
Use CSS variable `--tts-progress`, `data-progress-mode`, and `data-state`.
Retain keyboard accessibility and visible text. Increment userscript version
to `1.4.0`.

- [ ] **Step 6: Write failing test-page HTML assertions**

In `tests/test_server.py`, assert the root HTML contains:

```text
id="streamMode"
MediaSource.isTypeSupported
/tts/stream
/tts?format=ogg
WebM/Opus stream
```

- [ ] **Step 7: Run the page test and verify RED**

Expected: the current page lacks stream mode.

- [ ] **Step 8: Implement test-page stream toggle and progress**

Add a checked `流式模式` checkbox. Implement MediaSource append serialization,
early OGG fallback, transport status, and honest progress semantics directly
in the page script. Revoke old object URLs before each request.

- [ ] **Step 9: Run JavaScript and server tests**

```powershell
node --check tts-userscript.js
node --test tests/userscript-core.test.cjs
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_server.py -v
```

Expected: all tests pass.

- [ ] **Step 10: Inspect the local test page in the in-app browser**

Restart the service only after tests pass. Open `http://127.0.0.1:5000/` and
verify the stream checkbox, horizontal progress, transport labels, OGG fallback
path, and no console errors.

- [ ] **Step 11: Commit Task 5**

```powershell
git add tts-userscript.js server.py tests/userscript-core.test.cjs tests/test_server.py
git commit -m "feat: add streaming browser playback"
```

### Task 6: Windows Tray Login Auto-start

**Files:**
- Create: `windows_startup.py`
- Create: `tests/test_windows_startup.py`
- Modify: `tray_app.py`
- Modify: `tests/test_tray_app.py`

- [ ] **Step 1: Write failing shortcut path and inspection tests**

Express:

```python
def test_shortcut_path_is_current_user_startup(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert startup_shortcut_path() == (
        tmp_path / "Microsoft/Windows/Start Menu/Programs/Startup/Kokoro TTS.lnk"
    )


def test_shortcut_is_valid_only_for_expected_target_and_workdir(tmp_path):
    target = tmp_path / "Kokoro TTS.pyw"
    workdir = tmp_path
    runner = FakeShortcutRunner(
        metadata={
            "target": str(target),
            "working_directory": str(workdir),
        }
    )
    assert inspect_startup_shortcut(target, workdir, runner=runner) is True
    runner.metadata["target"] = str(tmp_path / "other.pyw")
    assert inspect_startup_shortcut(target, workdir, runner=runner) is False
```

Use an injected PowerShell runner returning JSON shortcut metadata; do not
modify the real Startup directory in unit tests.

- [ ] **Step 2: Run tests and verify RED**

Expected: `windows_startup` does not exist.

- [ ] **Step 3: Implement startup shortcut service**

Provide:

```python
class StartupShortcutError(RuntimeError):
    pass

def startup_shortcut_path() -> Path:
    return (
        Path(os.environ["APPDATA"])
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / "Kokoro TTS.lnk"
    )


def inspect_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> bool:
    shortcut = startup_shortcut_path()
    if not shortcut.exists():
        return False
    metadata = runner(
        INSPECT_SHORTCUT_SCRIPT,
        {
            "KOKORO_SHORTCUT": str(shortcut),
        },
    )
    return (
        Path(metadata["target"]).resolve() == target.resolve()
        and Path(metadata["working_directory"]).resolve() == workdir.resolve()
    )


def enable_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> None:
    shortcut = startup_shortcut_path()
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    runner(
        CREATE_SHORTCUT_SCRIPT,
        {
            "KOKORO_SHORTCUT": str(shortcut),
            "KOKORO_TARGET": str(target.resolve()),
            "KOKORO_WORKDIR": str(workdir.resolve()),
        },
    )
    if not inspect_startup_shortcut(target, workdir, runner):
        raise StartupShortcutError("Unable to enable login auto-start")


def disable_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> None:
    shortcut = startup_shortcut_path()
    if shortcut.exists():
        shortcut.unlink()


def reconcile_startup_shortcut(
    enabled: bool,
    target: Path,
    workdir: Path,
    runner=run_powershell,
) -> bool:
    if enabled:
        if not inspect_startup_shortcut(target, workdir, runner):
            enable_startup_shortcut(target, workdir, runner)
        return True
    disable_startup_shortcut(target, workdir, runner)
    return False
```

Pass target, working directory, and shortcut path through environment
variables. PowerShell source must not interpolate user paths. Delete only the
fixed `Kokoro TTS.lnk`.

- [ ] **Step 4: Add failing create/repair/delete/error tests**

Cover:

- Missing shortcut + enabled creates it.
- Wrong target + enabled repairs it.
- Correct shortcut + enabled is unchanged.
- Disabled removes only the named shortcut.
- Runner failure raises `StartupShortcutError`.

- [ ] **Step 5: Implement reconciliation and verify tests**

Run:

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_windows_startup.py -v
```

Expected: all tests pass.

- [ ] **Step 6: Write failing tray-setting and menu tests**

Assert:

- Default settings include `"auto_start": False`.
- Enabling saves only after successful shortcut creation.
- Failure preserves the prior setting and calls the message-box adapter.
- The menu item is checkable and its checked callback reflects verified state.

- [ ] **Step 7: Run tray tests and verify RED**

Expected: auto-start behavior is missing.

- [ ] **Step 8: Integrate auto-start into `TrayApp`**

On initialization, reconcile saved intent. Add:

```python
def toggle_auto_start(self, _=None):
    requested = not self.is_auto_start_enabled()
    try:
        actual = reconcile_startup_shortcut(
            requested,
            SCRIPT_DIR / "Kokoro TTS.pyw",
            SCRIPT_DIR,
        )
    except StartupShortcutError as error:
        self.show_error("Auto-start", str(error))
        return
    self.settings["auto_start"] = actual
    save_settings(self.settings)


def is_auto_start_enabled(self):
    return inspect_startup_shortcut(
        SCRIPT_DIR / "Kokoro TTS.pyw",
        SCRIPT_DIR,
    )
```

Use `Kokoro TTS.pyw` as target and project root as working directory. Display a
Windows error message on failure. Add `Auto-start on login` as a checked menu
item.

- [ ] **Step 9: Run startup and tray tests**

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests/test_windows_startup.py tests/test_tray_app.py -v
```

Expected: all tests pass.

- [ ] **Step 10: Commit Task 6**

```powershell
git add windows_startup.py tests/test_windows_startup.py tray_app.py tests/test_tray_app.py
git commit -m "feat: add tray login auto start"
```

### Task 7: CI, Documentation, Versioning, and Release Verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `说明.md`
- Modify: `docs/expert-review-2026-06-15.md`
- Create: `docs/iteration-3-2026-06-16.md`
- Modify: `server.py`

- [ ] **Step 1: Update CI and write a failing CI-equivalent local check**

Change CI to:

```yaml
- name: Verify bundled FFmpeg
  run: python -c "from audio_encoding import validate_ffmpeg; validate_ffmpeg()"

- name: Python tests
  run: python -m pytest tests -v
```

Run those commands before updating dependencies in a fresh temporary venv.
Expected before completion: missing package or tests fail, proving the isolated
environment check is meaningful.

- [ ] **Step 2: Update version assertions first**

Add/modify tests to expect:

```python
assert server.app.version == "1.2.0"
```

and userscript metadata version `1.4.0`. Run them and observe failure before
changing `server.py` or the userscript metadata.

- [ ] **Step 3: Set release versions**

Set FastAPI version to `1.2.0`; Task 5 has already set userscript `1.4.0`.

- [ ] **Step 4: Update documentation**

Document:

- `/tts/stream` WebM/Opus behavior.
- `/tts?format=ogg` and `Accept: audio/ogg`.
- MediaSource capability fallback.
- `imageio-ffmpeg` bundled executable.
- Tray login auto-start.
- `pytest` and Node test commands.
- No fabricated percentage before duration is known.

Strike completed third-iteration roadmap items and create
`docs/iteration-3-2026-06-16.md` with implementation and pending live
verification sections.

- [ ] **Step 5: Run the complete local suite**

```powershell
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' scripts/sync_catalog.py --check
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m py_compile server.py tray_app.py 'Kokoro TTS.pyw' tts_catalog.py windows_runtime.py windows_startup.py audio_encoding.py scripts/sync_catalog.py
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pytest tests -v
node --check tts-userscript.js
node --test tests/userscript-core.test.cjs
& 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' -m pip check
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 6: Recreate Windows CI locally**

Create a temporary venv under `$env:TEMP`, install
`requirements-test.txt`, and run the CI commands. Validate the resolved path is
inside `$env:TEMP` before deleting it.

Expected: encoding tests use bundled FFmpeg; no Torch or Kokoro model download.

- [ ] **Step 7: Restart and verify the CUDA service**

Verify port 5000 belongs to `service=kokoro-tts`, stop only that process, then
start:

```powershell
Start-Process `
  -FilePath 'C:\Users\YanShibo\.conda\envs\kokoro-tts\python.exe' `
  -ArgumentList 'server.py' `
  -WorkingDirectory 'D:\local-tts-env' `
  -WindowStyle Hidden
```

Poll `/health` until:

```json
{
  "version": "1.2.0",
  "ready": true,
  "device": "cuda",
  "gpu": "NVIDIA GeForce RTX 4070 Ti SUPER"
}
```

- [ ] **Step 8: Run real OGG and streaming smoke tests**

For `af_bella` and `bf_emma`, request `/tts?format=ogg` and assert:

- HTTP 200.
- `Content-Type: audio/ogg`.
- `OggS` and `OpusHead`.

Request a long `/tts/stream`, measure time to first bytes, assert EBML signature,
save the complete response to a temporary `.webm`, and run bundled FFmpeg:

```text
ffmpeg -v error -i stream.webm -f null -
```

Expected: zero exit status. Cancel a second long stream early, assert no FFmpeg
child remains, then verify a new `/tts` request succeeds.

- [ ] **Step 9: Complete the iteration report**

Record exact Python/Node test counts, isolated CI result, service PID, GPU,
OGG sizes, stream first-byte latency, decode result, and cancellation cleanup.

- [ ] **Step 10: Commit Task 7**

```powershell
git add .github/workflows/ci.yml README.md '说明.md' docs/expert-review-2026-06-15.md docs/iteration-3-2026-06-16.md server.py tests
git commit -m "docs: complete third iteration release"
```

- [ ] **Step 11: Final review, push, and GitHub CI**

Run a final review against the design spec. Push the feature branch, merge or
fast-forward to `main` according to the chosen branch workflow, push `main`,
and wait for the GitHub Windows CI run for the release commit to complete
successfully.

Expected: local worktree clean, remote SHA matches, GitHub CI conclusion is
`success`, and service remains `ready=true`.
