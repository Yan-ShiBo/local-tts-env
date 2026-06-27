# Remote Ollama Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tray-configured remote Ollama source so the browser can choose either local Ollama models or models exposed through an SSH tunnel to a LAN server.

**Architecture:** Keep the browser talking only to the local FastAPI server. The tray app owns SSH login, starts a local TCP tunnel, and passes a password-free source list to the server through `KOKORO_OLLAMA_SOURCES`. The server routes model references like `remote:lab-server:qwen3:14b` to the correct Ollama base URL while plain model names continue using local Ollama.

**Tech Stack:** Python 3.10, FastAPI, Pydantic, Paramiko for SSH tunneling, Tkinter for the tray dialog, Node test runner for userscript core tests.

---

## File Structure

- Modify `D:/local-tts-env/server.py`: add Ollama source/model-reference parsing, source-aware request routing, source-aware health metadata, and pinned model isolation.
- Modify `D:/local-tts-env/tests/test_server.py`: cover local compatibility, remote model parsing, remote source listing, remote request routing, and source-specific pinning.
- Modify `D:/local-tts-env/tray_app.py`: add remote settings defaults, SSH tunnel manager, environment payload builder, menu entry, and Tkinter connection dialog.
- Modify `D:/local-tts-env/tests/test_tray_app.py`: cover default settings and source environment payload behavior without opening a real SSH connection.
- Modify `D:/local-tts-env/tts-userscript.js`: append remote model options from health metadata and expose small pure helpers for tests.
- Modify `D:/local-tts-env/tests/userscript-core.test.cjs`: cover remote model option merging and selected remote model preservation.
- Modify `D:/local-tts-env/requirements.txt`: add `paramiko>=3.5,<5`.
- Modify `D:/local-tts-env/README.md` and `D:/local-tts-env/说明.md`: document the remote service flow.

## Task 1: Server Model Sources

**Files:**
- Modify: `D:/local-tts-env/server.py`
- Test: `D:/local-tts-env/tests/test_server.py`

- [ ] **Step 1: Write failing tests for model-reference parsing and source options**

Add these tests to `ApiTests` in `D:/local-tts-env/tests/test_server.py`:

```python
    def test_remote_model_reference_resolves_source_and_model(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                id="local",
                name="Local Ollama",
                base_url="http://127.0.0.1:11434",
                remote=False,
            ),
            "lab-server": server.OllamaSource(
                id="lab-server",
                name="Lab Server",
                base_url="http://127.0.0.1:49152",
                remote=True,
            ),
        }
        try:
            resolved = server._resolve_ollama_model_ref("remote:lab-server:qwen3:14b")
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(resolved.value, "remote:lab-server:qwen3:14b")
        self.assertEqual(resolved.model, "qwen3:14b")
        self.assertEqual(resolved.source.id, "lab-server")
        self.assertEqual(resolved.source.base_url, "http://127.0.0.1:49152")

    def test_plain_model_reference_uses_local_source(self):
        resolved = server._resolve_ollama_model_ref("translategemma:4b")

        self.assertEqual(resolved.value, "translategemma:4b")
        self.assertEqual(resolved.model, "translategemma:4b")
        self.assertEqual(resolved.source.id, "local")

    def test_model_options_include_remote_source_labels(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource("local", "Local Ollama", "http://127.0.0.1:11434", False),
            "lab-server": server.OllamaSource("lab-server", "Lab Server", "http://127.0.0.1:49152", True),
        }

        def fake_json(path, timeout=5.0, base_url=None):
            if path == "/api/tags" and base_url == "http://127.0.0.1:49152":
                return {"models": [{"name": "qwen3:14b"}]}
            if path == "/api/tags":
                return {"models": [{"name": "translategemma:4b"}]}
            raise AssertionError((path, base_url))

        try:
            with patch.object(server, "_call_ollama_json", side_effect=fake_json):
                options = server._collect_ollama_model_options()
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(
            options,
            [
                {
                    "value": "translategemma:4b",
                    "label": "Local Ollama / translategemma:4b",
                    "source": "local",
                    "source_name": "Local Ollama",
                    "model": "translategemma:4b",
                },
                {
                    "value": "remote:lab-server:qwen3:14b",
                    "label": "Lab Server / qwen3:14b",
                    "source": "lab-server",
                    "source_name": "Lab Server",
                    "model": "qwen3:14b",
                },
            ],
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
python -m pytest tests/test_server.py::ApiTests::test_remote_model_reference_resolves_source_and_model tests/test_server.py::ApiTests::test_plain_model_reference_uses_local_source tests/test_server.py::ApiTests::test_model_options_include_remote_source_labels -q
```

