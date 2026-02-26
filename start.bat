@echo off
echo Starting Research Hub...
cd /d "%~dp0"

:: Check if GEMINI_API_KEY is already set (e.g. as a system env var)
if "%GEMINI_API_KEY%"=="" (
    echo WARNING: GEMINI_API_KEY is not set.
    echo AI Discovery mode will not work until you set it.
    echo.
    echo To set it for this session, run:
    echo   set GEMINI_API_KEY=AIza...
    echo Then restart this script.
    echo.
)

start "" python server.py
