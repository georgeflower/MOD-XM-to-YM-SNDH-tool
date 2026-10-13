# Manual: Pattern editor {#manual-editor}

The **AY pattern editor** tab is a FastTracker 2-style editor for **one YM2149**: three voices (A, B, C), optionally a fourth *drum* column. It is based on the [YM Tracker](https://github.com/georgeflower/st-tune-master) data model: the same cells, the same effect letters and the same `.ymt` song files in both directions.

## Layout {#manual-editor-layout}

| Area | Contents |
|---|---|
| **Song bar** (top) | File buttons, undo/redo, title, instrument selector, *Drum channel* switch, Transpose / Echo / Scale volume, BPM and speed, transport, octave and *Add* step. |
| **Order** (left) | The song order: a list of pattern numbers. Click a position to jump to it. The ↻ mark shows the loop (restart) position. |
| **Pattern** (middle) | The grid. One row per line, one block of columns per voice. The status line below it explains the cell under the cursor. |
| **Instruments** (right) | The 16+ instruments, with usage counts. Double-click opens the instrument editor. |
| **Instrument / Drum editor** (below, optional) | The editors described in [Instrument editor](#manual-instruments) and [Digidrum editor](#manual-drums). |
| **Export** | SNDH, YM, game kit, maxYMiser, Arkos, Furnace, instrument `.myi`, WAV, registers. A list of warnings appears under the buttons when something cannot be exported exactly. |
| **Keyboard reference** | A collapsible list of all keys (also in [Tooltips and keys](#tooltips)). |

When you arrive from the Converter, or load an SNDH/YM here, a collapsed *Import report* panel above the song bar lists what was done.

## Song bar {#manual-editor-bar}

| Control | What it does |
|---|---|
| **New** | Empty song (asks first if there are unsaved changes). |
| **Load .ymt…** | Opens a YM Tracker song. |
| **Load .sndh/.ym…** | Turns an SNDH (subtune 1) or YM register dump into editable patterns, as *Edit as AY patterns →* does on the Converter page. See [Edit an existing SNDH or YM tune](#howto-edit-tune). |
| **Load maxYMiser…** | Opens a `.mys` (select its `.myv` voice bank at the same time) or a single `.myi` instrument. |
| **Load Arkos…** | Opens an Arkos Tracker 3 `.aks` song (Arkos Tracker 2 files are rejected with a message). |
| **Save .ymt** (Ctrl+S) | Saves the song as a gzip-compressed `.ymt`. |
| **Undo / Redo** (Ctrl+Z, Ctrl+Y) | Up to 200 steps. Instrument edits and imports are undoable too. |
| **Title** | Song name (up to 32 characters; goes into the exports). |
| **BPM** | Tempo, 32–255. A tick lasts 2.5 / BPM seconds, so **125 BPM = exactly 50 Hz = one chip update per tick**. |
| **Speed** | Ticks per row, 1–31. |
| **▶ Song / ▶ Pattern / ▶ From cursor / ■ Stop** | Transport (Right Ctrl, Right Alt, –, Space). |
| **○ Edit / ● Editing** | Edit mode on/off (Space when stopped). Note keys always audition; they are written into the pattern only in edit mode. |
| **Octave** (F1–F8) | Base octave for note keys. |
| **Add** | How many rows the cursor moves down after you enter a note (0–16, cycles around; `` ` `` or `§` cycles it). |
| **Instrument** | The instrument used for notes you type. |
| **Drum channel** | Adds or removes the fourth column — see [Drum channel](#manual-editor-drumcol). |
| **Transpose…** | Shifts notes by −48…+48 semitones in the block, track, pattern or whole song; optionally only notes of the current instrument. |
| **Echo…** | Copies each note a few rows later at lower volume: delay (1–32 rows), volume % (1–100), repeats (1–8). Only empty cells are filled. This is the classic AY *F-A echo*. |
| **Scale volume…** (Ctrl/Alt/Shift+V) | Multiplies the volume column of every note in the range by a percentage; different start and end values make a fade. |

## The pattern grid {#manual-editor-grid}

Each voice has these columns, from left to right:

| Column | Digits | Meaning |
|---|---|---|
| **Note** | `C-4`, `F#5`, `===` | Note `C-1`…`B-8`. `===` is key-off (release). `...` is empty. |
| **Instrument** | 2 hex digits | Instrument 01–FF. Empty = keep the previous one. |
| **Volume** | 2 hex digits | `10`…`50` sets volume 0…64 (`10` = silent, `50` = full). Empty = leave unchanged. |
| **Effect** | 1 character | An effect letter, see [Effects reference](#effects). |
| **Parameter** | 2 hex digits | The effect's value. |

Notes and volumes sound on the chip as: a note at the *volume column* level, scaled by the instrument's envelope; the 64 volume levels map to the chip's 16 amplitude steps.

### Entering notes {#manual-editor-notes}

The two keyboard rows work like a piano, exactly as in FastTracker 2 and the YM Tracker:

```
upper row:   2   3       5   6   7       9
           Q   W   E   R   T   Y   U   I   O        → C-(n+1) … D-(n+2)
lower row:   S   D       G   H   J       L
           Z   X   C   V   B   N   M   ,   .        → C-n … D-(n+1)
```

* **F1–F8** select the octave n. **Caps Lock** or **1** (in the note column) enters a key-off `===`.
* In a *drum* column the same keys pick **digidrum 1–27** of the instrument's bank (the octave does not matter).
* Hex digits go into the instrument, volume and parameter columns; effect letters into the effect column.
* **Digits typed into the parameter without an effect make an arpeggio** (as in FT2): `047` is a major chord.

### Selecting and editing blocks {#manual-editor-blocks}

Mouse drag or **Shift+click** selects; **Alt+arrows** or **Shift+↑/↓** extend the selection. Then:

| Keys | Action |
|---|---|
| **F3 / F4 / F5** with **Shift** (track), **Ctrl+Shift** (pattern) or **Alt** (block) | Cut / copy / paste |
| **Delete** | Clears the column under the cursor; **Shift+Del** the whole cell, **Ctrl+Del** volume + effect, **Alt+Del** the effect |
| **Insert / Backspace** | Insert / remove a cell in the track; with **Shift** the whole row |
| **Ctrl/Alt/Shift+V** | Scale volume in block / track / pattern (Ctrl+Shift: song) |

### The order list {#manual-editor-order}

| Button | Action |
|---|---|
| **New pat** | Insert a new empty pattern after this position. |
| **Clone pat** | Copy this pattern into a new one. |
| **Repeat** | Insert the same pattern again after this position. |
| **Remove** | Remove this position from the order (at least one stays). |
| **Move ↑ / Move ↓** | Move this position up or down in the order. |
| **Pat +** (Ctrl+→) / Ctrl+← | Change which pattern this position plays. |
| **Loop here** | Make this position the restart point (where the song jumps back to at its end). |
| **Pattern length** | Rows in the pattern, 1–256. |

A `.ymt` holds at most 255 patterns and 255 instruments.

### Channels: mute and solo {#manual-editor-mute}

Each channel header has **M** (mute) and **S** (solo) buttons. They affect only playback, not the exports.

### The status line {#manual-editor-status}

Under the grid a line explains the cell: `0xy` shows the note names of the arpeggio, `1xx`/`2xx` the slide in period units per row, `Fxx` the speed or tempo, and every other effect its meaning. When the cursor is on a drum-channel cell it names the drum.

## Drum channel {#manual-editor-drumcol}

Tick **Drum channel** to add a fourth column. A note there plays a digidrum of the *instrument written in that column* (or the last one used) on **voice C**. The key picks the drum number (Z = 1, S = 2, X = 3 …); `===` stops it. The drum silences voice C while it plays and only one drum plays at a time.

*Edit as AY patterns* adds this column automatically when the module has percussion; the converted drums are in a *Digidrums* bank instrument.

# Manual: Instrument editor {#manual-instruments}

Select an instrument in the list and press **Edit…** (or double-click it). Every change is undoable. Hold **Play C-5 (hold)** or press any note key to hear the instrument.

## Common fields {#manual-instruments-common}

| Field | Meaning |
|---|---|
| **Name** | Up to 22 characters. |
| **Preset** | Replaces the instrument with a ready-made sound — see [Presets](#manual-presets). |
| **Sound type** | **classic (ADSR / envelope)** or **step table**. Switching to step table starts from the *Pluck* macro. |

## Classic instruments {#manual-instruments-classic}

| Field | Meaning |
|---|---|
| **Tone** | Square wave on/off. |
| **Noise** + period | Noise on/off; period 0–31 (low = bright, high = dull). The noise generator is shared by all voices. |
| **Volume: ADSR** | When on: **A**ttack, **D**ecay (ticks, 0–255), **S**ustain (AY level 0–15), **R**elease (ticks). 1 tick = 20 ms at 125 BPM. |
| **Volume table** | When ADSR is off: AY levels 0–15, one per tick; the last one is held. |
| **After key-off** | A volume table played after a key-off. |

## Fields for both types {#manual-instruments-both}

| Field | Meaning |
|---|---|
| **Arpeggio** | Semitone offsets stepped through while the note plays, e.g. `0 4 7`. |
| **Arp speed** | Ticks per arpeggio step (1–31). |
| **Pitch table** | Period offsets added per tick (positive = lower pitch). |
| **Vibrato** speed / depth | Applied to every note of the instrument (depth 0 = off). 0–15 each. |
| **Sync-square** | Restarts the square wave at the start of every note — tight, punchy attacks. Real YM2149 hardware, SNDH, game kit and WAV only. |
| **Hard envelope** | The chip's own envelope generator (buzzer). **use** turns it on, **also play the tone (sync buzz)** adds the square wave. |
| **Shape** | Envelope shape: 8 saw down, 10 triangle (down first), 12 saw up, 14 triangle (up first), 9 one decay, 13 one attack then hold, 11 decay then high, 15 attack then silent (0 and 4 equal 9 and 15). |
| **Env. period** | **follow the note** (period = tone period ÷ divisor) or a fixed 1–65535. |

## Step-table instruments {#manual-instruments-step}

The table lists one row per tick (20 ms):

| Column | Meaning |
|---|---|
| **#** | Step number (↻ marks the loop-from step). |
| **Vol** | AY volume 0–15. |
| **Semitones** | Pitch offset, −48…+48, decimals allowed (e.g. 0.35). |
| **Noise** | Noise period 1–31; 0 = no noise. |
| **Tone** | Tone on/off. |
| **+ / −** | Duplicate / remove the step. |

Above the table: **Preset** (macro presets), **Loop from step** (−1 = play once), **Release** (ticks of fade-out after a key-off, 0 = cut), **Follow note volume** (scale by the note's volume at 3 dB per AY step). The **bar chart** shows the step volumes: click or drag to draw them.

Arpeggio, pitch table, vibrato, sync-square and the hard envelope still apply on top of a step table.

## Presets {#manual-presets}

All presets are plain 50 Hz register writes: no timer is needed and they play the same in every export.

| Group | Presets |
|---|---|
| **Chord ornaments** | Minor `0 3 7`, Major `0 4 7`, Minor doubled `0 0 3 3 7 7`, Major doubled `0 0 4 4 7 7`, Minor + octave `0 3 7 12`, Major + octave `0 4 7 12`, Blip `19` then note. |
| **Drums** | Kick, Snare, Hat closed, Hat open, Hat F-A echo, Tom (fast slide). |
| **Bass** | Punchy bass (sync-square), Acid bass (buzzer + swept square), Acid bass (slow sweep). |

# Manual: Digidrum editor {#manual-drums}

Open it with **Drums…** below the instrument list. A bank belongs to an **instrument**: up to 63 drums, at most 16 000 bytes each.

| Control | What it does |
|---|---|
| **Drum list** | Number (hex), name, rate, size and length in frames; ▶ auditions. |
| **Load WAV…** | Adds one or more WAV files (PCM or float, 8/16/24/32-bit, any rate; stereo is mixed down). |
| **Add starter kit** | Kick, Snare, Hi-hat, Open hat, Tom, Clap — synthesised. |
| **Add synth drum…** | One synthesised drum from the list. |
| **↑ / ↓ / Duplicate / Remove / Reverse** | Reorder, duplicate, delete or play backwards. |
| **Name** | Up to 24 characters. |
| **Rate Hz** | 1000–24000. The ST makes only some rates; the nearest is used and shown. |
| **Gain dB** | −24…+24. |
| **Max ms** | Longest drum, 0 = limited only by the 16 000-byte cap. |
| **normalise / trim silence / noise shaping / fade out** | Processing options. Changing one re-processes the *original* audio, so you can try settings without losing quality. |
| **Waveform** | The 4-bit result as the chip's volume DAC will play it. |

Play a drum with **`Z0n`** in an effect column (drum *n* of the cell's instrument, on that voice) or with the [drum channel](#manual-editor-drumcol).
