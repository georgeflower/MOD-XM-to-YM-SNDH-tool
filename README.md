# MOD/XM → YM2149 · SNDH · game stream

A browser tool that turns **ProTracker `.MOD`** and **FastTracker II `.XM`** modules into music for the
**Atari ST's YM2149** (one chip: 3 tone voices + noise, 50 Hz). Everything runs client-side — static files, no server.

**Status:** load → auto-convert → A/B listen → export, plus an FT2-style AY pattern editor.

## What you get today

| Export | What it is |
|---|---|
| **SNDH** (`.sndh`) | Header + a position-independent 68000 player (≈0.8 KB, includes the digidrum and timer-effect engines) + packed register stream (+ digidrum table). Timer C 50 Hz (`TC50`). Verified bit-exact in an emulated 68000 (psgplay) incl. loop wrap-around and digidrum sample values. |
| **YM** (`.ym`) | `YM5!` uncompressed register dump; `YM6!` with digidrums / timer effects when the song has any (loads in ST-Sound and friends). |
| **Game kit** (`.zip`) | `<name>.h` (packed stream as a C array, + digidrum table) + `ymplay.h` (small replayer; with digidrums / timer effects also the 68000 engine). The game owns the PSG, so sound effects can steal a voice. |
| **maxYMiser** (`.mys` + `.myv`, `.myi`) | The song as native files for gwEm's [maxYMiser](https://preromanbritain.com/maxymiser/) tracker (song + voice bank, or one instrument), so a tune can be continued there — digidrums and `Q` `S` `U` timer effects included. The same files load back into the editor (*Load maxYMiser…*). See below. |
| **Arkos Tracker 3** (`.aks`) | The song as an Arkos Tracker 3 file: the editor's envelopes, arpeggios, pitch macros, step tables and buzzer instruments are baked into Arkos instruments, notes, volume, arpeggio, vibrato, slide and speed go into the patterns. Also loads back (*Load Arkos…*). See below. |
| **Furnace** (`.fur`) | The song as a Furnace Tracker file on an AY-3-8910 / YM2149 chip (2 MHz): instruments become Furnace macros, notes, volume, effects, speed and pattern flow go into the patterns. See below. |
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
* **Save / load mapping**: *Save mapping* writes the instrument table (role, transpose, waveform, custom macros), the channel priorities and the options to a
  `<module>_mapping.json`; *Load mapping…* restores them (a mapping saved for a different module still loads, with a warning). The file is validated and
  clamped on loading, so hand-edited files can't break the converter.
* **Arp fill**: a module has more channels than the YM has voices. With fill on, notes that would be dropped are folded
  into a 2- or 3-note arpeggio on the voice with the closest pitch (alternating every frame). The strip under the roll
  shows dropped notes (red) and arpeggio notes (cyan); the channel table lists the shares.
* **Sample waveform → buzzer** (option, off by default; per-instrument override in the table): the cycle of each tonal sample is analysed (spectrum
  against square, pulse, sawtooth and triangle/sine templates) and, when it is a sawtooth, a thin pulse or a triangle/sine, played as the YM's *buzzer* — the hardware envelope run
  at the note's pitch, shape 8 / 12 (saw, falling / rising) or 10 (triangle) with the tone generator off — instead of a square wave. The YM has no pulse-width control, so a thin pulse
  becomes the saw (the closest bright wave); squares and anything the templates don't fit stay square tones. The envelope generator is shared and can't be scaled in level, so the
  buzzer is used for one voice at a time, for notes loud enough (AY level ≥ 12, else a square at the right level) and only where the envelope period hits the pitch (envelope period
  ≥ 32: up to about 240 Hz for a saw, 120 Hz for a triangle — i.e. bass). In the pattern editor it makes buzzer step-table instruments (hardware envelope, tone off) for sustained samples
  whose typical note is in range; a triangle is written an octave up there because its envelope cycle is two ramps. Works in every export (the envelope registers are in the stream).
* **Bass + drums on the middle voice** (option, off by default): the layout AY composers use. A source channel whose notes sit
  below 200 Hz (median) is the bass; it and the synthetic drums prefer voice B, melody and arpeggios voices A and C, so the three
  voices live in different frequency ranges. A melody note on B makes room when a bass or drum needs it and an outer voice is
  free. Digidrums stay on voice C. Works in the frame converter and in the pattern-editor conversion.

