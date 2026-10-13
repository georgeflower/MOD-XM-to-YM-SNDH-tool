# Architecture {#architecture}

## Overview {#architecture-overview}

The tool is a static single-page application (TypeScript, React, built with Vite). Everything — module parsing, conversion, 68000 emulation for SNDH import, audio rendering, file writing — runs in the browser. There is no server and no network traffic except loading the page itself and, for the "original" side of the A/B switch, the vendored libopenmpt worklet.

Everything revolves around **one intermediate representation: the register dump** — 14 bytes per 20 ms frame — plus two small "side tracks" for the things a 50 Hz dump cannot express (digidrums and timer effects).

```
 MOD / XM ──► loaders ──► Module ──┬─► replay ──► channel states ──► convert ──► ┐
                                    │                                            │
                                    └─► moduleToSong (pattern song) ──► render ──┤
 .ymt / maxYMiser / Arkos ──► Song ───────────────────────────► render ──────────┤
                                                                                 ▼
 .sndh (68000 emulator) / .ym ───────────────────────────────────────►  RegisterDump
                                                                       regs[nframes × 14]
                                                                       + DrumTrack + FxTrack
                                                                                 │
        ┌──────────┬──────────┬───────────┬──────────┬───────────┐              │
        ▼          ▼          ▼           ▼          ▼           ▼              │
      SNDH     YM5!/YM6!   game kit     WAV      .regs      YM emulator ◄───────┘
   (68000 +    (ST-Sound)  (.h + C)   (preview)            (browser preview)
    stream)
 Song ──► maxYMiser (.mys/.myv/.myi)    Song ──► Arkos (.aks)    Song ──► Furnace (.fur)
          (instrument baking: src/export/bake.ts shared by Arkos and Furnace)
```

The register dump is the single truth: the preview, the WAV, the SNDH and the YM file are all derived from the same bytes, so what you hear is what the chip will get. The three tracker-format exports (maxYMiser, Arkos, Furnace) are different: they write the *song*, not the dump, because the target tools are editors.

## Data model {#architecture-data}

| Type | Where | Meaning |
|---|---|---|
| `Module` | `src/core/types.ts` | A parsed MOD/XM: orders, patterns, instruments with samples, channel count, initial speed/BPM. |
| Replay frames | `src/core/replay.ts` | For every 50 Hz frame and every source channel: instrument, note, loudness, sample position, age. `null` for a skipped channel. |
| `ConvertResult` | `src/core/convert.ts` | `regs`, `nframes`, `loopFrame`, `drums` (DrumTrack), `fx` (FxTrack), the report, warnings, per-channel played/dropped/folded counts, instrument classification. |
| `Song` | `src/tracker/types.ts` | The pattern song of the editor: order, patterns (cells of note, instrument, volume, effect, param), instruments, tempo, channel count and drum channel. |
| `Instrument` | `src/tracker/types.ts` | Classic ADSR/envelope fields, optional `seq` (step table), `syncSquare`, `digiDrums` bank. |
| `DrumTrack` | `src/core/drums.ts` | The digidrum sample table plus one trigger code per frame. |
| `FxTrack` | `src/core/fx.ts` | One packed timer-effect state per frame (kind, voice, rate). |
| `Mapping` | `src/core/mapping.ts` | The converter settings as a file: options, priorities, instrument roles, instrument names. |

## Source layout {#architecture-layout}

```
src/core        module loaders (mod.ts, xm.ts), tracker replayer (replay.ts), AY converter (convert.ts),
                sample analysis (samples.ts, pitch.ts, waveform.ts), digidrums (drums.ts, digi.ts),
                timer effects (fx.ts), channel statistics (chanstats.ts), mapping file (mapping.ts)
src/export      stream packer, YM5/YM6, SNDH, game kit, C header + replayer, YM emulator (ymemu.ts), WAV, ZIP,
                instrument baking for other trackers (bake.ts)
src/player68k   68000 SNDH player and the digidrum / timer-effect engine (player.s, drumeng.s, gamedrum.s → blob.ts)
src/maxymiser   .MYS / .MYV / .MYI codec and the song ↔ maxYMiser converters, timer arithmetic
src/arkos       song ↔ Arkos Tracker 3 (.aks)
src/furnace     song → Furnace (.fur)
src/import      SNDH import: 68000 emulator (m68k.ts), MFP timers (mfp.ts), timer-effect classifier (sndhfx.ts),
                ICE / LHA depackers, YM reader, ZIP reader
src/tracker     pattern-song model, renderer (render.ts), module → patterns (fromModule.ts), editor store (editor.ts),
                .ymt reader/writer, presets, key map, status-line hints
src/ui          React UI: App (converter), Tracker, ImportDialog, InstrumentEditor, DrumEditor, AyRoll, audio.ts
public/vendor   chiptune3 / libopenmpt (MIT / BSD) for the "original" side of the A/B switch
public/docs     this documentation (generated)
docs            the documentation sources (Markdown)
scripts         command-line tools and checks; tools/ holds the external oracles
```

