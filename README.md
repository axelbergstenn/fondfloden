# Fondflöden

Vilka aktier köper och säljer fonderna? Fondflöden jämför svenska fonders innehav kvartal för kvartal, baserat på [Finansinspektionens öppna data om fondinnehav](https://www.fi.se/sv/vara-register/fondinnehav-per-kvartal/).

**Sajten:** https://axelbergstenn.github.io/fondfloden/

## Funktioner

- **Översikt** – mest köpta och sålda aktier, längsta köp- och säljsviter, nya och avvecklade innehav.
- **Aktier** – alla svenska eller utländska aktier som fonderna äger, med historik sedan 2018.
- **Fonder** – varje fonds affärer, avgift och aktiva risk.
- **Förvaltare** – vad Sveriges kända aktiva fonder har köpt och sålt, och var de är överens.
- **Avgifter** – aktiv risk mot avgift för alla aktiefonder, med indexnära fonder som tar ut höga avgifter.

## Struktur

```
site/                       Den statiska sajten (publiceras med GitHub Pages)
  index.html
  assets/app.js             Klientlogik, inga beroenden
  assets/charts.js          SVG-diagram
  assets/style.css
  data/index.json           Lista över byggda kvartal
  data/2026Q2.json          Svenska aktier, jämfört med kvartalet innan, + nyckeltal för alla fonder
  data/2026Q2-world.json    Utländska aktier
  data/history.json         Ägande och nettoköp per aktie för alla kvartal sedan 2018
scripts/
  build-data.ps1            Hämtar FI:s zip-filer och bygger site/data
  serve.ps1                 Lokal webbserver för utveckling
.github/workflows/
  update.yml                Hämtar ny data varje måndag och publicerar sajten
```

## Utveckling

Bygg data (laddar ner det som saknas till `.cache/`). Historiken läser alla kvartal, vilket tar en stund första gången:

```bash
pwsh scripts/build-data.ps1 -History 4
```

Snabbare lokalt test med bara två kvartal i historiken:

```bash
pwsh scripts/build-data.ps1 -History 1 -HistoryQuarters 2
```

Starta en lokal server och öppna http://localhost:8765:

```bash
pwsh scripts/serve.ps1
```

Skripten fungerar även i Windows PowerShell 5.1 (`powershell -File ...`).

## Automatisk uppdatering

GitHub Actions kör `update.yml` varje måndag, vid varje push till `main` och manuellt via fliken Actions. Arbetsflödet:

1. Läser vilka kvartal FI har publicerat.
2. Bygger de fyra senaste kvartalen och historiken om FI har publicerat nya versioner av källfilerna.
3. Committar ändrad data till repot.
4. Publicerar `site/` till GitHub Pages.

FI:s zip-filer cachas mellan körningar.

## Metod

- Nettoköp = förändring i antal aktier × kurs vid senaste kvartalsslut.
- Endast fonder som rapporterat båda kvartalen ingår i förändringarna.
- Aktier som är nya eller har försvunnit helt ur fonderna (noteringar, avknoppningar, uppköp) redovisas separat.
- Aktiesplittar upptäcks när minst tre fonder (och minst 15 %) har exakt samma förändringskvot långt från 1.
- Utländska aktier tas med när svenska fonder sammanlagt äger minst 20 mkr. Obligationer och fondandelar filtreras bort.
- Indexnära med hög avgift: aktiefond med aktiv risk under 3 % och förvaltningsavgift på minst 0,7 %.