Expected: FAIL because `OllamaSource`, `_resolve_ollama_model_ref`, and `_collect_ollama_model_options` do not exist.

- [ ] **Step 3: Implement source data structures and parsing**

Add this near the existing Ollama constants in `D:/local-tts-env/server.py`:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class OllamaSource:
    id: str
    name: str
    base_url: str
    remote: bool = False


@dataclass(frozen=True)
class OllamaModelRef:
    value: str
    model: str
    source: OllamaSource
```

Add these helpers below the Ollama constants:

```python
def _local_ollama_source() -> OllamaSource:
    return OllamaSource("local", "Local Ollama", OLLAMA_BASE_URL, False)


def _load_ollama_sources_from_env(raw: Optional[str] = None) -> dict[str, OllamaSource]:
    sources = {"local": _local_ollama_source()}
    raw_value = os.environ.get("KOKORO_OLLAMA_SOURCES", "") if raw is None else raw
    if not raw_value:
        return sources
    try:
        items = json.loads(raw_value)
    except json.JSONDecodeError:
        return sources
    if not isinstance(items, list):
        return sources
    for item in items:
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("id") or "").strip()
        name = str(item.get("name") or source_id).strip()
        base_url = str(item.get("base_url") or "").strip().rstrip("/")
        if not source_id or source_id == "local" or not base_url:
            continue
        if any(ch.isspace() for ch in source_id):
            continue
        sources[source_id] = OllamaSource(source_id, name or source_id, base_url, True)
    return sources


OLLAMA_SOURCES = _load_ollama_sources_from_env()


def _model_value_for_source(source: OllamaSource, model: str) -> str:
    return model if source.id == "local" else f"remote:{source.id}:{model}"


def _resolve_ollama_model_ref(value: Optional[str]) -> OllamaModelRef:
    selected = (value or OLLAMA_TRANSLATE_MODEL).strip() or OLLAMA_TRANSLATE_MODEL
    if selected.startswith("remote:"):
        parts = selected.split(":", 2)
        if len(parts) != 3 or not parts[1] or not parts[2]:
            raise RuntimeError("Invalid remote Ollama model reference")
        source = OLLAMA_SOURCES.get(parts[1])
        if source is None:
            raise RuntimeError("Remote Ollama source is not configured")
        return OllamaModelRef(_model_value_for_source(source, parts[2]), parts[2], source)
    source = OLLAMA_SOURCES["local"]
    return OllamaModelRef(selected, selected, source)


