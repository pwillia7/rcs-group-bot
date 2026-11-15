# Registers the "BotCookies" scheduled task: every 2 minutes, ask the bot whether
# its Google session needs cookies, and push them from the dedicated Chrome profile
# only if so. Expects gm-cookies.exe, admin-secret.txt and api-url.txt in %USERPROFILE%\rcs-group-bot.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "rcs-group-bot"
$exe = Join-Path $dir "gm-cookies.exe"
$log = Join-Path $dir "gm-cookies.log"
# gm-cookies.exe is a windowsgui build and logs itself via -log, so no cmd.exe
# wrapper and no console window popping up every 2 minutes.
$action = New-ScheduledTaskAction -Execute $exe -Argument "-log `"$log`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "BotCookies" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
"registered scheduled task BotCookies (every 2 min, log: $log)"
