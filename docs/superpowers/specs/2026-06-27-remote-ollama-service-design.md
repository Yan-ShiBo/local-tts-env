# Remote Ollama Service Design

## Goal

Add an optional remote Ollama source for translation-related models while keeping the existing local Ollama path working. The user configures the remote server from the Windows tray app, then the browser model selector shows both local models and remote server models.

## User Flow

1. The user right-clicks the Kokoro TTS tray icon and opens `Remote Service`.
2. A small settings window lets the user enter:
   - server display name
   - server IP or host
   - SSH port, default `22`
   - username
   - password
   - remote Ollama host and port, default `127.0.0.1:11434`
3. The user clicks connect.
4. The tray app opens an SSH tunnel from a local ephemeral port to the remote server's Ollama endpoint.
5. The local FastAPI service discovers models from both the local Ollama and configured remote sources.
6. The browser settings panel model selector shows grouped options for local models and the remote server name.
7. Translation, read preparation, formula verbalization, keep loaded, unload, and health checks use the selected source.

## Architecture

The browser userscript continues to talk only to the local Kokoro TTS API at `127.0.0.1:5000`. It never receives the remote SSH password.

The tray app owns remote connection setup because it already manages background process state and local settings. It saves the remote connection profile in `tray_settings.json` and starts the local server with environment variables that point to the active remote source configuration.

The FastAPI server adds source-aware Ollama routing. Existing model names such as `translategemma:4b` keep using local Ollama. Remote model choices are represented with an internal source prefix, for example:

```text
remote:<server-id>:qwen3:14b
```

API responses include display metadata so the browser can render friendly labels such as `Lab Server / qwen3:14b`.

## Components

### Tray App

Add a `Remote Service` menu item. It opens a basic Tkinter dialog for configuration and connection. The dialog validates required fields and tests the tunnel by calling `/api/tags` through the local forwarded port.

The tray app should store remote settings under a new `remote_ollama` key in `tray_settings.json`:

```json
{
  "enabled": true,
  "name": "Lab Server",
  "host": "192.168.1.10",
  "ssh_port": 22,
  "username": "user",
  "password": "password",
  "ollama_host": "127.0.0.1",
  "ollama_port": 11434,
  "local_port": 0
}
```

`local_port: 0` means choose an available local port automatically. The tray app keeps the SSH tunnel process alive while the Kokoro app is running and restarts the local server after connection changes.

### Server

Add an Ollama source abstraction with:

- source id
- display name
- base URL
- whether the source is local or remote

Default source:

```text
local -> http://127.0.0.1:11434
```

Remote sources are loaded from environment JSON passed by the tray app, for example `KOKORO_OLLAMA_SOURCES`.

The existing Ollama helper functions gain an optional source-aware model reference. They resolve `remote:<server-id>:<model>` into the selected source and clean model name before calling `/api/generate`, `/api/tags`, or `/api/ps`.

Pinned models are tracked by full model reference instead of plain model name, so a local `qwen3:14b` and remote `qwen3:14b` do not collide.

### Browser Userscript

The settings panel keeps the current local custom model behavior. It also uses the health response's available model metadata to append remote model options.

The selected model value can be either:

```text
qwen3:14b
remote:lab-server:qwen3:14b
```

The browser sends that value unchanged to existing endpoints.

## API Changes

`GET /translate/health?model=...` remains backward-compatible.

The response adds optional fields:

```json
{
  "source": "local",
  "source_name": "Local Ollama",
  "available_model_options": [
    {
      "value": "translategemma:4b",
      "label": "Local Ollama / translategemma:4b",
      "source": "local",
      "source_name": "Local Ollama",
      "model": "translategemma:4b"
    },
    {
      "value": "remote:lab-server:qwen3:14b",
      "label": "Lab Server / qwen3:14b",
      "source": "lab-server",
      "source_name": "Lab Server",
      "model": "qwen3:14b"
    }
  ]
}
```

Existing `available_models` remains a list of local-compatible strings for older userscripts.

## Error Handling

If the remote SSH tunnel cannot connect, the tray dialog shows a concise error and leaves the previous working settings unchanged.

If the local server starts without a working remote source, local Ollama still works. Health checks for remote selections return `ollama_reachable: false` and do not expose passwords or detailed connection strings.

Translation endpoints continue returning generic 502 errors. Logs may include source names but not passwords.

## Testing

Add server tests for:

- parsing local and remote model references
- listing model options across local and remote sources
- routing generate, tags, ps, keepalive, and unload requests to the selected source
- pinned model identity including source id
- backward compatibility for plain local model names

Add tray tests for:

- default remote settings shape
- saving remote settings without breaking existing voice, speed, and auto-start settings
- building a remote source environment payload without including unrelated fields

Add userscript tests for:

- appending remote model options from health metadata
- preserving selected remote model values when saving settings

## Non-Goals

This change does not install or configure Ollama on the remote server. It also does not add public HTTP authentication for Ollama. The intended remote path is SSH login to a LAN server and forwarding to that server's native Ollama API.
