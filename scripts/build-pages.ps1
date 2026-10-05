<#
.SYNOPSIS
  Bygger en fast sida per aktie, fond och fondbolag, delningsbilder, sitemap.xml och robots.txt.

.DESCRIPTION
  Sajten är en enda sida där vyn styrs av det som står efter # (fondinsyn.se/#/aktie/SE0000115446).
  Sökmotorer läser inte det som står efter #, och en delad länk får ingen egen förhandsbild. Skriptet
  skapar därför en riktig sida för varje aktie, fond och fondbolag (fondinsyn.se/aktie/volvo-b/) med
  egen titel, beskrivning, delningsbild och innehållet förifyllt. När sidan har laddats tar appen över
  och visar samma vy som vanligt (sidan anger vyn i <body data-route="...">).

  Sidorna utgår från site/index.html och körs därför efter att versionsnumret satts i bygget.
  Delningsbilderna (1200 x 630) ritas som SVG och görs om till PNG med rsvg-convert. Finns inte
  rsvg-convert (till exempel lokalt i Windows) blir SVG-filerna kvar och sidorna använder standardbilden.
#>
param(
  [string]$Site = "site",
  [string]$BaseUrl = "https://fondinsyn.se",
  # Skriver även om site/index.html med förifyllt innehåll. Används bara i bygget, inte lokalt.
  [switch]$WriteHome
)

$ErrorActionPreference = "Stop"
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding $false
$DataDir = Join-Path $Site "data"
$NB = [string][char]0xA0
$MINUS = [string][char]0x2212
$MONTHS = @("januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december")
$FONT = "Inter, 'Inter Variable', 'DejaVu Sans', Arial, sans-serif"

# ---------- Hjälpfunktioner ----------

