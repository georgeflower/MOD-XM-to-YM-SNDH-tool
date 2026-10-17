# Troubleshooting {#troubleshooting}

## Loading and playback {#troubleshooting-load}

| Problem | Cause and fix |
|---|---|
| **A · Original** is greyed out | The original side uses libopenmpt in an AudioWorklet, which browsers refuse when the page is opened from disk (`file://`). Serve the folder over http(s) (any static host, `python3 -m http.server`, or the published site). Everything else works from disk. |
| No sound at all | Browsers start audio only after a click. Press **▶ Play** (or Space) once; check the tab is not muted. |
| The preview takes seconds to update | The conversion runs in your browser: a quarter of a second after the last change, then 1–3 s for a long song. The status text shows *Converting…* / *Rendering…*. Changing a priority while playing is fine; the new version replaces the old one. |
| An XM used to be refused with *Amiga-frequency XM files are not supported* | An XM saved with FastTracker 2's **Amiga** frequency table (Instrument/Options: not *Linear*) is now loaded. Notes, samples and tempo are the same as in a linear XM; slides (`1xx 2xx 3xx 5xy E1x E2x X1x X2x`), vibrato and the instrument auto-vibrato act on periods the way FT2 does in that mode, so the same parameter slides high notes faster than low ones. The one remaining difference is that this tool uses exact periods, where FT2 rounds them to its period table (a fraction of a cent to a few cents on very high notes). |
| "not a MOD or XM file" | The contents were not recognised. Packed or Impulse Tracker / S3M files are not supported. Check the file is not a renamed archive. |
| A `.sndh` says *did not return* | The tune's init or play routine waits for hardware that is not emulated (for example a busy-wait on a timer data register). Try another subtune or a shorter *Seconds* value. |
| An `.ym` has the wrong length or no loop | YM files carry their own loop frame; if none is stored the tune plays once. For SNDH the loop is detected; *Seconds* overrides the length. |
| The demo does not start | Press **Demo: Omar's Bazaar** after the page has fully loaded; the demo is embedded in the page, so no network is needed. |

## The conversion sounds wrong {#troubleshooting-sound}

| Symptom | What to try |
|---|---|
| The melody keeps disappearing | Give its channel **Lead** (manual import) or press **+** a few times; check *Dropped* in *Source channels*. Switch on **Arp fill** so lost chord notes survive as arpeggios. |
| Notes jump between voices, clicks | Raise **Voice stickiness**. |
| Drums swallow the melody | Lower **Drum priority**; or lower the drum channel's priority. |
| Drums are missing | Check the drum instrument is not set to *mute* and the drum channel is not *Off*. With digidrums, make sure *Percussion as digidrums* or the *digidrum (sample)* role is set. |
| Drums sound thin | Use digidrums (a higher **Drum rate**, 10–12 kHz) or set the instrument role to *kick / snare / hat* to use the better-fitting synthetic drum. |
| Bass is too quiet or too high | **Level** up; **Tr.** of the bass instrument −12; or *Bass + drums on the middle voice*. |
| A tonal instrument sounds like noise or at the wrong pitch | Set its AY role to *tone (written note)* and/or correct **Tr.** The measured pitch (**C-4**) comes from the sample; very short or noisy samples measure badly. |
| The buzzer bass never appears | The buzzer is used only for loud notes (level ≥ 12) at low pitch (envelope period ≥ 32, up to about 240 Hz for a saw), one voice at a time. Raise **Level**, or force *saw buzzer* on that instrument. |
| Everything sounds a bit "dull" or "buzzy" | That is the chip: 3 voices, square waves, 16 volume steps. Use the editor to write a more idiomatic version. |

## Edit as AY patterns from an SNDH or YM {#troubleshooting-fromregs}

