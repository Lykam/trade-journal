# Weekly MOVERS update (SPEC §6.7f, Q85), run by the "TradeJournal Movers" Windows
# scheduled task every Saturday at 09:00 (and at the next logon/wake if the PC was
# off then). Fetches the new week from Massive, rewrites movers.json/movers.csv and
# commits movers.json to trade-history, which redeploys the site.
#
# Needs, in the user environment: POLYGON_API_KEY (or MASSIVE_API_KEY), and a
# logged-in `gh` (its token commits to trade-history). Log: _cache/movers-task.log.
#
# Register (once, as the user; no admin needed):
#   powershell -NoProfile -ExecutionPolicy Bypass -File build\movers-task.ps1 -Register
# Run now:      Start-ScheduledTask -TaskName "TradeJournal Movers"
# Remove:       Unregister-ScheduledTask -TaskName "TradeJournal Movers" -Confirm:$false
param([switch]$Register)

$repo = Split-Path -Parent $PSScriptRoot
$name = "TradeJournal Movers"

if ($Register) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`"" -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At 9:00am
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -RunOnlyIfNetworkAvailable
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description "Weekly big movers for TradeJournal's MOVERS page (npm run movers -- --publish)" -Force | Out-Null
  Write-Output "Registered '$name': Saturdays 09:00, runs late if the PC was off."
  exit 0
}

New-Item -ItemType Directory -Force (Join-Path $repo "_cache") | Out-Null
$log = Join-Path $repo "_cache\movers-task.log"
# A scheduled task gets the user environment as of logon: read the key from the registry so a newly set one works too.
foreach ($k in "MASSIVE_API_KEY", "POLYGON_API_KEY") {
  $v = (Get-ItemProperty HKCU:\Environment -ErrorAction SilentlyContinue).$k
  if ($v) { Set-Item "env:$k" $v }
}
Set-Location $repo
"=== $(Get-Date -Format s) ===" | Out-File -Append -Encoding utf8 $log
cmd /c "npm run movers -- --publish >> `"$log`" 2>&1"
$code = $LASTEXITCODE
"exit $code" | Out-File -Append -Encoding utf8 $log
exit $code
