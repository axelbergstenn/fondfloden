<#
.SYNOPSIS
  Kontrollerar att den byggda datan ser rimlig ut innan sajten publiceras.

.DESCRIPTION
  Körs i GitHub Actions efter att datan byggts. Om något ser fel ut (till exempel att FI har ändrat
  format så att antalet fonder rasar) avbryts körningen innan något sparas eller publiceras. Sajten
  ligger då kvar med den senaste fungerande datan och GitHub skickar ett mejl om att körningen misslyckades.
#>
param([string]$DataDir = "site/data")

$ErrorActionPreference = "Stop"
$errors = New-Object System.Collections.Generic.List[string]
function Check($ok, $msg) { if (-not $ok) { $errors.Add($msg) } else { Write-Host "  ok: $msg" } }
function Load($name) {
  $p = Join-Path $DataDir $name
  if (-not (Test-Path $p)) { $errors.Add("$name saknas"); return $null }
  try { return Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $errors.Add("$name går inte att läsa: $($_.Exception.Message)"); return $null }
}

Write-Host "Kontrollerar data i $DataDir"
$index = Load "index.json"
if ($index) {
  $qs = @($index.quarters)
  Check ($qs.Count -ge 1) "index.json har kvartal ($($qs.Count))"
  $latest = $qs[0].id
  $q = Load "$latest.json"
  if ($q) {
    $withHoldings = @($q.funds).Count
    Check ($withHoldings -ge 200) "$latest har fonder med svenska aktier ($withHoldings, minst 200)"
    Check (@($q.stocks).Count -ge 400) "$latest har svenska aktier ($(@($q.stocks).Count), minst 400)"
    Check (@($q.fundInfo).Count -ge 500) "$latest har nyckeltal för fonder ($(@($q.fundInfo).Count), minst 500)"
    $priced = @($q.stocks | Where-Object { $_[3] -gt 0 }).Count
    Check ($priced / [math]::Max(1, @($q.stocks).Count) -ge 0.9) "$latest har kurs för minst 90 % av aktierna ($priced)"
    # Jämför med kvartalet innan: antalet fonder får inte rasa
    if ($qs.Count -ge 2) {
      $prev = Load "$($qs[1].id).json"
      if ($prev) {
        $ratio = $withHoldings / [math]::Max(1, @($prev.funds).Count)
        Check ($ratio -ge 0.7) ("antal fonder jämfört med {0} ({1:P0})" -f $qs[1].id, $ratio)
      }
    }
  }
  $world = Load "$latest-world.json"
  if ($world) { Check (@($world.stocks).Count -ge 1000) "$latest-world har utländska aktier ($(@($world.stocks).Count))" }
}

foreach ($h in @("history-se.json", "history-world.json")) {
  $hist = Load $h
  if ($hist) {
    Check (@($hist.quarters).Count -ge 8) "$h har kvartal ($(@($hist.quarters).Count))"
    Check (@($hist.stocks.PSObject.Properties).Count -ge 300) "$h har aktier ($(@($hist.stocks.PSObject.Properties).Count))"
  }
}

$offers = Load "offers.json"
if ($offers) { Check (@($offers.offers).Count -ge 10) "offers.json har bud ($(@($offers.offers).Count))" }

# Blankning är frivillig: FI:s server krånglar ibland. Finns filen ska den se rimlig ut.
$shortsPath = Join-Path $DataDir "shorts.json"
if (Test-Path $shortsPath) {
  $shorts = Load "shorts.json"
  if ($shorts) { Check (@($shorts.aggregate).Count -ge 100) "shorts.json har blankade bolag ($(@($shorts.aggregate).Count))" }
} else { Write-Host "  varning: shorts.json saknas, blankningssidan visar ett felmeddelande" }

if ($errors.Count) {
  Write-Host ""
  Write-Host "Datakontrollen hittade fel. Inget publiceras:"
  $errors | ForEach-Object { Write-Host "  FEL: $_" }
  exit 1
}
Write-Host "Datakontrollen godkänd."
