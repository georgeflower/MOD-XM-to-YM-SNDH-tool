# Manual: Converter {#manual-converter}

The **Converter** tab is where a module (or an existing SNDH/YM tune) is loaded, converted, auditioned and exported. Panels appear as you need them: before anything is loaded you see only the *Start here* box.

## Header and loading {#manual-loading}

| Control | What it does |
|---|---|
| **Load MOD / XM / SNDH / YM / YMT…** | Opens a file. Accepted: `.mod`, `.xm`, `.sndh` / `.snd` (also ICE!-packed), `.ym` (YM2!, YM3!, YM3b!, YM5!, YM6!, also LHA-packed) and `.ymt`. The type is detected from the file contents, not the extension. |
| **Drop a file** | Dropping a file anywhere on the page does the same. |
| **Demo: Omar's Bazaar** | Loads the bundled XM song *Omar's Bazaar* by Qumran. |
| **Converter / AY pattern editor** tabs | Switch between the two halves of the tool. The loaded module stays in memory when you switch. |

What happens after loading depends on the file type:

* **MOD / XM** — converted automatically with default settings. The *Module*, *Conversion*, *Export*, *Preview*, *Instruments*, *Source channels* and *Report* panels appear.
* **SNDH / YM** — not converted, only *played*: a `.ym` is read as the register dump it is, a `.sndh` is run in a built-in 68000 emulator. You get the *Loaded tune* panel, the preview and the exports. See [Loading SNDH and YM](#howto-load-sndh).
* **YMT** — opens in the AY pattern editor.

## Module panel {#manual-module}

Read-only facts about the module: file name, title, type (MOD or XM) and channel count, patterns and orders, initial speed/BPM and the length of the YM version. **Composer** is a text field whose content is written into the SNDH `COMM` tag and the YM author field.

## Conversion panel {#manual-conversion}

All conversion controls re-render the preview automatically: the change is applied after a quarter of a second and the conversion of a long song takes one to three seconds (the status text shows *Converting…* and *Rendering…*).

| Control | Range / default | Effect |
|---|---|---|
| **Level** | −12…+12 dB, 0 | Overall loudness mapped onto the chip's 16 volume steps. Raise it if the YM version sounds quiet, lower it if many notes sit at the maximum level. |
| **Drum priority** | 0…6, 3 | Bonus added to percussion when voices are handed out. Higher = drums win over melody notes more often. |
| **Voice stickiness** | 0…4, 1.5 | Bonus for an event that stays on the voice it had in the previous frame. Higher = fewer voice jumps and clicks, but a new important note may wait. |
| **Sample waveform → buzzer (saw / triangle)** | off | Analyses each tonal sample's cycle; a sawtooth, thin pulse or triangle/sine becomes the chip's *buzzer* (hardware envelope at the note's pitch) instead of a square wave. Only for loud bass notes, one voice at a time. Per-instrument override in the table. |
| **Bass + drums on the middle voice** | off | The layout AY composers use: bass (median pitch below 200 Hz) and synthetic drums prefer voice B; melody and arpeggios go on A and C. Digidrums stay on voice C. |
| **Arpeggio** | `0 → x → y` | Order in which an arpeggio cycles its notes (FT2/ProTracker order, or reversed). |
| **Arp fill** | off | Notes that would be dropped are folded into a 2- or 3-note fast arpeggio on the voice with the closest pitch. |
| **Min. volume** | 1…12, 3 | (Shown with Arp fill.) Dropped notes quieter than this AY volume are not worth an arpeggio slot. |
| **Percussion as digidrums** | off | Percussion samples are played as real 4-bit samples through a timer interrupt instead of a noise/tone macro. |
| **Drum rate** | 4…16 kHz, 8 | (Shown with digidrums.) Sample rate of the drums. Higher is clearer but costs CPU time and memory. |
| **Drum length** | 50…1500 ms, 500 | (Shown with digidrums.) Longer drums are cut with a short fade. |

Buttons at the bottom of the panel:

| Button | What it does |
|---|---|
| **Reset to auto** | Restores all options, priorities, instrument roles and instrument names to the automatic defaults. |
| **Save mapping** | Writes `<module>_mapping.json` with the options, channel priorities, instrument names and per-instrument roles, transposes, waveforms and custom macros. |
| **Load mapping…** | Reads such a file back (also one made for a similar module — a warning tells you when the module differs). The file is validated and clamped, so hand-edited files cannot break the converter. |
| **Manual import…** | Opens the [manual import dialog](#manual-import). |
| **Edit as AY patterns →** | Converts the module into an editable pattern song (using all the settings above) and opens the AY pattern editor. |

## Instruments → AY role {#manual-roles}

One row per source instrument.

| Column | Meaning |
|---|---|
| **#**, **Name** | Instrument number (hex) and its name. The name is a **text field: type over it to rename the instrument** (up to 24 characters; Enter or leaving the field confirms, Esc cancels, an empty field goes back to the module's own name). The new name appears in the manual import dialog, the macro editor, the saved mapping and — in the pattern editor — as the name of the AY instruments made from it (e.g. `03 Bass lead`). Renaming does not change the sound. |
| **Detected** | What the analysis decided: *tonal* (a clearly periodic, pitched sound), *kick* (unpitched, low zero-crossing rate), *noise* (unpitched and noisy: snares, hats, cymbals) or *empty*. The AY role's *auto* entry shows what the converter then plays (e.g. `auto: hat`, `auto: digidrum`). |
| **C-4** | The measured pitch of the sample when played at note C-4. |
| **Wave** | (Tonal instruments.) The cycle's waveform: *auto* (use the analysis, shown in brackets), *square tone*, *saw buzzer ↘*, *saw buzzer ↗*, *triangle buzzer*. Buzzers are used only where the chip can do them (see the option above). |
| **AY role** | How the instrument is played on the chip: |
| | **auto** — tone at the measured pitch, a drum macro, or (with *digidrums*) a sample; |
| | **tone (written note)** — uses the written note's pitch with the sample's own volume curve; |
| | **kick / snare / hat** — forces a synthetic drum macro; |
| | **digidrum (sample)** — plays the sample as a 4-bit drum; |
| | **custom macro…** — a per-tick table you edit in the *Macro editor* below; |
| | **mute** — leaves the instrument out. |
| **Tr.** | Transpose in semitones (−48…+48). Disabled for drums and mute. |

### Macro editor {#manual-macro}

Appears below the tables when an instrument is set to *custom macro* and you press **edit**. One row = one step = **20 ms**.

| Field | Meaning |
|---|---|
| **Preset** | Pluck, Organ (sustain), Lead + vibrato, Bass thump, Tom, Hat (noise), Snare (tone+noise), Arpeggio major, Arpeggio minor. |
| **Loop from** | Step the sound jumps back to after the last one; −1 = play once, then silent. |
| **follow note volume** | Scales the steps by the source note's volume. |
| **+ step / − step** | Appends a copy of the last step / removes the last one. |
| Per step: **Vol** (0–15), **Semitones** (pitch offset, decimals allowed — a fraction makes vibrato), **Noise** (1–31, 0 = none), **Tone** (on/off) | |

## Source channels → 3 voices {#manual-channels}

For each source channel: **Played** (share of its events that got a voice), **In arp** (share folded into arpeggios, when *Arp fill* is on), **Dropped** (share lost; shown in red above 10 %) and a **Priority** value with −/+ buttons (steps of 1). These are the same priority values the [manual import dialog](#manual-import) sets with its five levels.

## Manual import dialog {#manual-import}

Opened with **Manual import…**. Use it when the automatic result loses a part you care about.

| Element | Meaning |
|---|---|
| **▶ Full preview (YM2149)** | Plays the whole conversion with the priorities currently set. You can keep changing priorities while it plays: after a short delay (0.25 s plus 1–3 s of conversion for a long song; the status text next to the buttons shows *Converting…*) the new version replaces the old one. |
| **▶ Original** | Plays the original module for comparison (only when original playback is available — see [Troubleshooting](#troubleshooting)). |
| **Suggest** | First guess: the busiest pitched channel becomes *Lead*, nearly silent channels (active < 5 % of the song) become *Low*, the rest *Normal*. |
| **Reset** | Removes all priorities. |
| **Channel table** | One row per source channel: **Activity over the song** (a loudness bar chart in 96 slices; *click it to listen from that point*), **Active** (% of frames sounding), **Notes** (number of note starts), **Pitch** (median note), **Main instruments** (up to three, with their numbers; the names are text fields you can rename). |
| **Priority** | A five-way switch per channel — see below. |
| **Solo ▶** | Plays that channel *alone* on the three voices as the chip will play it, with the current instrument settings. Disabled for silent channels. |
| **Click on the activity graph** | Plays that channel alone from the clicked point of the song (the graph spans the whole song, left = start). A white line shows the position. Clicking while the channel plays jumps there; clicking another channel's graph moves to that channel; while the *Full preview* plays, a click on any graph jumps the full preview to that point. Silent channels cannot be clicked. |
| **Edit as AY patterns →** | Converts with these priorities and opens the pattern editor. |
| **Done** | Closes the dialog; the priorities stay applied to the exports. **Esc** also closes it. |

The five priority levels:

| Level | Value added to the score | Use for |
|---|---|---|
| **Off** | channel removed entirely | Channels you do not want at all (a second pad, ambience). |
| **Low** | −3 | Background parts that should give way when voices run short. |
| **Normal** | 0 | No preference (default). |
| **High** | +3 | Parts that should usually win over normal channels (bass line). |
| **Lead** | +8 | The melody: keeps its voice almost always. |

A priority that does not match a level (set with the +/− buttons) is shown as *custom +n*.

## Export panel {#manual-export}

| Button | Output | Notes |
|---|---|---|
| **SNDH (.sndh)** | Atari ST music file with a built-in 68000 player | Plays in any SNDH player. Includes the digidrum and timer-effect engines when needed. |
| **YM (.ym)** | `YM5!` register dump; `YM6!` with digidrums/timer effects | For ST-Sound and similar players. |
| **Game kit (.zip)** | C header with the packed stream, `ymplay.h` replayer | For your own Atari ST game; the game owns the PSG, so sound effects can steal a voice. |
| **Preview (.wav)** | 44.1 kHz audio of the YM emulation | |
| **Raw regs (.regs)** | 14 bytes per frame | |
| **Report (.txt)** | The conversion report | |

Under the buttons: the size of the packed stream and the SNDH player. Arkos, Furnace and maxYMiser exports are in the pattern editor (*Edit as AY patterns*).

## Preview panel {#manual-preview}

| Control | Meaning |
|---|---|
| **⏮** | Back to the start. |
| **▶ Play / ■ Stop** (or **Space**) | Plays the selected source. |
| **A · Original / B · YM2149** (or **Tab**) | Switches source while playing, keeping the position. *Original* uses libopenmpt and needs the page served over http(s). |
| **Piano roll** | Pitch (vertical) and brightness (volume) of the three voices; orange = noise. Under it a strip shows dropped notes (red) and arpeggio notes (cyan). |

## Loaded SNDH / YM panel {#manual-tune}

Shown instead of *Module* when a `.sndh` or `.ym` is loaded.

| Field | Meaning |
|---|---|
| File, Title, Author, Comment | From the file's tags/header. |
| Length, Loop | Frames at 50 Hz; loop frame or "none detected (plays once)". |
| Timer | (SNDH) VBL or Timer A–D and its rate; non-50 Hz tunes are resampled to 50 Hz. |
| **Subtune** | (SNDH with several subtunes.) Choose which one to run. |
| **Seconds** | Length to run the emulator for; 0 = use the file's `TIME` tag. |
| **Composer** | Written to the exports. |

## Conversion report {#manual-report}

Lists what the converter did and what it could not do: dropped notes per channel, unsupported effects, clamped parameters. Warnings start with `warning:`.
