@echo off
chcp 65001 >nul 2>nul
title Kokoro TTS Setup

echo.
echo ========================================
echo    Kokoro TTS Environment Setup
echo ========================================
echo.

:: -- Step 0: Check eSpeak-NG --
echo [0/3] Checking eSpeak-NG...
where espeak-ng >nul 2>nul
if errorlevel 1 (
    echo.
    echo [WARNING] eSpeak-NG not found!
    echo.
    echo   Please install it manually:
    echo   1. Visit https://github.com/espeak-ng/espeak-ng/releases
    echo   2. Download the latest Windows .msi installer
    echo   3. Add install path to system PATH
    echo      (usually C:\Program Files\eSpeak NG)
    echo   4. Restart terminal and re-run this script
    echo.
    pause
    exit /b 1
)
echo [OK] eSpeak-NG installed
echo.

:: -- Step 1: Create conda env --
echo [1/3] Creating Conda environment (Python 3.10)...
call conda create -n kokoro-tts python=3.10 -y
if errorlevel 1 (
    echo [INFO] Environment may already exist, continuing...
)
call conda activate kokoro-tts
echo [OK] Environment activated
echo.

:: -- Step 2: Install PyTorch (CUDA 12.4) --
echo [2/3] Installing PyTorch (CUDA 12.4)...
echo    This may take a few minutes depending on network speed...
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
echo [OK] PyTorch installed
echo.

:: -- Step 3: Install project dependencies --
echo [3/3] Installing project dependencies (Kokoro TTS + FastAPI)...
pip install -r "%~dp0requirements.txt"

:: Install tray app dependencies
pip install pystray Pillow
echo [OK] Dependencies installed
echo.

echo ========================================
echo    Setup complete!
echo    Next: double-click start.bat
echo          or Kokoro TTS.pyw
echo ========================================
echo.

pause
