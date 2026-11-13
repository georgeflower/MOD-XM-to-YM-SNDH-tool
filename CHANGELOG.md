# Changelog

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
