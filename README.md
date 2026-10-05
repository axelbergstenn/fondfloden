# Fondflöden

Vilka svenska aktier köper och säljer fonderna? Fondflöden jämför svenska fonders innehav kvartal för kvartal, baserat på [Finansinspektionens öppna data om fondinnehav](https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/).

## Struktur

```
site/                  Den statiska sajten (publiceras med GitHub Pages)
  index.html
  assets/app.js        All klientlogik, inga beroenden
  assets/style.css
  data/index.json      Lista över byggda kvartal
  data/2026Q2.json     Ett kvartal jämfört med kvartalet innan
scripts/
  build-data.ps1       Hämtar FI:s zip-filer och bygger site/data
  serve.ps1            Lokal webbserver för utveckling
.github/workflows/
  update.yml           Hämtar ny data varje måndag och publicerar sajten
```

## Utveckling

Bygg data (laddar ner det som saknas till `.cache/`):

```bash
pwsh scripts/build-data.ps1 -History 4
```

Starta en lokal server och öppna http://localhost:8765:

```bash
pwsh scripts/serve.ps1
```

Skripten fungerar även i Windows PowerShell 5.1 (`powershell -File ...`).

## Automatisk uppdatering

GitHub Actions kör `update.yml` varje måndag, vid varje push till `main` och manuellt via fliken Actions. Arbetsflödet:

1. Läser vilka kvartal FI har publicerat.
2. Bygger de fyra senaste kvartalen om de saknas eller om FI har publicerat nya versioner av källfilerna.
3. Committar ändrad data till repot.
4. Publicerar `site/` till GitHub Pages.

Äldre kvartal ligger kvar i `site/data/` och kan väljas på sajten.

## Metod

- Nettoköp = förändring i antal aktier × kurs vid senaste kvartalsslut.
- Endast fonder som rapporterat båda kvartalen ingår i förändringarna.
- Aktier som är nya eller har försvunnit helt ur fonderna (noteringar, avknoppningar, uppköp) redovisas separat.
- Aktiesplittar justeras när de flesta fonder visar samma förändringskvot.
- Endast aktier med svensk ISIN. Obligationer och fondandelar filtreras bort.