## Loading .sndh and .ym

Besides modules the page loads **`.ym`** (YM2!/3!/3b/5!/6!, also LHA-packed) and **`.sndh`** (also ICE!-packed).
They are not converted: a `.ym` is read as the register dump it is, a `.sndh` is *run* in a built-in 68000 emulator
(init + play routine, YM writes captured per tick, resampled to 50 Hz, loop detected). You get the piano-roll view, the
YM preview and all exports (SNDH / YM5 / game kit / WAV / regs). SNDH subtunes and the rendered length can be chosen.
`.ym` files with YM5/YM6 digidrums are imported with their samples and play (and re-export) correctly, and YM6 SID-voice / sinus-SID / sync-buzzer
effects come in as timer effects.

**Timer interrupts in SNDH files.** The runner also models the MFP timers (A, B, C, D in delay mode, with their enable / mask bits and vectors) and runs
the tune's interrupt handlers in virtual time. Every YM write a handler makes is logged with a timestamp and then classified, whatever the driver looks like inside:

| a handler writes … | becomes |
|---|---|
| a volume register at a steady rate with many different values | a **digidrum** sample (rate from the timer, deduplicated, triggered in the frame it starts) |
| a volume register, alternating between two values | **`Q`** SID voice (rate = timer rate, level = the higher value) |
| a volume register stepping through a repeating wave with silent gaps | **`S`** sinus-SID |
| R13 at a steady rate | **`U`** sync-buzzer |
| anything else | the last value in each frame goes into the frame image, as before |

