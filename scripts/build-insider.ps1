<#
.SYNOPSIS
  Hämtar insynshandel (insideraffärer) från Finansinspektionens insynsregister och bygger site/data/insider.json.

.DESCRIPTION
  Personer i ledande ställning i börsbolag och deras närstående måste anmäla sina affärer i bolagets
  aktier till FI, som publicerar dem i insynsregistret. Skriptet hämtar de senaste $Days dagarnas
  publiceringar via registrets export (CSV). Exporten ger högst 1 000 rader per anrop, så perioden
  hämtas vecka för vecka och en vecka delas upp i kortare perioder om den når taket.

  Bara aktier tas med, och bara anmälningar med status "Aktuell" (rättade versioner ersätter de gamla).
  site/data/insider.json (senaste dagarna) ändras varje dag och sparas inte i repot. Alla affärer sparas dessutom
  i ett arkiv med en fil per månad i site/data/insyn-arkiv/, som sparas i repot och växer över tid.
#>
param(
  [string]$DataDir = "site/data",
  [int]$Days = 90,
  # Fyll arkivet bakåt från ett datum, till exempel 2019-01-01 (körs för hand)
  [string]$Backfill = "",
  # Sista dag för återfyllningen (standard: dagen innan de senaste $Days dagarna)
  [string]$BackfillTo = "",
  # Bara återfyllning, utan den dagliga hämtningen (för att köra flera perioder samtidigt)
  [switch]$BackfillOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Base = "https://marknadssok.fi.se/Publiceringsklient/sv-SE/Search/Search"
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("fondinsyn-insyn-" + $PID + ".csv")
$Curl = Get-Command -Name curl.exe, curl -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1

# Tabbar och andra styrtecken i FI:s fält blir mellanslag, annars blir JSON-filen ogiltig
function J($s) { if ($null -eq $s) { return "null" }; return '"' + (([string]$s) -replace '[\x00-\x1f]+', ' ').Replace('\', '\\').Replace('"', '\"') + '"' }
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
  for ($try = 1; $try -le 6; $try++) {
    try {
      # curl är betydligt snabbare än Invoke-WebRequest mot FI:s server
      if ($Curl) { & $Curl.Source -s -f -L --connect-timeout 15 -m 40 -A "Mozilla/5.0 (Fondinsyn; +https://fondinsyn.se)" -o $Tmp $url; if ($LASTEXITCODE -ne 0) { throw "curl avslutades med kod $LASTEXITCODE" } }
      else { Invoke-WebRequest -Uri $url -OutFile $Tmp -UseBasicParsing -UserAgent "Mozilla/5.0 (Fondinsyn; +https://fondinsyn.se)" -TimeoutSec 120 }
      break
    } catch {
      if ($try -eq 6) { throw }
      Start-Sleep -Seconds (2 * $try)
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


# Kolumner: 0 Publiceringsdatum, 1 Emittent, 4 Person, 5 Befattning, 6 Närstående, 11 Karaktär, 12 Instrumenttyp,
# 14 ISIN, 15 Transaktionsdatum, 16 Volym, 17 Volymsenhet, 18 Pris, 19 Valuta, 21 Status
# En rad blir ["transaktionsdatum","publiceringsdatum","bolag","isin","person","befattning",närstående,"karaktär",volym,pris,"valuta",värde i kr]
function ToRows($lines) {
  $rows = New-Object System.Collections.Generic.List[string]
  $seen = @{}
  foreach ($l in $lines) {
    $c = $l.Split(";")
    if ($c.Count -lt 22) { continue }
    if ($c[21] -ne "Aktuell" -or $c[12] -ne "Aktie") { continue }
    if ($seen.ContainsKey($l)) { continue }
    $seen[$l] = 1
    $vol = Num $c[16]; $price = Num $c[18]
    $value = if ($c[17] -eq "Antal" -and $null -ne $vol -and $null -ne $price) { $vol * $price } else { $null }
    $sek = if ($c[19] -eq "SEK") { $value } else { $null }
    $rows.Add("[" + (J $c[15].Substring(0, 10)) + "," + (J $c[0].Substring(0, 10)) + "," + (J ($c[1] -replace '^\s*Namn:\s*', '').Trim()) + "," + (J $c[14].Trim()) + "," +
      (J $c[4].Trim()) + "," + (J $c[5].Trim()) + "," + $(if ($c[6] -eq "Ja") { "1" } else { "0" }) + "," + (J $c[11].Trim()) + "," +
      (N $vol) + "," + (N $price) + "," + (J $c[19]) + "," + $(if ($null -ne $sek) { [math]::Round($sek).ToString($Inv) } else { "null" }) + "]")
  }
  return , $rows
}
function FetchRows($from, $to) {
  $lines = New-Object System.Collections.Generic.List[string]
  for ($d = $from; $d -le $to; $d = $d.AddDays(7)) {
    $end = $d.AddDays(6); if ($end -gt $to) { $end = $to }
    foreach ($l in (Fetch $d $end)) { $lines.Add($l) }
  }
  return (ToRows $lines)
}
function PubDate($row) { return $row.Substring(15, 10) }
function SortRows($rows) { return @($rows | Sort-Object { $_.Substring(15, 10) }, { $_.Substring(2, 10) } -Descending) }

# ---------- Arkivet: en fil per publiceringsmånad i site/data/insyn-arkiv/ (sparas i repot) ----------
# Raderna för perioden $from..$to ersätts med de nyhämtade, så att rättade anmälningar byter ut de gamla.
$ArchiveDir = Join-Path $DataDir "insyn-arkiv"
function ReadMonth($month) {
  $p = Join-Path $ArchiveDir "$month.json"
  if (-not (Test-Path $p)) { return @() }
  return @([System.IO.File]::ReadAllLines($p, [System.Text.Encoding]::UTF8) | Where-Object { $_.StartsWith('["') } | ForEach-Object { $_.TrimEnd(",") })
}
function MergeArchive($rows, $from, $to) {
  if (-not (Test-Path $ArchiveDir)) { New-Item -ItemType Directory -Force -Path $ArchiveDir | Out-Null }
  $f = $from.ToString("yyyy-MM-dd"); $t = $to.ToString("yyyy-MM-dd")
  for ($m = (Get-Date -Year $from.Year -Month $from.Month -Day 1).Date; $m -le $to; $m = $m.AddMonths(1)) {
    $month = $m.ToString("yyyy-MM")
    $keep = @(ReadMonth $month | Where-Object { $p = PubDate $_; $p -lt $f -or $p -gt $t })
    $new = @($rows | Where-Object { (PubDate $_).StartsWith($month) })
    $all = SortRows (@($keep) + @($new))
    if (-not $all.Count) { continue }
    [System.IO.File]::WriteAllText((Join-Path $ArchiveDir "$month.json"), "[`n" + ($all -join ",`n") + "`n]`n", (New-Object System.Text.UTF8Encoding $false))
  }
}

$today = (Get-Date).Date
$start = $today.AddDays(-$Days)

if ($Backfill) {
  # Fyll arkivet bakåt i tiden, en månad i taget (körs för hand)
  $stop = if ($BackfillTo) { [datetime]::ParseExact($BackfillTo, "yyyy-MM-dd", $Inv) } else { $start.AddDays(-1) }
  for ($m = [datetime]::ParseExact($Backfill, "yyyy-MM-dd", $Inv); $m -le $stop; $m = $m.AddMonths(1)) {
    $mEnd = $m.AddMonths(1).AddDays(-1); if ($mEnd -gt $stop) { $mEnd = $stop }
    $rows = FetchRows $m $mEnd
    MergeArchive $rows $m $mEnd
    Write-Host "  arkiv $($m.ToString('yyyy-MM')): $($rows.Count) affärer"
  }
  if ($BackfillOnly) { return }
}

Write-Host "Insynshandel: hämtar publiceringar $($start.ToString('yyyy-MM-dd')) till $($today.ToString('yyyy-MM-dd'))"
try {
  $rows = FetchRows $start $today
  MergeArchive $rows $start $today
} catch {
  # FI:s server svarar inte: använd de senaste dagarna ur arkivet så att sidan inte blir tom
  Write-Host "  varning: hämtningen misslyckades ($($_.Exception.Message)), använder arkivet"
  $f = $start.ToString("yyyy-MM-dd")
  $rows = New-Object System.Collections.Generic.List[string]
  for ($m = (Get-Date -Year $start.Year -Month $start.Month -Day 1).Date; $m -le $today; $m = $m.AddMonths(1)) {
    foreach ($r in (ReadMonth $m.ToString("yyyy-MM"))) { if ((PubDate $r) -ge $f) { $rows.Add($r) } }
  }
  if (-not $rows.Count) { throw }
}
Remove-Item $Tmp -ErrorAction SilentlyContinue

$sorted = SortRows $rows
$json = '{"built":' + (J (Get-Date).ToString("yyyy-MM-dd")) + ',"from":' + (J $start.ToString("yyyy-MM-dd")) + ',"days":' + $Days +
  ',"rows":[' + ($sorted -join ",") + "]}"
[System.IO.File]::WriteAllText((Join-Path $DataDir "insider.json"), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "  $($sorted.Count) affärer i aktier, arkivet uppdaterat"
