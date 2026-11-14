# Registers the "BotCookies" scheduled task: every 2 minutes, ask the bot whether
# its Google session needs cookies, and push them from the dedicated Chrome profile
# only if so. Expects gm-cookies.exe, admin-secret.txt and api-url.txt in %USERPROFILE%\rcs-group-bot.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "rcs-group-bot"
$exe = Join-Path $dir "gm-cookies.exe"
$log = Join-Path $dir "gm-cookies.log"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$exe`" >> `"$log`" 2>&1`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "BotCookies" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
"registered scheduled task BotCookies (every 2 min, log: $log)"
