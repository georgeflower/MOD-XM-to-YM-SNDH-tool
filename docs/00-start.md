# Start here

**MOD/XM → YM2149 · SNDH · game stream — version 0.5**

A browser tool that turns ProTracker `.mod` and FastTracker II `.xm` modules into music for the **Atari ST's YM2149** sound chip (one chip: three square-wave voices, one noise generator, one envelope generator, updated 50 times a second). It also loads `.sndh`, `.ym`, `.ymt`, maxYMiser and Arkos files, turns `.wav` / `.mp3` recordings into YM tunes, has an FT2-style pattern editor for the chip, and exports to SNDH, YM, a C game kit, maxYMiser, Arkos Tracker 3, Furnace, WAV and raw registers.

Everything runs in your browser. There is no server and none of your files are uploaded; the page only counts page views with GoatCounter (no cookies, no personal data).

## The two tabs

| Tab | What it is for |
|---|---|
| **Converter** | Load a module, let the tool convert it automatically, listen to the original and the YM version side by side, tune the conversion (priorities, instrument roles, options) and export. |
| **AY pattern editor** | Edit the song as patterns for the three YM voices, with your own instruments, digidrums and timer effects. Reached with *Edit as AY patterns →* (for a module, an `.sndh` or a `.ym`), *New*, or by loading a `.ymt`, `.sndh`, `.ym`, maxYMiser or Arkos file. |

## Ten-minute quick start

1. Press **Demo: Omar's Bazaar** (or **Load MOD / XM / SNDH / YM / YMT / WAV…**, or drop a file anywhere on the page).
2. Press **Space** to play. Press **Tab** to flip between the *original* (played by libopenmpt) and the *YM version*. The difference is the conversion.
3. If the melody gets lost, open **Manual import…**, give the melody channel the priority **Lead**, press **▶ Full preview**, and listen. See [Manual import](#howto-manual-import).
4. If a drum sounds thin, set the instrument's **AY role** to *digidrum (sample)* (or tick *Percussion as digidrums*).
5. Choose an export: **SNDH** plays in any Atari ST player; **YM** plays in ST-Sound and similar players.
6. To keep working on the song by hand, press **Edit as AY patterns →**. This works for a loaded `.sndh` or `.ym` as well: the tune is turned back into notes and instruments (see [Edit an existing SNDH or YM tune](#howto-edit-tune)).

## What's new in 0.5

* **WAV and MP3 (also Ogg, FLAC, M4A) → YM tune.** Load a recording like a module: each 20 ms frame is searched for up to three notes, tracked from frame to frame, and written as tone periods and volume steps; percussion and breath become the noise generator. The result is an ordinary tune: preview, all exports and *Edit as AY patterns →* work on it. It is an approximation by nature (see [Convert a recording](#howto-audio)).

## What was new in 0.4

* **Edit `.sndh` and `.ym` files as AY patterns** — *Edit as AY patterns →* in the *Loaded tune* panel, or *Load .sndh/.ym…* in the pattern editor. The tempo and the notes are found, every sound becomes a step-table instrument, digidrums and `Q S U` timer effects come along, and the *Import report* says what was found ([Edit an existing SNDH or YM tune](#howto-edit-tune)).
* **STe DMA samples in SNDH files** (maxYMiser's DMA track and other STe players): the SNDH emulator now behaves like an STe and the sample hits become digidrums on voice C; the *STe samples* checkbox turns this off.
* **XM files with the Amiga frequency table** load and convert (they were refused before).
* **Note keys play the selected instrument from anywhere** in the pattern editor, except in fields that take typed text.
* The SNDH emulator reports where an init routine got stuck.

## What was new in 0.3

* **Manual import dialog** — per-channel priority (*Off / Low / Normal / High / Lead*), *▶ Solo* for each channel, *▶ Full preview* that updates while you change priorities, click-to-seek on every channel's activity graph, instrument renaming, and *Suggest*.
* **Automatic drum channel** — *Edit as AY patterns* adds the drum column (digidrum samples) by itself when the module has percussion.
* **Arkos Tracker 3** export and import (`.aks`), with release tails, fractional pitch and vibrato.
* **Furnace** export (`.fur`) with exact vibrato and buzzer envelopes.
* **Demo song** replaced by *Omar's Bazaar* (Qumran).
* **Stable layout** in the pattern view (the instrument and pattern panels no longer change size).
* **This documentation**, available from the *Help* link in the header and as the single file `docs/index.html` next to the app.

## How to read this documentation

| If you want… | Read |
|---|---|
| to understand what the tool does and why | [Concepts](#concepts) |
| a description of every button and field | [Converter manual](#manual-converter), [Pattern editor manual](#manual-editor), [Instrument editor](#manual-instruments) |
| step-by-step recipes | [How-to](#howto) |
| what every effect letter does | [Effects reference](#effects) |
| the text of every tooltip and key | [Tooltips and keys](#tooltips) |
| how it is built | [Architecture](#architecture) |
| formats, limits and verification | [Technical specifications](#specs) |
| help when something sounds wrong | [Troubleshooting](#troubleshooting) |

## Glossary

| Term | Meaning |
|---|---|
| **YM2149 / AY** | The sound chip of the Atari ST (pin-compatible with the General Instrument AY-3-8910). Three tone voices (A, B, C), one noise generator, one hardware envelope. |
| **Frame** | One 20 ms update (50 Hz). Each frame is 14 register values (R0–R13). |
| **Tick** | The editor's time step. At 125 BPM one tick is exactly one frame. |
| **Row / speed** | A pattern row lasts *speed* ticks. BPM sets the tick length: 2.5 / BPM seconds. |
| **Voice** | One of the chip's three tone channels (A, B, C). A module has more *source channels* than the chip has voices. |
| **Priority** | A bonus added to a source channel when the converter decides which three events win the three voices in a frame. |
| **Buzzer** | The chip's hardware envelope run at audible pitch: a buzzy saw/triangle bass sound. One envelope is shared by all voices. |
| **Sync-square** | A trick that restarts the square wave at the start of each note so every note begins in the same phase. |
| **Step table** | An instrument defined tick by tick: volume, pitch offset, noise and tone for every 20 ms. |
| **Digidrum** | A short 4-bit sample played by writing a voice's volume register from a timer interrupt. |
| **MFP** | The Atari ST's timer chip (MC68901). Timer A drives the Q/S/U effects, Timer D the digidrums. |
| **SID voice / sinus-SID / sync-buzzer** | The three timer effects: `Q`, `S`, `U`. |
| **SNDH** | The Atari ST music file format: a small 68000 program plus data. |
| **YM** | The register-dump format of ST-Sound (`YM5!`, `YM6!`). |
| **`.ymt`** | The YM Tracker's native song file, read and written byte-compatibly. |
| **Mapping** | A `.json` file with the instrument roles, channel priorities and options of a conversion. |