def _collect_ollama_model_options() -> list[dict[str, str]]:
    options: list[dict[str, str]] = []
    for source in OLLAMA_SOURCES.values():
        try:
            payload = _call_ollama_json(
                "/api/tags",
                base_url=None if source.id == "local" else source.base_url,
            )
        except Exception:
            continue
        for model in _ollama_model_names(payload):
            value = _model_value_for_source(source, model)
            options.append(
                {
                    "value": value,
                    "label": f"{source.name} / {model}",
                    "source": source.id,
                    "source_name": source.name,
                    "model": model,
                }
            )
    return options
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
python -m pytest tests/test_server.py::ApiTests::test_remote_model_reference_resolves_source_and_model tests/test_server.py::ApiTests::test_plain_model_reference_uses_local_source tests/test_server.py::ApiTests::test_model_options_include_remote_source_labels -q
```

Expected: PASS.

## Task 2: Server Source-Aware Ollama Requests

**Files:**
- Modify: `D:/local-tts-env/server.py`
- Test: `D:/local-tts-env/tests/test_server.py`

- [ ] **Step 1: Write failing tests for remote request routing and source-aware pinning**

Add these tests to `ApiTests`:

```python
    def test_remote_translate_routes_generate_to_remote_base_url(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource("local", "Local Ollama", "http://127.0.0.1:11434", False),
            "lab-server": server.OllamaSource("lab-server", "Lab Server", "http://127.0.0.1:49152", True),
        }
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": "你好"})

        try:
            with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
                result = server._call_ollama_translate_raw(
                    "Hello",
                    "remote:lab-server:qwen3:14b",
                    "Simplified Chinese",
                    None,
                )
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(result, "你好")
        self.assertEqual(captured["url"], "http://127.0.0.1:49152/api/generate")
        self.assertEqual(captured["payload"]["model"], "qwen3:14b")

    def test_remote_pinned_model_generation_requests_keep_alive(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource("local", "Local Ollama", "http://127.0.0.1:11434", False),
            "lab-server": server.OllamaSource("lab-server", "Lab Server", "http://127.0.0.1:49152", True),
        }
        server.PINNED_OLLAMA_MODELS.add("remote:lab-server:qwen3:14b")
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": "你好"})

        try:
            with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
                server._call_ollama_translate_raw("Hello", "remote:lab-server:qwen3:14b", "Simplified Chinese")
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(captured["payload"]["keep_alive"], server.OLLAMA_KEEP_ALIVE_PIN_VALUE)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
python -m pytest tests/test_server.py::ApiTests::test_remote_translate_routes_generate_to_remote_base_url tests/test_server.py::ApiTests::test_remote_pinned_model_generation_requests_keep_alive -q
```

Expected: FAIL because generation still calls `OLLAMA_BASE_URL` and sends the prefixed model name.

- [ ] **Step 3: Implement source-aware URL and payload routing**

Update `_call_ollama_json` to accept `base_url`:

```python
def _call_ollama_json(path: str, timeout: float = 5.0, base_url: Optional[str] = None):
    selected_base_url = (base_url or OLLAMA_BASE_URL).rstrip("/")
    req = urllib_request.Request(
        f"{selected_base_url}{path}",
        headers={"Accept": "application/json"},
        method="GET",
    )
```

Add:

```python
def _ollama_generate_url(ref: OllamaModelRef) -> str:
    return f"{ref.source.base_url}/api/generate"
```

Then in `_call_ollama_model_keep_alive`, `_call_ollama_translate_raw`, `_call_ollama_text_generation`, and `_call_ollama_formula_verbalization`:

```python
ref = _resolve_ollama_model_ref(model)
payload["model"] = ref.model
_prepare_ollama_generate_payload(payload, ref.value)
req = urllib_request.Request(
    _ollama_generate_url(ref),
    data=data,
    headers={"Content-Type": "application/json"},
    method="POST",
)
```

Update `_apply_ollama_thinking_mode` to inspect the clean model name:

```python
def _apply_ollama_thinking_mode(payload: dict, model: Optional[str]) -> None:
    clean_model = _resolve_ollama_model_ref(model).model if model else model
    if _ollama_should_disable_thinking(clean_model):
        payload["think"] = False
```

Keep `_apply_ollama_keep_alive` checking the canonical full reference:

```python
def _apply_ollama_keep_alive(payload: dict, model: Optional[str]) -> None:
    if not model:
        return
    selected_model = _resolve_ollama_model_ref(model).value
    if selected_model in PINNED_OLLAMA_MODELS:
        payload["keep_alive"] = OLLAMA_KEEP_ALIVE_PIN_VALUE