function ReadJson($name) { [System.IO.File]::ReadAllText((Join-Path $DataDir $name), [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
function Save($rel, $text) {
  $path = Join-Path $Site $rel
  $dir = Split-Path $path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $Utf8)
}
function Esc($s) { ([string]$s).Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;") }
function J($s) { '"' + ([string]$s).Replace('\', '\\').Replace('"', '\"') + '"' }
function Num($x) { if ($null -eq $x) { return $null }; return [double]$x }

# "Atlas Copco AB ser. A" -> "atlas-copco-ab-ser-a"
function Slug($s) {
  $t = ([string]$s).ToLowerInvariant().Replace("&", " och ").Normalize([System.Text.NormalizationForm]::FormD)
  $t = [regex]::Replace($t, '\p{Mn}', '')
  $t = [regex]::Replace($t, '[^a-z0-9]+', '-').Trim('-')
  if ($t.Length -gt 70) { $t = $t.Substring(0, 70).Trim('-') }
  if (-not $t) { $t = "x" }
  return $t
}
function Uniq($used, $slug, $suffix) {
  if ($used.ContainsKey($slug)) { $slug = $slug + "-" + (Slug $suffix) }
  $used[$slug] = 1
  return $slug
}

# Samma som prettyName i app.js: "VOLVO AB SER. B" -> "Volvo AB SER. B"
function Pretty($name) {
  $name = [string]$name
  if (-not $name -or $name -cne $name.ToUpperInvariant()) { return $name }
  $parts = [regex]::Split($name, '(\s+)') | ForEach-Object {
    if ($_.Length -gt 3 -and $_ -cmatch '^[A-ZÅÄÖÉÜ]') { $_.Substring(0, 1) + $_.Substring(1).ToLowerInvariant() } else { $_ }
  }
  return ($parts -join "")
}

# Svensk talformatering: 1 574,2 och −5,3
function Fmt($v, [int]$dec) {
  $r = [math]::Round([double]$v, $dec)
  if ($r -eq 0) { $r = 0.0 }
  $s = $r.ToString("N$dec", $Inv).Replace(",", "_").Replace(".", ",").Replace("_", $NB)
  if ($s.StartsWith("-")) { $s = $MINUS + $s.Substring(1) }
  return $s
}
function Num0($n) { Fmt $n 0 }
function Signed($s, $v) { if ($v -gt 0) { return "+" + $s }; return $s }
function Mkr($v, [switch]$Sign) {
  $m = [double]$v / 1e6
  $s = if ([math]::Abs($m) -ge 100) { Fmt $m 0 } else { Fmt $m 1 }
  if ($Sign) { return Signed $s $m }; return $s
}
function BigSek($v, [switch]$Sign) {
  if ($null -eq $v) { return "–" }
  $v = [double]$v
  $s = if ([math]::Abs($v) -ge 1e9) { (Fmt ($v / 1e9) 1) + " mdkr" } else { (Fmt ($v / 1e6) 0) + " mkr" }
  if ($Sign) { return Signed $s $v }; return $s
}
function PctChange($v) { if ($null -eq $v) { return "–" }; return Signed ((Fmt ($v * 100) 1) + " %") $v }
function PctPlain($v) { if ($null -eq $v) { return "–" }; return (Fmt $v 1) + " %" }
function FeeText($fi) {
  if ($null -eq $fi.feeMax) { return "–" }
  if ($null -ne $fi.feeMin -and $fi.feeMin -lt $fi.feeMax) { return (Fmt $fi.feeMin 2) + "–" + (Fmt $fi.feeMax 2) + " %" }
  return (Fmt $fi.feeMax 2) + " %"
}
function QLabel($id) { return "Q" + $id.Substring(5) + " " + $id.Substring(0, 4) }
function DateText($iso) {
  $p = ([string]$iso).Split("-")
  if ($p.Count -ne 3) { return [string]$iso }
  return "{0} {1} {2}" -f [int]$p[2], $MONTHS[[int]$p[1] - 1], $p[0]
}
function Plural($n, $one, $many) { if ($n -eq 1) { return "1 $one" }; return (Num0 $n) + " $many" }
function JoinSv($items) {
  $items = @($items)
  if ($items.Count -eq 0) { return "" }
  if ($items.Count -eq 1) { return $items[0] }
  return (($items[0..($items.Count - 2)]) -join ", ") + " och " + $items[-1]
}
function SignClass($v) { if ($null -eq $v) { return "" }; if ($v -gt 0) { return "pos" }; if ($v -lt 0) { return "neg" }; return "" }
function Colored($v, $text) { return '<span class="' + (SignClass $v) + '">' + $text + "</span>" }
function A($url, $text) { return '<a href="' + (Esc $url) + '">' + (Esc $text) + "</a>" }
function Fig($label, $value) { return "<div><dt>$label</dt><dd>$value</dd></div>" }
function Block($title, $inner, $cls) { return '<section class="block ' + $cls + '"><div class="block-head"><h2>' + $title + "</h2></div>" + $inner + "</section>" }

# Tabell: första kolumnen är vänsterställd (namn), resten högerställda (tal)
function Table($heads, $rows) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<div class="table-wrap"><table><thead><tr>')
  for ($i = 0; $i -lt $heads.Count; $i++) {
    [void]$sb.Append($(if ($i -eq 0) { '<th class="l" scope="col">' } else { '<th scope="col">' }) + $heads[$i] + "</th>")
  }
  [void]$sb.Append("</tr></thead><tbody>")
  foreach ($r in $rows) {
    [void]$sb.Append("<tr>")
    for ($i = 0; $i -lt $r.Count; $i++) { [void]$sb.Append($(if ($i -eq 0) { '<td class="l name">' } else { "<td>" }) + $r[$i] + "</td>") }
    [void]$sb.Append("</tr>")
  }
  if ($rows.Count -eq 0) { [void]$sb.Append('<tr><td class="empty" colspan="' + $heads.Count + '">Inga rader.</td></tr>') }
  [void]$sb.Append("</tbody></table></div>")
  return $sb.ToString()
}
function NewList { return , (New-Object System.Collections.Generic.List[object]) }

# ---------- Data ----------

$index = ReadJson "index.json"
$qMeta = $index.quarters[0]
$Q = [string]$qMeta.id
$QL = QLabel $Q
$asOf = DateText $qMeta.curr
$raw = ReadJson "$Q.json"
Write-Host "Sidor: bygger från $QL"

$stocks = NewList
foreach ($x in $raw.stocks) {
  $stocks.Add([pscustomobject]@{
      isin = [string]$x[0]; name = (Pretty $x[1]); sector = $(if ($x[2]) { [string]$x[2] } else { "Övrigt" })
      price = $(if ($x[3]) { [double]$x[3] } else { 0.0 })
      h2 = 0.0; f2 = 0; h1b = 0.0; h2b = 0.0; flow = 0.0; nNew = 0; nExit = 0; val2 = 0.0; chg = $null
      isNew = $false; isGone = $false; netFlow = $null; slug = $null
      holders = (NewList); trades = (NewList)
    })
}

$funds = NewList
$fundById = @{}
foreach ($x in $raw.funds) {
  $f = [pscustomobject]@{
    id = [string]$x[0]; name = [string]$x[1]; co = [string]$x[2]; aum2 = $x[5]; h = $x[6]
    both = ($null -ne $x[4] -and $null -ne $x[5]); val = 0.0; nHold = 0; rows = (NewList)
  }
  $funds.Add($f)
  $fundById[$f.id] = $f
}

# Samma uträkning som compute() i app.js (utan att exkludera indexfonder)
foreach ($f in $funds) {
  $has2 = $null -ne $f.aum2
  foreach ($r in $f.h) {
    $s = $stocks[[int]$r[0]]
    $s1 = if ($r[1]) { [double]$r[1] } else { 0.0 }
    $s2 = if ($r[2]) { [double]$r[2] } else { 0.0 }
    $d = ($s2 - $s1) * $s.price
    $f.rows.Add([pscustomobject]@{ s = $s; s1 = $s1; s2 = $s2; v = $s2 * $s.price; d = $d })
    if ($s2 -and $has2) {
      $f.val += $s2 * $s.price; $f.nHold++
      $s.h2 += $s2; $s.f2++
      $s.holders.Add([pscustomobject]@{ f = $f; v = $s2 * $s.price; s1 = $s1; s2 = $s2 })
    }
    if (-not $f.both) { continue }
    $s.h1b += $s1; $s.h2b += $s2; $s.flow += $d
    if (-not $s1 -and $s2) { $s.nNew++ }
    if ($s1 -and -not $s2) { $s.nExit++ }
    if ($s1 -ne $s2) { $s.trades.Add([pscustomobject]@{ f = $f; d = $d; s1 = $s1; s2 = $s2 }) }
  }
}
$tFunds = @($funds | Where-Object { $_.both }).Count
$tHeld = 0; $tValue = 0.0; $tNet = 0.0
foreach ($s in $stocks) {
  $s.val2 = $s.h2 * $s.price
  if ($s.h1b) { $s.chg = ($s.h2b - $s.h1b) / $s.h1b }
  $s.isNew = $s.h1b -eq 0 -and $s.h2b -gt 0
  $s.isGone = $s.h2b -eq 0 -and $s.h1b -gt 0
  if (-not ($s.isNew -or $s.isGone)) { $s.netFlow = $s.flow; $tNet += $s.flow }
  if ($s.f2) { $tHeld++ }
  $tValue += $s.val2
}

$infos = NewList
$infoById = @{}
foreach ($x in $raw.fundInfo) {
  $fi = [pscustomobject]@{
    id = [string]$x[0]; name = [string]$x[1]; co = [string]$x[2]; bench = [string]$x[3]; aum = (Num $x[4])
    feeMin = (Num $x[5]); feeMax = (Num $x[6]); ar = (Num $x[8]); sd = (Num $x[9]); slug = $null; m = $fundById[[string]$x[0]]
  }
  $infos.Add($fi)
  $infoById[$fi.id] = $fi
}

# Fondbolag (skiftlägeskänsliga nycklar, precis som i appen)
$companies = New-Object 'System.Collections.Generic.Dictionary[string,object]'
foreach ($fi in $infos) {
  if (-not $companies.ContainsKey($fi.co)) {
    $companies[$fi.co] = [pscustomobject]@{ name = $fi.co; funds = (NewList); aum = 0.0; feeAum = 0.0; feeBase = 0.0; se = 0.0; slug = $null }
  }
  $c = $companies[$fi.co]
  $c.funds.Add($fi)
  if ($fi.aum) { $c.aum += $fi.aum }
  if ($null -ne $fi.feeMax -and $fi.aum) { $c.feeAum += $fi.aum * $fi.feeMax; $c.feeBase += $fi.aum }
  if ($fi.m) { $c.se += $fi.m.val }
}
function CoFee($c) { if ($c.feeBase) { return (Fmt ($c.feeAum / $c.feeBase) 2) + " %" }; return "–" }

# Historik för staplarna i delningsbilden
$hist = $null; $hq = -1
try {
  $hist = ReadJson "history-se.json"
  $hq = [array]::IndexOf([string[]]@($hist.quarters), $Q)
} catch { Write-Host "  ingen historik: $($_.Exception.Message)" }
function FlowBars($isin) {
  if (-not $hist -or $hq -lt 1) { return $null }
  $e = $hist.stocks.$isin
  if (-not $e) { return $null }
  $byQ = @{}
  foreach ($r in $e[3]) { $byQ[[int]$r[0]] = $r }
  $out = @()
  for ($k = [math]::Max(1, $hq - 11); $k -le $hq; $k++) {
    $r = $byQ[$k]
    $out += [double]$(if ($r -and $null -ne $r[3]) { $r[3] } else { 0 })
  }
  return , $out
}

# ---------- Adresser ----------

$pageStocks = @($stocks | Where-Object { $_.f2 -gt 0 } | Sort-Object isin)
$used = @{}
foreach ($s in $pageStocks) { $s.slug = Uniq $used (Slug $s.name) $s.isin }
$used = @{}
foreach ($fi in @($infos | Sort-Object id)) { $fi.slug = Uniq $used (Slug $fi.name) $fi.id }
$used = @{}
$coList = @($companies.Values | Sort-Object name)
$n = 0
foreach ($c in $coList) { $n++; $c.slug = Uniq $used (Slug $c.name) $n }

function StockUrl($s) { if ($s.slug) { return "/aktie/$($s.slug)/" }; return "/#/aktie/$($s.isin)" }
function FundUrl($id) { $fi = $infoById[$id]; if ($fi) { return "/fond/$($fi.slug)/" }; return "/#/fond/" + [uri]::EscapeDataString($id) }
function CoUrl($co) { if ($companies.ContainsKey($co)) { return "/fondbolag/$($companies[$co].slug)/" }; return "/#/fondbolag/" + [uri]::EscapeDataString($co) }

# Gamla sidor tas bort så att aktier och fonder som försvunnit inte ligger kvar
foreach ($dir in @("aktie", "fond", "fondbolag", "aktier", "fonder", "og")) {
  $p = Join-Path $Site $dir
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# ---------- Delningsbilder ----------

$HasRsvg = [bool](Get-Command rsvg-convert -ErrorAction SilentlyContinue)
function FitSize($text, $size, $min, $maxW, $factor) {
  while ($size -gt $min -and $text.Length * $size * $factor -gt $maxW) { $size -= 2 }
  return $size
}
function Clip($text, $size, $maxW, $factor) {
  $max = [math]::Floor($maxW / ($size * $factor))
  if ($text.Length -le $max) { return $text }
  return $text.Substring(0, [math]::Max(1, $max - 1)).TrimEnd(" ", ",", "·") + "…"
}
function TextEl($x, $y, $size, $color, $text, $extra) {
  return '<text x="' + $x + '" y="' + $y + '" font-family="' + $FONT + '" font-size="' + $size + '" fill="' + $color + '"' + $extra + ">" + (Esc $text) + "</text>"
}

# stats: lista med @(etikett, värde, färg). bars: nettoköp per kvartal (eller $null). Annars en textrad.
function OgSvg($title, $sub, $stats, $label, $bars, $line) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">')
  [void]$sb.Append('<rect width="1200" height="630" fill="#ffffff"/><rect width="1200" height="8" fill="#1f6feb"/>')
  [void]$sb.Append('<g transform="translate(72,52)"><rect width="40" height="40" rx="8" fill="#1f6feb"/><rect x="7.5" y="20" width="5" height="12.5" fill="#fff"/><rect x="17.5" y="12.5" width="5" height="20" fill="#fff"/><rect x="27.5" y="7.5" width="5" height="25" fill="#fff"/></g>')
  [void]$sb.Append((TextEl 126 83 30 "#1f2328" "Fondinsyn" ' font-weight="700"'))
  [void]$sb.Append((TextEl 1128 83 26 "#0969da" "fondinsyn.se" ' font-weight="600" text-anchor="end"'))
  $ts = FitSize $title 64 40 1056 0.6
  [void]$sb.Append((TextEl 72 205 $ts "#1f2328" (Clip $title $ts 1056 0.6) ' font-weight="700"'))
  [void]$sb.Append((TextEl 72 255 28 "#59636e" (Clip $sub 28 1056 0.55) ""))
  for ($i = 0; $i -lt $stats.Count; $i++) {
    $x = 72 + $i * 352
    $v = [string]$stats[$i][1]
    $vs = FitSize $v 50 28 330 0.6
    [void]$sb.Append((TextEl $x 335 24 "#59636e" $stats[$i][0] ""))
    [void]$sb.Append((TextEl $x 392 $vs $stats[$i][2] $v ' font-weight="700"'))
  }
  [void]$sb.Append('<line x1="72" y1="432" x2="1128" y2="432" stroke="#d1d9e0" stroke-width="2"/>')
  [void]$sb.Append((TextEl 72 476 22 "#59636e" $label ""))
  if ($bars) {
    $pos = 0.0; $neg = 0.0
    foreach ($b in $bars) { if ($b -gt $pos) { $pos = $b }; if (-$b -gt $neg) { $neg = -$b } }
    $span = $pos + $neg
    if ($span -le 0) { $span = 1 }
    $top = 500; $h = 92
    $base = $top + $h * $pos / $span
    $slot = 1056 / $bars.Count
    $w = [math]::Round($slot * 0.62, 1)
    for ($i = 0; $i -lt $bars.Count; $i++) {
      $b = $bars[$i]
      $bh = [math]::Max([double]2, [math]::Abs($b) / $span * $h)
      if ($b -eq 0) { $bh = 0 }
      $x = [math]::Round(72 + $i * $slot + ($slot - $w) / 2, 1)
      $y = if ($b -ge 0) { $base - $bh } else { $base }
      $color = if ($b -ge 0) { "#1a7f37" } else { "#cf222e" }
      $op = if ($i -eq $bars.Count - 1) { "1" } else { "0.55" }
      [void]$sb.Append('<rect x="' + $x + '" y="' + [math]::Round($y, 1) + '" width="' + $w + '" height="' + [math]::Round($bh, 1) + '" rx="3" fill="' + $color + '" fill-opacity="' + $op + '"/>')
    }
    [void]$sb.Append('<line x1="72" y1="' + [math]::Round($base, 1) + '" x2="1128" y2="' + [math]::Round($base, 1) + '" stroke="#8c959f" stroke-width="1.5"/>')
  } elseif ($line) {
    [void]$sb.Append((TextEl 72 535 34 "#1f2328" (Clip $line 34 1056 0.56) ' font-weight="600"'))
  }
  [void]$sb.Append("</svg>")
  return $sb.ToString()
}
function FlowColor($v) { if ($null -eq $v) { return "#1f2328" }; if ($v -gt 0) { return "#1a7f37" }; if ($v -lt 0) { return "#cf222e" }; return "#1f2328" }
function Image($name, $svg) {
  Save "og/$name.svg" $svg
  if ($HasRsvg) { return "og/$name.png" }
  return "og/fondinsyn.png"
}

# ---------- Sidor ----------

$template = [System.IO.File]::ReadAllText((Join-Path $Site "index.html"), [System.Text.Encoding]::UTF8)
function TagOf($pattern) {
  $m = [regex]::Match($template, $pattern)
  if (-not $m.Success) { throw "Hittar inte $pattern i index.html" }
  return $m.Value
}
$tag = @{
  charset = TagOf '<meta charset="utf-8">'
  title = TagOf '<title>[^<]*</title>'
  desc = TagOf '<meta name="description" content="[^"]*">'
  ogTitle = TagOf '<meta property="og:title" content="[^"]*">'
  ogDesc = TagOf '<meta property="og:description" content="[^"]*">'
  ogUrl = TagOf '<meta property="og:url" content="[^"]*">'
  ogImage = TagOf '<meta property="og:image" content="[^"]*">'
  canon = TagOf '<link rel="canonical" href="[^"]*">'
  body = TagOf '<body>'
  main = TagOf '<main id="app" class="container" tabindex="-1"></main>'
}
$sitemap = NewList

# $rel: "aktie/volvo-b/" (sparas som index.html) eller ett filnamn som "404.html"
function Page($rel, $route, $title, $desc, $image, $content, [switch]$NoIndex) {
  $url = $BaseUrl + "/" + $(if ($rel.EndsWith("/")) { $rel } else { "" })
  $head = $tag.charset + "`n  <base href=`"/`">" + $(if ($NoIndex) { "`n  <meta name=`"robots`" content=`"noindex`">" } else { "" })
  $t = $template.Replace($tag.charset, $head)
  $t = $t.Replace($tag.title, "<title>" + (Esc $title) + "</title>")
  $t = $t.Replace($tag.desc, '<meta name="description" content="' + (Esc $desc) + '">')
  $t = $t.Replace($tag.ogTitle, '<meta property="og:title" content="' + (Esc $title) + '">')
  $t = $t.Replace($tag.ogDesc, '<meta property="og:description" content="' + (Esc $desc) + '">')
  $t = $t.Replace($tag.ogUrl, '<meta property="og:url" content="' + (Esc $url) + '">')
  $t = $t.Replace($tag.ogImage, '<meta property="og:image" content="' + (Esc ($BaseUrl + "/" + $image)) + '">')
  $t = $t.Replace($tag.canon, '<link rel="canonical" href="' + (Esc $url) + '">')
  if ($route) { $t = $t.Replace($tag.body, '<body data-route="' + (Esc $route) + '">') }
  $t = $t.Replace($tag.main, '<main id="app" class="container" tabindex="-1">' + $content + "</main>")
  if ($rel -eq "" -or $rel.EndsWith("/")) { Save ($rel + "index.html") $t } else { Save $rel $t }
  if (-not $NoIndex) { $script:sitemap.Add($url) }
}
function Source($appHref, $linkText) {
  return '<p class="desc section-gap">Källa: Finansinspektionens fondinnehav per kvartal, ' + $asOf + ". " + (A $appHref $linkText) + "</p>"
}
function ChangeText($h) {
  if (-not $h.f.both) { return "–" }
  if (-not $h.s1) { return '<span class="pos">Ny</span>' }
  $c = ($h.s2 - $h.s1) / $h.s1
  return Colored $c (PctChange $c)
}

# Aktier
foreach ($s in $pageStocks) {
  $holders = @($s.holders | Sort-Object v -Descending)
  $buys = @($s.trades | Where-Object { $_.d -gt 0 } | Sort-Object d -Descending | Select-Object -First 10)
  $sells = @($s.trades | Where-Object { $_.d -lt 0 } | Sort-Object d | Select-Object -First 10)
  $fundsText = Plural $s.f2 "svensk fond" "svenska fonder"

  $lead = "$($s.name) ägs av $fundsText med ett sammanlagt innehav på $(BigSek $s.val2) den $asOf."
  if ($null -ne $s.netFlow -and [math]::Abs($s.flow) -ge 1e6) {
    $lead += $(if ($s.flow -gt 0) { " Under $QL nettoköpte fonderna aktier för $(BigSek $s.flow)" } else { " Under $QL nettosålde fonderna aktier för $(BigSek (-$s.flow))" })
    $extra = @()
    if ($s.nNew) { $extra += (Plural $s.nNew "fond" "fonder") + " köpte in sig för första gången" }
    if ($s.nExit) { $extra += (Plural $s.nExit "fond" "fonder") + " sålde hela sitt innehav" }
    $lead += $(if ($extra.Count) { ", och " + (JoinSv $extra) + "." } else { "." })
  }
  if ($holders.Count) { $lead += " Största ägare är " + (JoinSv @($holders | Select-Object -First 3 | ForEach-Object { $_.f.name })) + "." }

  $metaParts = @((Esc $s.sector), $s.isin)
  if ($s.price) { $metaParts += "Kurs " + (Fmt $s.price 1) + " kr (" + $qMeta.curr + ")" }
  $flowText = if ($null -eq $s.netFlow) { "–" } else { Colored $s.flow (BigSek $s.flow -Sign) }

  $holderRows = NewList
  foreach ($h in ($holders | Select-Object -First 25)) { $holderRows.Add(@((A (FundUrl $h.f.id) $h.f.name), (Mkr $h.v), (ChangeText $h))) }
  $buyRows = NewList; foreach ($t in $buys) { $buyRows.Add(@((A (FundUrl $t.f.id) $t.f.name), (Colored $t.d (Mkr $t.d -Sign)))) }
  $sellRows = NewList; foreach ($t in $sells) { $sellRows.Add(@((A (FundUrl $t.f.id) $t.f.name), (Colored $t.d (Mkr $t.d -Sign)))) }

  $content = '<div class="page-head"><div class="crumbs"><a href="/aktier/">Aktier</a> / ' + (Esc $s.name) + '</div><div class="title-row"><h1>' + (Esc $s.name) + '</h1></div><p class="meta">' + ($metaParts -join " · ") + "</p></div>" +
    '<p class="lead">' + (Esc $lead) + "</p>" +
    '<dl class="figures">' + (Fig "Fonder som äger" (Num0 $s.f2)) + (Fig "Fondernas innehav" (BigSek $s.val2)) + (Fig "Nettoköp $QL" $flowText) +
    (Fig "Δ antal aktier" (Colored $s.chg (PctChange $s.chg))) + (Fig "Nya fonder" (Num0 $s.nNew)) + (Fig "Avvecklat" (Num0 $s.nExit)) + "</dl>" +
    (Block "Största fondägare" (Table @("Fond", "Innehav (mkr)", "Förändring") $holderRows) "section-gap") +
    '<div class="grid-2 section-gap">' + (Block "Köpte mest $QL" (Table @("Fond", "Netto (mkr)") $buyRows) "") + (Block "Sålde mest $QL" (Table @("Fond", "Netto (mkr)") $sellRows) "") + "</div>" +
    (Source "/#/aktie/$($s.isin)" "Visa historik sedan 2018 och alla affärer")

  $bars = FlowBars $s.isin
  $stats = @(@("Fonder som äger", (Num0 $s.f2), "#1f2328"), @("Fondernas innehav", (BigSek $s.val2), "#1f2328"),
    @("Nettoköp $QL", $(if ($null -eq $s.netFlow) { "–" } else { BigSek $s.flow -Sign }), (FlowColor $s.netFlow)))
  $svg = if ($bars) { OgSvg $s.name "$($s.sector) · svenska fonders ägande · $QL" $stats "Fondernas nettoköp per kvartal, senaste $($bars.Count) kvartalen" $bars $null }
         else { OgSvg $s.name "$($s.sector) · svenska fonders ägande · $QL" $stats "Största fondägare" $null (JoinSv @($holders | Select-Object -First 3 | ForEach-Object { $_.f.name })) }
  $img = Image "aktie-$($s.slug)" $svg

  Page "aktie/$($s.slug)/" "aktie/$($s.isin)" "$($s.name) – vilka fonder äger aktien? | Fondinsyn" `
    "$fundsText äger $($s.name) för $(BigSek $s.val2) ($asOf). Se vilka fonder som köper och säljer aktien, största ägare och historik sedan 2018." $img $content
}
Write-Host "  $($pageStocks.Count) aktiesidor"

# Fonder
foreach ($fi in $infos) {
  $m = $fi.m
  $held = if ($m) { @($m.rows | Where-Object { $_.s2 -gt 0 } | Sort-Object v -Descending) } else { @() }
  $trades = if ($m -and $m.both) { @($m.rows | Where-Object { $_.s1 -ne $_.s2 -and -not $_.s.isNew -and -not $_.s.isGone }) } else { @() }
  $buys = @($trades | Where-Object { $_.d -gt 0 } | Sort-Object d -Descending | Select-Object -First 10)
  $sells = @($trades | Where-Object { $_.d -lt 0 } | Sort-Object d | Select-Object -First 10)
  $top3 = @($held | Select-Object -First 3 | ForEach-Object { $_.s.name })
  $fee = FeeText $fi
  $seVal = if ($m) { $m.val } else { 0.0 }

  $lead = "$($fi.name) förvaltas av $($fi.co) och har en fondförmögenhet på $(BigSek $fi.aum). Förvaltningsavgiften är $fee."
  if ($held.Count) { $lead += " Fonden äger " + (Plural $held.Count "svensk aktie" "svenska aktier") + " för $(BigSek $seVal), störst är " + (JoinSv $top3) + "." }
  if ($buys.Count -and $sells.Count) { $lead += " Under $QL köpte fonden mest $($buys[0].s.name) och sålde mest $($sells[0].s.name)." }

  $heldRows = NewList
  foreach ($r in ($held | Select-Object -First 30)) {
    $chg = if (-not $m.both) { "–" } elseif (-not $r.s1) { '<span class="pos">Ny</span>' } else { $c = ($r.s2 - $r.s1) / $r.s1; Colored $c (PctChange $c) }
    $heldRows.Add(@((A (StockUrl $r.s) $r.s.name), (Mkr $r.v), (PctPlain ($r.v / [math]::Max([double]1, [double]$seVal) * 100)), $chg))
  }
  $buyRows = NewList; foreach ($t in $buys) { $buyRows.Add(@((A (StockUrl $t.s) $t.s.name), (Colored $t.d (Mkr $t.d -Sign)))) }
  $sellRows = NewList; foreach ($t in $sells) { $sellRows.Add(@((A (StockUrl $t.s) $t.s.name), (Colored $t.d (Mkr $t.d -Sign)))) }

  $content = '<div class="page-head"><div class="crumbs"><a href="/fonder/">Fonder</a> / ' + (A (CoUrl $fi.co) $fi.co) + " / " + (Esc $fi.name) + '</div><div class="title-row"><h1>' + (Esc $fi.name) + '</h1></div><p class="meta">' +
    (A (CoUrl $fi.co) $fi.co) + $(if ($fi.bench) { " · Jämförelseindex: " + (Esc $fi.bench) } else { "" }) + "</p></div>" +
    '<p class="lead">' + (Esc $lead) + "</p>" +
    '<dl class="figures">' + (Fig "Fondförmögenhet" (BigSek $fi.aum)) + (Fig "Förvaltningsavgift" $fee) + (Fig "Aktiv risk" (PctPlain $fi.ar)) +
    (Fig "Standardavvikelse" (PctPlain $fi.sd)) + (Fig "Svenska aktier" (BigSek $seVal)) + "</dl>"
  if ($held.Count) {
    $content += (Block "Svenska innehav" (Table @("Aktie", "Innehav (mkr)", "Andel", "Förändring") $heldRows) "section-gap")
    if ($m.both) { $content += '<div class="grid-2 section-gap">' + (Block "Köpt $QL" (Table @("Aktie", "Netto (mkr)") $buyRows) "") + (Block "Sålt $QL" (Table @("Aktie", "Netto (mkr)") $sellRows) "") + "</div>" }
  } else {
    $content += '<p class="desc">Fonden har inga svenska aktier i sin senaste rapport till Finansinspektionen.</p>'
  }
  $content += Source ("/#/fond/" + [uri]::EscapeDataString($fi.id)) "Visa utländska innehav, avkastning och jämförelser"

  $stats = @(@("Fondförmögenhet", (BigSek $fi.aum), "#1f2328"), @("Avgift", $fee, "#1f2328"), @("Svenska aktier", (BigSek $seVal), "#1f2328"))
  $svg = if ($top3.Count) { OgSvg $fi.name "$($fi.co) · $QL" $stats "Största svenska innehav" $null ($top3 -join " · ") }
         else { OgSvg $fi.name "$($fi.co) · $QL" $stats "Jämförelseindex" $null $(if ($fi.bench) { $fi.bench } else { "Saknas" }) }
  $img = Image "fond-$($fi.slug)" $svg

  Page "fond/$($fi.slug)/" ("fond/" + [uri]::EscapeDataString($fi.id)) "$($fi.name) – innehav, avgift och affärer | Fondinsyn" `
    "Vad äger $($fi.name)? Se fondens svenska innehav, vilka aktier den köpt och sålt under $QL, avgift ($fee) och fondförmögenhet ($(BigSek $fi.aum))." $img $content
}
Write-Host "  $($infos.Count) fondsidor"

# Fondbolag
foreach ($c in $coList) {
  $cf = @($c.funds | Sort-Object { [double]$(if ($_.aum) { $_.aum } else { 0 }) } -Descending)
  $agg = @{}
  foreach ($fi in $cf) {
    if (-not $fi.m) { continue }
    foreach ($r in $fi.m.rows) {
      if (-not $r.s2) { continue }
      if (-not $agg.ContainsKey($r.s.isin)) { $agg[$r.s.isin] = [pscustomobject]@{ s = $r.s; v = 0.0; n = 0 } }
      $agg[$r.s.isin].v += $r.v; $agg[$r.s.isin].n++
    }
  }
  $topStocks = @($agg.Values | Sort-Object v -Descending | Select-Object -First 15)
  $fee = CoFee $c

  $lead = "$($c.name) förvaltar " + (Plural $cf.Count "svensk värdepappersfond" "svenska värdepappersfonder") + " med en sammanlagd fondförmögenhet på $(BigSek $c.aum)."
  if ($c.feeBase) { $lead += " Snittavgiften, viktad efter fondernas storlek, är $fee." }
  if ($topStocks.Count) { $lead += " Fondernas största svenska innehav är " + (JoinSv @($topStocks | Select-Object -First 3 | ForEach-Object { $_.s.name })) + "." }

  $fundRows = NewList
  foreach ($fi in $cf) { $fundRows.Add(@((A (FundUrl $fi.id) $fi.name), (BigSek $fi.aum), (FeeText $fi))) }
  $stockRows = NewList
  foreach ($t in $topStocks) { $stockRows.Add(@((A (StockUrl $t.s) $t.s.name), (Mkr $t.v), (Num0 $t.n))) }

  $content = '<div class="page-head"><div class="crumbs"><a href="/fonder/">Fonder</a> / <a href="/fondbolag/">Fondbolag</a> / ' + (Esc $c.name) + '</div><div class="title-row"><h1>' + (Esc $c.name) + "</h1></div></div>" +
    '<p class="lead">' + (Esc $lead) + "</p>" +
    '<dl class="figures">' + (Fig "Fonder" (Num0 $cf.Count)) + (Fig "Fondförmögenhet" (BigSek $c.aum)) + (Fig "Snittavgift" $fee) + (Fig "Svenska aktier" (BigSek $c.se)) + "</dl>" +
    (Block "Fonder" (Table @("Fond", "Förmögenhet", "Avgift") $fundRows) "section-gap")
  if ($stockRows.Count) { $content += Block "Största svenska innehav" (Table @("Aktie", "Innehav (mkr)", "Fonder") $stockRows) "section-gap" }
  $content += Source ("/#/fondbolag/" + [uri]::EscapeDataString($c.name)) "Visa bolagets köp och sälj"

  $stats = @(@("Fonder", (Num0 $cf.Count), "#1f2328"), @("Fondförmögenhet", (BigSek $c.aum), "#1f2328"), @("Snittavgift", $fee, "#1f2328"))
  $svg = OgSvg $c.name "Fondbolag · $QL" $stats "Största fonder" $null (@($cf | Select-Object -First 3 | ForEach-Object { $_.name }) -join " · ")
  $img = Image "fondbolag-$($c.slug)" $svg

  Page "fondbolag/$($c.slug)/" ("fondbolag/" + [uri]::EscapeDataString($c.name)) "$($c.name) – fonder, avgifter och innehav | Fondinsyn" `
    "Alla $($cf.Count) fonder från $($c.name) med avgifter, fondförmögenhet och största innehav. Data från Finansinspektionen, $QL." $img $content
}
Write-Host "  $($coList.Count) fondbolagssidor"

# Standardbilden (startsidan och sidor utan egen bild)
$homeStats = @(@("Fonder", (Num0 $tFunds), "#1f2328"), @("Svenska aktier", (Num0 $tHeld), "#1f2328"), @("Nettoköp $QL", (BigSek $tNet -Sign), (FlowColor $tNet)))
$null = Image "fondinsyn" (OgSvg "Vad köper och säljer fonderna?" "Svenska fonders innehav, $QL" $homeStats "Öppen data från Finansinspektionen" $null "Innehav, köp och sälj, avgifter, blankning och uppköp")
$defaultImg = "og/fondinsyn.png"

# Översiktssidor med länkar till alla sidor
$rows = NewList
foreach ($s in @($pageStocks | Sort-Object val2 -Descending)) {
  $rows.Add(@((A (StockUrl $s) $s.name), (Num0 $s.f2), (Mkr $s.val2), $(if ($null -eq $s.netFlow) { "–" } else { Colored $s.flow (Mkr $s.flow -Sign) })))
}
Page "aktier/" "aktier" "Aktier som svenska fonder äger | Fondinsyn" "Alla $($pageStocks.Count) svenska aktier som fonderna äger, med antal fondägare, innehav och nettoköp under $QL." $defaultImg (
  '<div class="page-head"><h1>Aktier som svenska fonder äger</h1><p class="meta">' + $QL + ", innehav den " + $asOf + "</p></div>" +
  '<p class="lead">Här är alla svenska aktier som ägs av minst en svensk värdepappersfond, sorterade efter hur mycket fonderna äger. Nettoköp är förändringen i antal aktier gånger kursen vid kvartalets slut.</p>' +
  (Table @("Aktie", "Fonder", "Innehav (mkr)", "Nettoköp (mkr)") $rows))

$rows = NewList
foreach ($fi in @($infos | Sort-Object { [double]$(if ($_.aum) { $_.aum } else { 0 }) } -Descending)) {
  $rows.Add(@((A (FundUrl $fi.id) $fi.name), (A (CoUrl $fi.co) $fi.co), (BigSek $fi.aum), (FeeText $fi)))
}
Page "fonder/" "fonder" "Alla svenska fonder – innehav och avgifter | Fondinsyn" "Alla $($infos.Count) svenska värdepappersfonder med fondbolag, fondförmögenhet och avgift. Se vad varje fond äger och har köpt och sålt." $defaultImg (
  '<div class="page-head"><h1>Fonder</h1><p class="meta">' + $QL + ", innehav den " + $asOf + "</p></div>" +
  '<p class="lead">Alla svenska värdepappersfonder som rapporterar sina innehav till Finansinspektionen, sorterade efter fondförmögenhet.</p>' +
  (Table @("Fond", "Fondbolag", "Förmögenhet", "Avgift") $rows))

$rows = NewList
foreach ($c in @($coList | Sort-Object aum -Descending)) { $rows.Add(@((A (CoUrl $c.name) $c.name), (Num0 $c.funds.Count), (BigSek $c.aum), (CoFee $c))) }
Page "fondbolag/" "fondbolag" "Fondbolag – fonder, avgifter och innehav | Fondinsyn" "Alla $($coList.Count) fondbolag med svenska värdepappersfonder, med antal fonder, fondförmögenhet och snittavgift." $defaultImg (
  '<div class="page-head"><h1>Fondbolag</h1><p class="meta">' + $QL + "</p></div>" +
  '<p class="lead">Fondbolagen bakom de svenska värdepappersfonderna. Snittavgiften är viktad efter fondernas storlek.</p>' +
  (Table @("Fondbolag", "Fonder", "Förmögenhet", "Snittavgift") $rows))

# Startsidan och 404
$intro = '<p class="intro"><b>Fondinsyn</b> visar vilka aktier svenska fonder äger, köper och säljer. Alla fondbolag rapporterar varje kvartal ' +
  "sina fonders innehav till Finansinspektionen. Fondinsyn hämtar rapporterna automatiskt och räknar ut hur innehaven har förändrats, " +
  "per aktie, fond och fondbolag, med historik sedan 2018. Här finns också fondernas avgifter, blankning och uppköpsbud. " +
  "Siffrorna gäller innehaven den " + $asOf + " jämfört med " + (DateText $qMeta.prev) + '. <a href="/#/om">Om datan och metoden</a></p>'
if ($WriteHome) {
  $cont = @($pageStocks | Where-Object { $null -ne $_.netFlow -and $_.price })
  $rowsB = NewList; foreach ($s in @($cont | Where-Object { $_.flow -gt 0 } | Sort-Object flow -Descending | Select-Object -First 15)) { $rowsB.Add(@((A (StockUrl $s) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
  $rowsS = NewList; foreach ($s in @($cont | Where-Object { $_.flow -lt 0 } | Sort-Object flow | Select-Object -First 15)) { $rowsS.Add(@((A (StockUrl $s) $s.name), (Colored $s.flow (Mkr $s.flow -Sign)), (Num0 $s.f2))) }
  $homeContent = $intro + '<div class="grid-2 section-gap">' + (Block "Störst nettoköp $QL" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rowsB) "") +
    (Block "Störst nettosälj $QL" (Table @("Aktie", "Nettoköp (mkr)", "Fonder") $rowsS) "") + "</div>" +
    '<p class="desc section-gap"><a href="/aktier/">Alla aktier</a> · <a href="/fonder/">Alla fonder</a> · <a href="/fondbolag/">Alla fondbolag</a></p>'
  $homeTitle = [regex]::Match($tag.title, '<title>([^<]*)</title>').Groups[1].Value
  $homeDesc = [regex]::Match($tag.desc, 'content="([^"]*)"').Groups[1].Value
  Page "" "" ([System.Net.WebUtility]::HtmlDecode($homeTitle)) ([System.Net.WebUtility]::HtmlDecode($homeDesc)) $defaultImg $homeContent
} else {
  $sitemap.Add($BaseUrl + "/")
}
Page "404.html" "" "Sidan finns inte | Fondinsyn" "Sidan finns inte." $defaultImg '<div class="notice">Sidan finns inte längre. <a href="/">Till översikten</a></div>' -NoIndex

# ---------- Sitemap, robots.txt och adresslistan för Dela-knappen ----------

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('<?xml version="1.0" encoding="UTF-8"?>' + "`n" + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + "`n")
foreach ($u in ($sitemap | Sort-Object -Unique)) { [void]$sb.Append("<url><loc>" + (Esc $u) + "</loc><lastmod>" + $qMeta.built + "</lastmod></url>`n") }
[void]$sb.Append("</urlset>`n")
Save "sitemap.xml" $sb.ToString()
Save "robots.txt" ("User-agent: *`nAllow: /`n`nSitemap: $BaseUrl/sitemap.xml`n")

$map = @()
$map += '"aktie":{' + ((@($pageStocks | ForEach-Object { (J $_.isin) + ":" + (J $_.slug) })) -join ",") + "}"
$map += '"fond":{' + ((@($infos | ForEach-Object { (J $_.id) + ":" + (J $_.slug) })) -join ",") + "}"
$map += '"fondbolag":{' + ((@($coList | ForEach-Object { (J $_.name) + ":" + (J $_.slug) })) -join ",") + "}"
Save "data/pages.json" ("{" + ($map -join ",") + "}")
Write-Host "  sitemap med $($sitemap.Count) adresser"

# ---------- SVG till PNG ----------

if ($HasRsvg) {
  $svgs = @(Get-ChildItem (Join-Path $Site "og") -Filter *.svg | ForEach-Object { $_.FullName })
  Write-Host "  ritar $($svgs.Count) delningsbilder"
  if ($PSVersionTable.PSVersion.Major -ge 7) {
    $svgs | ForEach-Object -ThrottleLimit 8 -Parallel {
      & rsvg-convert -w 1200 -h 630 -b white -o ($_ -replace '\.svg$', '.png') $_
      if ($LASTEXITCODE -eq 0) { Remove-Item $_ }
    }
  } else {
    foreach ($p in $svgs) {
      & rsvg-convert -w 1200 -h 630 -b white -o ($p -replace '\.svg$', '.png') $p
      if ($LASTEXITCODE -eq 0) { Remove-Item $p }
    }
  }
  $left = @(Get-ChildItem (Join-Path $Site "og") -Filter *.svg).Count
  if ($left) { Write-Host "  varning: $left bilder kunde inte göras om till PNG" }
} else {
  Write-Host "  rsvg-convert saknas, delningsbilderna sparas bara som SVG"
}
Write-Host "Sidor klara."
