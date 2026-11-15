# Changelog

## 0.8.2 — 2026-11-15

### Changed
- *Demo: Omar's Bazaar* loads with *Percussion as digidrums* on (the conversion, its exports and *Edit as AY patterns* get the digidrum channel).

## 0.8.1 — 2026-11-15

### Added
- **AY touches in *Edit as AY patterns*** (same options and the converter's lead channel): chorus / echo of the lead as notes on free voices (chorus: `E1x` fine slide for the detune, half the volume; echo: the lead's notes N frames later, a quarter of the volume, with key-offs where the voice is needed again); the lead sound as `S` / `Q` on the lead's notes (timer at twice the note frequency, sinus-SID handed to the bass above ~310 Hz, `S00` / `Q00` when it moves to another voice); soft starts (-4 / -2 levels) and a 4-frame release in the tonal step tables. A lead note that holds one `0xy` all along gets an instrument copy with that arpeggio as its macro, freeing the effect column.

## 0.8.0 — 2026-11-15

### Added
- **Echo / delay channel detection** (`src/core/echo.ts`): per channel the note starts are compared with every other channel's at the delay with the most notes in common; a channel whose notes are mostly copies (60 %+) of another's at one delay is an echo. Shown as *echo of ch X, N rows later* in *Source channels* and *Manual import…*; echo channels get the priority *Low* on load, *Suggest* and *Reset to auto*.
- **AY touches** (converter options, saved with the mapping), after MmcM / Scavenger:
  - *Free voices*: chorus (the lead a few cents higher, at least one period step, 2 levels quieter) or echo (the lead again N frames later, 4 levels quieter) on voices nobody needs.
  - *Lead sound*: sinus-SID (soft; up to ~310 Hz, else on the bass) or SID voice (filter sweep) on the lead voice, as a timer-effect track (SNDH / YM6 / game kit). The timer runs at twice the note frequency (both effects modulate at half the timer rate).
  - *Soft note starts and ends*: melodic notes start 4 / 2 levels down and fade out over a few frames on a voice that stays free.

## 0.7.0 — 2026-11-15

