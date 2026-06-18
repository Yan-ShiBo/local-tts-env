"""
tray_app.py - Kokoro TTS System Tray Application

Double-click to launch. The server runs in the background
with a system tray icon for control.

Features:
  - Auto-starts TTS server on launch
  - System tray icon with status indicator
  - Right-click menu: Start/Stop, Voice, Speed, Test Page, Exit
  - No terminal window
"""

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tts_catalog import (
    AVAILABLE_VOICES,
    DEFAULT_SPEED,
    DEFAULT_VOICE,
    SPEEDS,
    VOICE_GROUPS,
)
from windows_runtime import WindowsNamedMutex
from windows_startup import (
    StartupShortcutError,
    inspect_startup_shortcut,
    reconcile_startup_shortcut,
)

# ---------------------------------------------------------------------------
#  Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent.resolve()
SERVER_SCRIPT = SCRIPT_DIR / "server.py"
TRAY_LAUNCHER = SCRIPT_DIR / "Kokoro TTS.bat"
SETTINGS_FILE = SCRIPT_DIR / "tray_settings.json"
CONDA_ENV_NAME = "kokoro-tts"
APP_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", SCRIPT_DIR)) / "KokoroTTS"
LOG_FILE = APP_DATA_DIR / "server.log"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5000

VOICES = {
    group["label_en"]: [
        (
            voice["id"],
            f'{voice["id"]} - {voice["label_en"]}'
            + (" (Default)" if voice["id"] == DEFAULT_VOICE else ""),
        )
        for voice in group["voices"]
    ]
    for group in VOICE_GROUPS
}


# ---------------------------------------------------------------------------
#  Auto-detect conda environment Python path
# ---------------------------------------------------------------------------

