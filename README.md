# MOD/XM → YM2149 · SNDH · game stream

A browser tool that turns **ProTracker `.MOD`** and **FastTracker II `.XM`** modules into music for the
**Atari ST's YM2149** (one chip: 3 tone voices + noise, 50 Hz). Everything runs client-side — static files, no server.

**Status: milestone 1** — load → auto-convert → A/B listen → export.

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

## Loading .sndh and .ym

Besides modules the page loads **`.ym`** (YM2!/3!/3b/5!/6!, also LHA-packed) and **`.sndh`** (also ICE!-packed).
They are not converted: a `.ym` is read as the register dump it is, a `.sndh` is *run* in a built-in 68000 emulator
(init + play routine, YM writes captured per tick, resampled to 50 Hz, loop detected). You get the piano-roll view, the
YM preview and all exports (SNDH / YM5 / game kit / WAV / regs). SNDH subtunes and the rendered length can be chosen.
Limitation: tunes that need MFP timer interrupts *within* a frame (SID voice, sync-buzzer, digidrums) are captured at
frame granularity only. The emulator was checked against the Musashi core in `psgplay` (see `tools/verify`).

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
src/ui          React UI (FT2-flavoured skin), A/B audio
public/vendor   chiptune3 / libopenmpt (MIT / BSD) for the "original" side of the A/B switch
```

## Roadmap

* Instrument mapper (manual sample → waveform, per-tick sequences) and arpeggio generation
* FT2-style pattern editor for the AY data (from the *YM Tracker* project) with FT2 key layout
* Digidrums (also usable from games)
* Furnace `.fur`, Arkos Tracker `.aks`, Maxymiser `.MYS/.MYV/.MYI` export

Note: SNDH files made here play in any SNDH player but cannot be opened *in* Maxymiser (it only loads its own songs) —
that needs the native Maxymiser export on the roadmap.
