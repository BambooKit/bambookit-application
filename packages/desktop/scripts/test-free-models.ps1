# Verifies that every free BambooKit (OpenCode Zen) model offered by BambooKit Desktop actually answers.
# Uses the real OpenCode engine from source with the same config layer the desktop injects.
# Usage: pwsh packages/desktop/scripts/test-free-models.ps1
$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot/../../.."
$engine = Join-Path $root "packages/opencode"
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$version = (Get-Content (Join-Path $engine "package.json") -Raw | ConvertFrom-Json).version
$configTs = (Join-Path $root "packages/desktop/src/main/bambookit/engine-config.ts").Replace("\", "/")
$env:OPENCODE_CONFIG_CONTENT = (& bun -e "import { bambookitEngineConfig } from '$configTs'; console.log(JSON.stringify(bambookitEngineConfig()))").Trim()
Write-Host "Engine $version, BambooKit config: $env:OPENCODE_CONFIG_CONTENT"

Push-Location $engine
try {
  $defines = @("--define", "OPENCODE_VERSION:'$version'", "--define", "OPENCODE_CHANNEL:'latest'")
  $models = (& bun @defines ./src/index.ts models opencode 2>&1 | Out-String) -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -like "opencode/*" }
  $free = $models | Where-Object { $_ -match "free$|big-pickle" }
  Write-Host "Free models offered: $($free.Count)"
  $failed = 0
  foreach ($m in $free) {
    $job = Start-Job -ScriptBlock { param($m, $p, $d, $cfg) Set-Location $p; $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"; $env:OPENCODE_CONFIG_CONTENT = $cfg; & bun @d ./src/index.ts run -m $m "Reply with exactly the word: ok" 2>&1 | Out-String } -ArgumentList $m, $engine, $defines, $env:OPENCODE_CONFIG_CONTENT
    if (Wait-Job $job -Timeout 150) { $out = Receive-Job $job } else { Stop-Job $job; $out = "TIMEOUT" }
    Remove-Job $job -Force
    $last = ($out -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch '^\s*>' } | Select-Object -Last 1)
    $ok = $last -match '\bok\b' -and $last -notmatch 'Error'
    if (-not $ok) { $failed++ }
    Write-Host ("{0,-6} {1} {2}" -f ($(if ($ok) { "PASS" } else { "FAIL" })), $m, $(if ($ok) { "" } else { "=> $last" }))
  }
  if ($failed) { Write-Host "$failed model(s) failed"; exit 1 } else { Write-Host "All offered free models answered." }
} finally { Pop-Location }
