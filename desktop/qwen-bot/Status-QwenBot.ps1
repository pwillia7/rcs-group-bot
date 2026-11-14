$ProgressPreference = "SilentlyContinue"  # progress bars break over SSH
. "$PSScriptRoot\config.ps1"
$proc = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
    Select-Object ProcessId, @{n='Profile';e={ if ($_.CommandLine -match "--port $Port\b") { 'bot' } else { 'other' } }}
if ($proc) { $proc | Format-Table -AutoSize } else { "no llama-server running" }
try { $r = Invoke-WebRequest "http://${HostAddress}:$Port/health" -UseBasicParsing -TimeoutSec 5; "health: $($r.StatusCode) ok" } catch { "health: down ($($_.Exception.Message))" }
