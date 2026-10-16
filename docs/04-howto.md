# How-to recipes {#howto}

Each recipe is self-contained. Words in **bold** are buttons or fields; the full description of each is in the manuals.

## Load a MOD or XM {#howto-load}

1. Press **Load MOD / XM / SNDH / YM / YMT / WAV…** at the top, or drag the file anywhere onto the page. (To try it first, press **Demo: Omar's Bazaar**.)
2. The file type is detected from its contents. ProTracker `.mod` (M.K., 4CHN, 6CHN, 8CHN, FLT4/8, OCTA, nnCH and similar tags) and FastTracker II `.xm` are supported. The module is analysed and converted at once; a status text next to the buttons shows *Converting…* and *Rendering…*.
3. Press **Space** to play the YM version. Press **Tab** to switch to the original and back. If **A · Original** is greyed out, you opened the page from disk — see [Troubleshooting](#troubleshooting).
4. The **Conversion report** at the bottom lists what the converter did and any warnings.

If the file does not load, the red box under the tabs says why (e.g. "not a MOD or XM file", or a truncated file).

## Import automatically, then adjust the priority {#howto-auto}

The automatic import keeps the three most important notes every 20 ms. When it loses something you care about:

1. Look at **Source channels → 3 voices**. A high **Dropped** percentage (red above 10 %) means that channel is being cut down.
2. Press **+** next to the channel you want to protect (each press adds 1 to its priority); **−** for a channel that may give way. Or press **Manual import…** for a better view ([next recipe](#howto-manual-import)).
3. Listen again. The preview refreshes by itself one or two seconds after every change.
4. Useful companions: **Arp fill** (folds dropped notes into a fast arpeggio so chords survive), **Voice stickiness** (fewer voice jumps), **Drum priority** (how hard drums push melody notes out), **Level** (overall loudness).
5. **Reset to auto** goes back to the defaults.

## Manual import with channel priorities {#howto-manual-import}

1. Load the module and press **Manual import…** in the Conversion panel.
2. Wait for the *Analysing the channels…* line to be replaced by the table. Each row is one source channel with a loudness graph, how often it sounds, how many notes it plays, its median pitch and its main instruments — enough to tell the melody from the bass and the drums.
3. Press **Suggest** for a first guess (busiest pitched channel = *Lead*, nearly silent = *Low*).
4. Press **▶** in the *Solo* column of a channel to hear that channel alone, converted for the chip. Press it again (■) to stop. To start somewhere else in the song, **click the channel's activity graph** at the point you want to hear: that channel plays from there, and a white line follows the playing position. Clicking again while it plays jumps to the new point; clicking another channel's graph switches to that channel; while the *Full preview* is running a click on any graph jumps the full preview instead.
5. Set each channel's **Priority**: **Lead** for the melody, **High** for a bass line, **Normal** for the rest, **Low** for background parts, **Off** for channels you do not want at all.
6. Press **▶ Full preview (YM2149)** to hear the whole result. While it plays, keep changing priorities; the new version replaces the old after a moment. **▶ Original** compares with the real module.
7. Press **Done** to keep the priorities for the exports on the Converter tab, or **Edit as AY patterns →** to continue in the editor with the same priorities.

Tips:

* A drum channel with priority **Off** leaves its percussion out entirely; keep drums at **Normal** and use **Drum priority** to adjust their weight.
* If two channels fight for the lead role, make one **High** and the other **Normal**: the difference decides who wins a contested voice.
* The priorities are part of the mapping file — see [Save and reuse a conversion](#howto-mapping).

## Change how a module instrument is played {#howto-instruments-convert}

In the **Instruments → AY role** table:

1. Find the instrument (the **Detected** column tells you whether it was classified as tonal or as a drum; **C-4** shows its measured pitch).
2. Choose its **AY role**:
   * *tone (written note)* — if the measured pitch is wrong (a sample with no clear pitch), this plays the note as written;
   * *kick / snare / hat* — if a drum was classified as tonal, or the wrong drum;
   * *digidrum (sample)* — to play the sample itself as a 4-bit drum;
   * *mute* — to leave it out;
   * *custom macro…* — to design its sound tick by tick (see below).
3. Use **Tr.** to transpose it by semitones (e.g. −12 if a bass sits too high for the chip).
4. For a tonal instrument with a **Wave** column, choose *saw buzzer* or *triangle buzzer* if you want the chip's hardware-envelope bass sound, or *square tone* to forbid it. (The checkbox **Sample waveform → buzzer** applies the analysis to all instruments.)

**Custom macro:** choose *custom macro…* in AY role, press **edit** next to it. The Macro editor shows one row per 20 ms. Pick a **Preset** as a starting point (Pluck, Organ, Bass thump…), then change the **Vol**, **Semitones** (a fraction such as 0.35 makes vibrato), **Noise** and **Tone** values. Set **Loop from** to the step that should repeat while the note is held (−1 = play once). Use **+ step / − step** to lengthen or shorten.

## Rename instruments {#howto-rename}

Module instrument names are often cryptic (`** Omar's Bazaar **`, `and Qumran`). Give them names you recognise:

1. In the Converter's **Instruments → AY role** table, click the name field of an instrument, type the new name and press **Enter** (or click elsewhere). Esc cancels; an empty field goes back to the module's own name.
2. The same names are shown — and can be edited — in the **Main instruments** column of the manual import dialog, so you can rename an instrument the moment you recognise it while soloing a channel.
3. The names are used in the macro editor, saved with **Save mapping**, and become the names of the instruments in the pattern editor after **Edit as AY patterns →** (`03 Bass lead`; the number prefix stays so you can tell instruments apart).
4. In the pattern editor, rename any instrument in its editor (**Edit…** → *Name*).

Renaming never changes the sound, so it does not re-render the preview.

## Make drums sound right {#howto-drums-convert}

Two approaches exist:

* **Synthetic drums (default).** Kicks, snares and hats become short noise-and-pitch macros. They are cheap and work in every export. Switch an instrument's role between *kick / snare / hat* to fix a wrong classification.
* **Digidrums.** Tick **Percussion as digidrums**. Percussion samples are resampled to 4 kHz–16 kHz and played as real 4-bit samples. Choose the **Drum rate** and the **Drum length**. Individual instruments can be forced with the *digidrum (sample)* role.

Digidrums need a timer interrupt: they work in SNDH, YM6, the game kit and maxYMiser exports (not Arkos or Furnace). Only one plays at a time; they take voice C while they play. If drums and a melody on voice C fight, raise **Drum priority** or lower that channel's priority.

## Save and reuse a conversion {#howto-mapping}

* **Save mapping** writes `<module>_mapping.json` with the options, channel priorities and per-instrument roles/transposes/waveforms/macros.
* **Load mapping…** restores it, also for a different module of the same kind (a warning is shown when the module differs).
* The mapping is plain JSON and can be edited by hand; values outside the allowed ranges are clamped when it is loaded.

## Continue in the pattern editor {#howto-edit}

1. Press **Edit as AY patterns →** (in the Conversion panel or in the manual import dialog).
2. The module becomes an editable song: patterns with row-level voice allocation, one step-table instrument per module instrument, arpeggios folded into `0xy`, `Fxx` speed changes for exact row timing, slides and vibrato translated into `1xx`/`2xx`/`4xy`. If the module has percussion, a **drum channel** (fourth column) and a *Digidrums* bank instrument are added.
3. The conversion report is kept in a collapsed *Import report* panel above the song bar.
4. Press **Space** to start edit mode and **Right Ctrl** to play the song.
5. Save with **Ctrl+S** as `.ymt` to keep the song for later.

## Change an instrument in the editor {#howto-change-inst}

*To use a different instrument for existing notes:* put the cursor on the note's instrument column and type the new two-digit instrument number. To change many notes at once, select a block and use **Transpose…** with *only notes of instrument …* to move just one instrument's notes.

*To change how an instrument sounds:*

1. Click the instrument in the **Instruments** list.
2. Press **Edit…**. Hold **Play C-5 (hold)** to hear it while you work.
3. Change what you need — everything is undoable with **Ctrl+Z**. Changes apply everywhere the instrument is used, in the pattern playback and in all exports.
4. Use **Duplicate** first if you want to keep the old version as well, then point the notes you want to change at the copy.

## Create a new instrument {#howto-new-inst}

**From a preset (fastest).** Press **New** below the instrument list, then **Edit…**, and choose a **Preset**: chord ornaments (a whole chord on one voice), kick/snare/hats/tom, punchy sync-square bass, acid bass.

**A classic plucked lead.**

1. **New**, then **Edit…**. Keep *Sound type* on *classic*.
2. Tone on, noise off. Tick **ADSR**. Set A = 0, D = 6, S = 8, R = 8 (decay and release in ticks of 20 ms, sustain is the chip level 0–15).
3. Optional: **Vibrato** speed 4 and depth 3 gives a gentle wobble; **Arpeggio** `0 12` adds an octave flutter.
4. Name it, write a few notes in the pattern with this instrument selected (the **Instrument** counter in the song bar), and play.

**A buzzer bass.**

1. **New**, **Edit…**. Tick **Hard envelope: use**.
2. **Shape** 8 (saw down) for the classic buzz, 10 for a smoother triangle sound. **Env. period**: leave on *follow the note*, divisor 1; larger divisors play lower.
3. Untick **Tone** for a pure buzzer, or tick **also play the tone (sync buzz)** for a harsher blend.
4. The envelope generator is **shared by all voices**: only one buzzer can sound at a time, and its volume cannot be scaled.

**A step-table instrument (draw the sound tick by tick).**

1. **New**, **Edit…**, set *Sound type* to **step table**.
2. Choose a macro **Preset** as the starting point, then draw the volume with the mouse in the bar chart (click and drag).
3. In the table set **Semitones** for pitch sweeps (e.g. 24 at step 0 falling to 0 for a kick), **Noise** for noise bursts and **Tone** to switch the square wave off for noise-only steps.
4. **Loop from step** repeats the tail while the note is held; **Release** sets the fade after a key-off; *Follow note volume* lets the volume column scale it.
5. For a kick: step 0 = vol 15, semitones 24, noise 6; then vol 15→2 falling over 8 steps, pitch 14→−6. (That is the *Kick* preset.)

**A punchy bass with sync-square.** Tick **Sync-square: restart the tone at each note** — every note then starts at the same phase of the square wave. It is audible on real hardware, in the SNDH/game-kit exports and in the WAV preview, and is left out of YM, maxYMiser, Arkos and Furnace.

## Add and use digidrums {#howto-digidrum}

1. Choose (or create) an instrument to hold the drums and press **Drums…**.
2. Add drums: **Load WAV…** (several files at once), **Add starter kit**, or **Add synth drum…**. Select a drum and adjust **Rate Hz** (8000 is a good start), **Gain dB**, **Max ms**, *normalise*, *trim silence*, *noise shaping* and *fade out*; press ▶ to audition. The waveform shows the 4-bit result.
3. Use drums in the song in one of two ways:
   * **Z effect:** in the effect column type `Z` and a drum number in the parameter, e.g. `Z01` = drum 1 of the cell's instrument, played on that voice. `Z00` stops the drum.
   * **Drum channel:** tick **Drum channel**, then type notes in the fourth column. Z = drum 1, S = drum 2, X = drum 3 and so on; the instrument number in that column picks the bank. `===` stops.
4. Remember the limits: **one drum at a time** (a new one cuts the old one), the drum silences its voice while it plays, at most 63 drums per instrument and 16 000 bytes per drum.
5. Exports that carry digidrums: SNDH, YM (as YM6), game kit, maxYMiser, `.ymt`. Arkos, Furnace, raw registers and the register dump cannot carry them (a warning says so).

## Use the timer effects Q, S and U {#howto-timer}

1. Write a note with sound on a voice (tone or buzzer).
2. In the same cell (or a later row, while the note is held) type the effect, for example `Q4C`.
3. The parameter is `xy`: `y` is the octave, `x` the pitch step inside it. The timer rate is `20 Hz · 2^(y + x/16)`. A higher number means a faster, higher-pitched effect. `Q00` ends it; so does a new note without an effect.
4. `Q` = SID voice (rough), `S` = sinus-SID (smooth), `U` = sync-buzzer (use it on an envelope instrument).
5. Only one timer effect runs at a time; the status line warns when the rate is out of the MFP's range and clamps it.

Timer effects work in SNDH, YM6, game kit, WAV and maxYMiser exports. They need real hardware or an emulator that runs the timer.

## Write a tune from scratch {#howto-scratch}

1. Open the **AY pattern editor** tab and press **New** (or just start; the editor opens with an empty song).
2. Set **BPM** (125 is one tick per frame) and **Speed** (6 is a common start).
3. Press **Space** (Edit on), choose an **Instrument**, type notes with the piano keys, **F1–F8** for the octave.
4. Use the **Add** step to move more than one row per note; use `===` (Caps Lock) to release a note.
5. Add rows of effects: `0xy` arpeggio, `1xx`/`2xx` slides, `4xy` vibrato, `C` volume. See the [Effects reference](#effects).
6. Add patterns with **New pat**, **Clone pat**, **Repeat**. Set the loop point with **Loop here**.
7. Save with **Ctrl+S**.

## Edit an existing SNDH or YM tune {#howto-edit-tune}

An `.sndh` or `.ym` file is a recording of what the chip did, 50 times a second. It holds no notes, instruments or patterns, so the tool works them out again.

1. Load the file (**Load MOD / XM / SNDH / YM / YMT / WAV…**, or drop it on the page). For an SNDH with several subtunes, choose the **Subtune** (and, if the length is wrong, **Seconds**) first.
2. Press **Edit as AY patterns →** in the *Loaded tune* panel. In the pattern editor you can also press **Load .sndh/.ym…**, which takes subtune 1.
3. The *Import report* above the song bar says what was found, for example *YM import: 3840 frames -> 481 rows at 8 frames per row … 870 notes -> 255 step-table instruments*.
4. Press **Space**, then **Right Ctrl** to play it, and compare with the original (Converter tab, preview).
5. Edit as for any song: change notes, replace an instrument, add drums, then save with **Ctrl+S** as `.ymt` or export.

What you get, and what to expect:

* **Tempo.** The rows run at the tune's own speed (frames per row), found from where the notes start. If a tune has no regular tempo the song runs at one frame per row (speed 1): everything is still there, but patterns are long and notes are hard to read. A tune that begins a few frames before its first full row gets a short first row (an `Fxx` speed change on row 0 and row 1).
* **Notes and instruments.** Every note start becomes a note. What the voice did until the next note (volume, pitch relative to the note, noise, tone, hardware envelope) is written as a **step-table instrument** named *Tone*, *Noise*, *Tone+noise* or *Buzzer* plus a number. Notes that sounded the same share an instrument, and notes that differ only in loudness share one too (the loudness goes to the volume column). Held notes loop their tail and end with `===`. Arpeggios, vibrato and slides are inside the step tables, not in `0xy` / `4xy` / `1xx` columns, because the register dump has no way to tell them apart from notes. Edit the step table to change them, or replace the instrument.
* **Tuning.** Tunes that were converted from samples are often slightly off A = 440 Hz. The tune's overall offset is added to every step, so semitone values such as `-0.2` or `2.8` are normal in imported instruments. Pitches are snapped to clean values when the difference is under 0.4 % (about 7 cents).
* **Digidrums** of a YM5/YM6 file or an SNDH become a bank on a **Drum** channel (note = drum number). A drum that played on voice A or B is moved to voice C, which is where the drum channel plays; the report counts them.
* **Timer effects** (SID voice, sinus-SID, sync-buzzer) become `Q`, `S` and `U` on the voice's note, repeated after every new note on that voice.
* **STe DMA sound.** An STe tune can play 8-bit samples through the DMA sound chip next to the YM2149 (maxYMiser's DMA track does). The YM has no such channel and a register dump cannot carry it, so the emulator logs each sample start and the sample becomes a 4-bit digidrum hit at the same frame, on voice C, which is silent while the sample plays. The *Loaded tune* panel shows an **STe samples** checkbox for such tunes: untick it to leave the samples out and keep voice C as the tune plays it. The sound is the sample at 4-bit resolution and at most 12.5 kHz, so it is coarser than the STe's, and the bass or lead on voice C is cut while a sample plays.
* **Loop.** The tune's loop frame becomes the order position the song restarts at.
* **Too many sounds.** There are 255 instrument slots. If a tune has more distinct sounds, the most similar ones are merged and the report says how many and how large the difference is. A note that plays the wrong instrument sounds slightly different (a volume step or a fraction of a semitone), not wrong.
* **Check by ear.** The editor plays the same registers as the original to within a few percent of the frames (a few frames differ at merged instruments and where the tune does something the editor's voice model cannot, such as changing the buzzer period during a note).

## Load SNDH and YM files {#howto-load-sndh}

* **SNDH** (`.sndh`, `.snd`, also ICE!-packed): the file is *run* in a built-in 68000 emulator and the chip writes are captured at 50 Hz. Use **Subtune** to pick one, **Seconds** to set the length (0 = use the TIME tag). The emulated machine is an STe (cookie jar with `_MCH`, `_SND`, GEMDOS memory allocation, microwire handshake), so players that check for an STe before they start the DMA sound chip do start it; see *STe DMA sound* below. Tunes whose player never returns or waits for other hardware that is not emulated report *did not return* and the address where they got stuck.
* **YM** (`.ym`: YM2!, YM3!, YM3b!, YM5!, YM6!, LHA-packed): read as the register dump it is. YM5/YM6 digidrums and YM6 timer effects are imported with their samples.
* You get the piano roll, the YM preview and the exports SNDH / YM5 / game kit / WAV / regs, and **Edit as AY patterns →** to turn the tune into patterns ([Edit an existing SNDH or YM tune](#howto-edit-tune)). SNDH timer-interrupt effects are recognised and classified (digidrum, Q, S, U); one drum and one effect at a time, so overlapping ones keep the first and the import says how many it dropped.

## Convert a recording (WAV, MP3) {#howto-audio}

1. Press **Load…** and pick a `.wav`, `.mp3`, `.ogg`, `.flac` or `.m4a` file (or drop it on the page). Decoding uses your browser, so the formats are the ones your browser plays; WAV always works.
2. The *Transcribed recording* panel shows what was found. The first **120 seconds** are analysed; set **Start (s)** and **Seconds** to analyse another part (up to 600 s).
3. Press **Space** to hear the YM2149 version. Change **Voices** (1 for a melody, 3 for chords), **Gate (dB)** (higher drops quiet notes and noise), **Gain (dB)**, **Snap to notes** and **Noise** and listen again; the analysis re-runs when you change a setting.
4. Export (SNDH, YM, game kit, WAV, regs) or press **Edit as AY patterns →** to tidy the result by hand.

How it works: every 20 ms frame is analysed with a 93 ms window; up to three harmonic series are found (strongest first, each taken out of the spectrum before the next is looked for), tracked so that every voice keeps its note, snapped to semitones when within a third of a semitone, and given the nearest of the chip's 16 volume steps. What is left in the high band becomes the noise generator on a free voice. A recording that is tuned away from A = 440 Hz is corrected (the *Voice use* line shows the offset).

Limits: single instruments, bass lines, chords of up to three notes and chiptune-like music come out well. A full mix has far more than three notes at once, so you get a sketch of the strongest ones. Single-frame notes, very low notes (below about 32 Hz) and very high ones (above about 1.6 kHz) are not found. Vocals and noisy sounds give wobbly pitches; try 1 voice and a higher gate.

## Load maxYMiser, Arkos and `.ymt` files {#howto-load-other}

All three are in the **AY pattern editor** tab:

* **Load .ymt…** — YM Tracker songs. Step tables written by this tool are kept; the YM Tracker ignores them (it shows plain default instruments).
* **Load .sndh/.ym…** — turns a register dump into patterns ([Edit an existing SNDH or YM tune](#howto-edit-tune)).
* **Load maxYMiser…** — select the `.mys` song **and** its `.myv` voice bank in the same dialog (Ctrl/Shift-click): the song loads as patterns and all its instruments come in as step-table instruments. A single `.myi` instrument replaces the instrument that is selected in the instrument list (select the slot first; **Ctrl+Z** undoes it). A `.myv` on its own cannot be loaded, and if a `.mys` and a `.myi` are picked together only the song is loaded. What cannot be carried over (the STe DMA track, some effects) is listed in the red message under the song bar.
* **Load Arkos…** — an Arkos Tracker 3 `.aks`. Arkos Tracker 2 files are rejected with a message. After loading, the warnings list what was not imported (sample instruments, notes outside C-1…B-8, mid-note arpeggio/pitch-table changes, extra PSGs).

## Export {#howto-export}

| Goal | Do this |
|---|---|
| Play on a real Atari ST or emulator | **SNDH (.sndh)**. Copy it to the ST (or an emulator's disk) and play it with an SNDH player, or open it in a PC player that supports SNDH. Timer C 50 Hz is declared in the header (`TC50`). |
| Play in ST-Sound, YM player or Winamp plugin | **YM (.ym)**. A plain `YM5!` file, or `YM6!` if the song has drums or timer effects. |
| Put the music into your own Atari game | **Game kit (.zip)**: `<name>.h` + `ymplay.h`. Call `ymplay_start(<name>_data, <NAME>_FRAMES, <NAME>_LOOP_FRAME, <NAME>_LOOP_OFFSET)` once, then `ymplay_step(); ymplay_write();` every 50 Hz tick in supervisor mode. With digidrums or timer effects also call `ymdrum_init(<name>_drums)` once and `ymdrum_exit()` at the end. Read the comment at the top of `ymplay.h`. |
| Hear it on your PC | **Preview (.wav)**. |
| Continue in maxYMiser | **maxYMiser (.mys + .myv)** from the pattern editor. Load both files in maxYMiser. |
| Continue in Arkos Tracker 3 | **Arkos Tracker (.aks)** from the pattern editor. |
| Continue in Furnace | **Furnace (.fur)** from the pattern editor. |
| Share one instrument | **Instrument (.myi)** — the selected instrument as a maxYMiser instrument. |
| Analyse or re-import | **Raw regs (.regs)** (converter) / **Registers (.regs)** (editor): 14 bytes per frame. |

The Converter tab exports the converted module directly; the pattern editor exports the edited song. After *Edit as AY patterns* only the editor's exports include your manual changes.

## Use the command line {#howto-cli}

The same exporters run in Node (`npm install` first):

```sh
npx tsx scripts/export-cli.ts song.mod out/          # .ym .sndh .h .regs (set WAV=1 to also write .wav)
npx tsx scripts/convert-cli.ts song.xm out/song      # frame converter: register dump + report
npx tsx scripts/song-cli.ts song.xm [arpFill]        # convert to a pattern song and compare with the frame converter
npx tsx scripts/import-cli.ts tune.sndh out.regs     # run an SNDH / read a YM into a register dump (optional: subtune seconds)
```
