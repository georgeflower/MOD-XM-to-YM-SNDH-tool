# Concepts {#concepts}

## The YM2149 in one page {#concepts-chip}

The chip has **14 registers** that you write 50 times a second (once per video frame on an Atari ST).

| Registers | Function |
|---|---|
| R0/R1, R2/R3, R4/R5 | Tone period (12 bit) for voices A, B, C. Frequency = 2 000 000 / (16 × period). |
| R6 | Noise period (0–31). One noise generator for all voices. |
| R7 | Mixer: tone/noise on or off for each voice. |
| R8, R9, R10 | Volume (0–15) for A, B, C. Bit 4 = "use the hardware envelope instead". |
| R11/R12 | Envelope period (16 bit). |
| R13 | Envelope shape (0–15). Writing it restarts the envelope. |

Consequences that shape everything in this tool:

* **Three voices only.** A module with eight channels must be reduced to three events per frame.
* **One noise generator and one envelope generator** are shared by all voices, so two drums with different noise periods cannot sound at once, and a buzzer bass uses the envelope for the whole chip.
* **Volume has 16 steps** of about 3 dB each. A module's 64 volume levels are mapped onto them.
* **50 Hz resolution.** Anything faster than a frame (digidrums, SID voices) needs a timer interrupt on the ST — see [Digidrums](#concepts-digidrums) and [Timer effects](#concepts-timer).

## How the automatic conversion works {#concepts-convert}

1. **Replay.** The module is played tick-accurately in a model of the original tracker (all MOD/XM effects, envelopes, auto-vibrato, loop detection). Every 20 ms the state of each source channel is captured: instrument, pitch, loudness, sample position.
2. **Classify.** For each source instrument the tool measures the sample's pitch from its waveform cycle and decides whether it is *tonal* (a note) or *percussive* (a kick, snare, hat…).
3. **Turn into AY events.** A tonal channel becomes a tone period plus a level. A drum becomes a macro (a short burst of noise and falling tone) or, if you choose, a digidrum sample.
4. **Allocate.** Every frame, each candidate event gets a **score**: its AY volume, plus the channel's **priority**, plus the drum bonus for percussion, plus a stickiness bonus if it was on that voice last frame. The best three win the three voices. Events that lose are dropped — or, with *Arp fill*, folded into a fast arpeggio on the nearest voice.
5. **Write registers.** The three winners and the shared noise/envelope state become the 14 register bytes of the frame.

The result is a register dump; every export (SNDH, YM, game kit, WAV…) is built from the same dump, so they all sound the same.

### The score, in detail {#concepts-score}

```
score = AY volume (0–15)
      + channel priority            (Off = channel left out, Low −3, Normal 0, High +3, Lead +8)
      + drum priority bonus         (only for percussion, slider "Drum priority", default +3)
      + stickiness bonus            (if this event was on that voice in the last frame, default +1.5)
```

Example: a *Lead* note at volume 7 scores 15, the same as a *Normal* note at full volume, and with the stickiness bonus it keeps its voice. A *Lead* note beats a *Normal* one unless the normal one is more than 8 steps louder, which on a 16-step scale means almost never. The numbers behind the five levels are listed in the [Manual import](#manual-import) chapter; the +/− buttons in the Converter's channel table set any other value.

## Two ways to get to a result {#concepts-ways}

| Way | Use it when | Result |
|---|---|---|
| **Converter only** | You want a quick YM/SNDH of a tune and a few tweaks are enough. | Exports are produced directly from the frame converter. |
| **Edit as AY patterns** | You want to fix things by hand, make your own instruments, add drums, add timer effects, or export to maxYMiser/Arkos/Furnace. | An editable pattern song (3 voices + optional drum column) that you can save as `.ymt`. |

*Edit as AY patterns* uses the same priorities and roles you set in the Converter. The converter is a *rendering* of the module; the pattern song is an *editable approximation* of it, with row-level voice allocation and step-table instruments, and all editor effects available.

## Instruments in the editor {#concepts-instruments}

The editor has two kinds of instrument:

* **Classic** (the YM Tracker's own kind): tone and/or noise on, a volume **ADSR** or a **volume table**, an optional **hardware envelope** (buzzer), arpeggio and pitch tables, vibrato.
* **Step table** (this tool's extension): one row per 20 ms tick with volume, pitch offset (semitones, decimals allowed), noise period and a tone on/off switch, plus *loop from* and a *release*. This is what the converter produces for module instruments, and what the presets (drums, acid bass…) use.

A step table plus the hardware-envelope option gives a **gated buzzer**; plus *sync-square* gives the punchy bass attack; with *digidrums* attached an instrument becomes a drum bank.

## Digidrums {#concepts-digidrums}

A digidrum is a **4-bit sample** (16 amplitude levels) played by writing a voice's volume register thousands of times a second from an MFP **Timer D** interrupt. While a drum plays, its voice carries the sample (tone and noise off).

* **One drum at a time.** A new drum cuts the one before it.
* Rates between 1 kHz and 24 kHz are possible; the ST can make only certain rates, so the nearest MFP rate is used (8 kHz becomes 7989 Hz).
* A drum is at most 16 000 bytes; an instrument carries at most 63 drums.
* Digidrums need a real timer interrupt, so they exist only in exports that carry the drum engine: **SNDH, YM6, game kit, `.ymt`, maxYMiser**. Arkos, Furnace and the register dump cannot carry them.

## Timer effects: Q, S, U {#concepts-timer}

Three YM Tracker effects use the MFP **Timer A** to change the chip faster than 50 Hz. Their parameter `xx` is pitch (high nibble) and octave (low nibble): the timer runs at `20 Hz · 2^(octave + pitch/16)`.

| Effect | What the timer does |
|---|---|
| `Qxx` SID voice | Toggles the voice volume between its value and 0 — the classic raspy "SID" sound. |
| `Sxx` sinus-SID | Same, but the *on* half is a rectified sine — a smoother, softer wobble. |
| `Uxx` sync-buzzer | Rewrites the envelope shape register at the timer rate, restarting the envelope — a harsh hard-sync buzz. |

Only **one** timer effect and **one** drum can run at a time.

## What survives in which export {#concepts-matrix}

| Feature | SNDH | YM | Game kit | WAV | maxYMiser | Arkos | Furnace |
|---|---|---|---|---|---|---|---|
| Tone, noise, volume, envelope | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Hardware envelope (buzzer) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Sync-square | ✓ | – | ✓ | ✓ | – | – | – |
| Digidrums | ✓ | YM6 | ✓ | ✓ | ✓ | – | – |
| Q / S / U timer effects | ✓ | YM6 | ✓ | ✓ | ✓ | – | – |
| Editable instruments / patterns | – | – | – | – | ✓ | ✓ | ✓ |
| Loop point | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ |

*YM* means the file stays a plain `YM5!` dump unless the song has drums or timer effects, in which case a `YM6!` file is written.
