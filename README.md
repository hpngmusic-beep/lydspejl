# Lydspejl

Stereo- og spektralmonitor, der kører i browseren. Den analyserer den lyd, der spiller på computeren (YouTube, browser, systemlyd eller en loopback-enhed), og viser:

- **Lissajous/goniometer (M/S eller X/Y)** som farvekodet heatmap pr. frekvensbånd: blandet farve, dominant bånd eller ren heat
- **Stereo-ellipser pr. bånd** (2σ) til at se bredde, retning og faseproblemer
- **Spektrum** (L/R, Mid/Side eller sum) med hældning, peak hold og frekvens-/toneaflæsning. Båndkanterne kan trækkes direkte i spektret
- **Spektrogram**
- **Niveau** (sample peak og RMS), **korrelation** og **balance**
- **Loudness efter ITU-R BS.1770 / EBU R128**: momentary, short-term, integreret, LRA, true peak (4x oversampling), PLR og afstand til et valgfrit mål
- **Frekvensbånd** med forvalg (mix, 3-bånd, oktaver, tale, bund, rumlig lokalisering), egne grænser, farver, solo og LR4/LR8-crossovers. Pr. bånd vises niveau, korrelation, balance og bredde

## Start

Åbn `https://hpngmusic-beep.github.io/lydspejl/` i Chrome. Vælg **Installér som app**, så får den sit eget vindue og ikon i Dock.

Ved opstart står appen i **standby**. Vælg en kilde, og så snart der kommer lyd, spørger den: *"Der er lyd. Vil du analysere?"*

### Kilder
1. **Browserfane**: Vælg *Chrome-fane* og slå *Del lyd* til.
2. **Al systemlyd**: Kræver Chrome 141+ og macOS 14.2+. Vælg *Hele skærmen* og slå *Del systemlyd* til.
3. **Loopback (BlackHole 2ch)**: Opret en enhed med flere udgange (højttalere + BlackHole) i Lyd-MIDI-opsætning, og vælg BlackHole i Lydspejl. Med *Start automatisk* begynder appen selv at lytte, når den åbnes.

Taster: mellemrum = frys · F = fuld skærm · 1–9 = solo bånd · 0 = alle.

Al analyse sker lokalt. Ingen lyd forlader computeren.
