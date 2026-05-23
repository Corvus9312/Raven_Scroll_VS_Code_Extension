@echo off
cd /d "%~dp0"
if not exist release mkdir release
echo Packaging Raven's Scroll...
npx @vscode/vsce package --no-dependencies --allow-missing-repository --out release
if %errorlevel% neq 0 (
    echo.
    echo Build failed!
    exit /b 1
) else (
    echo.
    echo Done! VSIX file is ready.
)