```

- [ ] **Step 4: Run focused server tests**

Run:

```powershell
python -m pytest tests/test_server.py::ApiTests::test_remote_translate_routes_generate_to_remote_base_url tests/test_server.py::ApiTests::test_remote_pinned_model_generation_requests_keep_alive tests/test_server.py::ApiTests::test_translate_uses_local_ollama_settings tests/test_server.py::ApiTests::test_pinned_model_generation_requests_keep_alive -q
```

Expected: PASS.

## Task 3: Server Health and Residency APIs

**Files:**
- Modify: `D:/local-tts-env/server.py`
- Test: `D:/local-tts-env/tests/test_server.py`

- [ ] **Step 1: Write failing tests for health metadata and remote keepalive**

Add:

```python
    def test_translate_health_reports_remote_source_metadata(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource("local", "Local Ollama", "http://127.0.0.1:11434", False),
            "lab-server": server.OllamaSource("lab-server", "Lab Server", "http://127.0.0.1:49152", True),
        }

        def fake_json(path, timeout=5.0, base_url=None):
            if base_url == "http://127.0.0.1:49152" and path == "/api/tags":
                return {"models": [{"name": "qwen3:14b"}]}
            if base_url == "http://127.0.0.1:49152" and path == "/api/ps":
                return {"models": [{"name": "qwen3:14b"}]}
            if path == "/api/tags":
                return {"models": [{"name": "translategemma:4b"}]}
            if path == "/api/ps":
                return {"models": []}
            raise AssertionError((path, base_url))

        try:
            with patch.object(server, "_call_ollama_json", side_effect=fake_json):
                response = self.client.get("/translate/health?model=remote:lab-server:qwen3:14b")
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source"], "lab-server")
        self.assertEqual(payload["source_name"], "Lab Server")
        self.assertEqual(payload["model"], "remote:lab-server:qwen3:14b")
        self.assertTrue(payload["model_running"])
        self.assertIn(
            {
                "value": "remote:lab-server:qwen3:14b",
                "label": "Lab Server / qwen3:14b",
                "source": "lab-server",
                "source_name": "Lab Server",
                "model": "qwen3:14b",
            },
            payload["available_model_options"],
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -m pytest tests/test_server.py::ApiTests::test_translate_health_reports_remote_source_metadata -q
```

Expected: FAIL because the health response has no source metadata.

- [ ] **Step 3: Extend response models and health logic**

Add:

```python
class OllamaModelOption(BaseModel):
    value: str
    label: str
    source: str
    source_name: str
    model: str
```

Update `TranslateHealthResponse`:

```python
class TranslateHealthResponse(BaseModel):
    status: str
    ollama_reachable: bool
    model: str
    model_available: bool
    model_running: bool
    model_pinned: bool = False
    available_models: list[str]
    running_models: list[str]
    source: str = "local"
    source_name: str = "Local Ollama"
    available_model_options: list[OllamaModelOption] = Field(default_factory=list)
    error: Optional[str] = None
```

In `translate_health`, resolve the selected model first:

```python
ref = _resolve_ollama_model_ref(model or OLLAMA_TRANSLATE_MODEL)
base_url = None if ref.source.id == "local" else ref.source.base_url
available_models = _ollama_model_names(_call_ollama_json("/api/tags", base_url=base_url))
running_models = _ollama_model_names(_call_ollama_json("/api/ps", base_url=base_url))
```

Return `model=ref.value`, `source=ref.source.id`, `source_name=ref.source.name`, `model_available=ref.model in available_models`, and `model_pinned=ref.value in PINNED_OLLAMA_MODELS`.

- [ ] **Step 4: Run health tests**

Run:

```powershell
python -m pytest tests/test_server.py::ApiTests::test_translate_health_reports_remote_source_metadata tests/test_server.py::ApiTests::test_translate_health_reports_model_state tests/test_server.py::ApiTests::test_translate_health_handles_ollama_offline -q
```

Expected: PASS.

## Task 4: Tray Remote Settings and Tunnel Payload

**Files:**
- Modify: `D:/local-tts-env/tray_app.py`
- Modify: `D:/local-tts-env/requirements.txt`
- Test: `D:/local-tts-env/tests/test_tray_app.py`

- [ ] **Step 1: Write failing tests for settings and server environment payload**

Add:

```python
class TrayRemoteOllamaTests(unittest.TestCase):
    def test_default_settings_include_remote_ollama(self):
        with patch.object(
            tray_app,
            "SETTINGS_FILE",
            Path("__missing_tray_settings_for_test__.json"),
        ):
            settings = tray_app.load_settings()

        self.assertEqual(
            settings["remote_ollama"],
            {
                "enabled": False,
                "name": "",
                "host": "",
                "ssh_port": 22,
                "username": "",
                "password": "",
                "ollama_host": "127.0.0.1",
                "ollama_port": 11434,
                "local_port": 0,
            },
        )

    def test_remote_source_env_omits_password(self):
        app = TrayAutoStartTests().make_app()
        app.settings["remote_ollama"] = {
            "enabled": True,
            "name": "Lab Server",
            "host": "192.168.1.10",
            "ssh_port": 22,
            "username": "alice",
            "password": "secret",
            "ollama_host": "127.0.0.1",
            "ollama_port": 11434,
            "local_port": 49152,
        }
        app.remote_tunnel_local_port = 49152

        payload = app.build_remote_ollama_sources_env()

        self.assertEqual(
            json.loads(payload),
            [
                {
                    "id": "lab-server",
                    "name": "Lab Server",
                    "base_url": "http://127.0.0.1:49152",
                }
            ],
        )
        self.assertNotIn("secret", payload)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
python -m pytest tests/test_tray_app.py::TrayRemoteOllamaTests -q
```

Expected: FAIL because remote defaults and payload builder do not exist.

- [ ] **Step 3: Implement remote settings defaults and payload builder**

Add:

```python
def default_remote_ollama_settings():
    return {
        "enabled": False,
        "name": "",
        "host": "",
        "ssh_port": 22,
        "username": "",
        "password": "",
        "ollama_host": "127.0.0.1",
        "ollama_port": 11434,
        "local_port": 0,
    }


def slugify_source_id(value):
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value.strip())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned or "remote-server"
```

In `load_settings`, merge `remote_ollama` with `default_remote_ollama_settings()`.

In `TrayApp.__init__`, add:

```python
self.remote_tunnel = None
self.remote_tunnel_local_port = None
```

Add:

```python
def build_remote_ollama_sources_env(self):
    remote = self.settings.get("remote_ollama") or {}
    if not remote.get("enabled"):
        return ""
    local_port = self.remote_tunnel_local_port or int(remote.get("local_port") or 0)
    if local_port <= 0:
        return ""
    name = (remote.get("name") or remote.get("host") or "Remote Ollama").strip()
    source_id = slugify_source_id(name)
    return json.dumps(
        [
            {
                "id": source_id,
                "name": name,
                "base_url": f"http://127.0.0.1:{local_port}",
            }
        ],
        ensure_ascii=False,
    )
