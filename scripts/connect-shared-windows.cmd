@echo off
setlocal DisableDelayedExpansion
rem Wire-only connector. The shared HTTP core must already be running.
if not defined CODEX_QUOTA_GUARD_NODE set "CODEX_QUOTA_GUARD_NODE=node.exe"
"%CODEX_QUOTA_GUARD_NODE%" "%~dp0..\dist\http-connector.js"
exit /b %errorlevel%
