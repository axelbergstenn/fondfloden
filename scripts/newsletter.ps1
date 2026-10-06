<#
.SYNOPSIS
  Skapar ett utkast till kvartalets nyhetsbrev hos Buttondown när ett nytt kvartal har byggts.

.DESCRIPTION
  Körs i GitHub Actions efter build-data.ps1. Om miljövariabeln BUTTONDOWN_API_KEY finns och det senaste
  kvartalet inte redan har fått ett utkast skapas ett mejl med status "draft" hos Buttondown. Utkastet
  skickas aldrig automatiskt: du granskar och skickar det själv i Buttondown.

  Vilka kvartal som fått utkast sparas i site/data/newsletter.json.
#>
param(
  [string]$DataDir = "site/data",
  [string]$SiteUrl = "https://www.fondinsyn.se/"
)

$ErrorActionPreference = "Stop"
$key = $env:BUTTONDOWN_API_KEY
if (-not $key) { Write-Host "Nyhetsbrev: ingen BUTTONDOWN_API_KEY, hoppar över."; return }

$index = Get-Content (Join-Path $DataDir "index.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$q = $index.quarters[0]
$logFile = Join-Path $DataDir "newsletter.json"
$log = if (Test-Path $logFile) { Get-Content $logFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{ drafts = @() } }
if (@($log.drafts) -contains $q.id) { Write-Host "Nyhetsbrev: utkast för $($q.id) finns redan."; return }

function QLabel($id) { "Q" + $id.Substring(5) + " " + $id.Substring(0, 4) }
function Mdkr($v) {
  $sv = [System.Globalization.CultureInfo]::GetCultureInfo("sv-SE")
  $s = if ([math]::Abs($v) -ge 1e9) { ($v / 1e9).ToString("0.0", $sv) + " mdkr" } else { ($v / 1e6).ToString("0", $sv) + " mkr" }
  if ($v -gt 0) { "+" + $s } else { $s.Replace("-", "−") }
}

# Nettoköp per aktie bland fonder som rapporterat båda kvartalen (samma metod som på sajten)
$d = Get-Content (Join-Path $DataDir ($q.id + ".json")) -Raw -Encoding UTF8 | ConvertFrom-Json
$n = $d.stocks.Count
$flow = New-Object double[] $n; $h1 = New-Object double[] $n; $h2 = New-Object double[] $n
foreach ($f in $d.funds) {
  if ($null -eq $f[4] -or $null -eq $f[5]) { continue }
  foreach ($r in $f[6]) {
    $k = [int]$r[0]; $s1 = [double]$r[1]; $s2 = [double]$r[2]
    $flow[$k] += ($s2 - $s1) * [double]$d.stocks[$k][3]
    $h1[$k] += $s1; $h2[$k] += $s2
  }
}
$rows = for ($k = 0; $k -lt $n; $k++) {
  if ($h1[$k] -gt 0 -and $h2[$k] -gt 0 -and $d.stocks[$k][3]) { [pscustomobject]@{ Name = $d.stocks[$k][1]; Isin = $d.stocks[$k][0]; Flow = $flow[$k] } }
}
$buys = @($rows | Sort-Object Flow -Descending | Select-Object -First 5)
$sells = @($rows | Sort-Object Flow | Select-Object -First 5)
$net = ($rows | Measure-Object Flow -Sum).Sum

$ql = QLabel $q.id
$lines = @()
$lines += "Ny fonddata från Finansinspektionen: så här handlade svenska fonder med svenska aktier under $ql, jämfört med $(QLabel $q.prevId)."
$lines += ""
$lines += "Totalt **$(if ($net -ge 0) { 'nettoköpte' } else { 'nettosålde' }) fonderna för $((Mdkr ([math]::Abs($net))).TrimStart('+'))**."
$lines += ""
$lines += "## Mest köpta"
$i = 1; foreach ($b in $buys) { $lines += "$i. [$($b.Name)]($($SiteUrl)#/aktie/$($b.Isin)) $(Mdkr $b.Flow)"; $i++ }
$lines += ""
$lines += "## Mest sålda"
$i = 1; foreach ($s in $sells) { $lines += "$i. [$($s.Name)]($($SiteUrl)#/aktie/$($s.Isin)) $(Mdkr $s.Flow)"; $i++ }
$lines += ""
$lines += "**[Läs hela kvartalsrapporten]($($SiteUrl)#/rapport)**: sektorrotation, köpsviter, kända förvaltare, uppköp och avgifter."
$lines += ""
$lines += "_Fondinsyn bygger på Finansinspektionens öppna data. Inte investeringsrådgivning._"

$body = @{ subject = "Fondinsyn $($ql): det här köpte och sålde fonderna"; body = ($lines -join "`n"); status = "draft"
  # Bara till dem som anmält sig till nyhetsbrevet (inte till dem som bara bevakar en aktie)
  filters = @{ predicate = "and"; groups = @(); filters = @(@{ operator = "contains"; field = "subscriber.tags"; value = "nyhetsbrev" }) } } | ConvertTo-Json -Depth 6 -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Method Post -Uri "https://api.buttondown.com/v1/emails" -Headers @{ Authorization = "Token $key" } -ContentType "application/json; charset=utf-8" -Body $bytes | Out-Null
Write-Host "Nyhetsbrev: utkast för $($q.id) skapat hos Buttondown."

$drafts = @($log.drafts) + $q.id
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path $DataDir) "newsletter.json"), (@{ drafts = $drafts } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
