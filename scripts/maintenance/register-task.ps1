param([string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path)
$ErrorActionPreference = 'Stop'
$stateDir = Join-Path $env:LOCALAPPDATA 'J-skills'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$taskConfig = @{
    repo = $Repo
    python = (& python -c 'import sys; print(sys.executable)').Trim()
    paths = @((Split-Path (Get-Command node).Source), (Split-Path (Get-Command git).Source), (Split-Path (Get-Command gh).Source))
}
$taskConfig | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDir 'config.json') -Encoding utf8
$launcher = @'
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, 'Local\JSkillsDailyUpdate')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    $cfg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
    $env:PATH = ($cfg.paths -join ';') + ';' + $env:PATH
    $env:PYTHONUTF8 = '1'
    $now = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time')
    if ($now.TimeOfDay -lt [TimeSpan]::new(11,17,0)) { exit 0 }
    $log = Join-Path $PSScriptRoot ('update-' + $now.ToString('yyyy-MM-dd') + '.log')
    & $cfg.python (Join-Path $cfg.repo 'scripts/maintenance/update_local.py') --repo $cfg.repo --state $PSScriptRoot --scheduled *>> $log
    $result = $LASTEXITCODE
    if ($result -ne 0) {
        & "$env:SystemRoot\System32\msg.exe" $env:USERNAME /TIME:30 'J-skills daily update failed. Your previous skills were preserved. See %LOCALAPPDATA%\J-skills\status.json and the daily log.' 2>$null
    }
    exit $result
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
'@
$launcherPath = Join-Path $stateDir 'run-daily.ps1'
$launcher | Set-Content -LiteralPath $launcherPath -Encoding utf8
$shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$action = New-ScheduledTaskAction -Execute $shell -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"') -WorkingDirectory $Repo
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$daily = New-ScheduledTaskTrigger -Daily -At '11:17'
$login = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'J-skills Daily Update' -Action $action -Trigger @($daily, $login) -Principal $principal -Settings $settings -Description 'Once daily after 11:17 Hong Kong time: validate J-skills, preserve local edits, install with rollback. Login only catches a missed daily check.' -Force | Out-Null
Get-ScheduledTask -TaskName 'J-skills Daily Update' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName 'J-skills Daily Update' | Select-Object NextRunTime,LastTaskResult