### Changed
- **Edit as AY patterns follows the conversion much more closely** (measured on F-Zero SPCs and Omar's Bazaar: spectrogram correlation with the converter output 0.86–0.99 → 0.98–0.99).
  - Note starts are found from the note age going down, not from tick 0: at high tempos (SPC files: 250 BPM, speed 2) the first 50 Hz frame of a note is its tick 1, so notes were never retriggered.
  - Tonal instruments get their level steps from the played notes (sample x volume envelope x volume changes, 90th percentile over the notes) instead of the raw sample: XM volume envelopes and SNES ADSR come along.
  - The volume column is set closed-loop against the instrument step the voice is at, and pitch follows the source closed-loop with `1xx` / `2xx` (one-tick rows: `E1x` / `E2x`) instead of copying the source's slides.
  - Drums: digidrums only when *Percussion as digidrums* is on (as in the converter); a percussion sample that cannot become a digidrum falls back to a drum macro instead of going silent.
- The converter counts note ages in frames as well (drum macros and step tables at high tempos).

### Added
- **Replace…** in the editor's instrument panel: a preset sound or another instrument's sound into the slot, or the instrument's notes moved to another instrument (block / track / pattern / song).
- **Arpeggios…** in the editor: every `0xy` arpeggio and instrument chord ornament with its chord name; *Major ↔ minor* (inversions kept) or custom notes.

### Fixed
- Whole-song *Transpose* / *Scale volume* applied twice to a pattern that appears twice in the order.

## 0.6.0 — 2026-11-13

### Added
- **SPC loop point.** The key-on events are searched for a period (same voice, sample and pitch, within a timer tick); once the music has repeated for a whole loop and at least 30 s, the recording stops. The module ends at the loop end and restarts at the loop start (a new pattern starts there), so the YM, SNDH and game-kit exports loop like the game. The preview loops both sides there. A jingle that ends (20 s without a new note) stops the search early and takes the *Seconds* length. *Loop* checkbox in the SNES SPC panel.
- **Echo channels.** The DSP echo (EDL delay, EVOL x FIR level, EON voices) becomes one extra channel per echoed voice: a delayed copy at the level of the first repeat, priority *Low* by default. *Echo notes* checkbox.
- **Rows per step.** The note grid is measured from the key-on times (least-squares fit, 64–250 ms steps); one row per step at 125 BPM, the speed of each row follows the grid (Fxx where it changes), notes off the grid get `EDx`, the DSP envelope of each instrument becomes an XM volume envelope, and level and pitch changes inside a row become volume-column slides, `Axy` and `1xx`/`2xx`. *Rows* choice (default: one per frame).
- **Voice mute** in the SNES SPC panel (also mutes the voice in the original preview).

### Fixed
- A note delay (`EDx`) applies the volume column on the delayed tick (FastTracker 2 behaviour); it was overwritten by the sample volume.

## 0.5.0 — 2026-11-13

### Added
- **SNES SPC import.** `.spc` files (SPC700 state snapshots) load like a module. A built-in SPC700 CPU + S-DSP emulator (BRR decoding, Gaussian interpolation, ADSR / GAIN, noise, echo, timers) replays the tune; every BRR sample becomes an instrument, every voice a channel, and the result goes through the normal converter, *Manual import…*, exports and *Edit as AY patterns →*. Pitch is tracked at 50 Hz with fine slides; sample pitch is measured from the BRR loop; noise-enabled voices become noise instruments.
- **SNES SPC panel** with *Start*, *Seconds* (default: the ID666 length, else 120 s) and *Echo*, plus warnings for echo, pitch modulation, out-of-range notes and dropped instruments (max 128 instruments).
- **Original side of the preview** for SPC files is the emulator's own 32 kHz stereo render, so it works without libopenmpt and from `file://`.
- Checked against the snes_spc reference on 17 F-Zero SPCs (RMS within 0.2 %); `tests/spc.test.ts` covers the emulator, module conversion and the converter with a synthetic SPC.

### Limits
- `.sfc` / `.smc` ROMs are not supported (use a ripped `.spc`). Echo and pitch modulation are not reproduced in the YM version. The SPC loop point is not detected.

## 0.4.0 — 2026-10-14

### Added
- **SNDH / YM → AY patterns.** A loaded `.sndh` or `.ym` can be opened in the pattern editor (*Edit as AY patterns →*, or *Load .sndh/.ym…* in the editor). The row tempo, notes, step-table instruments, digidrums and `Q S U` timer effects are recovered from the register dump; the loop frame becomes the restart position; an *Import report* lists what was found. Up to 255 instruments (similar ones are merged).
- **STe DMA sound in SNDH files.** The 68000 emulator now presents an STe (cookie jar with `_MCH` / `_SND`, GEMDOS `Malloc` / `Mxalloc` / `Mfree`, microwire handshake), logs DMA sample starts and turns each distinct sample into a 4-bit digidrum hit on voice C. A *STe samples* checkbox in the *Loaded tune* panel turns it off. Regression fixture: maxYMiser's `TEST_STE.SND`.
- **XM with the Amiga frequency table** (header flag bit 0 clear) loads and converts; slides, vibrato, arpeggio and the instrument auto-vibrato work on periods like FastTracker 2 does in that mode.
- The SNDH importer reports the address where an init routine is stuck.
- GoatCounter page-view counter (`qumran.goatcounter.com`) on the app and the Help page; the privacy notes in the docs say so.
- Documentation: a *What's new in 0.4* section, XM frequency tables in the specifications, new troubleshooting entries.

### Changed
- Note keys audition the selected instrument from anywhere in the pattern editor (instrument list, instrument editor, sliders, checkboxes, dropdowns); only fields that take typed text keep their keys.

### Fixed
- A player that allocates a sample buffer no longer overwrites low memory in the SNDH emulator (it used to corrupt the cookie area and skip hardware set-up).

## 0.3.0

- Documentation: manual, how-to, effects reference, tooltip list, architecture and specifications (Help link, single-file `docs/index.html`).
- Manual import dialog: per-channel priority, solo, *Full preview*, click-to-seek on every channel's activity graph, instrument renaming, *Suggest*.
- Automatic drum channel in *Edit as AY patterns*; Arkos Tracker 3 export and import; Furnace export; demo song *Omar's Bazaar*; stable pattern-view layout.
