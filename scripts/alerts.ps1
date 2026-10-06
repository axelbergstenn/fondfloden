<#
.SYNOPSIS
  Skickar bevakningsmejl via Buttondown till dem som bevakar en aktie.

.DESCRIPTION
  På aktiesidan kan man anmäla sin e-postadress till Buttondown med etiketten "a-<ISIN>". Skriptet körs
  varje morgon efter att datan byggts och letar efter nyheter om de bevakade aktierna sedan förra körningen:

    - nytt kvartal från FI: hur många fonder som äger aktien, nettoköp och vilka fonder som köpt och sålt mest
    - insynshandel: köp och sälj som publicerats sedan förra körningen
    - blankning: när den sammanlagda blankningen ändrats minst 0,5 procentenheter
    - uppköpserbjudanden: nya bud på bolaget

  Ett mejl per aktie skickas bara till prenumeranter med aktiens etikett (Buttondowns "filters").
  Mejlen skapas som utkast tills miljövariabeln ALERTS_SEND är "true", så att man kan granska dem först.
  Vad som redan rapporterats sparas i site/data/alerts-state.json. Första körningen sparar bara läget.
#>
param([string]$DataDir = "site/data", [int]$MaxEmails = 60)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$key = $env:BUTTONDOWN_API_KEY
if (-not $key) { Write-Host "Bevakning: ingen BUTTONDOWN_API_KEY, hoppar över"; return }
$send = $env:ALERTS_SEND -eq "true"
$api = "https://api.buttondown.com/v1"
$headers = @{ Authorization = "Token $key" }
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding $false

