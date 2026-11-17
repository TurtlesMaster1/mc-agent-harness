# Stops the brains, the players' bodies, the Warden and the headless browser that were started from this folder.
# "stop.ps1 all" also stops the Minecraft server and the tunnels.
# Everything is matched by this folder's path in the command line, so other copies are left alone.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$mine = [regex]::Escape($here)
function Stop-Mine($names, $pattern) {
  Get-CimInstance Win32_Process | Where-Object { $_.Name -in $names -and $_.CommandLine -match $mine -and $_.CommandLine -match $pattern -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Stop-Mine 'node.exe' 'brains\.js'        # first, so no new turns start
Stop-Mine 'node.exe' 'supervisor\.js'    # before the body, or it would restart it
Start-Sleep 1
Stop-Mine @('claude.exe', 'node.exe', 'chrome.exe') '.'
if ($args -contains 'all') {
  Stop-Mine 'cloudflared.exe' '.'
  $port = (Get-Content "$here\config.json" -Raw | ConvertFrom-Json).mcPort
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'java') { Stop-Process -Id $p.Id -Force }
  }
}
Remove-Item "$here\main.pid", "$here\brains.pid" -ErrorAction SilentlyContinue
Write-Host 'stopped'
