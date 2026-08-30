param([Parameter(Mandatory)][string]$SettingsPath, [Parameter(Mandatory)][string]$NodePath)
$ErrorActionPreference = 'Stop'
# Scheduled locally, no model invocation. Node inherits this hidden console.
& $NodePath (Join-Path $PSScriptRoot '..\dist\managed-ensure.js') $SettingsPath
exit $LASTEXITCODE
