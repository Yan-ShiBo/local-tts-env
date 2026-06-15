@echo off
chcp 65001 >nul 2>nul
title Kokoro TTS Server

echo.
echo ========================================
echo    Kokoro TTS Local Server
echo ========================================
echo.

:: Check eSpeak-NG
where espeak-ng >nul 2>nul
if errorlevel 1 (
    echo [ERROR] eSpeak-NG not found!
    echo         Please run setup.bat first.
    pause
    exit /b 1
)

:: Activate conda env and start server
call conda activate kokoro-tts
if errorlevel 1 (
    echo [ERROR] kokoro-tts conda env not found!
    echo         Please run setup.bat first.
    pause
    exit /b 1
)

echo Starting Kokoro TTS server...
echo Press Ctrl+C to stop.
echo.
python "%~dp0server.py"

pause