function ReadJson($name) { $p = Join-Path $DataDir $name; if (-not (Test-Path $p)) { return $null }; [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
function Fmt($v, $dec) { $r = [math]::Round([double]$v, $dec); if ($r -eq 0) { $r = 0.0 }; return $r.ToString("N$dec", $Inv).Replace(",", " ").Replace(".", ",") }
function Sek($v) { $v = [double]$v; $s = if ([math]::Abs($v) -ge 1e9) { (Fmt ($v / 1e9) 1) + " mdkr" } elseif ([math]::Abs($v) -ge 1e6) { (Fmt ($v / 1e6) 1) + " mkr" } else { (Fmt $v 0) + " kr" }; if ($v -gt 0) { return "+" + $s }; return $s.Replace("-", "−") }
function Plain($v) { (Sek $v).TrimStart("+") }
# Samma som prettyName i app.js: "VOLVO AB SER. B" blir "Volvo AB SER. B"
function Pretty($name) {
  $name = [string]$name
  if (-not $name) { return $name }
  if ($name -ceq $name.ToUpperInvariant()) {
    $name = ([regex]::Split($name, '(\s+|-)') | ForEach-Object { if ($_.Length -gt 3 -and $_ -cmatch '^[A-ZÅÄÖÉÜ]') { $_.Substring(0, 1) + $_.Substring(1).ToLowerInvariant() } else { $_ } }) -join ""
  }
  return [regex]::Replace($name, '\b(INC|LTD|CORP)\b', [System.Text.RegularExpressions.MatchEvaluator] { param($m) $m.Value.Substring(0, 1) + $m.Value.Substring(1).ToLowerInvariant() })
}

# ---------- Vilka aktier bevakas? ----------
$watched = @{}
$url = "$api/subscribers"
while ($url) {
  $r = Invoke-RestMethod -Uri $url -Headers $headers
  foreach ($s in $r.results) {
    $type = if ($s.type) { $s.type } else { $s.subscriber_type }
    if ($type -in @("unactivated", "unsubscribed", "removed", "spammy", "blocked")) { continue }
    foreach ($t in @($s.tags)) { if ([string]$t -like "a-*") { $watched[([string]$t).Substring(2)] = 1 } }
  }
  $url = $r.next
}
Write-Host "Bevakning: $($watched.Count) bevakade aktier"

$index = ReadJson "index.json"
$Q = [string]$index.quarters[0].id
$shorts = ReadJson "shorts.json"
$insider = ReadJson "insider.json"
$offers = ReadJson "offers.json"
$statePath = Join-Path $DataDir "alerts-state.json"
$state = ReadJson "alerts-state.json"
$shortNow = @{}
if ($shorts) { foreach ($a in $shorts.aggregate) { if ([string]$a[1]) { $shortNow[[string]$a[1]] = [double]$a[2] } } }
$lastPub = if ($insider -and $insider.rows.Count) { ($insider.rows | ForEach-Object { [string]$_[1] } | Sort-Object -Descending | Select-Object -First 1) } else { "" }
$lastOffer = if ($offers -and $offers.offers.Count) { ($offers.offers | ForEach-Object { [string]$_.date } | Sort-Object -Descending | Select-Object -First 1) } else { "" }

function SaveState($quarter, $pub, $offer, $shortMap) {
  $sm = ($shortMap.Keys | Sort-Object | ForEach-Object { '"' + $_ + '":' + ([double]$shortMap[$_]).ToString("0.##", $Inv) }) -join ","
  $json = '{"quarter":"' + $quarter + '","insiderPub":"' + $pub + '","offerDate":"' + $offer + '","shorts":{' + $sm + '}}'
  [System.IO.File]::WriteAllText($statePath, $json, $Utf8)
}

if (-not $state) {
  Write-Host "  första körningen: sparar läget utan att skicka något"
  SaveState $Q $lastPub $lastOffer $shortNow
  return
}

# ---------- Nytt kvartal: fondernas affärer i de bevakade aktierna ----------
$quarterNews = @{}
if ($Q -ne [string]$state.quarter -and $watched.Count) {
  $raw = ReadJson "$Q.json"
  $idx = @{}
  for ($i = 0; $i -lt $raw.stocks.Count; $i++) { $isin = [string]$raw.stocks[$i][0]; if ($watched.ContainsKey($isin)) { $idx[$i] = $isin } }
  $acc = @{}
  foreach ($f in $raw.funds) {
    $both = $null -ne $f[4] -and $null -ne $f[5]
    foreach ($h in $f[6]) {
      $i = [int]$h[0]
      if (-not $idx.ContainsKey($i)) { continue }
      $st = $raw.stocks[$i]; $price = if ($st[3]) { [double]$st[3] } else { 0.0 }
      $s1 = if ($h[1]) { [double]$h[1] } else { 0.0 }; $s2 = if ($h[2]) { [double]$h[2] } else { 0.0 }
      if (-not $acc.ContainsKey($i)) { $acc[$i] = @{ name = (Pretty $st[1]); owners = 0; flow = 0.0; trades = New-Object System.Collections.Generic.List[object] } }
      $e = $acc[$i]
      if ($s2 -and $null -ne $f[5]) { $e.owners++ }
      if ($both -and $s1 -ne $s2) { $d = ($s2 - $s1) * $price; $e.flow += $d; $e.trades.Add(@([string]$f[1], $d)) }
    }
  }
  foreach ($i in $acc.Keys) {
    $e = $acc[$i]
    $buy = @($e.trades | Where-Object { $_[1] -gt 0 } | Sort-Object { $_[1] } -Descending | Select-Object -First 3)
    $sell = @($e.trades | Where-Object { $_[1] -lt 0 } | Sort-Object { $_[1] } | Select-Object -First 3)
    $t = "## Fonderna, " + "Q" + $Q.Substring(5) + " " + $Q.Substring(0, 4) + "`n`n" +
      "$($e.owners) svenska fonder äger aktien. Nettoköp under kvartalet: **$(Sek $e.flow)**.`n"
    if ($buy.Count) { $t += "`nKöpte mest: " + (($buy | ForEach-Object { $_[0] + " (" + (Sek $_[1]) + ")" }) -join ", ") + ".`n" }
    if ($sell.Count) { $t += "`nSålde mest: " + (($sell | ForEach-Object { $_[0] + " (" + (Sek $_[1]) + ")" }) -join ", ") + ".`n" }
    $quarterNews[$idx[$i]] = @{ name = $e.name; text = $t }
  }
}

# ---------- Sammanställ per aktie ----------
$mails = @{}
function Add($isin, $name, $text) {
  if (-not $mails.ContainsKey($isin)) { $mails[$isin] = @{ name = $name; parts = New-Object System.Collections.Generic.List[string] } }
  $mails[$isin].parts.Add($text)
}
foreach ($isin in $quarterNews.Keys) { Add $isin $quarterNews[$isin].name $quarterNews[$isin].text }

if ($insider) {
  $by = @{}
  foreach ($r in $insider.rows) {
    $isin = [string]$r[3]
    if (-not $watched.ContainsKey($isin) -or [string]$r[1] -le [string]$state.insiderPub) { continue }
    if ($r[7] -ne "Förvärv" -and $r[7] -ne "Avyttring") { continue }
    if (-not $by.ContainsKey($isin)) { $by[$isin] = @{ name = [string]$r[2]; rows = New-Object System.Collections.Generic.List[string] } }
    $value = if ($null -ne $r[11]) { " för " + (Plain $r[11]) } else { "" }
    $by[$isin].rows.Add("- " + $(if ($r[7] -eq "Förvärv") { "Köp" } else { "Sälj" }) + $value + ": " + $r[4] + " (" + $r[5] + ")" + $(if ($r[6] -eq 1) { ", närstående" } else { "" }) + ", " + $r[0])
  }
  foreach ($isin in $by.Keys) { Add $isin $by[$isin].name ("## Insynshandel`n`n" + ($by[$isin].rows -join "`n") + "`n") }
}

$prevShorts = @{}
if ($state.shorts) { foreach ($p in $state.shorts.PSObject.Properties) { $prevShorts[$p.Name] = [double]$p.Value } }
foreach ($isin in $watched.Keys) {
  $now = if ($shortNow.ContainsKey($isin)) { $shortNow[$isin] } else { 0.0 }
  $before = if ($prevShorts.ContainsKey($isin)) { $prevShorts[$isin] } else { $now }
  if ([math]::Abs($now - $before) -ge 0.5) {
    $name = ($shorts.aggregate | Where-Object { $_[1] -eq $isin } | Select-Object -First 1)
    Add $isin $(if ($name) { [string]$name[0] } else { $isin }) ("## Blankning`n`nBlankningen har " + $(if ($now -gt $before) { "ökat" } else { "minskat" }) + " från " + (Fmt $before 2) + " % till **" + (Fmt $now 2) + " %** av aktierna.`n")
  }
}

if ($offers) {
  foreach ($o in $offers.offers) {
    if ([string]$o.date -le [string]$state.offerDate) { continue }
    foreach ($isin in @($o.isins)) {
      if (-not $watched.ContainsKey([string]$isin)) { continue }
      Add ([string]$isin) ([string]$o.target) ("## Uppköpserbjudande`n`n" + $o.bidder + " lämnade ett bud på " + $o.target + " (" + $o.date + ")" +
        $(if ($null -ne $o.premium) { ", med en premie på " + (Fmt $o.premium 1) + " %" } else { "" }) + ".`n")
    }
  }
}

# ---------- Skicka ----------
$sent = 0
foreach ($isin in $mails.Keys) {
  if ($sent -ge $MaxEmails) { Write-Host "  taket på $MaxEmails mejl nått"; break }
  $m = $mails[$isin]
  $body = ($m.parts -join "`n") + "`n[Se allt om $($m.name) på Fondinsyn](https://www.fondinsyn.se/#/aktie/$isin)`n`n" +
    "Du får det här mejlet eftersom du bevakar $($m.name) på Fondinsyn. Inget här är investeringsrådgivning."
  $payload = @{
    subject = "Fondinsyn: nytt om $($m.name)"
    body = $body
    status = $(if ($send) { "about_to_send" } else { "draft" })
    filters = @{ predicate = "and"; groups = @(); filters = @(@{ operator = "contains"; field = "subscriber.tags"; value = "a-$isin" }) }
  } | ConvertTo-Json -Depth 6 -Compress
  Invoke-RestMethod -Method Post -Uri "$api/emails" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) | Out-Null
  $sent++
}
Write-Host "  $sent mejl $(if ($send) { 'skickade' } else { 'skapade som utkast (sätt ALERTS_SEND=true för att skicka)' })"

SaveState $Q $lastPub $lastOffer $shortNow
