# callrec

A desktop meeting recorder for **Windows 10/11** and **macOS**. It records both sides of a call: the other side through
system audio ("Them") and you through the microphone ("Me"). It transcribes them live **on your computer** and
saves one folder per meeting: `audio.webm`, `transcript.md`, `transcript.json`.

It does not join meetings and has no account and no cloud backend. It works with any call app (Zoom, Meet, Teams, a
browser tab…) because it listens to the computer's output.

## Download

Get the latest build from [Releases](https://github.com/bioztar/callrec/releases). The builds are unsigned and come from GitHub Actions.

### Windows

- `callrec-<version>-portable-x64.exe`: a single file. No installer and no admin rights. Double-click it.
- `callrec-<version>-win-x64.zip`: unzip it anywhere, e.g. `Documents\callrec`, and run `callrec.exe`. Use this
  one if your company blocks programs that unpack into `%TEMP%`; the portable `.exe` does that on every start.

Windows SmartScreen will say "Windows protected your PC" (unknown publisher). Click **More info → Run anyway**.

**Speech models (first use).** callrec transcribes twice, on the device:

- **Live model**: a draft while the call runs, line by line.
- **Final model**: after **Stop**, re-transcribes the whole recording for a better transcript (in the background;
  the tray tooltip and the window show *Finalising transcript… 43%*, and a notification says when it is done).

The default for both is [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (int8, 670 MB,
25 European languages including Spanish and English, detects the language itself). It ran faster than real time
and was as accurate as Whisper large-v3 in our benchmark (below). The app shows a card with a **Download** button
and a progress bar; every file is checked against a pinned SHA-256. **Settings › Live model / Final model** can also
pick a Whisper model ([whisper.cpp](https://github.com/ggml-org/whisper.cpp): base, small, large-v3-turbo, large-v3).
Download always fetches the model you selected; if it is not there yet, Settings says which installed model is used
in the meantime.

If your network blocks the download (company proxy), get the files on another network and put them in the models
folder, `%APPDATA%\callrec\models\` (**Open models folder** opens it), or use **Choose model file…**:

- Parakeet: the four files `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt` from
  <https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tree/2bda32ec70b097a55adaa07d9a7173915b43cc78>,
  in one folder. Choose `encoder.int8.onnx`; the other three must sit next to it. They are copied to
  `models\parakeet-tdt-0.6b-v3-int8\`.
- Whisper: e.g. <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin>. Any whisper.cpp
  `ggml-*.bin` file works.

**Tray.** callrec lives in the notification area (the icon gets a red dot while recording; the tooltip shows the
elapsed time). Left-click shows the window. Right-click: **Start/Stop recording** (with the shortcut), **Show callrec**,
**Open recordings folder**, **Quit**. Closing the window (✕) keeps callrec running in the tray, ready for the next
call; **Quit** stops a running recording cleanly first. callrec does not start at login. Recording works with the
window hidden (tray menu or shortcut).

**Permissions.** Windows Settings › Privacy & security › Microphone must allow *Microphone access* and *Let
desktop apps access your microphone*. callrec shows a button that opens that page if access is off. System audio
needs no permission; it is captured from the default output device (speakers or headset) via WASAPI loopback.

Start/stop shortcut: **Ctrl+Alt+Shift+R** (Ctrl+Shift+R is Outlook's Reply All). You can change it in Settings.

### macOS (Apple silicon)

Open the `.dmg` and drag callrec to Applications. Because the app is unsigned, the first time you must right-click it and choose **Open**.
Permissions: Microphone, Screen & System Audio Recording (for the other side) and Speech Recognition (Native engine).
The app shows buttons that open the right System Settings panes. Shortcut: **Cmd+Shift+R**.
macOS behaves as before (the window's close button quits); the menu bar also gets the callrec icon with the same menu.

## Engines and languages

| Engine | Where | Notes |
|---|---|---|
| **On-device** (Parakeet via sherpa-onnx, or Whisper via whisper.cpp) | Windows default; macOS optional | Spanish, English, or *Spanish (+ English words)*, which detects the language for each utterance. Live draft + final pass after Stop. |
| **Native Mac** | macOS default | Apple's on-device engine; the Spanish model may need a one-time download, which the app offers. It cannot switch languages: the mixed setting listens in Spanish only. |
| **Deepgram Nova-3** | both | Cloud. Needs your own API key, which Settings stores encrypted with the OS keychain (Electron `safeStorage`). Mixed = Deepgram `multi`. |

Parakeet runs in a child process; Whisper in a local `whisper-server` that only listens on `127.0.0.1`. callrec cuts
each side's audio into utterances (voice-activity detection), and each line appears shortly after the speaker pauses.

### Model benchmark

`npm run bench` measures every model present in `vendor/models` on the committed fixtures (Spanish, English, mixed
ES/EN; [test/fixtures](test/fixtures/README.md)): word error rate and real-time factor (RTF, compute time / audio time;
below 1 is faster than real time). CI runs it on `windows-latest` and `macos-latest` (job summary). On a 4-core
x64 cloud VM:

| model | runtime | WER es | WER en | WER mixed | mean WER | RTF |
|---|---|---|---|---|---|---|
| **Parakeet TDT 0.6B v3** int8 | sherpa-onnx | 3.7 % | 0.0 % | 3.8 % | **2.5 %** | **0.12** |
| Whisper small q5_1 | whisper.cpp | 11.1 % | 0.0 % | 11.5 % | 7.5 % | 0.57 |
| Whisper large-v3-turbo q5_0 | whisper.cpp | 11.1 % | 0.0 % | 11.5 % | 7.5 % | 3.06 |
| Whisper large-v3 q5_0 | whisper.cpp | 3.7 % | 0.0 % | 3.8 % | 2.5 % | 3.75 |

The fixtures are short, so the WER spread is small; the only Spanish error left is "Hola" heard as "El".

## Output

Meetings are saved to `<root>/YYYY-MM-DD HHmm <title>/`. The default root is `Documents/callrec` in your home folder. Audio chunks
(every 3 s) and every finished transcript line are written as they arrive, so a crash keeps everything recorded so far.

| File | What |
|---|---|
| `audio.webm` | both sides mixed (Opus), kept |
| `transcript.md`, `transcript.json` | the final transcript once the final pass is done; until then the live draft |
| `transcript.draft.md`, `transcript.draft.json` | the live draft, kept after the final pass |
| `audio-me.wav`, `audio-them.wav` | each side as 16 kHz WAV (~2 MB per minute each), only until the final pass succeeds; then deleted |
| `final-pass.json` | final-pass status |

If you quit during the final pass, it resumes on the next launch; the draft is never overwritten. If the Final model
is not installed yet, the meeting waits until it is (the WAV files stay). After three failed attempts callrec gives
up and keeps the draft and the WAV files.
When the mic picks up the other side through your speakers, that echo is dropped from "Me".

## Privacy

With the Whisper and Native engines, **audio never leaves the device**. With Deepgram, audio is streamed to Deepgram's
API under your key. callrec has no telemetry. It makes no other network calls apart from the one-time model download
(and Apple's own model download on macOS).

## Build from source

You need Node 20+, CMake and a C++ compiler (Visual Studio 2022 Build Tools on Windows, Xcode on macOS).

```
npm install
npm run build:whisper        # builds whisper.cpp's whisper-server into vendor/whisper (pinned tag)
npm run fetch:model          # optional: model into vendor/models (for tests and benchmarks)
bash native/stt/build.sh     # macOS only: on-device speech helper (Xcode 26+, macOS 26 SDK; --no-analyzer for older)
npm start
npm test                     # node --test; Whisper tests run when the binary + model are present
npm run bench                # Whisper speed on this machine
npm run dist:win             # Windows: portable .exe + .zip in dist/
npm run dist                 # macOS: unsigned .app + .dmg in dist/
```

If `npm start` says "Electron failed to install correctly" (seen with very new Node versions, where `electron`'s
postinstall can skip extraction), unzip the cached Electron zip into `node_modules/electron/dist` and write the
binary's relative path (e.g. `Electron.app/Contents/MacOS/Electron`) to `node_modules/electron/path.txt`.

## Test hooks

`CALLREC_AUTORUN_SEC=N` records N seconds, then quits. It records real audio, so use it deliberately. CI also uses
`CALLREC_USER_DATA` (a throw-away profile), `CALLREC_FAKE_MIC_WAV` (a WAV file as the microphone) and
`CALLREC_AUTORUN_REPORT` (a JSON summary); see `scripts/smoke.js`.

## License

[MIT](LICENSE). whisper.cpp is MIT-licensed and its licence ships next to the binary. Whisper models are MIT-licensed by OpenAI. sherpa-onnx is Apache-2.0. Parakeet TDT 0.6B v3 is CC-BY-4.0 by NVIDIA.
