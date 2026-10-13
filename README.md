# MOD/XM → YM2149 · SNDH · game stream

A browser tool that turns **ProTracker `.MOD`** and **FastTracker II `.XM`** modules into music for the
**Atari ST's YM2149** (one chip: 3 tone voices + noise, 50 Hz). Everything runs client-side — static files, no server.

**Status:** load → auto-convert → A/B listen → export, plus an FT2-style AY pattern editor.

## What you get today

| Export | What it is |
|---|---|
| **SNDH** (`.sndh`) | Header + a 220-byte position-independent 68000 player + packed register stream. Timer C 50 Hz (`TC50`). Verified bit-exact in an emulated 68000 (psgplay) incl. loop wrap-around. |
| **YM** (`.ym`) | `YM5!` uncompressed register dump (loads in ST-Sound and friends). |
| **Game kit** (`.zip`) | `<name>.h` (packed stream as a C array) + `ymplay.h` (30-line replayer). The game owns the PSG, so sound effects can steal a voice. |
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
Limitation: tunes that need MFP timer interrupts *within* a frame (SID voice, sync-buzzer, digidrums) are captured at
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

Limits worth knowing: `Z` (digidrum), `Q` / `S` / `U` (timer effects) and a drum channel are stored but **not rendered yet**;
vibrato depth in `.ymt` tops out at about ±7 period units, so converted vibrato is approximate; a `.ymt` holds at most 255
patterns and 255 instruments.

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
npm run build:player # re-assemble src/player68k/player.s (needs m68k-linux-gnu-as + objcopy)
npx tsx scripts/export-cli.ts song.mod out/   # same exporters from the command line
```

### Verification

* `tests/convert.test.ts` — the TypeScript converter reproduces the original Python reference dump of `OLGIENG.XM`
  **frame for frame** (`tools/reference/` holds the Python oracle).
* `tools/verify/sndh_check.py` — runs an `.sndh` in [psgplay](https://github.com/frno7/psgplay)'s 68000 core and compares
  every YM register write against the `.regs` dump (`scripts/synth-loop.ts` builds a looping test song).
* Perceptual check: chroma similarity against libopenmpt renders ≈ 0.95 (XM) / 0.95 (MOD).

### Layout

```
src/core        module loaders, tracker replayer, AY converter
src/export      stream packer, YM5, SNDH, C header + replayer, YM emulator (preview), WAV, ZIP
src/player68k   68000 SNDH player (player.s → blob.ts)
src/tracker     pattern song model, renderer (tick player), module -> patterns, editor store, .ymt IO
src/ui          React UI (FT2-flavoured skin), converter tab, pattern editor tab, A/B audio
public/vendor   chiptune3 / libopenmpt (MIT / BSD) for the "original" side of the A/B switch
```

## Roadmap

* Mapper follow-ups: sample → waveform (square duty/buzzer envelope), saving a mapping with the project
* Digidrums: `Z` / `Q` / `S` / `U` rendering, a drum channel, an in-game digidrum API
* Furnace `.fur`, Arkos Tracker `.aks`, Maxymiser `.MYS/.MYV/.MYI` export

Note: SNDH files made here play in any SNDH player but cannot be opened *in* Maxymiser (it only loads its own songs) —
that needs the native Maxymiser export on the roadmap.