Limits: one drum plays at a time and one timer effect runs at a time, so overlapping ones (e.g. 3-voice "quartet" drivers) keep the first and the import says
how many it dropped; a handler that mixes samples or changes a drum's pitch while it plays comes out as a plain sample at the average rate; drums are placed on the
50 Hz frame they start in (up to 20 ms early). Tunes that busy-wait on a timer data register still hang (reported as "did not return"). The emulator was checked against the Musashi core in `psgplay` (see `tools/verify`).

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
* **Instrument presets** (picker at the top of the instrument editor): the chord ornaments AY composers use for a whole chord on one
  voice (`0 3 7`, `0 4 7`, doubled `0 0 3 3 7 7`, with octave `0 3 7 12`, and a `19 0 0` blip at the start of a note), kick / snare / hats /
  toms from noise bursts and fast pitch drops (including a hat with the F-A volume echo), and **acid bass**: the buzzer plays the note
  while a square wave on the same voice sweeps down onto it from 40 semitones above (gwEm, *Torture Your YM*, Alive 9). They are plain
  50 Hz register writes, so they need no timer and play on real hardware in every export; checked register-for-register against the real
  maxYMiser replayer. A step table with the hard envelope on gates the buzzer (its level can't be scaled) and drives tone and noise.
* **Sync-square** (checkbox in the instrument editor, preset *Punchy bass*): the square wave restarts at every note. The
  YM2149's tone counter only toggles when it reaches the period, so the player writes a very short period, waits 8 PSG clocks
  (8 NOPs = 32 CPU cycles), then writes the real period back (high byte first, so no stray short period appears; Tattersall,
  gwEm in Alive 9). Every note then starts in the same phase: tight bass attacks and thin pulses. In the stream it is bit 5 of
  the voice's volume byte (the chip ignores it); the SNDH player and the game-kit `ymplay.h` act on it, the WAV render restarts
  the phase, YM files and maxYMiser leave it out. Verified by tracing the 68000 player's writes (order, value, gap). It needs an
  STFM-style 4:1 CPU/PSG clock: on an STE the clocks differ slightly and an edge can be missed.
* **Echo…** copies each note a few rows later at a lower volume (delay, volume %, repeats), into empty cells only.
* The editor plays through a register-level emulation of the chip (including the hardware envelope) and exports the same
  formats as the converter: **SNDH, YM, game kit, WAV, raw registers**.

Limits worth knowing: vibrato depth in `.ymt` tops out at about ±7 period units, so converted vibrato is approximate; a `.ymt` holds at most 255
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

## Timer effects (Q / S / U)

The YM Tracker's three MFP-timer effects, with its parameter: `xx` = pitch (high nibble) and octave (low nibble), timer rate
`20 Hz · 2^(octave + pitch/16)`, `00` = off. They need a note with sound on that voice; a new note without `Q`/`S`/`U` ends the effect.

| | |
|---|---|
| **`Qxx` SID voice** | every timer tick the voice's volume toggles between its register value and 0 (the classic "SID" buzz) |
| **`Sxx` sinus-SID** | like `Q`, but the *on* half is a rectified 32-step sine (the interrupt runs 32× the musical rate) |
| **`Uxx` sync-buzzer** | the hardware-envelope shape register is rewritten at the timer rate, restarting the envelope (use an envelope instrument) |

* **One effect at a time.** The ST has one MFP timer to spare for this (Timer A, vector `$134`; drums keep Timer D). If a second voice
  asks for an effect while one runs, the first keeps going and the editor warns. Rates the MFP cannot make (below ≈ 48 Hz, above
  20 kHz, sinus above ≈ 625 Hz) are clamped to the nearest one and also warned about.
* **Exports.** SNDH and game kit carry the effect as a small event in the stream and run it from a Timer A interrupt (the engine
  shares its code with the digidrums); YM6 uses the ST-Sound effect slots (`R1`/`R3` high nibble, repeated every frame the effect runs), and `.ym` files
  with those codes are imported back. Preview in the editor is the register emulation plus the timer behaviour.
* **Verification.** The 68000 engine runs in psgplay (Q: volume register alternates 15/0 at the exact rate; S: 32 sine steps per
  period; U: R13 rewritten at the timer rate; stop restores the volume; the SNDH output without effects is unchanged), and the
  generated game-kit C code does the same (`tools/verify/gamekit_check.sh`, which includes an effect that starts in the frame of a drum trigger).
  YM6 effect rendering in ST-Sound itself could not be checked here.

## maxYMiser export

*Export → maxYMiser* writes a `.MYS` song and a `.MYV` voice bank (zipped with a short note); *Instrument (.myi)* writes the selected instrument. Both
use the editor's own file formats (song `MYM0`, voice bank version 0), so maxYMiser 1.29 and later load them, and gwEm's replayer plays them.

* **Timing is 1 : 1.** maxYMiser calls its replayer at 50–200 Hz and one row is `speed` calls: that is this editor's tick, so BPM × 0.4 becomes the
  replay rate (125 BPM = 50 Hz) and the speed carries over. Below 125 BPM is clamped to 50 Hz (warned). `Fxx` speed changes become `Sxx`.
* **Instruments become sequences.** ADSR / volume envelope → volume sequence, arpeggio and pitch macros → arpeggio / vibrato sequences, built-in vibrato → vibrato
  sequence, tone / noise / hardware envelope (buzzer, incl. fixed envelope period) → mixer / noise / fixed-pitch sequences, step-table instruments (the ones made by the module
  converter) → all of them step by step, a fractional-semitone tuning as a fine detune per note. Sequences hold 31 steps, so longer envelopes run at a slower sequence speed.
  ADSR / step-table **release** is played as a note re-trigger with a fade instrument (maxYMiser itself cuts on note-off).
* **Effects that carry over:** `0xy` arpeggio, `1xx` `2xx` slides, `3xx` tone portamento, `4xy` vibrato, `Cxx` / volume column (as attenuation), `Fxx` speed, `Dxx`/`Bxx`/`E6x`
  (the player's real walk through the song is unrolled into positions, the loop point becomes the repeat position), `Xxx` forced buzzer, `Kxx` key off.
* **Digidrums** (`Z` effect and the drum channel) become *digi* instruments (mixer kind 13) over 8-bit samples: each 4-bit drum is written through the replayer's own DAC table
  (so it reads back as the same 16 levels), samples are shared by content, the rate is `2457600 / (4 × n)` Hz with n = 24…205. A drum owns its voice and the voice stays
  silent after it until the next note. At most 8 different samples of 32 KB and the 32 instrument slots; what does not fit is listed.
* **Timer effects** `Q` (SID), `S` (sinus-SID) and `U` (sync-buzzer) become a copy of the instrument whose mixer selects the SID (5) or sync-buzzer (11) timer, whose `Tim`
  sequence is the waveform (square `15,0`; the sinus table in 16 steps, fewer when the rate needs it; the buzzer shape for `U`) and whose timer is pinned to the wanted rate with a
  fixed-frequency sequence (the arithmetic of the replayer's rate table is in `src/maxymiser/timers.ts`). The Hz you asked for is what plays, within the MFP's limits (warned when clamped).
  A `Q`/`S`/`U` on a note that is already sounding re-triggers it.
* **Not exported** (listed as warnings): volume slides, tremolo, global volume, retrigger / note cut / delay, `L M P Y` envelope effects, tempo changes, `Q S U` switch-off while a
  note sounds, instruments beyond 32, second-chip channels.
* **Verified against the real replayer.** `scripts/maxymiser-check.ts <MYM_REPL.BIN> <song>` wraps the export in an SNDH with gwEm's own replayer
  (`tools/verify/maxymiser/`) and compares every frame with the editor's render: simple songs are identical, converted modules match except where noted (fractional
  tuning that varies per step, vibrato phase). The format code also round-trips gwEm's example songs, banks and instruments byte for byte, and the files decode in
  [go-MaxYMiser](https://github.com/olivierh59500/go-MaxYMiser). The replayer binary and gwEm's files are not part of this repository.
* maxYMiser is © Gareth Morris "gwEm"; its licence asks that anything released that was made with it says so.

### maxYMiser import

*Load maxYMiser…* takes a `.MYS` (select its `.MYV` voice bank too) or a single `.MYI`. The song becomes a normal pattern song: each song position is a pattern of the three tracks,
a pattern break shortens it, the repeat position is the restart position, the replay rate is the BPM (× 2.5), `Sxx` is `Fxx`. Looping "jam" patterns are skipped as the player does.

* **Instruments are played tick by tick** into step tables (volume, arpeggio, vibrato, fixed pitch and coarse detune folded into a semitone offset, noise, tone), so sequences
  with their own speed, loop points and different lengths come out right. Buzzer sounds become hardware-envelope instruments (shape, fixed envelope period, divisor, arpeggio /
  vibrato as macros). The instrument's component masks decide where arpeggio, vibrato, portamento, transpose and detune apply, as in the replayer.
* **Digi instruments** become instruments with digidrums (sample → 4-bit through the replayer's DAC thresholds, volume and attenuation baked in) and a `Z` on each hit.
  **SID / sync-buzzer instruments** get a `Q` / `S` / `U` next to each note (timer rate from the note's frequency × waveform steps; a two-level waveform is a `Q`, anything else
  an `S`; pulse widths are not kept).
* **Effects:** `X` → `0xy`, `H` → `1xx`/`2xx`, `P` → `3xx` (scaled for the tick the editor skips), `V` → `4xy` (depth is limited to what `4xy` can do), `W`/`M` → `Xx` (buzzer),
  `S`, `T`, `E` (a tuned copy of the step-table instrument per note). The editor has one effect per cell, maxYMiser two: timers / drums win, then speed, buzzer, vibrato,
  arpeggio, slides; arpeggio and slides are repeated on every row they last. What does not fit is counted in the warnings.
* **Not imported:** the STe DMA track, sequence-switching effects (`A F I L N Q`), `C D O Y U` effects, timer kinds other than SID / digi / sync-buzzer (the other replayer builds
  have more).
* Checked against the real replayer register by register (`scripts/maxymiser-check.ts <MYM_REPL.BIN> song.mys`): gwEm's own example songs and songs exported from here
  play identically except for slides (the replayer also slides on the first tick) and fractional tuning.

## Arkos Tracker export

*Export → Arkos Tracker (.aks)* writes an Arkos Tracker 3 song (the XML inside a zip, the way AT3 saves it): one subsong, the YM clock (2 MHz), replay rate = BPM × 0.4 Hz
(125 BPM = 50 Hz), three channels, one Arkos instrument per editor instrument.

* **Instruments are baked per tick.** ADSR / volume envelope, arpeggio and pitch macros, built-in vibrato and the step tables (drum, acid, chord-ornament presets) become the
  instrument's cells; periodic macros are unrolled to their common period and looped. Buzzer instruments use a software + hardware link (envelope period from the note, tone
  free to sweep), buzzer-only ones a hardware link; shapes 0-7 are played as 9 / 15 (Arkos has 8-15 only).
* **Release tails** are kept: a note-off plays the instrument's release part as its own instrument (continuing the arpeggio / vibrato cycle), and fractional semitone offsets become per-note
  copies of the instrument with exact periods.
* **Effects that carry over:** notes, volume column / `Cxx` (as Arkos' 16 levels), `0xy` arpeggio, `1xx` `2xx` slides, `3xx` glide (to a note without instrument), `4xy` vibrato (as a pitch
  table), `Fxx` speed (speed track), `Dxx` (shorter pattern).
* **Approximations** (listed as warnings): slides and glides run evenly over the row instead of only on the ticks after the first, sync-square and `Q S U` / `Z` timer effects and digidrums are
  left out, tremolo, volume slides, BPM changes, `Bxx` are not exported.
* **Verified** by loading the exported file in an independent Arkos replayer (the Rust `ym2149-arkos-replayer`, not part of this repository) and comparing every frame with the editor's
  render: ADSR, release tails, volume, arpeggio macros, vibrato, fractional pitch, speed changes, note-off, the drum, hat, tom and acid-bass presets and the sync-bass step table are
  register-identical; slides differ by a few period units inside a row; converted modules agree on volume and, within a few percent of the frames, on pitch. The official Arkos Tracker 3 could
  not be run here, so open the file there and tell me if it complains.

### Arkos import

*Load Arkos…* opens an Arkos Tracker 3 song (`.aks`, zipped or plain XML; Arkos Tracker 2 files are rejected with a message). One editor pattern per position, speed track → `Fxx`,
replay frequency → BPM. Instruments are baked into step tables (cell speed and loop kept, envelope cells become buzzer steps); an arpeggio table, a pitch table or a volume slide started with
a note becomes a copy of the instrument for that note; pitch slides and glides become `1xx` `2xx` `3xx`.

* Not imported (listed after loading): sample instruments, notes outside C-1…B-8, `forceInstrumentSpeed`, hardware-to-software links, extra PSGs, and arpeggio / pitch tables or volume slides that
  change in the middle of a note (the editor cannot change an instrument without a new note).
* Checked against the independent Arkos replayer on about 40 real songs (not part of this repository): most match register for register; the rest differ in slide phase and rounding at low
  volumes.

## Furnace export

*Export → Furnace (.fur)* writes a [Furnace](https://github.com/tildearrow/furnace) module (format 228, readable by every Furnace from 0.6.8 on): one subsong, one AY-3-8910 chip flagged as
YM2149 with the 2 MHz Atari ST clock, three channels, tick rate = BPM × 0.4 Hz, one instrument per editor instrument.

* **Instruments become macros.** The volume macro carries the envelope (a release tail is the macro's release part, played by the note-release command), the wave macro tone / noise / envelope
  bits, the duty macro the noise period; arpeggio, pitch and built-in vibrato are baked into the arpeggio and pitch macros (the song is flagged *non-linear pitch*, so pitch macro and slides
  are in YM period units like in the editor). Buzzers write the envelope shape (`ex2`) and restart it with every note (phase-reset macro). The editor ties the envelope period to the written
  note (not to arpeggios, slides or glides), so a buzzer gets one copy per played note with that period written out (`ex5`); a fixed envelope period is written as such.
* **Fractional semitones** (the converter's step tables are tuned in fractions of a semitone) need the note: Furnace's pitch macro is in period units, so such an instrument is written once
  per note it plays, each copy carrying that note's period correction (copies within one period unit are shared).
* **Effects that carry over:** notes and note-off (release when the instrument has a tail), volume column / `Cxx`, `0xy` arpeggio (with the instrument's arpeggio speed), `1xx` `2xx` slides,
  `3xx` tone portamento, `4xy` vibrato, `EDx` note delay, `ECx` note cut, `Kxx`, `Fxx` speed and BPM, `Dxx`, `Bxx`; shorter patterns end with a jump, the restart position is a jump at the end.
* **Vibrato** (`4xy`): Furnace's own vibrato runs the other way and two ticks earlier than the editor's, so a vibrato that is the same command from its first row until the next note is
  written into that note's instrument copy (pitch macro) instead — register-identical in Furnace. A vibrato whose command changes in the middle of a note stays a Furnace `04xy`
  (opposite start direction, listed as a warning); a cycle longer than 254 ticks is cut.
* **Differences** (listed as warnings): the first tick of a release shows the held level (Furnace re-reads the macro's release position) before the tail follows; an instrument arpeggio speed that does not divide
  the ticks per row drifts by up to speed-1 ticks (Furnace's arpeggio counter runs on across notes); sync-square, `Q S U` timer effects,
  digidrums (`Z`, the drum channel), tremolo, volume slides, global volume, `X Y M P L R T`, `E1x` `E2x` `E6x` `E9x` `EAx` `EBx` and channels beyond the third are not exported.
* **Verified** by playing the export in a real (headless) Furnace and comparing every register frame with the editor's render (`scripts/furnace-check.ts <furnace> <module|ymt|synth>`, needs a
  Furnace with the `-vgmout` option): ADSR, volume envelopes and tables, arpeggios, slides, tone portamento, speed / BPM changes, pattern lengths, `Dxx`, `Bxx`, restart, noise, step tables,
  one-shot tables, fractional tuning, vibrato and all buzzer shapes (also with arpeggios, slides and glides) are register-identical; the converted modules agree on pitch within 2 % and on level within 2 steps for 99 % of the sounding frames.

## Using it

1. Open the page, **Load MOD / XM / SNDH / YM…** (or drop a file anywhere) — or press **Demo** (Omar's Bazaar).
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

* `tests/convert.test.ts` — the demo song `OMARSBAZAAR.xm` (Omar's Bazaar, by Qumran) loads, converts to the expected length and gives a stable register dump
  **frame for frame** (`tools/reference/` holds the Python oracle).
* `tools/verify/sndh_check.py` — runs an `.sndh` in [psgplay](https://github.com/frno7/psgplay)'s 68000 core and compares
  every YM register write against the `.regs` dump (`scripts/synth-loop.ts` builds a looping test song).
* `scripts/furnace-check.ts` — plays the Furnace export in a real Furnace (`-vgmout`) and compares the AY registers with the editor's render.
* `scripts/maxymiser-check.ts` + `tools/verify/maxymiser/` — plays the maxYMiser export through gwEm's real replayer (supply `MYM_REPL.BIN` yourself) and diffs the registers with the editor's render.
* `tools/verify/gamekit_check.sh` — generates a game kit for a drum test song, compiles `ymplay.h` for the 68000, wraps it in an SNDH and runs it in psgplay.
* Perceptual check: chroma similarity against libopenmpt renders ≈ 0.95 (XM) / 0.95 (MOD).

### Layout

```
src/core        module loaders, tracker replayer, AY converter, digidrum samples (drums.ts, digi.ts)
src/export      stream packer, YM5/YM6, SNDH, game kit, C header + replayer, YM emulator (preview), WAV, ZIP
src/player68k   68000 SNDH player + digidrum / timer-effect engine (player.s, drumeng.s, gamedrum.s → blob.ts)
src/maxymiser   maxYMiser .MYS/.MYV/.MYI codec and the song -> maxYMiser converter
src/arkos       song -> Arkos Tracker 3 (.aks)      src/furnace   song -> Furnace (.fur)      src/export/bake.ts  instrument baking shared by both
src/tracker     pattern song model, renderer (tick player), module -> patterns, editor store, .ymt IO
src/ui          React UI (FT2-flavoured skin), converter tab, pattern editor tab, A/B audio
public/vendor   chiptune3 / libopenmpt (MIT / BSD) for the "original" side of the A/B switch
```

## Roadmap

* More than one timer effect or drum at a time (needs a second timer / mixing engine); timer-driven arpeggio and other handler effects that are not drums or Q/S/U
* maxYMiser: the STe DMA track (sampled sound), sequence-switching effects, more than one timer effect on the voices at once

Note: SNDH files made here play in any SNDH player but cannot be opened *in* maxYMiser (it only loads its own songs) — use the maxYMiser export for that.
