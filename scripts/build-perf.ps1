<#
.SYNOPSIS
  Hämtar fondernas avkastning från Pensionsmyndighetens öppna fonddata och bygger site/data/perf.json.

.DESCRIPTION
  Pensionsmyndigheten publicerar varje vecka en lista över fonderna på premiepensionens fondtorg med
  avkastning per kalenderår, snitt för fem år, avgift och risk. Listan saknar ISIN, så fonderna kopplas
  till Finansinspektionens fonder via namnet. Fonder som inte finns på fondtorget får ingen avkastning.
#>
param(
  [string]$DataDir = "site/data",
  [string]$Url = "https://static.pensionsmyndigheten.se/fond/fonddata.csv"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Inv = [System.Globalization.CultureInfo]::InvariantCulture

function J($s) { if ($null -eq $s) { return "null" }; return '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"') + '"' }
function Num($s) {
  $s = ([string]$s).Trim()
  if (-not $s -or $s -eq '-') { return $null }
  $d = 0.0
  if ([double]::TryParse($s.Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}
function N($v) { if ($null -eq $v) { return "null" }; return ([double]$v).ToString("0.##", $Inv) }

# Namn utan andelsklass och skiljetecken: "Alfred Berg Aktiv R" -> "alfred berg aktiv"
function NormFund($s) {
  $s = ([string]$s).ToLowerInvariant() -replace '[^a-z0-9åäöéü]+', ' '
  $s = ($s -replace '\s+', ' ').Trim()
  for ($i = 0; $i -lt 3; $i++) {
    $s = ($s -replace '\s(a|b|c|d|r|s|i|x|sek|eur|usd|acc|inc|dis|utd|klass|class|series|ser)$', '').Trim()
  }
  return $s
}

Write-Host "Avkastning: hämtar Pensionsmyndighetens fonddata"
$tmp = [System.IO.Path]::GetTempFileName()
Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -TimeoutSec 120
$text = [System.Text.Encoding]::GetEncoding(28591).GetString([System.IO.File]::ReadAllBytes($tmp))
Remove-Item $tmp
$lines = @($text -split "`r?`n" | Where-Object { $_ })
$header = $lines[0] -split ';'
# Kolumner: Fondnr;Fondnamn;Fondkategori;<år>;<år-1>;<år-2>;Snitt 5 år;Fondavgift (%);Risk senaste 36 mån;Beräknad
$years = @($header[3], $header[4], $header[5])

# FI:s fonder i senaste kvartalet
$index = Get-Content (Join-Path $DataDir "index.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$q = Get-Content (Join-Path $DataDir ($index.quarters[0].id + ".json")) -Raw -Encoding UTF8 | ConvertFrom-Json
$byName = @{}
foreach ($f in $q.fundInfo) {
  $k = NormFund $f[1]
  if (-not $byName.ContainsKey($k)) { $byName[$k] = New-Object System.Collections.Generic.List[string] }
  $byName[$k].Add([string]$f[0])
}

$out = New-Object System.Collections.Generic.List[string]
$matched = @{}
foreach ($l in ($lines | Select-Object -Skip 1)) {
  $c = $l -split ';'
  if ($c.Count -lt 10) { continue }
  $k = NormFund $c[1]
  $ids = $byName[$k]
  if (-not $ids) { continue }
  foreach ($id in $ids) {
    if ($matched.ContainsKey($id)) { continue }   # första andelsklassen per fond räcker
    $matched[$id] = $true
    $out.Add((J $id) + ":[" + (N (Num $c[3])) + "," + (N (Num $c[4])) + "," + (N (Num $c[5])) + "," + (N (Num $c[6])) + "," +
      (N (Num $c[7])) + "," + (N (Num $c[8])) + "," + (J $c[1].Trim()) + "," + (J $c[2].Trim()) + "]")
  }
}

$calc = ($lines | Select-Object -Skip 1 | ForEach-Object { ($_ -split ';')[9] } | Sort-Object -Descending | Select-Object -First 1)
$json = '{"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"calculated":' + (J $calc) + ',"years":[' + (($years | ForEach-Object { J $_ }) -join ",") + '],"funds":{' + ($out -join ",") + "}}"
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path $DataDir) "perf.json"), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host ("Klart: {0} av {1} fonder på fondtorget kopplade till FI:s fonder" -f $out.Count, ($lines.Count - 1))
