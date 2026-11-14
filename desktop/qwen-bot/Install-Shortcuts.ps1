# Creates desktop shortcuts to start, stop and check the bot's Qwen server.
# Run on the desktop: powershell -ExecutionPolicy Bypass -File Install-Shortcuts.ps1
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$desktop = [Environment]::GetFolderPath("Desktop")
$shell = New-Object -ComObject WScript.Shell
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function New-Shortcut($name, $script, $scriptArgs, $icon) {
    $lnk = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
    $lnk.TargetPath = $ps
    # Keep the window open until Enter so the result is readable.
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$dir\$script' $scriptArgs; Read-Host 'Press Enter to close'`""
    $lnk.WorkingDirectory = $dir
    $lnk.IconLocation = $icon
    $lnk.Description = $name
    $lnk.Save()
    "created $name"
}

New-Shortcut "Qwen Bot - Start"  "Start-QwenBot.ps1"  "-Ask" "$env:SystemRoot\System32\imageres.dll,101"
New-Shortcut "Qwen Bot - Stop"   "Stop-QwenBot.ps1"   ""     "$env:SystemRoot\System32\imageres.dll,100"
New-Shortcut "Qwen Bot - Status" "Status-QwenBot.ps1" ""     "$env:SystemRoot\System32\imageres.dll,76"
