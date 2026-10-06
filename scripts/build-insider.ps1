<#
.SYNOPSIS
  Hämtar insynshandel (insideraffärer) från Finansinspektionens insynsregister och bygger site/data/insider.json.

.DESCRIPTION
  Personer i ledande ställning i börsbolag och deras närstående måste anmäla sina affärer i bolagets
  aktier till FI, som publicerar dem i insynsregistret. Skriptet hämtar de senaste $Days dagarnas
  publiceringar via registrets export (CSV). Exporten ger högst 1 000 rader per anrop, så perioden
  hämtas vecka för vecka och en vecka delas upp i kortare perioder om den når taket.

  Bara aktier tas med, och bara anmälningar med status "Aktuell" (rättade versioner ersätter de gamla).
  Filen ändras varje dag och sparas därför inte i repot, precis som blankningen.
#>
param(
  [string]$DataDir = "site/data",
  [int]$Days = 90
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Base = "https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) "fondinsyn-insyn.csv"

function J($s) { if ($null -eq $s) { return "null" }; return '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"') + '"' }
function N($v) { if ($null -eq $v) { return "null" }; return ([double]$v).ToString("0.####", $Inv) }
function Num($s) {
  $s = ([string]$s).Trim().Replace(" ", "")
  if (-not $s) { return $null }
  $d = 0.0
  if ([double]::TryParse($s.Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}

# Hämtar alla anmälningar publicerade mellan två datum (rader som text, utan rubrikrad)
function Fetch($from, $to) {
  $url = $Base + "?SearchFunctionType=Insyn&Utgivare=&PersonILedandeStallningNamn=&Transaktionsdatum.From=&Transaktionsdatum.To=" +
    "&Publiceringsdatum.From=" + $from.ToString("yyyy-MM-dd") + "&Publiceringsdatum.To=" + $to.ToString("yyyy-MM-dd") + "&button=export&Page=1"
  for ($try = 1; $try -le 3; $try++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $Tmp -UseBasicParsing -UserAgent "Mozilla/5.0 (Fondinsyn; +https://fondinsyn.se)" -TimeoutSec 120
      break
    } catch {
      if ($try -eq 3) { throw }
      Start-Sleep -Seconds (5 * $try)
    }
  }
  # Exporten är UTF-16 (little endian)
  $text = [System.IO.File]::ReadAllText($Tmp, [System.Text.Encoding]::Unicode)
  $lines = @($text -split "`r?`n" | Where-Object { $_ -and -not $_.StartsWith("Publiceringsdatum;") })
  if ($lines.Count -ge 999 -and $from -lt $to) {
    # Taket nått: dela perioden på mitten
    $mid = $from.AddDays([math]::Floor(($to - $from).TotalDays / 2))
    return @(Fetch $from $mid) + @(Fetch $mid.AddDays(1) $to)
  }
  if ($lines.Count -ge 999) { Write-Host "  varning: $($from.ToString('yyyy-MM-dd')) har minst 1 000 rader, en del kan saknas" }
  return $lines
}

$today = (Get-Date).Date
$start = $today.AddDays(-$Days)
Write-Host "Insynshandel: hämtar publiceringar $($start.ToString('yyyy-MM-dd')) till $($today.ToString('yyyy-MM-dd'))"
$all = New-Object System.Collections.Generic.List[string]
for ($d = $start; $d -le $today; $d = $d.AddDays(7)) {
  $end = $d.AddDays(6); if ($end -gt $today) { $end = $today }
  foreach ($l in (Fetch $d $end)) { $all.Add($l) }
}
Remove-Item $Tmp -ErrorAction SilentlyContinue

# Kolumner: 0 Publiceringsdatum, 1 Emittent, 4 Person, 5 Befattning, 6 Närstående, 11 Karaktär, 12 Instrumenttyp,
# 14 ISIN, 15 Transaktionsdatum, 16 Volym, 17 Volymsenhet, 18 Pris, 19 Valuta, 21 Status
$rows = New-Object System.Collections.Generic.List[string]
$seen = @{}
foreach ($l in $all) {
  $c = $l.Split(";")
  if ($c.Count -lt 22) { continue }
  if ($c[21] -ne "Aktuell" -or $c[12] -ne "Aktie") { continue }
  $key = $l
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = 1
  $vol = Num $c[16]; $price = Num $c[18]
  $value = if ($c[17] -eq "Antal" -and $null -ne $vol -and $null -ne $price) { $vol * $price } else { $null }
  $sek = if ($c[19] -eq "SEK") { $value } else { $null }
  $rows.Add("[" + (J $c[15].Substring(0, 10)) + "," + (J $c[0].Substring(0, 10)) + "," + (J $c[1].Trim()) + "," + (J $c[14].Trim()) + "," +
    (J $c[4].Trim()) + "," + (J $c[5].Trim()) + "," + $(if ($c[6] -eq "Ja") { "1" } else { "0" }) + "," + (J $c[11].Trim()) + "," +
    (N $vol) + "," + (N $price) + "," + (J $c[19]) + "," + $(if ($null -ne $sek) { [math]::Round($sek).ToString($Inv) } else { "null" }) + "]")
}

# Senast publicerade först
$sorted = @($rows | Sort-Object { $_.Substring(15, 10) }, { $_.Substring(2, 10) } -Descending)
$json = '{"built":' + (J (Get-Date).ToString("yyyy-MM-dd")) + ',"from":' + (J $start.ToString("yyyy-MM-dd")) + ',"days":' + $Days +
  ',"rows":[' + ($sorted -join ",") + "]}"
[System.IO.File]::WriteAllText((Join-Path $DataDir "insider.json"), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "  $($sorted.Count) affärer i aktier ($($all.Count) anmälningar totalt)"
