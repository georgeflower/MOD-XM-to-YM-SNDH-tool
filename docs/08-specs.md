# Technical specifications {#specs}

All multi-byte values are **big-endian** unless a format says otherwise (`.ymt` and `.aks`/`.fur` follow their own conventions).

## Time base and registers {#specs-time}

| Item | Value |
|---|---|
| PSG clock | 2 000 000 Hz (Atari ST) |
| Frame rate | 50 Hz (one frame = 20 ms = 40 000 PSG clocks) |
| Tone frequency | `2 000 000 / (16 × period)`, period 1–4095 |
| Envelope frequency | `2 000 000 / (256 × period)`, period 1–65535 |
| Tick (editor) | `2.5 / BPM` seconds; speed = ticks per row |
| Maximum render length | 60 000 frames = 20 minutes |
| Volume steps | 16 (R8–R10 bits 0–3); the tracker volume column (0–64) maps to the nearest step of the chip's amplitude table |

## Register dump (`.regs`, internal) {#specs-regs}

14 bytes per frame, R0…R13, no header. Two conventions of this tool inside the dump:

* **R13 = `0xFF`** means *do not write R13 this frame*. A write of the same shape retriggers the envelope, so only frames that really restart the envelope write it. When no voice ever uses the envelope (volume bit 4), R13 is never written.
* **Bit 5 of R8–R10** is the *sync-square* flag (the chip ignores that bit). It is stripped in YM files and maxYMiser; the SNDH player and the game-kit replayer act on it.

## Packed stream (SNDH and game kit) {#specs-stream}

Delta-coded; per frame:

```
A  = bit 7 "B follows" | mask of R0..R6 that changed (bits 0-6)
B  = bit 7 "event bytes follow" | mask of R7..R13 that changed (bits 0-6)     [only if A bit 7]
events (only if B bit 7):
   timer effect (at most one per frame), top two bits 00:
       X = kind<<4 | voice<<2 | cont       kind 0 = stop; 1 = SID, 2 = sinus, 3 = sync
       kinds 1..3 are followed by: prescaler code, data register
       cont = 1: a drum byte follows
   digidrum trigger, top two bits != 00:
       T = (voice+1)<<6 | drum index        drum 63 = stop
then one data byte per set mask bit, in register order
```

* The loop frame always starts with a **full refresh**, so a loop point is self-contained.
* Streams without drums or effects never set bit 7 of B, so older players can read them.
* The packer returns `data` and `loopOffset` (the byte offset of the loop frame).

## SNDH file {#specs-sndh}

| Offset | Content |
|---|---|
| 0, 4, 8 | Three `bra.w` entries: init, exit, play (SNDH convention) |
| 12 | `SNDH` magic, then tags: `TITL`, `COMM` (composer), `CONV`, `YEAR`, `##01` (one subtune), `TC50` (Timer C, 50 Hz), `TIME` (seconds, 16 bit), `HDNS` (end of tags) |
| after the tags | The 68000 player blob (1540 bytes, position independent, even aligned) |
| player + 12 | `.w` number of frames |
| player + 14 | `.w` frames in the loop (`nframes − loopFrame`) |
| player + 16 | `.l` byte offset of the loop frame in the stream |
| player + 20 | `.l` offset of the digidrum table, only when the song has drums |
| after the player | The packed stream, then (word aligned) the digidrum table |

Text is Latin-1 (other characters become `?`). The player calls Timer C at 50 Hz, writes the PSG, and starts an MFP interrupt handler for drum or effect events. Digidrum and timer-effect engines are included in every SNDH (they are part of the blob).

## YM5! and YM6! files {#specs-ym}

| Field | `YM5!` | `YM6!` |
|---|---|---|
| Magic | `YM5!LeOnArD!` | `YM6!LeOnArD!` |
| Frames (u32) | number of frames | same |
| Attributes (u32) | 1 (interleaved) | 1 + 4 (interleaved + 4-bit drum samples) |
| Drum count (u16) | 0 | number of drums (≤ 32) |
| Clock (u32) | 2 000 000 | same |
| Frame rate (u16) | 50 | 50 |
| Loop frame (u32) | frame index | same |
| Extra (u16) | 0 | 0 |
| Drum samples | – | per drum: `.l` length, then one byte (0–15) per sample |
| Strings | title, author, comment (NUL terminated, Latin-1) | same |
| Data | 16 register columns of `nframes` bytes (interleaved: all R0, then all R1 …) | same |
| End marker | `End!` | `End!` |

