@echo off
setlocal DisableDelayedExpansion
set "QUOTA_GUARD_SCRIPT_DIR=%~dp0"
rem Explicit Windows-hosted MCP: callable from native Windows or WSL interop.
rem Paths/profile/state are Windows paths even when the caller is in WSL.
if not defined CODEX_QUOTA_GUARD_NODE set "CODEX_QUOTA_GUARD_NODE=node.exe"
if /i "%~1"=="--scheduler-bridge-doctor" goto scheduler
"%CODEX_QUOTA_GUARD_NODE%" "%~dp0..\dist\main.js" %*
exit /b %errorlevel%
:scheduler
shift
rem This branch is read-only; the doctor never calls an automation tool.
"%CODEX_QUOTA_GUARD_NODE%" "%QUOTA_GUARD_SCRIPT_DIR%scheduler-bridge-doctor.mjs" --server "%~1"
exit /b %errorlevel%
