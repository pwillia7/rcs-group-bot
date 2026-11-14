# Stop the bot's llama-server (leaves any other llama-server alone).
. "$PSScriptRoot\config.ps1"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
    Where-Object { $_.CommandLine -match "--port $Port\b" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped PID $($_.ProcessId)" }
