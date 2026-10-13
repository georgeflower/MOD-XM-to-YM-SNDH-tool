# Effects reference {#effects}

An effect is one letter and two hex digits (the *parameter*) in the effect column of a pattern cell: `4 37` means vibrato, speed 3, depth 7. The effect letters are those of the YM Tracker: `0123456789ABCDEFGHKLMPRTXYQSUZ`. The status line under the pattern explains the effect under the cursor.

## Timing: rows, ticks and frames {#effects-timing}

* A **row** lasts *speed* **ticks**. A tick lasts 2.5 / BPM seconds.
* At **125 BPM a tick is exactly one 50 Hz frame**, which is what an Atari ST player does. At other tempos the renderer samples the tick stream at 50 Hz: below 125 BPM a tick spans more than one frame, above it some ticks fall between two frames and are not heard.
* Effects that "run every tick" do so from the **second** tick of the row on (tick 1, 2 …), not on tick 0, except where noted.

## How long an effect lasts {#effects-lifetime}

| Group | Lifetime |
|---|---|
| `0xy` arpeggio, `1xx` and `2xx` slides | Only on the row where they are written. Repeat them on every row for a longer arpeggio or slide. |
| `3xx` tone portamento, `4xy` vibrato, `7xy` tremolo, `Axy` volume slide, `5xy`, `6xy`, `H` global volume slide | Stay active until a new note (without the effect) is played. |
| `Rxy` and `E9y` retrigger | Until the next note. |
| `Qxx`, `Sxx`, `Uxx` | Until `Q00` / `S00` / `U00`, or until the next note that does not set a timer effect again. |
| `Xxx`, `Mxx`, `Yxx`, `Pxx` | Until the next note (a new note restores the instrument's own envelope settings). |
| `Cxx`, `Gxx`, `Fxx`, `Bxx`, `Dxx`, `Kxx`, `Lxx`, `E1y`, `E2y`, `EAy`, `EBy`, `ECy`, `EDy`, `Zxx` | Happen once, on the row. |

A parameter of `00` for `1xx`, `2xx`, `3xx`, `4xy`, `Axy` continues with the previous value.

## Pitch effects {#effects-pitch}

| Effect | Name | Description |
|---|---|---|
| `0xy` | **Arpeggio** | Cycles the note, note + `x` semitones, note + `y` semitones, one step per tick (or per *Arp speed* ticks of the instrument). Typing digits into the parameter column with no effect creates this effect: `047` is a major chord, `037` a minor chord. `00` is no arpeggio. |
| `1xx` | **Slide up** | Lowers the period by `xx` units every tick (after tick 0), raising the pitch. A row of speed 6 moves `5 × xx` units. Units are **period units**, not semitones: the same slide moves higher notes by a larger musical interval. |
| `2xx` | **Slide down** | Raises the period by `xx` every tick. |
| `3xx` | **Slide to note** (tone portamento) | Slides from the current pitch to the note written in the same cell at `xx` period units per tick, then stops. Without a note it continues toward the previous target. A `3xx` with a note on a silent voice just starts the note. |
| `4xy` | **Vibrato** | `x` = speed (0–F), `y` = depth (0–F). Sine wave on the period, peak ±`y × 0.5` period units. Restarts at each new note. If the instrument has its own vibrato it is applied automatically to every note and `4xy` overrides it. |
| `5xy` | **Slide to note + volume slide** | Continues the current `3xx` and applies the volume slide `xy` (`x` up, `y` down). |
| `6xy` | **Vibrato + volume slide** | Continues the current vibrato and applies the volume slide `xy`. |
| `E1y` | **Fine slide up** | Lowers the period by `y` once. |
| `E2y` | **Fine slide down** | Raises the period by `y` once. |

## Volume effects {#effects-volume}

| Effect | Name | Description |
|---|---|---|
| Volume column `10`…`50` | **Set volume** | `10` = 0, `50` = 64 (full). Volume 64 levels are mapped to the chip's 16 steps (about 3 dB each). |
| `Cxx` | **Set volume** | Same, `00`–`40` hex. |
| `Axy` | **Volume slide** | `x` up or `y` down by that many units per tick (the first non-zero nibble wins). |
| `7xy` | **Tremolo** | `x` speed, `y` depth. A sine wave on the volume, peak ±`y` of 64. |
| `EAy` / `EBy` | **Fine volume up / down** | Change the volume once by `y`. |
| `Gxx` | **Global volume** | `00`–`40`, scales all voices. |
| `Hxy` | **Global volume slide** | `x` up / `y` down per tick. |
| `ECy` | **Note cut** | Silences the note after `y` ticks. |
| `EDy` | **Note delay** | Starts the cell's note after `y` ticks. |
| `Kxx` | **Key off** | Releases the note (starts the instrument's release). Same as `===` in the note column. |
| `Lxx` | **Envelope position** | Jumps the instrument's volume table to position `xx` (classic instruments with a volume table only). |
| `E9y` | **Retrigger** | Restarts the note every `y` ticks. |

## Hardware envelope (buzzer) effects {#effects-envelope}

These work on the chip's shared envelope generator. Because there is only one envelope, only the voice that most recently set it determines the shape and period.

| Effect | Name | Description |
|---|---|---|
| `Xxy` | **Force envelope shape** | Turns the hardware envelope on for this note with shape `y` (the low nibble); `x` is ignored. Shapes: 8 saw down, 10 triangle, 12 saw up, 14 triangle (up first), 9 / 15 single decay or attack-then-silent, 11 / 13 single ramps that hold. |
| `Mxx` | **Envelope period, low byte** | Overrides the period's low 8 bits. |
| `Yxx` | **Envelope period, high byte** | Overrides the period's high 8 bits. Period = `Y × 256 + M`. |
| `Pxx` | **Envelope divisor** | Overrides the instrument's divisor (period = tone period ÷ `xx`, min. 1). |
| `Rxy` | **Retrigger with volume change** | Restarts the note every `y` ticks and changes the volume by code `x`: 1 −1, 2 −2, 3 −4, 4 −8, 5 −16, 6 ×⅔, 7 ×½, 9 +1, A +2, B +4, C +8, D +16, E ×1½, F ×2 (0 and 8: none). `R00` restarts the envelope shape once. |
| `T` | *reserved* | Accepted for YM Tracker compatibility; ignored by the renderer. |

## Flow effects {#effects-flow}

| Effect | Name | Description |
|---|---|---|
| `Bxx` | **Jump** | Jump to song position `xx` (hex). |
| `Dxx` | **Pattern break** | Go to the next position, row `xx`. The two digits are **decimal** (`D32` = row 32), as in FT2. |
| `E6y` | **Loop** | `E60` marks the loop start in this channel; `E6y` loops back `y` times. |
| `Fxx` | **Speed / tempo** | `F01`–`F1F`: ticks per row. `F20`–`FFF`: BPM. `F00`: stop the song. |
| `E` other | — | Other `E` sub-effects (including `E3`–`E5`, `E7`, `E8`) are ignored. |
| `8`, `9` | — | Accepted (panning and sample offset in FT2); not played. |

## Timer and sample effects {#effects-timer}

These need an MFP timer interrupt, so they exist only where an engine or an emulated timer is present (SNDH, YM6, game kit, WAV, maxYMiser; not Arkos or Furnace).

| Effect | Name | Description |
|---|---|---|
| `Qxx` | **SID voice** | The voice's volume toggles between its value and 0 at the timer rate. Parameter `xy`: `x` (high nibble) = pitch step, `y` (low nibble) = octave. Rate = `20 Hz × 2^(y + x/16)`, e.g. `Q43` = 20 × 2^(3 + 4/16) ≈ 190 Hz. `Q00` ends it. |
| `Sxx` | **Sinus-SID** | The *on* half is a rectified sine, 32 steps per period (the interrupt runs 32× the musical rate). |
| `Uxx` | **Sync-buzzer** | The envelope shape is rewritten at the timer rate, restarting it each time. Use on an instrument with a hardware envelope. |
| `Zxx` | **Digidrum** | Plays drum `xx` (1–63, hex) of the cell's instrument on that voice. `Z00` stops the drum. A missing drum is reported as a warning. |

Rates: a timer effect runs between about 48 Hz and 20 kHz (the sinus effect up to about 625 Hz, because its interrupt runs 32 times faster); anything outside is clamped to the nearest rate the MFP can make and a warning says so. The octave nibble `y` multiplies the base rate by two per step:

| `y` (octave) | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| Base rate (`x` = 0) | 20 Hz | 40 Hz | 80 Hz | 160 Hz | 320 Hz | 640 Hz | 1.3 kHz | 2.6 kHz | 5.1 kHz |

The pitch step `x` (0–F) raises the rate within the octave by `2^(x/16)`, up to almost double. Low rates give slow, rhythmic pulses, high ones the metallic "buzz".

## Which effects survive in which export {#effects-matrix}

| Effect | SNDH / YM / game kit / WAV | maxYMiser | Arkos | Furnace |
|---|---|---|---|---|
| Notes, `===`, volume column, `Cxx` | ✓ | ✓ | ✓ | ✓ |
| `0xy` arpeggio | ✓ | ✓ | ✓ | ✓ |
| `1xx` `2xx` slides | ✓ | ✓ | ≈ (even over the row) | ✓ |
| `3xx` portamento | ✓ | ✓ | ✓ (to a note without instrument) | ✓ |
| `4xy` vibrato | ✓ | ✓ | ✓ (as pitch table) | ✓ |
| `5xy` `6xy` `Axy` volume slides | ✓ | – | – | – |
| `7xy` tremolo | ✓ | – | – | – |
| `Fxx` speed | ✓ | ✓ | ✓ | ✓ |
| `Fxx` tempo (BPM) | ✓ | song tempo only (below 125 BPM is clamped to 50 Hz) | song tempo only | ✓ |
| `Dxx` | ✓ | ✓ | ✓ | ✓ |
| `Bxx` | ✓ | ✓ | – | ✓ |
| `Gxx` `Hxy` global volume | ✓ | – | – | – |
| `Kxx` key off | ✓ | ✓ | ✓ | ✓ |
| `ECy` cut, `EDy` delay | ✓ | – | – | ✓ |
| `E1y` `E2y` fine slides | ✓ | – | – | – |
| `E6y` loop | ✓ | ✓ | – | – |
| `E9y`, `EAy`, `EBy` | ✓ | – | – | – |
| `Lxx` `Mxx` `Pxx` `Rxy` `Yxx` | ✓ | – | – | – |
| `Xxy` forced buzzer | ✓ | ✓ | – | – |
| `Qxx` `Sxx` `Uxx` | ✓ | ✓ | – | – |
| `Zxx` + drum channel | ✓ | ✓ | – | – |

(YM files carry timer effects and drums only as `YM6!`.) Every export lists the effects it could not carry in its warning list; the export still completes.