| Problem | Cause and fix |
|---|---|
| There is no **Edit as AY patterns** button | Load the file first: the button is in the *Loaded tune* panel (below the Composer field), or use **Load .sndh/.ym…** in the pattern editor. |
| One frame per row; patterns are very long | The tune has no regular tempo that the note starts agree with (the report says *no regular tempo found*), for example because of swing, frequent speed changes or a play rate that is not 50 Hz. The result is still accurate; shorten the work with **Repeat** / **Clone pat**, or re-time it by hand. |
| The notes are all there but there are no arpeggios or vibrato effects | The register dump only says what the voice did, so these are inside the step-table instruments. Open the instrument (double-click) to change them. |
| Instruments are called *Tone 0A*, *Buzzer 12* | They are named by what they do. Rename them in the instrument editor. |
| *distinct sounds do not fit in 255 instruments* | The most similar ones were merged. If the difference matters, import fewer subtunes or shorter sections, or fix the affected notes by hand. |
| An SNDH from maxYMiser or another STe player sounds different from the original | It plays samples through the STe DMA sound chip, which a YM register dump cannot hold. The importer turns the sample hits into digidrums on voice C (coarser, and voice C is silent while a sample plays), see the **STe samples** checkbox. A tune that checks for hardware the emulator does not model may still skip its DMA part; the warning *init routine did not return … stuck at offset $…* names where. |
| A drum plays on the wrong voice | The drum column always plays on voice C. The report says how many hits were moved. |
| The first notes are late or a *no free effect slot* warning | A tune that starts a few frames before its first row needs `F` speed effects on rows 0 and 1; they were not possible because every channel already had an effect there. Move the effect and add the `F` cells by hand. |
| The editor sounds slightly different from the original | Pitches are snapped within about 7 cents and merged instruments differ by a level step. For an exact copy use the Converter tab: the original dump is exported untouched. |

## Pattern editor {#troubleshooting-editor}

| Problem | Cause and fix |
|---|---|
| Typing notes does nothing | Edit mode is off. Press **Space** (when stopped) or **○ Edit**. Note keys always audition. |
| A digidrum does not play | The instrument in that cell has no drum of that number (the status line and export warnings say so), or another drum is still playing. Open **Drums…** and check the bank. |
| `Z` or the drum channel plays nothing after load | The song is from an export that cannot carry digidrums (Arkos, Furnace). |
| The effect `Q`/`S`/`U` seems to do nothing | It needs a sounding note on that voice, and a rate inside 48 Hz–20 kHz. A new note without the effect ends it. Only one timer effect runs at a time. |
| Slides sound different on different notes | `1xx`/`2xx` are in period units, so the same value is a larger musical interval on higher notes. |
| A buzzer instrument disturbs another voice | The envelope generator is shared: only one buzzer can sound at a time, and its shape and period are those written last. |
| The `.ymt` opens in the YM Tracker with default instruments | The YM Tracker ignores step tables (this tool's extension). Classic instruments are kept. |

## Export {#troubleshooting-export}

| Problem | Cause and fix |
|---|---|
| Warnings under the export buttons | Each lists an effect or feature the format cannot carry; the file is still written. See the matrices in [Concepts](#concepts-matrix) and [Effects](#effects-matrix). |
| Digidrums or timer effects missing in a `.ym` | Players that only know `YM5!` ignore them. The tool writes `YM6!` when they are present; use an ST-Sound-compatible player. |
| Sync-square has no effect in the `.ym` | It exists only in SNDH, the game kit and the WAV preview; the YM format has no place for it. |
| maxYMiser does not find the voices | Load the `.mys` **and** the `.myv` voice bank (they are in the same zip). |
| Arkos reports an unsupported version | The tool reads and writes Arkos Tracker **3** files (formatVersion 3.0). Re-save an Arkos Tracker 2 song in Arkos Tracker 3 first. |
| Furnace refuses the file | Furnace 0.6.8 or newer is needed (format 228). |
| The SNDH is silent in a player | Players that do not honour the `TC50` tag play at their default rate. The file declares Timer C 50 Hz; use a standard SNDH player (on a real ST or in an emulator, or a PC player that supports SNDH). |
| The game kit crashes | The functions must be called in supervisor mode; with digidrums or effects call `ymdrum_init(...)` first, `ymdrum_exit()` at the end, and keep Timer A and D free. |

## Files and privacy {#troubleshooting-privacy}

* Your files are never uploaded. All conversion happens in the browser; the page's only outside request is the page-view counter (GoatCounter, `qumran.goatcounter.com`: no cookies, no personal data, nothing from your files) besides loading itself and, over http, the vendored libopenmpt files.
* Settings are not stored between sessions (except the documentation's light/dark choice). Use **Save mapping** and **Save .ymt** to keep your work.
* There is no auto-save: closing the page discards the pattern editor song. The editor asks before replacing a song that has unsaved changes.

## Getting help {#troubleshooting-help}

Include the file type, what you did and the *Conversion report* (or the warnings) when you report a problem. The source and issue tracker are at <https://github.com/georgeflower/mod-xm-to-ym-sndh-tool>.
