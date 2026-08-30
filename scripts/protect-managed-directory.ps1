param([Parameter(Mandatory)][string]$Path)
$ErrorActionPreference = 'Stop'
$targetPath = [IO.Path]::GetFullPath($Path)
if ([IO.Path]::GetFileName($targetPath) -notmatch '^core-[a-f0-9]{64}$') { throw 'Expected a dedicated Guard core directory' }
$created = $false
if (Test-Path -LiteralPath $targetPath) {
  $item = Get-Item -LiteralPath $targetPath -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe managed directory' }
} else {
  New-Item -ItemType Directory -Path $targetPath | Out-Null
  $created = $true
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $targetPath
# Hosted Windows runners can assign the Administrators group as owner for a
# directory created by an administrator token. Normalize only a directory we
# created in this invocation; a pre-existing directory with another owner is
# still rejected before its DACL is touched.
if ($created -and $acl.Owner -and ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
  $directoryInfo = [IO.DirectoryInfo]::new($targetPath)
  $ownerAcl = [IO.FileSystemAclExtensions]::GetAccessControl($directoryInfo, [Security.AccessControl.AccessControlSections]::Owner)
  $ownerAcl.SetOwner($sid)
  [IO.FileSystemAclExtensions]::SetAccessControl($directoryInfo, $ownerAcl)
  $acl = Get-Acl -LiteralPath $targetPath
}
if ($acl.Owner -and ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Managed directory is not owned by this user' }
$directoryInfo = [IO.DirectoryInfo]::new($targetPath)
# Change only DACL; rewriting owner/audit sections can require SeSecurityPrivilege.
$privateAcl = [IO.FileSystemAclExtensions]::GetAccessControl($directoryInfo, [Security.AccessControl.AccessControlSections]::Access)
$privateAcl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($privateAcl.Access)) { $privateAcl.RemoveAccessRuleSpecific($rule) }
$privateAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl($directoryInfo, $privateAcl)
