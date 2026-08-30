param([Parameter(Mandatory)][string]$SettingsPath, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$SettingsPath = [IO.Path]::GetFullPath($SettingsPath)
$settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
if ($settings.revision -ne 1 -or $settings.installationId -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid managed installation' }
$taskName = 'CodexQuotaGuard-' + $settings.installationId
$marker = 'Codex Quota Guard managed health supervisor; installation=' + $settings.installationId
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$existing = $null
try { $existing = $folder.GetTask($taskName) } catch {
  if ($_.Exception.HResult -ne -2147024894) { throw }
}
if ($existing -and $existing.Definition.RegistrationInfo.Description -ne $marker) { throw 'Task ownership mismatch' }
if ($Remove) {
  if ($existing) { $folder.DeleteTask($taskName, 0) }
  [pscustomobject]@{removed=[bool]$existing; taskName=$taskName} | ConvertTo-Json -Compress
  exit
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = $marker
$definition.Principal.UserId = $sid
$definition.Principal.LogonType = 3 # Same signed-in user, no password and no elevation.
$definition.Principal.RunLevel = 0
$definition.Settings.Enabled = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.MultipleInstances = 2 # Ignore another health check while one is running.
$definition.Settings.ExecutionTimeLimit = 'PT30S'
$definition.Settings.Hidden = $true
$logon = $definition.Triggers.Create(9)
$logon.UserId = $sid
$daily = $definition.Triggers.Create(2)
$daily.StartBoundary = (Get-Date).AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss')
$daily.DaysInterval = 1
$daily.Repetition.Interval = 'PT5M'
$daily.Repetition.Duration = 'P1D'
$action = $definition.Actions.Create(0)
$action.Path = Join-Path $env:SystemRoot 'System32\wscript.exe'
$ensurePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\managed-ensure.js'))
$hiddenLauncher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'run-hidden.vbs'))
foreach ($value in @($SettingsPath, $settings.nodeExecutable, $ensurePath, $hiddenLauncher)) {
  if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'Unsafe action path' }
}
$action.Arguments = '//B //Nologo "' + $hiddenLauncher + '" "' + $settings.nodeExecutable + '" "' + $ensurePath + '" "' + $SettingsPath + '"'
$task = $folder.RegisterTaskDefinition($taskName, $definition, 6, $sid, $null, 3, $null)
$null = $task.Run($null)
[pscustomobject]@{installed=$true; taskName=$taskName; intervalMinutes=5; runLevel='leastPrivilege'; logonType='interactiveUser'; hidden=$true; action='wscript'; consoleWindow=$false} | ConvertTo-Json -Compress
