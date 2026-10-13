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

**Speech model (first use).** callrec uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with the
multilingual `ggml-small-q5_1.bin` model (190 MB). The app shows a card with a **Download** button and a progress
bar. The file is checked against a pinned SHA-256. If your network blocks the download (company proxy):

1. On another network, download
   <https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin>.
2. Click **Choose model file…** in callrec. Or copy the file into the models folder,
   `%APPDATA%\callrec\models\` (the **Open models folder** button opens it).

On computers with fewer than 8 logical CPUs callrec picks `ggml-base-q5_1.bin` (60 MB) instead: it is less accurate
but keeps up with live speech. If the app warns that Whisper is behind, pick a smaller model. Settings › Whisper model
switches between base, small and `ggml-large-v3-turbo-q5_0.bin` (574 MB). Large is more accurate, but only fast enough
on a strong CPU. Any whisper.cpp `ggml-*.bin` model works through **Choose model file…**.

**Permissions.** Windows Settings › Privacy & security › Microphone must allow *Microphone access* and *Let
desktop apps access your microphone*. callrec shows a button that opens that page if access is off. System audio
needs no permission; it is captured from the default output device (speakers or headset) via WASAPI loopback.

Start/stop shortcut: **Ctrl+Alt+Shift+R** (Ctrl+Shift+R is Outlook's Reply All). You can change it in Settings.
Closing the window quits the app.

### macOS (Apple silicon)

Open the `.dmg` and drag callrec to Applications. Because the app is unsigned, the first time you must right-click it and choose **Open**.
Permissions: Microphone, Screen & System Audio Recording (for the other side) and Speech Recognition (Native engine).
The app shows buttons that open the right System Settings panes. Shortcut: **Cmd+Shift+R**.

## Engines and languages

| Engine | Where | Notes |
|---|---|---|
| **Whisper** (whisper.cpp) | Windows default; macOS optional | On-device. Spanish, English, or *Spanish (+ English words)*, which detects the language for each utterance. |
| **Native Mac** | macOS default | Apple's on-device engine; the Spanish model may need a one-time download, which the app offers. It cannot switch languages: the mixed setting listens in Spanish only. |
| **Deepgram Nova-3** | both | Cloud. Needs your own API key, which Settings stores encrypted with the OS keychain (Electron `safeStorage`). Mixed = Deepgram `multi`. |

Whisper runs in a local `whisper-server` process that only listens on `127.0.0.1`. callrec cuts each side's audio
into utterances (voice-activity detection), and each line appears shortly after the speaker pauses.

## Output

Meetings are saved to `<root>/YYYY-MM-DD HHmm <title>/`. The default root is `Documents/callrec` in your home folder. Audio chunks
(every 3 s) and every finished transcript line are written as they arrive, so a crash keeps everything recorded so far.
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

[MIT](LICENSE). whisper.cpp is MIT-licensed and its licence ships next to the binary. Whisper models are MIT-licensed by OpenAI.
