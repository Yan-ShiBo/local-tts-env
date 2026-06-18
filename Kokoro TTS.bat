@echo off
chcp 65001 >nul 2>nul
setlocal

set "CONDA_ENV=kokoro-tts"
set "PYTHONW_EXE="

if exist "%USERPROFILE%\.conda\envs\%CONDA_ENV%\pythonw.exe" set "PYTHONW_EXE=%USERPROFILE%\.conda\envs\%CONDA_ENV%\pythonw.exe"
if not defined PYTHONW_EXE if exist "%USERPROFILE%\.conda\envs\%CONDA_ENV%\python.exe" set "PYTHONW_EXE=%USERPROFILE%\.conda\envs\%CONDA_ENV%\python.exe"
if not defined PYTHONW_EXE if exist "%USERPROFILE%\anaconda3\envs\%CONDA_ENV%\pythonw.exe" set "PYTHONW_EXE=%USERPROFILE%\anaconda3\envs\%CONDA_ENV%\pythonw.exe"
if not defined PYTHONW_EXE if exist "%USERPROFILE%\anaconda3\envs\%CONDA_ENV%\python.exe" set "PYTHONW_EXE=%USERPROFILE%\anaconda3\envs\%CONDA_ENV%\python.exe"
if not defined PYTHONW_EXE if exist "%USERPROFILE%\miniconda3\envs\%CONDA_ENV%\pythonw.exe" set "PYTHONW_EXE=%USERPROFILE%\miniconda3\envs\%CONDA_ENV%\pythonw.exe"
if not defined PYTHONW_EXE if exist "%USERPROFILE%\miniconda3\envs\%CONDA_ENV%\python.exe" set "PYTHONW_EXE=%USERPROFILE%\miniconda3\envs\%CONDA_ENV%\python.exe"
if not defined PYTHONW_EXE if exist "%ProgramData%\anaconda3\envs\%CONDA_ENV%\pythonw.exe" set "PYTHONW_EXE=%ProgramData%\anaconda3\envs\%CONDA_ENV%\pythonw.exe"
if not defined PYTHONW_EXE if exist "%ProgramData%\anaconda3\envs\%CONDA_ENV%\python.exe" set "PYTHONW_EXE=%ProgramData%\anaconda3\envs\%CONDA_ENV%\python.exe"
if not defined PYTHONW_EXE if exist "%ProgramData%\miniconda3\envs\%CONDA_ENV%\pythonw.exe" set "PYTHONW_EXE=%ProgramData%\miniconda3\envs\%CONDA_ENV%\pythonw.exe"
if not defined PYTHONW_EXE if exist "%ProgramData%\miniconda3\envs\%CONDA_ENV%\python.exe" set "PYTHONW_EXE=%ProgramData%\miniconda3\envs\%CONDA_ENV%\python.exe"

if not defined PYTHONW_EXE (
    for /f "delims=" %%P in ('conda run -n %CONDA_ENV% python -c "from pathlib import Path; import sys; p=Path(sys.executable); w=p.with_name('pythonw.exe'); print(w if w.exists() else p)" 2^>nul') do (
        if exist "%%P" set "PYTHONW_EXE=%%P"
    )
)

if /i "%~1"=="--print-python" (
    if defined PYTHONW_EXE echo %PYTHONW_EXE%
    if not defined PYTHONW_EXE echo NOT_FOUND
    exit /b 0
)

if not defined PYTHONW_EXE (
    echo [ERROR] kokoro-tts conda env Python not found!
    echo         Please run setup.bat first.
    pause
    exit /b 1
)

start "Kokoro TTS" "%PYTHONW_EXE%" "%~dp0tray_app.py"
exit /b 0
