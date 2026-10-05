<#
.SYNOPSIS
  Hämtar Finansinspektionens fondinnehav och bygger site/data/*.json.

.DESCRIPTION
  Läser listan över publicerade kvartal på fi.se, laddar ner de zip-filer som behövs
  och skriver en JSON-fil per kvartal (jämfört med kvartalet innan) samt site/data/index.json.
  Ett kvartal byggs om bara när FI har publicerat en ny version av någon av dess källfiler.

  Fungerar i både Windows PowerShell 5.1 och PowerShell 7 (pwsh).

.EXAMPLE
  pwsh scripts/build-data.ps1 -History 4
#>
param(
  [string]$OutDir = "site/data",
  [string]$CacheDir = ".cache",
  [int]$History = 4,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$FiBase = "https://www.fi.se"
$FiList = "https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/"
$Inv = [System.Globalization.CultureInfo]::InvariantCulture

# GICS-sektorer (FI anger branschkod enligt GICS nivå 1)
$Gics = @{
  "10" = "Energi"; "15" = "Material"; "20" = "Industri"; "25" = "Sällanköpsvaror"; "30" = "Dagligvaror"
  "35" = "Hälsovård"; "40" = "Finans"; "45" = "IT"; "50" = "Kommunikationstjänster"; "55" = "Kraftförsörjning"; "60" = "Fastigheter"
}

function Num($s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $d = 0.0
  if ([double]::TryParse(([string]$s).Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}

function Get-Releases {
  $html = (Invoke-WebRequest -Uri $FiList -UseBasicParsing).Content
  $seen = @{}
  $list = foreach ($m in [regex]::Matches($html, 'filnamn=(Fondinnehav_(\d{4})Q(\d)_[^"''<>]+?\.zip)')) {
    $file = [System.Net.WebUtility]::UrlDecode([System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value))
    $id = $m.Groups[2].Value + "Q" + $m.Groups[3].Value
    if ($seen.ContainsKey($id)) { continue }
    $seen[$id] = $true
    [pscustomobject]@{ Id = $id; Year = [int]$m.Groups[2].Value; Q = [int]$m.Groups[3].Value; File = $file }
  }
  if (-not $list) { throw "Hittade inga kvartalsfiler på $FiList. Har sidan ändrat format?" }
  return @($list | Sort-Object Year, Q -Descending)
}

function Get-Zip($release) {
  New-Item -ItemType Directory -Force $CacheDir | Out-Null
  $path = Join-Path $CacheDir ($release.Id + ".zip")
  $stamp = "$path.src"
  if ((Test-Path $path) -and (Test-Path $stamp) -and ((Get-Content $stamp -Raw).Trim() -eq $release.File)) { return $path }
  $url = "$FiBase/FondInnehavLista/download?filnamn=" + [uri]::EscapeDataString($release.File)
  Write-Host "  Laddar ner $($release.File)"
  Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
  Set-Content -Path $stamp -Value $release.File
  return $path
}

# Läser ett kvartals zip-fil: fonder och deras innehav i svenska aktier (antal per ISIN)
function Read-Quarter($zipPath) {
  $funds = @{}; $names = @{}; $sect = @{}; $price = @{}; $date = $null
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $zipPath).Path)
  try {
    foreach ($entry in $zip.Entries) {
      if (-not $entry.FullName.EndsWith(".xml")) { continue }
      $x = New-Object System.Xml.XmlDocument
      $stream = $entry.Open()
      try { $x.Load($stream) } finally { $stream.Dispose() }
      $root = $x.DocumentElement
      if (-not $date) { $date = [string]$root.Rapportinformation.Kvartalsslut }
      $fi = $root.Fondinformation
      $holdings = @{}
      foreach ($i in $fi.FinansiellaInstrument.FinansielltInstrument) {
        if ($i.'Tillgångsslag_enligt_LVF_5_kap' -ne 'ÖverlåtbartVärdepapper') { continue }
        $isin = [string]$i.'ISIN-kod_instrument'
        if (-not $isin -or -not $isin.StartsWith("SE")) { continue }
        $n = Num $i.Antal
        if (-not $n -or $n -le 0) { continue }
        # Obligationer och fondandelar som rapporterats med antal hoppas över
        if (Num $i.Nominellt_belopp) { continue }
        $nm = ([string]$i.Instrumentnamn).Trim()
        if ($nm -match '\d{1,2}/\d{1,2}/\d{2,4}|\bFloat\b|\bFRN\b|%|fond\b') { continue }

        if ($holdings.ContainsKey($isin)) { $holdings[$isin] += $n } else { $holdings[$isin] = $n }
        $mv = Num $i.'Marknadsvärde_instrument'
        if ($mv -and $mv -gt 0) { $price[$isin] = $mv / $n }
        if (-not $names.ContainsKey($isin)) { $names[$isin] = @{} }
        $names[$isin][$nm] = 1 + [int]$names[$isin][$nm]
        $code = [string]$i.Bransch.'Branschkod_instrument'
        if ($code -and $code -ne "0") {
          if (-not $sect.ContainsKey($isin)) { $sect[$isin] = @{} }
          $sect[$isin][$code] = 1 + [int]$sect[$isin][$code]
        }
      }
      $funds[[string]$fi.Fond_institutnummer] = @{
        name  = ([string]$fi.Fond_namn).Trim()
        co    = ([string]$root.Bolagsinformation.Fondbolag_namn).Trim()
        aum   = Num $fi.'Fondförmögenhet'
        bench = (@($fi.'Jämförelseindex'.'Jämförelseindex') -join ", ")
        h     = $holdings
      }
    }
  } finally { $zip.Dispose() }
  return @{ funds = $funds; names = $names; sect = $sect; price = $price; date = $date }
}

function Top($tally) {
  if (-not $tally) { return $null }
  return ($tally.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
}
function J($s) {
  if ($null -eq $s) { return "null" }
  return '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"') + '"'
}
function N($v) {
  if ($null -eq $v) { return "null" }
  return ([double]$v).ToString("0.####", $Inv)
}

function Build-Pair($prevRel, $currRel, $outFile) {
  Write-Host "Bygger $($currRel.Id) (jämfört med $($prevRel.Id))"
  $P = @(Read-Quarter (Get-Zip $prevRel)) | Where-Object { $_ -is [hashtable] } | Select-Object -Last 1
  $C = @(Read-Quarter (Get-Zip $currRel)) | Where-Object { $_ -is [hashtable] } | Select-Object -Last 1

  $isins = New-Object System.Collections.Generic.HashSet[string]
  foreach ($q in @($P, $C)) { foreach ($fd in $q.funds.Values) { foreach ($k in $fd.h.Keys) { [void]$isins.Add($k) } } }

  # Splitjustering: en split ger samma kvot nu/förra hos de flesta fonder som ägt aktien båda
  # kvartalen. En nyemission ger spridda kvoter och justeras inte.
  $factor = @{}
  foreach ($isin in $isins) {
    $ratios = New-Object System.Collections.Generic.List[double]
    foreach ($id in $C.funds.Keys) {
      if (-not $P.funds.ContainsKey($id)) { continue }
      $before = $P.funds[$id].h[$isin]; $after = $C.funds[$id].h[$isin]
      if ($before -and $after) { $ratios.Add($after / $before) }
    }
    if ($ratios.Count -lt 3) { continue }
    $sorted = @($ratios | Sort-Object)
    $med = $sorted[[int][math]::Floor($sorted.Count / 2)]
    $same = @($sorted | Where-Object { [math]::Abs($_ / $med - 1) -lt 0.005 }).Count
    if (($med -ge 1.8 -or $med -le 0.55) -and $same / $sorted.Count -ge 0.6) { $factor[$isin] = $med }
  }

  $stockList = @($isins | Sort-Object)
  $idx = @{}
  for ($k = 0; $k -lt $stockList.Count; $k++) { $idx[$stockList[$k]] = $k }

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"meta":{"id":' + (J $currRel.Id) + ',"prevId":' + (J $prevRel.Id))
  [void]$sb.Append(',"prev":' + (J $P.date) + ',"curr":' + (J $C.date) + ',"built":' + (J (Get-Date -Format "yyyy-MM-dd")))
  [void]$sb.Append(',"src":[' + (J $prevRel.File) + ',' + (J $currRel.File) + ']},"stocks":[')
  for ($k = 0; $k -lt $stockList.Count; $k++) {
    $isin = $stockList[$k]
    $nm = $C.names[$isin]; if (-not $nm) { $nm = $P.names[$isin] }
    $sc = $C.sect[$isin]; if (-not $sc) { $sc = $P.sect[$isin] }
    $sec = $null; $code = Top $sc; if ($code) { $sec = $Gics[$code] }
    $px = $C.price[$isin]
    if (-not $px) { $px = $P.price[$isin]; if ($px -and $factor[$isin]) { $px = $px / $factor[$isin] } }
    if ($k -gt 0) { [void]$sb.Append(",") }
    [void]$sb.Append("[" + (J $isin) + "," + (J (Top $nm)) + "," + (J $sec) + "," + (N $px) + "," + (N $factor[$isin]) + "]")
  }
  [void]$sb.Append('],"funds":[')

  $ids = New-Object System.Collections.Generic.HashSet[string]
  foreach ($id in $P.funds.Keys) { [void]$ids.Add($id) }
  foreach ($id in $C.funds.Keys) { [void]$ids.Add($id) }
  $first = $true
  foreach ($id in ($ids | Sort-Object)) {
    $fp = $P.funds[$id]; $fc = $C.funds[$id]
    $info = if ($fc) { $fc } else { $fp }
    $keys = New-Object System.Collections.Generic.HashSet[string]
    if ($fp) { foreach ($k in $fp.h.Keys) { [void]$keys.Add($k) } }
    if ($fc) { foreach ($k in $fc.h.Keys) { [void]$keys.Add($k) } }
    if ($keys.Count -eq 0) { continue }
    $rows = foreach ($isin in $keys) {
      $s1 = if ($fp) { $fp.h[$isin] } else { $null }
      if ($s1 -and $factor[$isin]) { $s1 = $s1 * $factor[$isin] }
      $s2 = if ($fc) { $fc.h[$isin] } else { $null }
      "[" + $idx[$isin] + "," + (N $s1) + "," + (N $s2) + "]"
    }
    if (-not $first) { [void]$sb.Append(",") }; $first = $false
    $aumPrev = if ($fp) { $fp.aum } else { $null }
    $aumCurr = if ($fc) { $fc.aum } else { $null }
    [void]$sb.Append("[" + (J $id) + "," + (J $info.name) + "," + (J $info.co) + "," + (J $info.bench) + "," + (N $aumPrev) + "," + (N $aumCurr) + ",[")
    [void]$sb.Append(($rows -join ",") + "]]")
  }
  [void]$sb.Append("]}")

  [System.IO.File]::WriteAllText($outFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
  $splits = ($factor.Keys | ForEach-Object { "$_ x" + [math]::Round($factor[$_], 3) }) -join ", "
  Write-Host ("  {0} aktier, {1} fonder. Splitjusterade: {2}" -f $stockList.Count, $ids.Count, $(if ($splits) { $splits } else { "inga" }))
}

# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$releases = Get-Releases
Write-Host ("FI har publicerat {0} kvartal, senast {1}" -f $releases.Count, $releases[0].Id)

$built = 0
for ($k = 0; $k -lt [math]::Min($History, $releases.Count - 1); $k++) {
  $curr = $releases[$k]; $prev = $releases[$k + 1]
  $outFile = Join-Path $OutDir ($curr.Id + ".json")
  if (-not $Force -and (Test-Path $outFile)) {
    $head = [System.IO.File]::ReadAllText($outFile)
    $m = [regex]::Match($head, '"src":\["([^"]*)","([^"]*)"\]')
    if ($m.Success -and $m.Groups[1].Value -eq $prev.File -and $m.Groups[2].Value -eq $curr.File) {
      Write-Host "$($curr.Id) är aktuell"
      continue
    }
  }
  Build-Pair $prev $curr $outFile
  $built++
}

# index.json listar alla kvartal som finns byggda, nyast först
$indexFile = Join-Path $OutDir "index.json"
if ($built -eq 0 -and (Test-Path $indexFile)) { Write-Host "Inget nytt från FI."; return }
$entries = Get-ChildItem $OutDir -Filter "*.json" | Where-Object { $_.Name -match '^\d{4}Q\d\.json$' } | Sort-Object Name -Descending | ForEach-Object {
  $txt = [System.IO.File]::ReadAllText($_.FullName)
  $meta = [regex]::Match($txt, '"meta":(\{[^{}]*?"src":\[[^\]]*\]\})').Groups[1].Value
  if (-not $meta) { throw "Saknar meta i $($_.Name)" }
  $meta
}
$index = '{"updated":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"quarters":[' + (@($entries) -join ",") + ']}'
[System.IO.File]::WriteAllText($indexFile, $index, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Klart. Byggde $built kvartal."
