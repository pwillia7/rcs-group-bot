<#
  Start the bot's llama-server.
    .\Start-QwenBot.ps1            # start via scheduled task, wait for /health
    .\Start-QwenBot.ps1 -Force     # also stop any other llama-server (e.g. one you use for coding) first
    .\Start-QwenBot.ps1 -Ask       # ask before stopping another llama-server (desktop shortcut)
    .\Start-QwenBot.ps1 -Foreground  # run in this console (what the scheduled task calls)
#>
param([switch]$Foreground, [switch]$Force, [switch]$Ask)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # progress bars break over SSH
. "$PSScriptRoot\config.ps1"

if ($Foreground) {
    $LlamaServer = (Get-Command llama-server -ErrorAction Stop).Source
    $Arguments = @(
        "-m", $ModelPath
        "--alias", $ModelAlias
        "--host", $HostAddress
        "--port", "$Port"
        "--api-key-file", $ApiKeyFile
        "--temp", "$Temperature"
        "--top-p", "$TopP"
        "--top-k", "$TopK"
        "--min-p", "$MinP"
        "--presence-penalty", "$PresencePenalty"
        "--repeat-penalty", "$RepeatPenalty"
        "--reasoning", "$Reasoning"
        "--reasoning-effort", "$ReasoningEffort"
        "--no-reasoning-preserve"
        "--jinja"
        "--flash-attn", $FlashAttention
        "-ngl", "$GpuLayers"
        "-c", "$ContextSize"
        "--parallel", "$Parallel"
        "--cache-type-k", $CacheTypeK
        "--cache-type-v", $CacheTypeV
    )
    if ($EnableMetrics) { $Arguments += "--metrics" }
    if ($SleepIdleSeconds -gt 0) { $Arguments += @("--sleep-idle-seconds", "$SleepIdleSeconds") }
    if ($MaxTokens -gt 0) { $Arguments += @("--n-predict", "$MaxTokens") }
    if ($MmprojPath -and (Test-Path $MmprojPath)) { $Arguments += @("--mmproj", $MmprojPath) }
    New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
    # Start-Process with file redirects: PowerShell 5.1 turns native stderr into
    # terminating errors when redirected with *>> under ErrorActionPreference=Stop.
    $errLog = [IO.Path]::ChangeExtension($LogFile, ".err.log")
    $p = Start-Process -FilePath $LlamaServer -ArgumentList $Arguments -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput $LogFile -RedirectStandardError $errLog
    exit $p.ExitCode
}

# Background start via the scheduled task
$others = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
    Where-Object { $_.CommandLine -notmatch "--port $Port\b" }
if ($others) {
    if ($Ask -and -not $Force) {
        $answer = Read-Host "Another llama-server is using the GPU (PID $($others.ProcessId -join ', '), probably your coding Qwen). Stop it and start the bot's? [y/N]"
        $Force = $answer -match '^(y|yes)$'
        if (-not $Force) { "not started"; exit 1 }
    }
    if (-not $Force) {
        Write-Error "Another llama-server is running (PID $($others.ProcessId -join ', ')). Stop it or rerun with -Force."
    }
    $others | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 3
}

$health = "http://${HostAddress}:$Port/health"
try { if ((Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { "already running"; exit 0 } } catch {}

Start-ScheduledTask -TaskName $TaskName
$deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    try {
        if ((Invoke-WebRequest $health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { "ready: $health"; exit 0 }
    } catch {}
}
Write-Error "llama-server did not become healthy within 4 minutes; see $LogFile"
