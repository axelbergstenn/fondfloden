<#
.SYNOPSIS
  Hämtar Finansinspektionens fondinnehav och bygger site/data/*.json.

.DESCRIPTION
  Läser listan över publicerade kvartal på fi.se, laddar ner de zip-filer som behövs och skriver:

    site/data/<kvartal>.json        Svenska aktier, jämfört med kvartalet innan, samt nyckeltal för alla fonder
    site/data/<kvartal>-world.json  Utländska aktier, samma format
    site/data/history.json          Fondernas ägande och nettoköp per aktie för alla kvartal sedan 2018
    site/data/index.json            Lista över byggda kvartal

  Filer byggs om bara när FI har publicerat nya versioner av källfilerna (eller när formatet ändrats).
  Fungerar i både Windows PowerShell 5.1 och PowerShell 7 (pwsh).

.EXAMPLE
  pwsh scripts/build-data.ps1 -History 4
  pwsh scripts/build-data.ps1 -History 1 -HistoryQuarters 2   # snabbt lokalt test
#>
param(
  [string]$OutDir = "site/data",
  [string]$CacheDir = ".cache",
  [int]$History = 4,              # antal kvartal (jämförelser) som byggs i detalj
  [int]$HistoryQuarters = 0,      # 0 = alla kvartal FI har publicerat
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$FormatVersion = 2
$FiBase = "https://www.fi.se"
$FiList = "https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/"
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$IndexRe = '(?i)index|indx|\bomx|passiv|tracker|\betf\b|\bzero\b'
$BondRe = '\d{1,2}/\d{1,2}/\d{2,4}|\bFloat\b|\bFRN\b|%|fond\b'
$WorldMinValue = 20e6           # utländska aktier: minsta sammanlagda fondinnehav för att tas med
$HistoryMinSe = 1e6             # historik: minsta toppvärde för svenska aktier
$HistoryMinWorld = 200e6        # historik: minsta toppvärde för utländska aktier

# GICS-sektorer (FI anger branschkod enligt GICS nivå 1)
$Gics = @{
  "10" = "Energi"; "15" = "Material"; "20" = "Industri"; "25" = "Sällanköpsvaror"; "30" = "Dagligvaror"
  "35" = "Hälsovård"; "40" = "Finans"; "45" = "IT"; "50" = "Kommunikationstjänster"; "55" = "Kraftförsörjning"; "60" = "Fastigheter"
}

# ---------------------------------------------------------------------------
# Hjälpfunktioner

function Num($s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $d = 0.0
  if ([double]::TryParse(([string]$s).Replace(",", "."), [System.Globalization.NumberStyles]::Float, $Inv, [ref]$d)) { return $d }
  return $null
}
function J($s) {
  if ($null -eq $s) { return "null" }
  return '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"').Replace("`t", " ").Replace("`r", "").Replace("`n", " ") + '"'
}
function N($v, $fmt = "0.####") {
  if ($null -eq $v) { return "null" }
  return ([double]$v).ToString($fmt, $Inv)
}
function Top($tally) {
  if (-not $tally) { return $null }
  $best = $null; $max = -1
  foreach ($e in $tally.GetEnumerator()) { if ($e.Value -gt $max) { $max = $e.Value; $best = $e.Key } }
  return $best
}
function Tally($table, $key, $value) {
  if (-not $value) { return }
  if (-not $table.ContainsKey($key)) { $table[$key] = @{} }
  $table[$key][$value] = 1 + [int]$table[$key][$value]
}
function Write-Utf8($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------------------
# FI

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

# Läser ett kvartal: alla fonder med nyckeltal och innehav i aktier (antal per ISIN)
$QuarterCache = @{}
function Read-Quarter($release) {
  if ($QuarterCache.ContainsKey($release.Id)) { return $QuarterCache[$release.Id] }
  Write-Host "  Läser $($release.Id)"
  $funds = @{}; $names = @{}; $sect = @{}; $country = @{}; $price = @{}; $date = $null
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path (Get-Zip $release)).Path)
  try {
    foreach ($entry in $zip.Entries) {
      if (-not $entry.FullName.EndsWith(".xml")) { continue }
      $x = New-Object System.Xml.XmlDocument
      $stream = $entry.Open()
      try { $x.Load($stream) } finally { $stream.Dispose() }
      $root = $x.DocumentElement
      if (-not $date) { $date = [string]$root.Rapportinformation.Kvartalsslut }
      $fi = $root.Fondinformation
      if (-not $fi) { continue }

      $holdings = @{}
      $equity = 0.0
      foreach ($i in $fi.FinansiellaInstrument.FinansielltInstrument) {
        if ($i.'Tillgångsslag_enligt_LVF_5_kap' -ne 'ÖverlåtbartVärdepapper') { continue }
        $isin = [string]$i.'ISIN-kod_instrument'
        if (-not $isin -or $isin.Length -ne 12) { continue }
        $n = Num $i.Antal
        if (-not $n -or $n -le 0) { continue }
        # Obligationer och fondandelar som rapporterats med antal hoppas över
        if (Num $i.Nominellt_belopp) { continue }
        $nm = ([string]$i.Instrumentnamn).Trim()
        if ($nm -match $BondRe) { continue }

        if ($holdings.ContainsKey($isin)) { $holdings[$isin] += $n } else { $holdings[$isin] = $n }
        $mv = Num $i.'Marknadsvärde_instrument'
        if ($mv -and $mv -gt 0) { $price[$isin] = $mv / $n; $equity += $mv }
        Tally $names $isin $nm
        $code = [string]$i.Bransch.'Branschkod_instrument'
        if ($code -ne "0") { Tally $sect $isin $code }
        Tally $country $isin ([string]$i.Landkod_Emittent)
      }

      $fees = @()
      $feeNode = $fi.ChildNodes | Where-Object { $_.LocalName -eq 'Förvaltningsavgift' } | Select-Object -First 1
      $perf = $false
      if ($feeNode) {
        foreach ($f in $feeNode.SelectNodes(".//*[local-name()='Förvaltningsavgift_fast']")) { $v = Num $f.InnerText; if ($null -ne $v) { $fees += $v } }
        $perf = $null -ne $feeNode.SelectSingleNode(".//*[local-name()='Förvaltningsavgift_Prestationsbaserad']")
      }
      $aum = Num $fi.'Fondförmögenhet'
      $name = ([string]$fi.Fond_namn).Trim()
      $funds[[string]$fi.Fond_institutnummer] = @{
        name   = $name
        co     = ([string]$root.Bolagsinformation.Fondbolag_namn).Trim()
        aum    = $aum
        bench  = (@($fi.'Jämförelseindex'.'Jämförelseindex') -join ", ")
        feeMin = $(if ($fees.Count) { ($fees | Measure-Object -Minimum).Minimum } else { $null })
        feeMax = $(if ($fees.Count) { ($fees | Measure-Object -Maximum).Maximum } else { $null })
        perf   = $perf
        ar     = Num $fi.Aktiv_risk
        sd     = Num $fi.'Standardavvikelse_24_månader'
        eq     = $(if ($aum -and $aum -gt 0) { [math]::Min(1, $equity / $aum) } else { $null })
        index  = $name -match $IndexRe
        h      = $holdings
      }
    }
  } finally { $zip.Dispose() }
  $q = @{ id = $release.Id; funds = $funds; names = $names; sect = $sect; country = $country; price = $price; date = $date }
  $QuarterCache[$release.Id] = $q
  return $q
}

# Splitjustering: en split ger samma kvot nu/förra hos de flesta fonder som ägt aktien båda
# kvartalen. En nyemission ger spridda kvoter och justeras inte.
function Get-SplitFactors($P, $C) {
  $ratios = @{}
  foreach ($id in $C.funds.Keys) {
    $fp = $P.funds[$id]
    if (-not $fp) { continue }
    $hc = $C.funds[$id].h
    foreach ($isin in $hc.Keys) {
      $before = $fp.h[$isin]
      if (-not $before) { continue }
      if (-not $ratios.ContainsKey($isin)) { $ratios[$isin] = New-Object System.Collections.Generic.List[double] }
      $ratios[$isin].Add($hc[$isin] / $before)
    }
  }
  $factor = @{}
  foreach ($isin in $ratios.Keys) {
    $list = $ratios[$isin]
    if ($list.Count -lt 3) { continue }
    # Fonder som inte handlat i aktien får exakt splitkvoten. Om minst tre fonder (och minst 15 %)
    # har exakt samma kvot långt från 1 är det en split, även om andra fonder handlat samtidigt.
    $buckets = @{}
    foreach ($r in $list) {
      if ($r -lt 1.8 -and $r -gt 0.55) { continue }
      $key = [math]::Round([math]::Log($r) / 0.002)
      if (-not $buckets.ContainsKey($key)) { $buckets[$key] = New-Object System.Collections.Generic.List[double] }
      $buckets[$key].Add($r)
    }
    $best = $null
    foreach ($b in $buckets.Values) { if (-not $best -or $b.Count -gt $best.Count) { $best = $b } }
    if ($best -and $best.Count -ge 3 -and $best.Count / $list.Count -ge 0.15) {
      $s = @($best | Sort-Object)
      $factor[$isin] = $s[[int][math]::Floor($s.Count / 2)]
    }
  }
  return $factor
}

function Get-Totals($Q) {
  $tot = @{}
  foreach ($fd in $Q.funds.Values) {
    foreach ($isin in $fd.h.Keys) { $tot[$isin] = [double]$tot[$isin] + $fd.h[$isin] * [double]$Q.price[$isin] }
  }
  return $tot
}

function Stock-Meta($P, $C, $isin, $factor) {
  $nm = $C.names[$isin]; if (-not $nm) { $nm = $P.names[$isin] }
  $sc = $C.sect[$isin]; if (-not $sc) { $sc = $P.sect[$isin] }
  $ct = $C.country[$isin]; if (-not $ct) { $ct = $P.country[$isin] }
  $sec = $null; $code = Top $sc; if ($code) { $sec = $Gics[$code] }
  $px = $C.price[$isin]
  if (-not $px) { $px = $P.price[$isin]; if ($px -and $factor[$isin]) { $px = $px / $factor[$isin] } }
  return @{ name = (Top $nm); sector = $sec; country = (Top $ct); price = $px }
}

# Skriver en marknadsfil (svenska eller utländska aktier) för ett kvartalspar
function Write-Market($P, $C, $factor, [string[]]$isins, $meta, $extra, $file) {
  $isins = @($isins | Sort-Object)
  $idx = @{}
  for ($k = 0; $k -lt $isins.Count; $k++) { $idx[$isins[$k]] = $k }

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"meta":' + $meta + ',"stocks":[')
  for ($k = 0; $k -lt $isins.Count; $k++) {
    $isin = $isins[$k]
    $m = Stock-Meta $P $C $isin $factor
    if ($k -gt 0) { [void]$sb.Append(",") }
    [void]$sb.Append("[" + (J $isin) + "," + (J $m.name) + "," + (J $m.sector) + "," + (N $m.price) + "," + (N $factor[$isin]) + "," + (J $m.country) + "]")
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
    if ($fp) { foreach ($k in $fp.h.Keys) { if ($idx.ContainsKey($k)) { [void]$keys.Add($k) } } }
    if ($fc) { foreach ($k in $fc.h.Keys) { if ($idx.ContainsKey($k)) { [void]$keys.Add($k) } } }
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
  [void]$sb.Append("]" + $extra + "}")
  Write-Utf8 $file $sb.ToString()
  return $isins.Count
}

function Build-Pair($prevRel, $currRel) {
  Write-Host "Bygger $($currRel.Id) (jämfört med $($prevRel.Id))"
  $P = Read-Quarter $prevRel
  $C = Read-Quarter $currRel
  $factor = Get-SplitFactors $P $C

  $all = New-Object System.Collections.Generic.HashSet[string]
  foreach ($q in @($P, $C)) { foreach ($fd in $q.funds.Values) { foreach ($k in $fd.h.Keys) { [void]$all.Add($k) } } }
  $totP = Get-Totals $P; $totC = Get-Totals $C
  $se = @($all | Where-Object { $_.StartsWith("SE") })
  $world = @($all | Where-Object { -not $_.StartsWith("SE") -and [math]::Max([double]$totP[$_], [double]$totC[$_]) -ge $WorldMinValue })

  $meta = '{"v":' + $FormatVersion + ',"id":' + (J $currRel.Id) + ',"prevId":' + (J $prevRel.Id) + ',"prev":' + (J $P.date) + ',"curr":' + (J $C.date) +
    ',"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"src":[' + (J $prevRel.File) + ',' + (J $currRel.File) + ']}'

  # Nyckeltal för alla fonder i det senaste kvartalet (avgifter, aktiv risk, aktieandel)
  $info = foreach ($id in ($C.funds.Keys | Sort-Object)) {
    $f = $C.funds[$id]
    "[" + (J $id) + "," + (J $f.name) + "," + (J $f.co) + "," + (J $f.bench) + "," + (N $f.aum) + "," + (N $f.feeMin) + "," + (N $f.feeMax) + "," +
      $(if ($f.perf) { "1" } else { "0" }) + "," + (N $f.ar) + "," + (N $f.sd) + "," + (N $f.eq "0.###") + "," + $f.h.Count + "]"
  }
  $extra = ',"fundInfo":[' + (@($info) -join ",") + "]"

  $nSe = Write-Market $P $C $factor $se $meta $extra (Join-Path $OutDir ($currRel.Id + ".json"))
  $nWorld = Write-Market $P $C $factor $world $meta "" (Join-Path $OutDir ($currRel.Id + "-world.json"))
  $splits = ($factor.Keys | ForEach-Object { "$_ x" + [math]::Round($factor[$_], 3) }) -join ", "
  Write-Host ("  {0} svenska och {1} utländska aktier. Splitjusterade: {2}" -f $nSe, $nWorld, $(if ($splits) { $splits } else { "inga" }))
}

# Historik: per aktie och kvartal antal fonder som äger, fondernas innehav och nettoköp
function Build-History($releases, $file) {
  $ordered = @($releases | Sort-Object Year, Q)
  Write-Host "Bygger historik för $($ordered.Count) kvartal ($($ordered[0].Id)–$($ordered[-1].Id))"
  $series = @{}; $peak = @{}; $metaOf = @{}
  $prev = $null
  for ($qi = 0; $qi -lt $ordered.Count; $qi++) {
    $C = Read-Quarter $ordered[$qi]
    $factor = if ($prev) { Get-SplitFactors $prev $C } else { @{} }
    $count = @{}; $value = @{}; $flow = @{}; $flowA = @{}
    foreach ($id in $C.funds.Keys) {
      $fc = $C.funds[$id]
      $fp = if ($prev) { $prev.funds[$id] } else { $null }
      foreach ($isin in $fc.h.Keys) {
        $count[$isin] = 1 + [int]$count[$isin]
        $value[$isin] = [double]$value[$isin] + $fc.h[$isin] * [double]$C.price[$isin]
      }
      if (-not $fp) { continue }
      $keys = New-Object System.Collections.Generic.HashSet[string]
      foreach ($k in $fc.h.Keys) { [void]$keys.Add($k) }
      foreach ($k in $fp.h.Keys) { [void]$keys.Add($k) }
      foreach ($isin in $keys) {
        $px = $C.price[$isin]
        if (-not $px -and $prev.price[$isin]) { $px = $prev.price[$isin] / $(if ($factor[$isin]) { $factor[$isin] } else { 1 }) }
        if (-not $px) { continue }
        $s1 = [double]$fp.h[$isin]; if ($factor[$isin]) { $s1 = $s1 * $factor[$isin] }
        $d = ([double]$fc.h[$isin] - $s1) * $px
        $flow[$isin] = [double]$flow[$isin] + $d
        if (-not $fc.index) { $flowA[$isin] = [double]$flowA[$isin] + $d }
      }
    }
    $isins = New-Object System.Collections.Generic.HashSet[string]
    foreach ($k in $count.Keys) { [void]$isins.Add($k) }
    foreach ($k in $flow.Keys) { [void]$isins.Add($k) }
    foreach ($isin in $isins) {
      if (-not $series.ContainsKey($isin)) { $series[$isin] = New-Object System.Collections.Generic.List[string] }
      $v = [double]$value[$isin]
      $fl = if ($prev) { N ($flow[$isin] / 1e6) "0.#" } else { "null" }
      $fa = if ($prev) { N ($flowA[$isin] / 1e6) "0.#" } else { "null" }
      $series[$isin].Add("[" + $qi + "," + [int]$count[$isin] + "," + (N ($v / 1e6) "0.#") + "," + $fl + "," + $fa + "]")
      if ($v -gt [double]$peak[$isin]) { $peak[$isin] = $v }
    }
    # Spara metadata (namn, sektor, land) från senaste kvartalet aktien förekom
    foreach ($isin in $count.Keys) {
      $m = Stock-Meta $C $C $isin @{}
      $metaOf[$isin] = $m
    }
    if ($prev) { $QuarterCache.Remove($prev.id) }
    $prev = $C
  }

  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('{"v":' + $FormatVersion + ',"built":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"quarters":[' + ((@($ordered | ForEach-Object { J $_.Id })) -join ",") + ']')
  [void]$sb.Append(',"src":[' + ((@($ordered | ForEach-Object { J $_.File })) -join ",") + '],"stocks":{')
  $first = $true; $kept = 0
  foreach ($isin in ($series.Keys | Sort-Object)) {
    $min = if ($isin.StartsWith("SE")) { $HistoryMinSe } else { $HistoryMinWorld }
    if ([double]$peak[$isin] -lt $min) { continue }
    $m = $metaOf[$isin]
    if (-not ($m -is [hashtable])) { continue }
    if (-not $first) { [void]$sb.Append(",") }; $first = $false
    [void]$sb.Append((J $isin) + ":[" + (J $m.name) + "," + (J $m.sector) + "," + (J $m.country) + ",[" + ($series[$isin] -join ",") + "]]")
    $kept++
  }
  [void]$sb.Append("}}")
  Write-Utf8 $file $sb.ToString()
  Write-Host "  Historik för $kept aktier."
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
  if (-not $Force -and (Test-Path $outFile) -and (Test-Path (Join-Path $OutDir ($curr.Id + "-world.json")))) {
    $head = [System.IO.File]::ReadAllText($outFile)
    $m = [regex]::Match($head, '^\{"meta":\{"v":(\d+),.*?"src":\["([^"]*)","([^"]*)"\]')
    if ($m.Success -and [int]$m.Groups[1].Value -eq $FormatVersion -and $m.Groups[2].Value -eq $prev.File -and $m.Groups[3].Value -eq $curr.File) {
      Write-Host "$($curr.Id) är aktuell"
      continue
    }
  }
  Build-Pair $prev $curr
  $built++
}

$histReleases = if ($HistoryQuarters -gt 0) { @($releases | Select-Object -First $HistoryQuarters) } else { $releases }
$histFile = Join-Path $OutDir "history.json"
$histSrc = '"src":[' + ((@($histReleases | Sort-Object Year, Q | ForEach-Object { J $_.File })) -join ",") + ']'
$histCurrent = (Test-Path $histFile) -and ([System.IO.File]::ReadAllText($histFile).Contains($histSrc)) -and ([System.IO.File]::ReadAllText($histFile).StartsWith('{"v":' + $FormatVersion + ','))
if ($Force -or -not $histCurrent) {
  Build-History $histReleases $histFile
  $built++
} else {
  Write-Host "Historiken är aktuell"
}

# index.json listar alla kvartal som finns byggda, nyast först
$indexFile = Join-Path $OutDir "index.json"
if ($built -eq 0 -and (Test-Path $indexFile)) { Write-Host "Inget nytt från FI."; return }
$entries = Get-ChildItem $OutDir -Filter "*.json" | Where-Object { $_.Name -match '^\d{4}Q\d\.json$' } | Sort-Object Name -Descending | ForEach-Object {
  $txt = [System.IO.File]::ReadAllText($_.FullName)
  $meta = [regex]::Match($txt, '^\{"meta":(\{[^{}]*?"src":\[[^\]]*\]\})').Groups[1].Value
  if (-not $meta) { throw "Saknar meta i $($_.Name)" }
  if ($meta -notmatch '"v":' + $FormatVersion + ',') { Write-Host "  Hoppar över $($_.Name) (gammalt format)"; return }
  $meta
}
$index = '{"updated":' + (J (Get-Date -Format "yyyy-MM-dd")) + ',"quarters":[' + (@($entries) -join ",") + ']}'
Write-Utf8 $indexFile $index
Write-Host "Klart."