YM6 digidrum trigger (ST-Sound convention): `R1` high nibble = `0x40 | (voice+1)<<4`, `R6` bits 5–7 = MFP prescaler, `R14` = MFP data register, `R(8+voice)` = drum number. ST-Sound effects last one frame, so **timer effects** are repeated every frame they run: `R1`/`R3` high nibble = `(voice+1)<<4 | type` (`0x00` SID, `0x80` sinus-SID, `0xC0` sync-buzzer), prescaler in `R6`/`R8` bits 5–7, data register in `R14`/`R15`; a frame with both a drum and an effect uses slot 1 for the drum and slot 2 for the effect. The rate stored is the musical rate (the sinus effect's interrupt runs 32× faster in the engine). `R13` carries the envelope shape for sync-buzzer frames.

YM6 limits: 32 drums, no *stop* code (approximated), drums on different voices may overlap in ST-Sound (approximated).

Importers accept YM2!, YM3!, YM3b!, YM5!, YM6!, also LHA-packed.

## Digidrum table and engine {#specs-drums}

Table read by the 68000 engine (`drumtable.ts`): `.w` count, then per drum `.l` PCM offset, `.w` length, `.b` MFP prescaler code, `.b` MFP data register; then the PCM bytes (one byte per sample, 0–15 = chip volume step).

| Item | Value |
|---|---|
| MFP clock | 2 457 600 Hz |
| Prescaler dividers | code 1…7 = 4, 10, 16, 50, 64, 100, 200 (code 0 = stopped) |
| Data register | 1–255 |
| Rate | `2 457 600 / (divider × data)`; the nearest achievable rate is used (8 kHz → 7 989 Hz) |
| Timer | Timer D, vector `$110`, IPL 6 |
| Voice | the voice named in the trigger; tone and noise off while playing |
| Concurrency | one drum at a time; a trigger cuts the previous drum |
| Max rate in the editor | 24 000 Hz; converter drum rates 4–16 kHz |
| Max size | 63 drums per instrument, 16 000 bytes each |
| `.ymt` storage | 4-bit packed, low nibble first |

Samples are 4-bit values written to the volume register, so amplitude follows the chip's non-linear DAC levels (the waveform view in the drum editor draws exactly that).

## Timer-effect engine {#specs-fx}

| Item | Value |
|---|---|
| Timer | Timer A, vector `$134`, IPL 6 |
| Parameter | `xy`: pitch step `x`, octave `y`; rate `20 × 2^(y + x/16)` Hz; `00` = off |
| Range | 48.2 Hz (`2 457 600 / (200 × 255)`) to 20 kHz; clamped, with a warning |
| SID voice (Q) | each tick toggles the volume register between the voice's level (full level on an envelope voice) and 0 |
| Sinus-SID (S) | 64-step table (32-step rectified sine, then 32 silent steps); level `(sin32[t] × vol × 17 + 128) >> 8`; interrupt rate 32× the musical rate, so the musical rate is limited to about 625 Hz |
| Sync-buzzer (U) | each tick rewrites R13 with the current shape (restarting the envelope) |
| Concurrency | one effect at a time; the first keeps running |

## Game kit {#specs-gamekit}

`<name>.h`: `<N>_FRAMES`, `<N>_LOOP_FRAME`, `<N>_LOOP_OFFSET`, `static const unsigned char <n>_data[]` (the packed stream), and with drums `<N>_DRUMS` and `static const unsigned short <n>_drums[]` (the table, word aligned).

`ymplay.h` (single header, plain C, 68000 target):

| Call | Meaning |
|---|---|
| `ymplay_start(<n>_data, <N>_FRAMES, <N>_LOOP_FRAME, <N>_LOOP_OFFSET)` | Once, before the first step: points the replayer at the stream and clears the registers. |
| `ymplay_step()` | Advance one 50 Hz frame; fills `ymplay_reg[0..13]`. At the end it jumps back to the loop frame by itself. |
| `ymplay_write()` | Write `ymplay_reg` to the PSG (supervisor mode). With drums/effects: also keeps the register shadow, leaves the volume register of the voice that plays a drum or effect alone, and starts/stops them. |
| `ymplay_reg[14]` | The registers of the current frame, for games that write the PSG themselves (so sound effects can steal a voice by overriding registers first). |
| `ymdrum_init(<n>_drums)` | Once, supervisor mode: takes over Timer D (and Timer A for effects). Use `ymdrum_init(0)` when only effects are present. |
| `ymdrum_exit()` | Restores the timers and the voice volume. |
| `ymdrum_busy()`, `ymfx_voice()`, `ymplay_trig`, `ymplay_fxev` | For hand-written PSG access; see the comment at the top of `ymplay.h`. |

The 68000 engine is embedded as `unsigned short ymdrum_code[]` (1188 bytes, position independent, needs RAM). Timer D and Timer A must not be used by anything else while the music plays.

## `.ymt` song file {#specs-ymt}

The YM Tracker's native format, read and written byte-compatibly (little-endian).

| Field | Content |
|---|---|
| Header | `YMT1`, version `u8` = 1, flags `u8` (bit 0 = gzip), header size `u16` = 8 |
| Payload (gzip when flagged) | name (`u16` length + UTF-8), BPM `u16`, speed `u8`, step `u8`, restart `u16`, channel count `u8`, drum channel `i8` (−1 = none), order length / pattern count / instrument count (`u16` each), channel names (flag `u8`, then `str8` per channel), the order (`u8` each) |
| Patterns | per pattern: rows `u16`, packed size `u32`, then cells: one mask byte per cell (`0x80` = empty cell; else bit 7 set + bit 0 note, 1 instrument, 2 volume, 3 effect, 4 parameter, followed by those bytes) |
| Instruments | name, ADSR, hard-envelope fields, noise/tone, arp speed, vibrato, phase/duty/noise masks, volume envelope, release table, arpeggio macro (`i8`), pitch macro (`i16`), wavetable, digidrum bank (name, rate `u16`, length `u32`, 4-bit packed PCM) |
| Extensions (this tool) | `XSEQ`: step tables (count, then per instrument index, loop-from `i16`, velocity flag, release, step count, steps as volume×100 `i16`, semitone×100 `i16`, noise `u8`, flags `u8`); `XAUT`: author; `XSYN`: instruments with sync-square. The YM Tracker stops reading after the instruments and ignores them. |

Limits: 255 patterns, 255 instruments, 1–256 rows per pattern, up to 7 channels in the file (the editor uses 3 voices + the drum column).

## Mapping file (`.json`) {#specs-mapping}

```json
{
  "format": "mod-xm-to-ym-mapping",
  "version": 1,
  "module": { "title": "...", "kind": "xm", "channels": 4, "instruments": 4 },
  "opts":  { "gainDb": 0, "drumBonus": 3, "sticky": 1.5, "arpOrder": "xy", "arpFill": 0, "arpMinVol": 3,
             "digi": false, "digiRate": 8000, "digiMaxMs": 500, "middle": false, "waveform": false },
  "prio":  { "0": 8, "2": -99 },
  "inst":  { "1": { "mode": "tone", "transpose": -12, "wave": "saw" },
             "3": { "mode": "macro", "macro": { "loopFrom": 2, "velocity": true,
                    "steps": [ { "vol": 15, "semi": 0, "noise": 0, "tone": true } ] } } },
  "names": { "1": "Bass lead" }
}
```

* `prio`: 0-based channel → value; `-99` = Off. Low −3, High +3, Lead +8 in the dialog; any number is valid.
* `inst.mode`: `auto`, `mute`, `tone`, `kick`, `snare`, `hat`, `macro`, `digi`; `wave`: `tone`, `saw`, `sawup`, `smooth`.
* `names`: instrument number (1–255) → name, at most 24 characters. Optional (files without it load fine).
* All values are validated and clamped on loading; unreadable entries are dropped with a warning.

## Exports to other trackers {#specs-trackers}

| Target | File | Timing | Instruments | Effects carried | Not carried |
|---|---|---|---|---|---|
| maxYMiser | `.mys` + `.myv` (+ `.myi`) | replay rate = BPM × 0.4 Hz (≥ 50), row = *speed* calls | sequences of 31 steps, 32 slots, 8 samples × 32 KB | `0xy 1xx 2xx 3xx 4xy C F D B E6 X K`, digidrums, `Q S U` | volume slides, tremolo, global volume, retrigger/cut/delay, `L M P Y`, tempo changes, second chip |
| Arkos Tracker 3 | `.aks` (XML in a zip, format 3.0) | 2 MHz PSG, replay rate = BPM × 0.4 Hz, 1 subsong, 3 channels | baked per tick; periodic macros unrolled to common period; buzzer as software+hardware link | notes, volume/`C`, `0xy 1xx 2xx 3xx 4xy F D` | digidrums, `Q S U`, sync-square, tremolo, volume slides, BPM changes, `B` |
| Furnace | `.fur` (format 228) | tick rate BPM × 0.4 Hz, AY-3-8910 flagged YM2149 at 2 MHz, non-linear pitch | macros (volume, wave, duty, arp, pitch, ex shape/period); per-note copies for fractional tuning and vibrato | notes, vol, `0xy 1xx 2xx 3xx 4xy ED EC K F D B` | digidrums, `Q S U`, sync-square, tremolo, volume slides, global volume, `X Y M P L R T`, `E1 E2 E6 E9 EA EB` |

Details, tolerances and the known differences (first release tick, arpeggio-speed drift on odd row lengths, slide phasing) are listed in the README and as warnings in each export. The tools were checked as described in [Architecture → Verification](#architecture-verification).

## Limits at a glance {#specs-limits}

| Item | Limit |
|---|---|
| Voices | 3 (+ the drum column, which plays on voice C) |
| Notes | C-1…B-8 (1–96); `===` = key off |
| BPM / speed | 32–255 / 1–31 |
| Pattern rows / patterns / instruments | 1–256 / 255 / 255 |
| Table lengths in instruments | 256 entries (arpeggio, pitch, volume tables); step tables up to 255 steps |
| Instrument name | 22 characters in the editor; 24 for source-instrument names in the converter |
| Digidrums | 63 per instrument, 16 000 bytes each; YM6: 32 in total |
| Timer effects | 48–20 000 Hz (sinus ≤ about 625 Hz); one drum and one effect at a time |
| Undo | 200 steps |
| maxYMiser | 32 instrument slots, 8 samples of 32 KB, sequences of 31 steps |
| Arkos | notes C-1…B-8, one PSG |
| Furnace | one chip, 3 channels; a vibrato cycle over 254 ticks is cut |
| Render length | 20 minutes |

## Scenarios {#specs-scenarios}

What each way of using the tool produces:

| Scenario | Path | Result |
|---|---|---|
| **A. Quick SNDH** | Load MOD/XM → Converter → *SNDH* | Dump from the frame converter; 1540-byte player + stream (typically 150–400 bytes per second of music for dense songs, ≈ 166 B/s for the demo). |
| **B. Priorities tuned** | Load → *Manual import…* / priority buttons → export | Same pipeline; channels with *Off* are never replayed; priorities change only the allocation. |
| **C. With digidrums** | *Percussion as digidrums* or per-instrument *digidrum* role → export | Dump + `DrumTrack`. SNDH/game kit carry the table (`drumtable.ts`) and the Timer D engine; YM becomes YM6; WAV renders the samples. |
| **D. Edit as AY patterns** | *Edit as AY patterns →* | `moduleToSong`: pattern song with step-table instruments, drum column if the module has percussion, names and priorities applied; renderer produces the same dump. |
| **E. Hand-written song** | New → editor | Renderer only; all effects including `Q S U Z` available. |
| **F. Import SNDH / YM** | Load `.sndh` / `.ym` | No conversion: the dump is the music (SNDH is emulated); drums and effects are classified from MFP writes; exports re-pack the dump. |
| **G. Round trip to other trackers** | Editor → maxYMiser / Arkos / Furnace | Song-level export with instrument baking; maxYMiser and Arkos can be loaded back. |
| **H. Game integration** | Converter or editor → *Game kit (.zip)* | Header + replayer; the game calls `ymplay_step()` / `ymplay_write()` every 50 Hz tick. |
| **I. Offline / file://** | Open `index.html` from disk | Everything works except the *Original* A/B side (needs http(s)). |
