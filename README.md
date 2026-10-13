# MOD/XM → YM2149 · SNDH · game stream

A browser tool that turns **ProTracker `.MOD`** and **FastTracker II `.XM`** modules into music for the
**Atari ST's YM2149** (one chip: 3 tone voices + noise, 50 Hz). Everything runs client-side — static files, no server.

**Status:** load → auto-convert → A/B listen → export, plus an FT2-style AY pattern editor.

## What you get today

| Export | What it is |
|---|---|
| **SNDH** (`.sndh`) | Header + a position-independent 68000 player (≈0.8 KB, includes the digidrum engine) + packed register stream (+ digidrum table). Timer C 50 Hz (`TC50`). Verified bit-exact in an emulated 68000 (psgplay) incl. loop wrap-around and digidrum sample values. |
| **YM** (`.ym`) | `YM5!` uncompressed register dump; `YM6!` with digidrums when the song has any (loads in ST-Sound and friends). |
| **Game kit** (`.zip`) | `<name>.h` (packed stream as a C array, + digidrum table) + `ymplay.h` (small replayer; with digidrums also the 68000 drum engine). The game owns the PSG, so sound effects can steal a voice. |
| Raw regs / WAV / report | 14 bytes per frame; YM emulator preview; conversion log. |

How the conversion works: the module is replayed tick-accurately (all XM/MOD effects, envelopes, auto-vibrato,
loop detection) into per-frame channel states; sample pitch is measured from the waveform's cycle length, drum-like
samples become kick/snare/hat macros (falling tone / noise bursts), and every 20 ms the 3 most important events win a
voice (stickiness avoids voice jumping, one noise generator is shared, volumes map to the YM's ≈3 dB steps).

## Instrument mapper and arpeggio fill

* Per source instrument: **auto** (tone at the measured pitch, or a drum macro), **tone** (written note's pitch, volume
  follows the sample), **kick / snare / hat**, **custom macro**, **mute**, plus a semitone transpose.
* A **macro** is a per-tick (20 ms) table: volume 0–15, pitch offset in semitones (fractional → vibrato), noise period,
  tone on/off, loop-from step, optional "follow note volume". Presets: pluck, organ, vibrato lead, bass thump, tom,
  hat, snare, major/minor arpeggio.
* **Arp fill**: a module has more channels than the YM has voices. With fill on, notes that would be dropped are folded
  into a 2- or 3-note arpeggio on the voice with the closest pitch (alternating every frame). The strip under the roll
  shows dropped notes (red) and arpeggio notes (cyan); the channel table lists the shares.

## Loading .sndh and .ym

Besides modules the page loads **`.ym`** (YM2!/3!/3b/5!/6!, also LHA-packed) and **`.sndh`** (also ICE!-packed).
They are not converted: a `.ym` is read as the register dump it is, a `.sndh` is *run* in a built-in 68000 emulator
(init + play routine, YM writes captured per tick, resampled to 50 Hz, loop detected). You get the piano-roll view, the
YM preview and all exports (SNDH / YM5 / game kit / WAV / regs). SNDH subtunes and the rendered length can be chosen.
`.ym` files with YM5/YM6 digidrums are imported with their samples and play (and re-export) correctly. Limitation: an `.sndh` that needs MFP timer interrupts *within* a frame (SID voice, sync-buzzer, digidrums) is captured at
frame granularity only. The emulator was checked against the Musashi core in `psgplay` (see `tools/verify`).

## AY pattern editor

The second tab is a FastTracker 2-style editor for **one YM2149** (three channels, 50 Hz), based on the
[YM Tracker](https://github.com/georgeflower/st-tune-master) data model: same cells (note, instrument, volume column, effect,
parameter), same effect letters, same `.ymt` song files in both directions.

* **Start** from scratch (*New*), load a `.ymt`, or press **Edit as AY patterns →** in the converter: the module is turned into
  patterns with row-level voice allocation, step-table instruments, arpeggios folded into `0xy`, `Fxx` speed changes for exact
  row timing and slides/vibrato translated by pitch ratio. The conversion report is kept above the editor.
* **Keys** are the FT2 / YM Tracker ones. Notes `Z S X D C V G B H N J M , L .` and `Q 2 W 3 E R 5 T 6 Y 7 U I 9 O`, `F1–F8`
  octave, `Space` stop / toggle Edit, `Right Ctrl` play song, `Right Alt` play pattern, `Right Shift` record pattern,
  `Caps Lock` or `1` note off, `` ` `` / `§` cycles the Add step, `Shift+←/→` song position, `Ctrl+←/→` pattern number,
  `Alt+arrows` block select, `Del` variants, `Insert` / `Backspace`, `Shift` / `Ctrl+Shift` / `Alt` + `F3 F4 F5`
  cut / copy / paste of track / pattern / block, `Ctrl` / `Alt` / `Shift` + `V` scale volume. Extra: `Ctrl+Z` / `Ctrl+Y` undo / redo,
  `Ctrl+S` save, mouse click / drag / `Shift+click` for cursor and selection. The *Keyboard reference* at the bottom of the tab lists them all.
* A status line explains the effect under the cursor (arpeggio notes, slide size, speed / tempo, digidrum…).
* **Instruments** are either the YM Tracker's classic ADSR / envelope / hardware-envelope kind, or a **step table**
  (this tool's extension): volume, pitch offset, noise and tone for every 20 ms tick, drawn with the mouse.
  The YM Tracker ignores the step tables, so such songs still load there with plain default instruments.
* The editor plays through a register-level emulation of the chip (including the hardware envelope) and exports the same
  formats as the converter: **SNDH, YM, game kit, WAV, raw registers**.

Limits worth knowing: `Q` / `S` / `U` (timer effects) are stored but **not rendered yet**;
vibrato depth in `.ymt` tops out at about ±7 period units, so converted vibrato is approximate; a `.ymt` holds at most 255
patterns and 255 instruments.

## Digidrums

A digidrum is a short **4-bit sample** that the ST plays by writing a voice's volume register from an MFP **Timer D** interrupt
(8 kHz and up). While it plays that voice carries the sample (tone and noise off), and **one drum plays at a time**: a new drum cuts the old one.

* **In the editor.** Each instrument can carry a bank of drums (*Drums…* in the instrument panel: load WAV files, add the
  synthesised starter kit, kick / snare / hat / tom / clap presets, rate, gain, normalise, noise shaping, waveform, audition).
  Play one with **`Z0n`** on a tone channel (drum *n* of that cell's instrument on that voice), or tick **Drum channel**:
  a fourth column where a note picks the drum (keys `Z S X D …` = drum 1, 2, 3 …) and plays it on voice C; `===` stops it.
* **In the converter.** *Percussion as digidrums* plays every non-tonal instrument as its own sample (resampled to 4 kHz–16 kHz,
  one table entry per pitch and volume class, ≤ 63) instead of a noise / tone macro; per instrument you can force **digidrum**.
  The frame converter hands voice C to the sample while it plays; *Edit as AY patterns* builds the drum column and a
  *Digidrums* bank instrument. Quieter hits get their own −6 / −12 dB variant (a digidrum cannot change level per hit).
* **Exports.** SNDH (engine + table inside the file), YM6 (ST-Sound convention, max 32 drums, drums on other voices may overlap
  there), game kit (`ymdrum_init(song_drums)`, `ymplay_step(); ymplay_write();` in supervisor mode — read the comment at the top of
  `ymplay.h`; it takes Timer D, vector `$110`, IPL 6), WAV preview, `.ymt` (samples stored 4-bit packed).
* **Verification.** The 68000 engine runs in psgplay: sample values, rate (7989 Hz for 8 kHz requested), voice, cut by a
  new drum, stop, loops; the generated game-kit C code compiles with `m68k-linux-gnu-gcc` and runs the same way
  (`tools/verify/gamekit_check.sh`).

## Using it

1. Open the page, **Load MOD / XM / SNDH / YM…** (or drop a file anywhere) — or press **Demo**.
2. **Tab** flips between the original (libopenmpt) and the YM version, **Space** plays/stops.
3. Tweak *Level / Drum priority / Voice stickiness / Arpeggio order*, per-instrument **AY role** (kick/snare/hat) and
   per-channel **priority**; the preview re-renders automatically.
4. Export.

## Develop

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # parity + export tests (needs gcc for the C replayer test)
npm run build        # static site in dist/ (relative paths: works from any sub-folder, e.g. Nekoweb)
npm run build:player # re-assemble src/player68k/player.s + gamedrum.s (needs m68k-linux-gnu-as + objcopy + nm)
npx tsx scripts/export-cli.ts song.mod out/   # same exporters from the command line
```

### Verification

* `tests/convert.test.ts` — the TypeScript converter reproduces the original Python reference dump of `OLGIENG.XM`
  **frame for frame** (`tools/reference/` holds the Python oracle).
* `tools/verify/sndh_check.py` — runs an `.sndh` in [psgplay](https://github.com/frno7/psgplay)'s 68000 core and compares
  every YM register write against the `.regs` dump (`scripts/synth-loop.ts` builds a looping test song).
* `tools/verify/gamekit_check.sh` — generates a game kit for a drum test song, compiles `ymplay.h` for the 68000, wraps it in an SNDH and runs it in psgplay.
* Perceptual check: chroma similarity against libopenmpt renders ≈ 0.95 (XM) / 0.95 (MOD).

### Layout

```
src/core        module loaders, tracker replayer, AY converter, digidrum samples (drums.ts, digi.ts)
src/export      stream packer, YM5/YM6, SNDH, game kit, C header + replayer, YM emulator (preview), WAV, ZIP
src/player68k   68000 SNDH player + digidrum engine (player.s, drumeng.s, gamedrum.s → blob.ts)
src/tracker     pattern song model, renderer (tick player), module -> patterns, editor store, .ymt IO
src/ui          React UI (FT2-flavoured skin), converter tab, pattern editor tab, A/B audio
public/vendor   chiptune3 / libopenmpt (MIT / BSD) for the "original" side of the A/B switch
```

## Roadmap

* Mapper follow-ups: sample → waveform (square duty/buzzer envelope), saving a mapping with the project
* Timer effects `Q` / `S` / `U` (SID voice, sync buzzer); extracting digidrums from SNDH files
* Furnace `.fur`, Arkos Tracker `.aks`, Maxymiser `.MYS/.MYV/.MYI` export

Note: SNDH files made here play in any SNDH player but cannot be opened *in* Maxymiser (it only loads its own songs) —
that needs the native Maxymiser export on the roadmap.