```

In `start_server`, add:

```python
sources_env = self.build_remote_ollama_sources_env()
if sources_env:
    env["KOKORO_OLLAMA_SOURCES"] = sources_env
```

Add `paramiko>=3.5,<5` to `requirements.txt`.

- [ ] **Step 4: Run tray tests**

Run:

```powershell
python -m pytest tests/test_tray_app.py::TrayRemoteOllamaTests tests/test_tray_app.py::TrayAutoStartTests -q
```

Expected: PASS.

## Task 5: Tray SSH Tunnel and Dialog

**Files:**
- Modify: `D:/local-tts-env/tray_app.py`

- [ ] **Step 1: Implement tunnel manager with lazy Paramiko import**

Add a `RemoteOllamaTunnel` class that:

```python
class RemoteOllamaTunnel:
    def __init__(self, settings):
        self.settings = settings
        self.client = None
        self.server = None
        self.thread = None
        self.local_port = 0

    def start(self):
        import paramiko
        # Connect with password, no agent, no key lookup.
        # Start a local threaded TCP server forwarding to remote ollama_host:ollama_port.
        # Return the selected local port.

    def stop(self):
        # Shutdown TCP server and close SSH client if present.
```

Use `socketserver.ThreadingTCPServer`, `select.select`, and `paramiko.Transport.open_channel("direct-tcpip", ...)` for forwarding. Import Paramiko inside `start()` so tests can import `tray_app.py` even before dependencies are installed.

- [ ] **Step 2: Add tray methods**

Add:

```python
def connect_remote_ollama(self):
    self.disconnect_remote_ollama(restart=False)
    tunnel = RemoteOllamaTunnel(self.settings["remote_ollama"])
    local_port = tunnel.start()
    self.remote_tunnel = tunnel
    self.remote_tunnel_local_port = local_port
    self.settings["remote_ollama"]["enabled"] = True
    self.settings["remote_ollama"]["local_port"] = local_port
    save_settings(self.settings)
    self.restart_server()


def disconnect_remote_ollama(self, restart=True):
    if self.remote_tunnel:
        self.remote_tunnel.stop()
    self.remote_tunnel = None
    self.remote_tunnel_local_port = None
    if restart:
        self.settings["remote_ollama"]["enabled"] = False
        save_settings(self.settings)
        self.restart_server()
