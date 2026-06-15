"""Launcher for Kokoro TTS tray app (no console window)."""
import json
import subprocess
import sys
import tkinter.messagebox
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
TRAY_SCRIPT = SCRIPT_DIR / "tray_app.py"
CONDA_ENV_NAME = "kokoro-tts"


def find_pythonw():
    """Auto-detect pythonw.exe in the kokoro-tts conda environment."""
    try:
        result = subprocess.run(
            ["conda", "env", "list", "--json"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode == 0:
            envs = json.loads(result.stdout).get("envs", [])
            for env_path in envs:
                if Path(env_path).name == CONDA_ENV_NAME:
                    pythonw = Path(env_path) / "pythonw.exe"
                    if pythonw.exists():
                        return str(pythonw)
    except Exception:
        pass

    # Check common locations
    home = Path.home()
    for base in [
        home / ".conda" / "envs",
        home / "anaconda3" / "envs",
        home / "miniconda3" / "envs",
        Path(r"C:\ProgramData\anaconda3\envs"),
        Path(r"C:\ProgramData\miniconda3\envs"),
    ]:
        pythonw = base / CONDA_ENV_NAME / "pythonw.exe"
        if pythonw.exists():
            return str(pythonw)

    return None


pythonw = find_pythonw()
if not pythonw:
    tkinter.messagebox.showerror(
        "Kokoro TTS",
        "找不到 kokoro-tts Conda 环境。请先运行 setup.bat。",
    )
    raise SystemExit(1)

subprocess.Popen(
    [pythonw, str(TRAY_SCRIPT)],
    cwd=str(SCRIPT_DIR),
    creationflags=subprocess.CREATE_NO_WINDOW,
)
