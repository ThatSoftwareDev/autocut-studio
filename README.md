# AutoCut Studio

A local Premiere Pro panel that speeds up the rough-cut stage of editing. It removes silences, adds punch-in zooms with a matching sound effect, and places B-roll based on what is being said.

Everything runs on your own machine. The panel talks to a small Python service on `127.0.0.1`. Nothing is uploaded, there is no account and no subscription. The only network access is the one-time Whisper model download, which you start yourself.

Status: panel 0.2.1, helper service 0.2.0. Silence removal has been used on real footage. Zoom, swoosh and B-roll are covered by automated tests against a simulated Premiere and still need more real-world testing (see [Known limitations](#known-limitations)).

## Why

Editing long-form speech starts with the same mechanical processes every time: cut the silences, punch in for emphasis, drop in B-roll when the speaker mentions something. That is hours of work before the creative part begins. AutoCut Studio does those passes up front, so you open a timeline that is already roughed out.

## Features

1. Silence removal, with separate padding before and after speech (defaults 80 ms in, 150 ms out) and a tail guard (default 6 dB) so quiet word endings are not cut off.
2. Automatic zoom in three modes: camera switch, slow zoom, or punch-in on emphasis. Strength 105-125 %, optional ease in/out.
3. Swoosh: places your own soundeffect at the start of every zoom (default track A2).
4. B-roll: local transcription (faster-whisper) plus keywords from your B-roll folder. Clips are placed on V2 without audio.

Every step is shown as a preview list first. Nothing is applied until you confirm, and it is applied to a copy of the sequence, never to the original.

## Requirements

Windows, Adobe Premiere Pro (CEP panels), and three free tools:

- Python 3.11 or 3.12 (tick "Add python.exe to PATH" in the installer)
- ffmpeg, which includes ffprobe: `winget install Gyan.FFmpeg`
- Node.js LTS

## Installation

The panel UI is currently in German. Control names in this README are translated.

### Helper service

Run these from `sidecar\`:

1. `setup.bat` creates the virtual environment, installs numpy and faster-whisper and runs a self-test. It should end with `OK`.
2. `download-model.bat` downloads the Whisper model once (`small`, about 0.5 GB) into `sidecar\models`. `download-model.bat base` is faster but less accurate. Only needed for B-roll.
3. `start-sidecar.bat` starts the service. Keep the window open. It prints the helper version, the ffmpeg location and the available Whisper models.

### Panel

This repo contains the project-specific files only (`panel-overlay/`). They are copied over a Bolt CEP project.

New project:

```
npx create-bolt-cep
```

Choose React, Premiere Pro, and install dependencies. Then copy the overlay and build:

```powershell
Copy-Item -Recurse -Force "C:\path\to\autocut-studio\panel-overlay\*" ".\autocut-panel\"
cd autocut-panel
npm run build
```

To update an existing project, repeat the copy and build steps. Restart Premiere afterwards, or close and reopen the panel.

### CEP debug mode

Premiere only loads unsigned CEP panels when debug mode is on. Double-click `scripts\enable-cep-debug.reg`, confirm the registry change, and restart Premiere completely.

### Open the panel

Window > Extensions (Legacy) > AutoCut Studio. For debugging, the panel console is at `http://localhost:8860`.

## Usage

### Swoosh file

No sound file is included, so add your own.

- Default location: `Documents\AutoCut Studio\swoosh.wav`. The panel creates the folder on first launch and shows the path in orange while the file is missing.
- Another file or location: use Browse in the Swoosh section. The path is saved. Default resets it.
- The file is imported once into a project bin called "AutoCut Assets" and reused from there. The tool does not change the volume, so set the level beforehand.
- Recommended: WAV, 48 kHz, 0.3-0.8 s. If the audible peak is not at the start of the file, set a negative offset (for example -150 ms) so the peak lands on the zoom.
- If the swoosh track (default A2) is already occupied at a position, no swoosh is placed there and the result lists those positions. If A2 does not exist, the panel says so. Create it via right-click on the track headers.

### B-roll matching

1. Choose a folder. Subfolders are searched up to 3 levels deep. Supported: video (mp4, mov, mkv, webm, m4v, avi, mxf, mts) and images (jpg, jpeg, png, webp, bmp, tif). Images are inserted for the length set under "B-roll length". Other files, such as .heic, are ignored and listed in a notice.
2. Keywords come from the file name (split at `_`, `-`, `,`, `.` and spaces), from a `.txt` file with the same name, and optionally from a `broll-tags.json` in the folder.
   - `haustier_hund_welpe.jpg` gives haustier, hund, welpe. Each word counts on its own, so if the speaker says only one of them, the file is eligible.
   - `haustier_hund_welpe.txt` containing `Napf, Garten, spielen` adds those words.
   - `{"tiere/garten.mp4": ["Garten", "Morgenroutine"]}` in `broll-tags.json` adds tags by relative path.
   - "Show keywords" displays what the tool reads from your files. Filler words such as "und", "video" and "final" are ignored.
3. Transcription runs locally with faster-whisper on CPU (model `small`, int8). The transcript is also saved as JSON under `%LOCALAPPDATA%\AutoCutStudio\transcripts`.
4. Matching ignores case, normalizes umlauts ("füttern" matches "Futter", "Kueken" matches "Küken"), strips simple endings ("Welpen" matches "Welpe") and detects compounds ("Haustierfutter" contains "Haustier"). The rules are aimed at German text.
5. Placement on V2 in the cut copy: start shortly before the keyword (lead-in), length as configured (shorter if the clip is shorter), a minimum gap between two B-rolls, and each clip used once by default. Words that fell into a removed pause are not used.
6. Audio: the track is checked before insertion, then the clip's audio is unlinked and deleted. Afterwards the tool verifies that all audio tracks are exactly as before.
7. Scale to fill (default on): for example 4K B-roll in a 1080p sequence is set to 50 %. If your Premiere preference "Default Media Scaling" is already "Scale to Frame Size", turn this option off.

A CLIP-based image match that also recognises untitled clips could be added later as a second stage.

### Zoom modes

| Mode | Behaviour | Swoosh |
|---|---|---|
| Camera switch | First segment at 100 %, next at the zoom strength, then back to 100 %. Switches no sooner than the minimum gap. Hard cuts, no ease. | At every switch to the zoomed shot |
| Slow zoom | Inside each speech segment (from a configurable minimum length), from 100 % to the zoom strength. | At the start of each segment |
| Punch on emphasis | At passages clearly louder than your normal speech level (threshold in dB): 0.2 s in, hold, 0.2 s out. Signal analysis only, no ML. Minimum gap applies. | At the start of each zoom |

Keyframes always stay inside a single clip segment. If a punch ends at the end of a segment, the next cut resets to 100 % anyway. Clips that already have scale keyframes are left alone.

### Trying it out

1. Take a 1-3 minute recording and create a sequence from the clip. Make sure V2 and A2 exist and are empty.
2. Put soundeffect in `Documents\AutoCut Studio` and 3-5 clips with descriptive names into a B-roll folder.
3. Analyze, then check word endings with the preview (raise Padding Out if needed).
4. Enable zoom and pick a mode, enable swoosh, enable B-roll, choose the folder, transcribe.
5. Review the preview, untick what does not fit, and apply to the copy.
6. Check the zoom keyframes in Effect Controls, the swooshes on A2, the B-roll on V2 (no audio), and lip sync at the end of the sequence.

## Project structure

```
autocut-studio/
├─ README.md
├─ scripts/enable-cep-debug.reg        lets Premiere load the unsigned panel
├─ sidecar/                            Python helper
│  ├─ setup.bat                        one-off: environment, numpy, faster-whisper, self-test
│  ├─ download-model.bat               one-off: download Whisper model
│  ├─ start-sidecar.bat                start the helper
│  ├─ requirements.txt
│  ├─ bin/                             optional: ffmpeg.exe and ffprobe.exe
│  ├─ models/                          created by download-model.bat
│  ├─ autocut_sidecar/
│  │  ├─ server.py                     HTTP server (127.0.0.1 only, origin check)
│  │  ├─ ffmpeg_tools.py               locate ffmpeg, stream audio
│  │  ├─ silence.py / analysis.py      silence detection, padding, tail guard
│  │  ├─ timeline.py                   original timeline -> cut copy
│  │  ├─ zoom.py                       camera switch, slow zoom, emphasis (signal analysis)
│  │  ├─ broll.py                      index B-roll folder, keywords, matching
│  │  ├─ plan.py                       full plan (zooms, swooshes, B-roll) in frames of the copy
│  │  └─ transcription/
│  │     ├─ base.py                    swappable interface
│  │     ├─ faster_whisper_engine.py   CPU, int8 (CTranslate2 has no AMD GPU support)
│  │     ├─ whisper_cpp_engine.py      placeholder for a later whisper.cpp + Vulkan backend
│  │     └─ service.py                 background job, progress, cache, JSON export
│  └─ tests/
└─ panel-overlay/                      copied into a Bolt CEP project
   ├─ cep.config.ts
   ├─ src/shared/autocut-types.ts      shared types, panel <-> Premiere
   ├─ src/jsx/ppro/                    Premiere layer (ExtendScript)
   │  ├─ common.ts
   │  ├─ autocut.ts                    copy, cut, close gaps, verify
   │  └─ enhance.ts                    zoom keyframes, swoosh, B-roll, track comparison
   ├─ src/js/lib/
   │  ├─ premiere.ts                   Premiere adapter (the only place using evalTS)
   │  ├─ applySilenceCuts.ts           cutting flow
   │  ├─ applyEnhancements.ts          zoom -> B-roll -> swoosh flow with track checks
   │  └─ sidecar.ts / settings.ts / files.ts
   ├─ src/js/main/                     UI: workflow, silence, zoom and B-roll panels
   └─ tests/premiere-sim/              flow tests against a simulated Premiere
```

## Challenges

Premiere's scripting API is the hard part. `overwriteClip` and `setInPoint` are described inconsistently in Adobe's documentation (ticks in one place, seconds in another), so the panel tries the variants, measures the result and remembers the one that works. `razor()` belongs to the unofficial QE interface, so the outcome is verified after every step. Bezier interpolation for the zoom ease is set and then measured. If it does not come out smooth in a given Premiere version, the tool falls back to an exactly computed ease curve built from intermediate keyframes and says so in the result.

CEP cannot group steps into a single undo. The safety net is therefore structural: work on a copy of the sequence, and compare all tracks after every step. Only the target track may change. Otherwise the run aborts, and V1/A1 (the original recording) stay untouched.

The first silence cutter clipped word endings. Separate padding before and after speech, plus the tail guard (quiet audio just below the threshold at the edge of a pause still counts as speech), fixed most of it.

For B-roll, the matching turned out to be less a lookup than a normalization problem: case, umlauts, endings and compound words all decide whether "Haustierfutter" in a transcript finds a file named `haustier.jpg`.

## Troubleshooting

| Message | Fix |
|---|---|
| Helper not reachable | Start `start-sidecar.bat`, then "Check again". |
| Whisper model not downloaded | Run `download-model.bat`, restart the helper. |
| ffprobe not found | Install an ffmpeg package that includes ffprobe (winget), or put `ffprobe.exe` next to `ffmpeg.exe` in `sidecar\bin`. |
| Swoosh file not found | Put it at `Documents\AutoCut Studio\swoosh.wav` or choose it via Browse. |
| Video track V2 / audio track A2 does not exist | Create the track in the sequence and apply again. |
| None of the keywords occur | Check "Show keywords", rename files or add `.txt` tags. |
| No clear emphasis found | Lower "Emphasis from" (for example to 4 dB). |
| Track was changed unexpectedly | The run aborted for safety. Delete the copy and open an issue with the message. |
| Abort while applying | The original is unchanged. Delete the partial copy in the Project panel. |

## Known limitations

- Undo: CEP cannot bundle steps, so the copy is the safety net. Parts of the Premiere layer rely on undocumented behaviour (see Challenges), which is why every step is verified.
- Whisper often drops filler words ("äh"). That does not affect B-roll, but it matters for the planned stumble detection.

## Built with

[Bolt CEP](https://github.com/hyperbrew/bolt-cep) for the panel scaffolding, [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with OpenAI's Whisper models for transcription, and ffmpeg for audio and media probing.