def find_conda_python(env_name: str) -> Path:
    """Find the Python executable for a given conda environment name."""
    # Method 1: Try 'conda env list' to get all env paths
    try:
        result = subprocess.run(
            ["conda", "env", "list", "--json"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode == 0:
            envs = json.loads(result.stdout).get("envs", [])
            for env_path in envs:
                if Path(env_path).name == env_name:
                    python_exe = Path(env_path) / "python.exe"
                    if python_exe.exists():
                        return python_exe
    except Exception:
        pass

    # Method 2: Check common locations
    home = Path.home()
    candidates = [
        home / ".conda" / "envs" / env_name / "python.exe",
        home / "anaconda3" / "envs" / env_name / "python.exe",
        home / "miniconda3" / "envs" / env_name / "python.exe",
        Path(r"C:\ProgramData\anaconda3\envs") / env_name / "python.exe",
        Path(r"C:\ProgramData\miniconda3\envs") / env_name / "python.exe",
    ]
    for p in candidates:
        if p.exists():
            return p

    raise FileNotFoundError(
        f"Conda environment '{env_name}' was not found. Run setup.bat first."
    )


def find_conda_pythonw(env_name: str) -> Path:
    """Find pythonw.exe (no-console) for a conda env."""
    python = find_conda_python(env_name)
    pythonw = python.parent / "pythonw.exe"
    return pythonw if pythonw.exists() else python


# ---------------------------------------------------------------------------
#  Settings persistence
# ---------------------------------------------------------------------------

def load_settings():
    defaults = {"voice": DEFAULT_VOICE, "speed": DEFAULT_SPEED, "auto_start": False}
    try:
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
                defaults.update(saved)
    except Exception:
        pass
    if defaults["voice"] not in AVAILABLE_VOICES:
        defaults["voice"] = DEFAULT_VOICE
    if defaults["speed"] not in SPEEDS:
        defaults["speed"] = DEFAULT_SPEED
    defaults["auto_start"] = bool(defaults.get("auto_start", False))
    return defaults


def save_settings(settings):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
    except Exception:
        pass


# ---------------------------------------------------------------------------
#  Icon generation (no external image files needed)
# ---------------------------------------------------------------------------

def create_icon_image(color="green"):
    """Create a simple tray icon with PIL."""
    from PIL import Image, ImageDraw, ImageFont

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle
    if color == "green":
        fill = (102, 126, 234, 255)  # Purple-blue (brand color)
    elif color == "red":
        fill = (200, 80, 80, 255)    # Red (stopped)
    elif color == "yellow":
        fill = (240, 192, 64, 255)   # Yellow (loading)
    else:
        fill = (128, 128, 128, 255)  # Gray

    draw.ellipse([4, 4, size - 4, size - 4], fill=fill)

    # "K" letter
    try:
        font = ImageFont.truetype("segoeui.ttf", 32)
    except Exception:
        try:
            font = ImageFont.truetype("arial.ttf", 32)
        except Exception:
            font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), "K", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2
    ty = (size - th) // 2 - 2
    draw.text((tx, ty), "K", fill=(255, 255, 255, 255), font=font)

    return img


# ---------------------------------------------------------------------------
#  Server process management
# ---------------------------------------------------------------------------

class TrayApp:
    def __init__(self):
        self.server_process = None
        self.owns_server = False
        self._log_handle = None
        self.settings = load_settings()
        self.tray_icon = None
        self.is_running = False
        self._lock = threading.Lock()
        self.python_exe = find_conda_python(CONDA_ENV_NAME)
        # 缓存开机自启状态，避免右键托盘菜单渲染时同步拉起 PowerShell 子进程导致系统假死
        self.auto_start_cached = bool(self.settings.get("auto_start", False))
        threading.Thread(target=self._init_and_reconcile_auto_start, daemon=True).start()

    def get_health(self, port=DEFAULT_PORT):
        try:
            with urllib.request.urlopen(
                f"http://{DEFAULT_HOST}:{port}/health", timeout=1
            ) as response:
                data = json.load(response)
            if (
                response.status == 200
                and data.get("service") == "kokoro-tts"
                and data.get("ready") is True
            ):
                return data
        except (OSError, ValueError, urllib.error.URLError):
            pass
        return None

    def start_server(self, _=None):
        with self._lock:
            if self.server_process and self.server_process.poll() is None:
                return  # Already running

            existing_health = self.get_health()
            if existing_health:
                self.owns_server = False
                self.is_running = True
                self._update_icon("green", "Kokoro TTS - Running")
                return

            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(1)
                if sock.connect_ex((DEFAULT_HOST, DEFAULT_PORT)) == 0:
                    self.owns_server = False
                    self.is_running = False
                    self._update_icon(
                        "red", f"Kokoro TTS - Port {DEFAULT_PORT} is occupied"
                    )
                    return

            self._update_icon("yellow", "Kokoro TTS - Starting...")

            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            env["KOKORO_HOST"] = DEFAULT_HOST
            env["KOKORO_PORT"] = str(DEFAULT_PORT)
            env["KOKORO_VOICE"] = self.settings["voice"]
            env["KOKORO_SPEED"] = str(self.settings["speed"])
            env["KOKORO_TRAY_PID"] = str(os.getpid())

            # Start server process (hidden, no window)
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE

            APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
            self._log_handle = open(LOG_FILE, "a", encoding="utf-8")
            self.server_process = subprocess.Popen(
                [str(self.python_exe), str(SERVER_SCRIPT)],
                cwd=str(SCRIPT_DIR),
                env=env,
                startupinfo=startupinfo,
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            self.owns_server = True

        # Wait for server to be ready in background
        def wait_ready():
            for _ in range(60):  # 60s timeout
                if self.server_process.poll() is not None:
                    self.owns_server = False
                    self.is_running = False
                    self._update_icon("red", "Kokoro TTS - Failed to start")
                    self._close_log()
                    return
                if self.get_health():
                    self.is_running = True
                    self._update_icon("green", "Kokoro TTS - Running")
                    return
                time.sleep(1)
            self.is_running = False
            self._update_icon("red", "Kokoro TTS - Startup timeout")

        threading.Thread(target=wait_ready, daemon=True).start()

    def stop_server(self, _=None):
        with self._lock:
            if self.server_process and self.server_process.poll() is None:
                self.server_process.terminate()
                try:
                    self.server_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.server_process.kill()
            self.server_process = None
            self.owns_server = False
            self._close_log()
            if self.get_health():
                self.is_running = True
                self._update_icon("green", "Kokoro TTS - External server running")
                return
            self.is_running = False
            self._update_icon("red", "Kokoro TTS - Stopped")

    def restart_server(self, _=None):
        self.stop_server()
        time.sleep(1)
        self.start_server()

    def can_stop_server(self):
        return self.is_running and self.owns_server

    def open_test_page(self, _=None):
        webbrowser.open(f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/")

    def open_health(self, _=None):
        webbrowser.open(f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/health")

    def open_project_dir(self, _=None):
        os.startfile(str(SCRIPT_DIR))

    def open_log(self, _=None):
        APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not LOG_FILE.exists():
            LOG_FILE.touch()
        os.startfile(str(LOG_FILE))

    def show_error(self, title, message):
        if os.name == "nt":
            try:
                import ctypes

                ctypes.windll.user32.MessageBoxW(
                    0,
                    str(message),
                    f"Kokoro TTS - {title}",
                    0x10,
                )
                return
            except Exception:
                pass
        print(f"[Kokoro TTS] {title}: {message}")

    def _init_and_reconcile_auto_start(self):
        try:
            # 在后台线程中检查快捷方式实际是否存在，避免卡死托盘启动
            actual = inspect_startup_shortcut(TRAY_LAUNCHER, SCRIPT_DIR)
            self.auto_start_cached = actual
            
            desired = bool(self.settings.get("auto_start", False))
            if desired != actual:
                actual = reconcile_startup_shortcut(desired, TRAY_LAUNCHER, SCRIPT_DIR)
                self.auto_start_cached = actual
        except Exception:
            pass
        self.settings["auto_start"] = self.auto_start_cached
        save_settings(self.settings)
        if self.tray_icon:
            self.tray_icon.menu = self._build_menu()

    def is_auto_start_enabled(self):
        return self.auto_start_cached

    def toggle_auto_start(self, _=None):
        previous = self.auto_start_cached
        try:
            requested = not previous
            actual = reconcile_startup_shortcut(
                requested,
                TRAY_LAUNCHER,
                SCRIPT_DIR,
            )
            self.auto_start_cached = actual
        except StartupShortcutError as error:
            self.auto_start_cached = previous
            self.show_error("Auto-start", str(error))
            return

        self.settings["auto_start"] = self.auto_start_cached
        save_settings(self.settings)
        if self.tray_icon:
            self.tray_icon.menu = self._build_menu()

    def set_voice(self, voice_id):
        def _set(_=None):
            self.settings["voice"] = voice_id
            save_settings(self.settings)
            self.restart_server()
        return _set

    def set_speed(self, speed_val):
        def _set(_=None):
            self.settings["speed"] = speed_val
            save_settings(self.settings)
            self.restart_server()
        return _set

    def quit_app(self, _=None):
        self.stop_server()
        if self.tray_icon:
            self.tray_icon.stop()

    def _update_icon(self, color, title):
        if self.tray_icon:
            self.tray_icon.icon = create_icon_image(color)
            self.tray_icon.title = title

    def _close_log(self):
        if self._log_handle:
            self._log_handle.close()
            self._log_handle = None

    def _build_menu(self):
        import pystray
        from pystray import MenuItem as Item

        # Voice submenu
        voice_items = []
        for group_name, voices in VOICES.items():
            for vid, vlabel in voices:
                is_current = vid == self.settings["voice"]
                voice_items.append(
                    Item(
                        (">> " if is_current else "   ") + vlabel,
                        self.set_voice(vid),
                    )
                )
            voice_items.append(pystray.Menu.SEPARATOR)

        # Speed submenu
        speed_items = []
        for spd in SPEEDS:
            is_current = abs(spd - self.settings["speed"]) < 0.01
            label = f"{'>> ' if is_current else '   '}{spd}x"
            if abs(spd - DEFAULT_SPEED) < 0.01:
                label += " (default)"
            speed_items.append(Item(label, self.set_speed(spd)))

        menu = pystray.Menu(
            Item("Start Server", self.start_server,
                 enabled=lambda _: not self.is_running),
            Item("Stop Server", self.stop_server,
                 enabled=lambda _: self.can_stop_server()),
            Item("Restart Server", self.restart_server,
                 enabled=lambda _: self.can_stop_server()),
            pystray.Menu.SEPARATOR,
            Item("Voice", pystray.Menu(*voice_items)),
            Item("Speed", pystray.Menu(*speed_items)),
            pystray.Menu.SEPARATOR,
            Item("Open Test Page", self.open_test_page,
                  enabled=lambda _: self.is_running),
            Item("Open Server Log", self.open_log),
            Item("Open Project Folder", self.open_project_dir),
            Item(
                "Auto-start on login",
                self.toggle_auto_start,
                checked=lambda _: self.is_auto_start_enabled(),
            ),
            pystray.Menu.SEPARATOR,
            Item("Exit", self.quit_app),
        )
        return menu

    def run(self):
        import pystray

        icon = pystray.Icon(
            name="kokoro-tts",
            icon=create_icon_image("yellow"),
            title="Kokoro TTS - Starting...",
            menu=self._build_menu(),
        )
        self.tray_icon = icon

        # Auto-start server
        threading.Thread(target=self.start_server, daemon=True).start()

        icon.run()


# ---------------------------------------------------------------------------
#  Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    instance_mutex = WindowsNamedMutex(r"Local\KokoroTTS.Tray")
    if not instance_mutex.acquire():
        import ctypes

        ctypes.windll.user32.MessageBoxW(
            0,
            "Kokoro TTS 已在运行。",
            "Kokoro TTS",
            0x40,
        )
        raise SystemExit(0)
    try:
        app = TrayApp()
        app.run()
    finally:
        instance_mutex.close()
