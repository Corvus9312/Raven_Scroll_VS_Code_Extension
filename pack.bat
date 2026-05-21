@echo off
cd /d "%~dp0"
if not exist release mkdir release
echo Packaging Corvus9312 BookReader...
npx @vscode/vsce package --no-dependencies --allow-missing-repository --out release
if %errorlevel% neq 0 (
    echo.
    echo Build failed!
    pause
) else (
    echo.
    echo Done! VSIX file is ready.
    pause
)
