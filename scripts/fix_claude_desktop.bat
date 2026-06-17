@echo off
REM ============================================================
REM  fix_claude_desktop.bat
REM  Fixes "problem with Claude" / reinstall errors on Windows
REM  Just double-click this file to run it.
REM ============================================================

echo.
echo =============================================
echo   Claude Desktop Fix Script
echo =============================================
echo.

REM --- Step 1: Close Claude Desktop if running ---
echo [1/5] Closing Claude Desktop if open...
taskkill /F /IM "claude.exe" >nul 2>&1
taskkill /F /IM "Claude.exe" >nul 2>&1
timeout /t 2 /nobreak >nul
echo     Done.

REM --- Step 2: Back up broken config ---
echo [2/5] Backing up broken config file...
set "CONFIG_DIR=%APPDATA%\Claude"
set "CONFIG_FILE=%CONFIG_DIR%\claude_desktop_config.json"

if exist "%CONFIG_FILE%" (
    copy /Y "%CONFIG_FILE%" "%CONFIG_DIR%\claude_desktop_config.BACKUP.json" >nul
    del /F /Q "%CONFIG_FILE%"
    echo     Backed up to claude_desktop_config.BACKUP.json
) else (
    echo     No config file found, skipping.
)

REM --- Step 3: Clear cache ---
echo [3/5] Clearing Claude cache...
if exist "%LOCALAPPDATA%\Claude\Cache" (
    rmdir /S /Q "%LOCALAPPDATA%\Claude\Cache" >nul 2>&1
    echo     Cache cleared.
) else (
    echo     No cache found, skipping.
)
if exist "%LOCALAPPDATA%\Claude\Code Cache" (
    rmdir /S /Q "%LOCALAPPDATA%\Claude\Code Cache" >nul 2>&1
    echo     Code cache cleared.
)
if exist "%LOCALAPPDATA%\Claude\GPUCache" (
    rmdir /S /Q "%LOCALAPPDATA%\Claude\GPUCache" >nul 2>&1
    echo     GPU cache cleared.
)

REM --- Step 4: Build fresh config with TradingView MCP ---
echo [4/5] Creating fresh config with TradingView MCP server...

REM Auto-detect where tradingview-mcp is installed
set "MCP_PATH="

REM Check common locations
if exist "%USERPROFILE%\tradingview-mcp\src\server.js" set "MCP_PATH=%USERPROFILE%\tradingview-mcp"
if exist "%USERPROFILE%\Desktop\tradingview-mcp\src\server.js" set "MCP_PATH=%USERPROFILE%\Desktop\tradingview-mcp"
if exist "%USERPROFILE%\Documents\tradingview-mcp\src\server.js" set "MCP_PATH=%USERPROFILE%\Documents\tradingview-mcp"
if exist "C:\tradingview-mcp\src\server.js" set "MCP_PATH=C:\tradingview-mcp"

REM Make sure the config folder exists
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

if not "%MCP_PATH%"=="" (
    REM Write config with MCP server (replace backslashes for JSON)
    set "SERVER_JS=%MCP_PATH%\src\server.js"
    echo     Found tradingview-mcp at: %MCP_PATH%

    REM Use PowerShell to write valid JSON (handles backslash escaping)
    powershell -NoProfile -Command "$p = '%MCP_PATH%\src\server.js'.Replace('\','\\'); $json = '{\"mcpServers\":{\"tradingview\":{\"command\":\"node\",\"args\":[\"' + $p + '\"]}}}'; Set-Content -Path '%CONFIG_FILE%' -Value $json -Encoding UTF8"
    echo     Config written successfully.
) else (
    REM Write minimal empty config so Claude opens
    echo {}> "%CONFIG_FILE%"
    echo     tradingview-mcp not found in common locations.
    echo     Claude will open without the MCP server.
    echo     You can add it later from Claude Desktop settings.
)

REM --- Step 5: Launch Claude Desktop ---
echo [5/5] Launching Claude Desktop...

set "CLAUDE_EXE="
if exist "%LOCALAPPDATA%\AnthropicClaude\claude.exe" set "CLAUDE_EXE=%LOCALAPPDATA%\AnthropicClaude\claude.exe"
if exist "%PROGRAMFILES%\Claude\claude.exe" set "CLAUDE_EXE=%PROGRAMFILES%\Claude\claude.exe"
if exist "%LOCALAPPDATA%\Programs\claude\claude.exe" set "CLAUDE_EXE=%LOCALAPPDATA%\Programs\claude\claude.exe"

REM Try Windows Store / packaged install
if "%CLAUDE_EXE%"=="" (
    for /f "tokens=*" %%i in ('where claude.exe 2^>nul') do set "CLAUDE_EXE=%%i"
)

if not "%CLAUDE_EXE%"=="" (
    echo     Launching: %CLAUDE_EXE%
    start "" "%CLAUDE_EXE%"
) else (
    echo     Claude Desktop not found in common locations.
    echo     Please open it manually from your Start menu or Desktop shortcut.
)

echo.
echo =============================================
echo   Done! Claude Desktop should open now.
echo   If it still fails, please send a screenshot
echo   of the error message.
echo =============================================
echo.
pause
