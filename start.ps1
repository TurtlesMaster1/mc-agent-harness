# Starts the Minecraft server (if it is not running), the players' bodies and their brains.
# Needs: node and java on PATH, server\server.jar (see README), config.json.
# Optional: cloudflared on PATH for public links.
function Test-Port($p) { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', $p); $true } catch { $false } finally { $c.Close() } }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path "$here\config.json")) { Write-Host 'no config.json: copy config.example.json to config.json and edit it'; exit 1 }
$cfg = Get-Content "$here\config.json" -Raw | ConvertFrom-Json
& "$here\stop.cmd" | Out-Null

if (-not (Test-Port $cfg.mcPort)) {
  if (-not (Test-Path "$here\server\server.jar")) { Write-Host "nothing is listening on port $($cfg.mcPort) and there is no server\server.jar; see README"; exit 1 }
  Write-Host 'starting Minecraft server...'
  Start-Process (Get-Command java).Source -ArgumentList '-Xms512M','-Xmx1G','-jar','server.jar','nogui' `
    -WorkingDirectory "$here\server" -WindowStyle Hidden -RedirectStandardOutput "$here\server\stdout.log" -RedirectStandardError "$here\server\stderr.log"
  $deadline = (Get-Date).AddMinutes(3)
  while (-not (Test-Port $cfg.mcPort)) {
    if ((Get-Date) -gt $deadline) { Write-Host 'server did not come up; see server\stdout.log'; exit 1 }
    Start-Sleep 2
  }
}
$node = (Get-Command node).Source
Start-Process $node -ArgumentList (@("`"$here\supervisor.js`"") + $args) -WorkingDirectory $here -WindowStyle Hidden -RedirectStandardOutput "$here\out.log" -RedirectStandardError "$here\err.log"
Write-Host "running. Views: http://localhost:$($cfg.webPort)/   Log: run.log   Stop: stop.cmd (stop.cmd all = server too)"

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source

# public link to the view page (Cloudflare quick tunnel), when config.json has "publicView": true
if ($cfg.publicView -and $cloudflared) {
  if (-not (Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object CommandLine -match "127\.0\.0\.1:$($cfg.webPort)")) {
    Remove-Item "$here\tunnel.log" -ErrorAction SilentlyContinue
    Start-Process $cloudflared -ArgumentList 'tunnel','--no-autoupdate','--url',"http://127.0.0.1:$($cfg.webPort)",'--logfile',"$here\tunnel.log" -WorkingDirectory $here -WindowStyle Hidden
    foreach ($i in 1..20) { Start-Sleep 2; $m = Select-String -Path "$here\tunnel.log" -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $m.Matches[0].Value | Set-Content "$here\public-url.txt"; break } }
  }
  if (Test-Path "$here\public-url.txt") { Write-Host ("public link: " + (Get-Content "$here\public-url.txt")) }
}

# the players' brains: Claude Code sessions on the signed-in subscription (only when config.json has "brain": "claude-code")
if ($cfg.brain -eq 'claude-code') {
  foreach ($i in 1..40) { if (Test-Port $cfg.webPort) { break }; Start-Sleep 2 }
  Start-Sleep 8
  Start-Process $node -ArgumentList "`"$here\brains.js`"" -WorkingDirectory $here -WindowStyle Hidden -RedirectStandardOutput "$here\brains-out.log" -RedirectStandardError "$here\brains-err.log"
  Write-Host 'players are thinking through Claude Code (subscription). Turn log: brains.log'
}

# public Minecraft address (Cloudflare TCP tunnel) plus the Warden that keeps visitors in spectator,
# when config.json has "publicMinecraft": true
if ($cfg.publicMinecraft) {
  Start-Process $node -ArgumentList "`"$here\warden.js`"" -WorkingDirectory $here -WindowStyle Hidden -RedirectStandardOutput "$here\warden-out.log" -RedirectStandardError "$here\warden-err.log"
  if ($cloudflared) {
    if (-not (Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object CommandLine -match "tcp://127\.0\.0\.1:$($cfg.mcPort)")) {
      Remove-Item "$here\mc-tunnel.log" -ErrorAction SilentlyContinue
      Start-Process $cloudflared -ArgumentList 'tunnel','--no-autoupdate','--url',"tcp://127.0.0.1:$($cfg.mcPort)",'--logfile',"$here\mc-tunnel.log" -WorkingDirectory $here -WindowStyle Hidden
      foreach ($i in 1..20) { Start-Sleep 2; $m = Select-String -Path "$here\mc-tunnel.log" -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { ($m.Matches[0].Value -replace '^https://','') | Set-Content "$here\mc-public-host.txt"; break } }
    }
    if (Test-Path "$here\mc-public-host.txt") { Write-Host ("public Minecraft host: " + (Get-Content "$here\mc-public-host.txt")) }
  } else { Write-Host 'cloudflared not found on PATH: no public Minecraft address' }
}
