# One-time setup: API key + scheduled task. Safe to rerun (keeps an existing key).
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\config.ps1"
if (-not (Test-Path $ApiKeyFile)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $_.ToString("x2") }) | Set-Content -NoNewline -Path $ApiKeyFile
    "created $ApiKeyFile"
}
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSScriptRoot\Start-QwenBot.ps1`" -Foreground" `
    -WorkingDirectory $PSScriptRoot
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
# S4U: runs whether or not you're signed in, so signing out / switching sessions
# no longer kills the server. No stored password needed.
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
# Start at boot (no sign-in needed with S4U). The delay lets drives, the GPU
# driver and Tailscale come up first.
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT1M"
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"registered scheduled task $TaskName (S4U, starts at boot, restarts on failure)"