```

- [ ] **Step 3: Add Tkinter dialog and tray menu item**

Add `open_remote_service_settings` that creates a small Tkinter dialog with fields for name, host, SSH port, username, password, Ollama host, and Ollama port. On `Connect`, update `self.settings["remote_ollama"]`, call `connect_remote_ollama`, and close the dialog. On `Disconnect`, call `disconnect_remote_ollama` and close the dialog.

Add to `_build_menu` near the project/log items:

```python
Item("Remote Service", self.open_remote_service_settings),
```

- [ ] **Step 4: Run tray tests and import check**

Run:

```powershell
python -m pytest tests/test_tray_app.py -q
python -c "import tray_app; print('tray import ok')"
```

Expected: PASS and `tray import ok`.

## Task 6: Browser Remote Model Options

**Files:**
- Modify: `D:/local-tts-env/tts-userscript.js`
- Test: `D:/local-tts-env/tests/userscript-core.test.cjs`

- [ ] **Step 1: Write failing userscript helper tests**

Add:

```javascript
test("model option merge includes remote health metadata", () => {
  const { mergeTranslationModelOptions } = require("../tts-userscript.js");
  const merged = mergeTranslationModelOptions(
    [{ value: "translategemma:4b", label: "translategemma:4b - default" }],
    {
      available_models: ["translategemma:4b"],
      available_model_options: [
        {
          value: "remote:lab-server:qwen3:14b",
          label: "Lab Server / qwen3:14b",
          source: "lab-server",
          source_name: "Lab Server",
          model: "qwen3:14b",
        },
      ],
    },
    "remote:lab-server:qwen3:14b"
  );

  assert.deepEqual(merged, [
    { value: "translategemma:4b", label: "translategemma:4b - default" },
    { value: "remote:lab-server:qwen3:14b", label: "Lab Server / qwen3:14b" },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test tests/userscript-core.test.cjs
```

Expected: FAIL because `mergeTranslationModelOptions` is not exported.

- [ ] **Step 3: Implement and export pure merge helper**

Inside the `KokoroTTSCore` block add:

```javascript
function mergeTranslationModelOptions(baseOptions, payload, selectedValue) {
  const merged = [];
  const seen = new Set();
  function add(value, label) {
    const cleanValue = String(value || "").trim();
    if (!cleanValue || seen.has(cleanValue)) return;
    seen.add(cleanValue);
    merged.push({ value: cleanValue, label: String(label || cleanValue) });
  }
  for (const option of Array.isArray(baseOptions) ? baseOptions : []) {
    add(option.value, option.label);
  }
  const remoteOptions = payload && Array.isArray(payload.available_model_options)
    ? payload.available_model_options
    : [];
  for (const option of remoteOptions) {
    add(option.value, option.label);
  }
  for (const model of payload && Array.isArray(payload.available_models) ? payload.available_models : []) {
    add(model, `Installed: ${model}`);
  }
  if (selectedValue) add(selectedValue, `Custom: ${selectedValue}`);
  return merged;
}
```

Export it in the returned object.

Update `syncInstalledTranslationModels` to call this helper and rebuild the select options while preserving `settings.translateModel`.

- [ ] **Step 4: Run userscript tests**

Run:

```powershell
node --test tests/userscript-core.test.cjs
```

Expected: PASS.

## Task 7: Documentation and Full Verification

**Files:**
- Modify: `D:/local-tts-env/README.md`
- Modify: `D:/local-tts-env/说明.md`

- [ ] **Step 1: Document the remote service**

Add a short section explaining:

```markdown
### Remote Ollama over LAN

Right-click the Kokoro TTS tray icon and choose `Remote Service`.
Enter the server name, IP, SSH port, username, password, and remote Ollama host/port.
The app creates a local SSH tunnel and the browser model selector will show models as `Server Name / model`.

The browser script never receives the SSH password. The password is stored in `tray_settings.json` for convenience.
```

- [ ] **Step 2: Run full Python and Node tests**

Run:

```powershell
python -m pytest -q
node --test tests/userscript-core.test.cjs
```

Expected: all tests PASS.

- [ ] **Step 3: Manual tray smoke check**

Run:

```powershell
python -c "import tray_app; settings=tray_app.default_remote_ollama_settings(); print(settings['ollama_host'], settings['ollama_port'])"
```

Expected:

```text
127.0.0.1 11434
```

## Self-Review

- Spec coverage: server routing, tray configuration, remote SSH tunnel, browser model selection, error privacy, and documentation are each covered by a task.
- Placeholder scan: no deferred implementation markers are used; each step has concrete commands and expected results.
- Type consistency: remote model references use `remote:<source-id>:<model>` throughout; server source fields are consistently `id`, `name`, `base_url`, and `remote`; browser option fields match the API response shape.
