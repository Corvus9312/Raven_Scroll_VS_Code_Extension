@echo off
cd /d "%~dp0"
if not exist release mkdir release

rem tsc leaves the compiled output of deleted sources behind, and vsce would ship
rem it. Clear out\ so the VSIX only ever contains code that still has a source
rem file; vsce:prepublish recompiles it.
if exist out rmdir /s /q out

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