## The converter pipeline in detail {#architecture-converter}

1. **Load** — `loadModule` detects MOD or XM by content (`isMod`, XM header) and parses patterns, instruments and samples.
2. **Analyse** — `samples.ts` and `pitch.ts` measure each instrument's sample cycle by autocorrelation (a clear periodicity, quality ≥ 0.75, makes it *tonal*; otherwise a high zero-crossing rate makes it *noise* — snare/hat-like — and a low one a *kick*); `waveform.ts` compares the cycle's spectrum with square, pulse, saw and triangle templates.
3. **Replay** — `replay.ts` plays the module in a tick-accurate model (all MOD and XM effects, envelopes, auto-vibrato, loop detection) and snapshots every channel's state each 20 ms. A `skip` predicate (`channelSkipper`) excludes channels set to *Off* or not soloed, so those channels never enter the result.
4. **Candidate events** — each sounding channel becomes a candidate: a tone period plus level, or a drum macro, or a digidrum hit, according to the instrument mapping (`InstMap`: auto / tone / kick / snare / hat / digi / macro / mute, transpose, wave).
5. **Allocation** — per frame, `score = AY volume + priority + drum bonus + stickiness`; the best three win the three voices. Options adjust the rules: *middle layout* gives bass and drums voice B, *arp fill* folds the losers into arpeggios.
6. **Register generation** — noise period, mixer, volume (with envelope bit), envelope shape and period are merged into the 14 registers; sync-square marks bit 5 of a volume register.
7. **Side tracks** — digidrum hits become trigger codes in the `DrumTrack`, the voice is silenced in the registers while the sample plays.

`moduleToSong` (`src/tracker/fromModule.ts`) does the same analysis but allocates voices **per row** and writes a *pattern song* with step-table instruments instead of registers, so it can be edited. It shares the priorities, roles, names, transposes and options with the frame converter.

## The pattern renderer {#architecture-renderer}

`src/tracker/render.ts` is a pure function `Song → registers`, a port of the YM Tracker's player: per tick it processes the row (note triggers, instruments, effects), advances ADSR / step tables / arpeggio / pitch / vibrato / tremolo state, and writes registers. Ticks run at 2.5 / BPM seconds; frames are sampled from the tick stream at 50 Hz. Digidrums (`Z`, drum channel) and timer effects (`Q S U`) are produced as side tracks and the voice's register is silenced while a drum plays. Mute/solo in the editor are honoured here, so the editor's playback is the same renderer the exports use.

## The editor store {#architecture-editor}

`src/tracker/editor.ts` is a small observable class: song, cursor, selection, clipboard, undo stack (references to previous `Song` objects; only touched rows are copied, 200 levels), order list, playback state. React components subscribe with `useSyncExternalStore(ed.subscribe, ed.getVersion)`. The editor's audio (`ed.play`, `ed.jam`) renders the song with the pure renderer and streams it through the same `Preview` class the converter uses.

## Audio {#architecture-audio}

`src/ui/audio.ts` — `Preview` owns one Web Audio `AudioContext`:

