# How-to recipes {#howto}

Each recipe is self-contained. Words in **bold** are buttons or fields; the full description of each is in the manuals.

## Load a MOD or XM {#howto-load}

1. Press **Load MOD / XM / SNDH / YM / YMT…** at the top, or drag the file anywhere onto the page. (To try it first, press **Demo: Omar's Bazaar**.)
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
3. The conversion report is kept in a collapsed panel above the song bar.
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

## Load SNDH and YM files {#howto-load-sndh}

* **SNDH** (`.sndh`, `.snd`, also ICE!-packed): the file is *run* in a built-in 68000 emulator and the chip writes are captured at 50 Hz. Use **Subtune** to pick one, **Seconds** to set the length (0 = use the TIME tag). Tunes whose player never returns or waits for hardware that is not emulated report *did not return*.
* **YM** (`.ym`: YM2!, YM3!, YM3b!, YM5!, YM6!, LHA-packed): read as the register dump it is. YM5/YM6 digidrums and YM6 timer effects are imported with their samples.
* You get the piano roll, the YM preview and the exports SNDH / YM5 / game kit / WAV / regs. SNDH timer-interrupt effects are recognised and classified (digidrum, Q, S, U); one drum and one effect at a time, so overlapping ones keep the first and the import says how many it dropped.

## Load maxYMiser, Arkos and `.ymt` files {#howto-load-other}

All three are in the **AY pattern editor** tab:

* **Load .ymt…** — YM Tracker songs. Step tables written by this tool are kept; the YM Tracker ignores them (it shows plain default instruments).
* **Load maxYMiser…** — select the `.mys` song **and** its `.myv` voice bank in the same dialog (Ctrl/Shift-click), or a single `.myi` instrument. Instruments are played tick by tick into step tables.
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