* **YM side**: the register dump is rendered to PCM by `src/export/ymemu.ts`, a register-level YM2149 emulation (tone counters, 17-bit noise LFSR, the 16 envelope shapes, the chip's non-linear volume table, the 4-bit digidrum DAC and the timer effects), and played as a looping `AudioBufferSource`.
* **Original side**: libopenmpt in an `AudioWorklet` (chiptune3), vendored under `public/vendor/chiptune3`. It is loaded by URL at runtime because the worklet imports sibling files; it is therefore unavailable when the page is opened from `file://`.
* The A/B switch changes the gain of the two branches so position is preserved.
* The manual import dialog creates a second `Preview` for the *solo* preview of single channels, so a solo and the main preview never overlap.

## SNDH import {#architecture-sndh-import}

`src/import/sndh.ts` runs the tune in a built-in Motorola 68000 interpreter (`m68k.ts`, 4 MB RAM, I/O page at `$FF8000`): it loads the file (ICE!-depacked if needed) at a base address, calls the init routine for the chosen subtune, then calls the play routine at the tune's own rate (VBL or Timer A–D) and records the YM registers once per frame. The MFP model (`mfp.ts`) runs timer interrupts in virtual time; every YM write made inside an interrupt is logged with a timestamp, and `sndhfx.ts` classifies the log into digidrums and timer effects (see the table in [How-to: load SNDH](#howto-load-sndh)). The interpreter was checked against the Musashi core in psgplay.

## Exporters {#architecture-exporters}

| Exporter | Input | Notes |
|---|---|---|
| SNDH (`export/sndh.ts`) | register dump + side tracks | Header tags + position-independent 68000 player + packed stream + optional drum table. |
| YM5 / YM6 (`export/ym.ts`) | register dump + side tracks | Plain `YM5!`, or `YM6!` when drums or effects exist. |
| Game kit (`export/gamekit.ts`, `cheader.ts`, `replayer.ts`) | register dump + side tracks | C array + single-header C replayer with the same 68000 engine blob as `gamedrum.s`. |
| WAV, regs | register dump | Through the emulator / raw. |
| maxYMiser (`maxymiser/convert.ts`, `format.ts`) | `Song` | Unrolls the song's walk, bakes instruments to sequences, maps effects; digi and timer instruments. |
| Arkos (`arkos/aks.ts`) | `Song` | Bakes instruments per tick via `export/bake.ts`; XML in a zip. |
| Furnace (`furnace/fur.ts`) | `Song` | Bakes instruments into macros via `bake.ts`; per-note instrument copies for fractional tuning and vibrato. |

`bake.ts` renders an instrument tick by tick with the editor's own logic (`bakeInstrument` → `Baked` ticks of volume, pitch, noise, tone, envelope), so Arkos and Furnace instruments are exactly what the editor plays.

## The 68000 engine {#architecture-68000}

`src/player68k/player.s` (the SNDH player), `drumeng.s` (digidrum + timer-effect engine) and `gamedrum.s` (the same engine for the C game kit) are assembled with `m68k-linux-gnu-as` and committed as binary blobs (`player.bin`, `gamedrum.bin`) wrapped by `blob.ts`; `npm run build:player` rebuilds them. The player reads the packed stream, writes the PSG once per 50 Hz tick, and on a drum or effect event starts an MFP interrupt handler.

## Build and delivery {#architecture-build}

* `npm run build` runs `tsc --noEmit` then `vite build`, producing a static folder in `dist/`.
* `base: './'` makes every URL relative, so the folder works from any sub-path (a Nekoweb folder URL, `…/index.html`) and from `file://`.
* The script is emitted as a classic IIFE with `defer` (browsers refuse module scripts and `crossorigin` requests on `file://`), the demo module is inlined as a data URL, and the documentation is a single self-contained HTML file copied from `public/docs/`.

## Verification strategy {#architecture-verification}

The design relies on independent oracles rather than listening alone:

| Component | Oracle |
|---|---|
| Frame converter | `tools/reference/` — an independent Python implementation; the register dump of the demo song must match frame for frame (`tests/convert.test.ts`). |
| SNDH player + drum/effect engine | psgplay's Musashi 68000 core runs the exported SNDH; YM register writes are compared with `.regs` (`tools/verify/sndh_check.py`). |
| Game kit | The generated C is compiled for the 68000, wrapped in an SNDH and run in psgplay (`tools/verify/gamekit_check.sh`). |
| 68000 interpreter | ALU and mixed test programs compared with Musashi (`tools/verify/m68ktest`). |
| maxYMiser export / import | gwEm's real replayer run on the export (`scripts/maxymiser-check.ts`). |
| Arkos export / import | The independent Rust `ym2149-arkos-replayer` (not part of the repository). |
| Furnace export | A real, headless Furnace with `-vgmout` (`scripts/furnace-check.ts`). |
| Perceptual | Chroma similarity against libopenmpt renders ≈ 0.95. |

`npm test` runs the unit and parity tests (about 210). Tests that need external binaries (gcc for the C replayer, psgplay, Furnace, the maxYMiser replayer) are skipped or run by the scripts above.
