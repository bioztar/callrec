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
  the tray tooltip shows *finalising 43% · CPU 100%*, the window *Finalising transcript… 43%*, and a notification
  says when it is done).

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
call; **Quit** stops a running recording cleanly first. Windows shutdown or sign-out never waits on callrec: a
running recording is closed on the spot and its final pass runs on the next launch. callrec does not start at login. Recording works with the
window hidden (tray menu or shortcut).

**Finalising speed.** The tray menu's **Finalising speed** (20 % / 40 % / 60 % / 80 % / 100 % (max), default 100 %)
sets how much of the CPU the final pass may use; a change applies within seconds, mid-pass, and the final pass
always runs at below-normal priority so the apps you are using come first. Starting a new recording drops the
final pass to 20 % so the live draft keeps up, and Stop returns to your chosen level (a level you pick during the
call applies right away, until Stop). While it runs, the tray tooltip shows progress, time left (measured from
this pass's own speed, shown after the first few percent) and the level, e.g. *callrec — finalising 43% · ~25 min
left · CPU 100%*.

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
below 1 is faster than real time). CI runs it on `windows-latest` and `macos-latest` (job summary + `bench-*.json`
artifact). On the `windows-latest` runner (4 vCPU, AMD EPYC 7763):

| model | runtime | WER es | WER en | WER mixed | mean WER | RTF |
|---|---|---|---|---|---|---|
| **Parakeet TDT 0.6B v3** int8 | sherpa-onnx | 3.7 % | 0.0 % | 3.8 % | **2.5 %** | **0.14** |
| Whisper base q5_1 | whisper.cpp | 14.8 % | 0.0 % | 7.7 % | 7.5 % | 0.61 |
| Whisper small q5_1 | whisper.cpp | 11.1 % | 0.0 % | 11.5 % | 7.5 % | 2.40 |
| Whisper large-v3-turbo q5_0 | whisper.cpp | 11.1 % | 0.0 % | 11.5 % | 7.5 % | 11.48 |
| Whisper large-v3 q5_0 | whisper.cpp | 3.7 % | 0.0 % | 3.8 % | 2.5 % | 14.09 |

The fixtures are short, so the WER spread is small; the only Spanish error left is "Hola" heard as "El".

### Final-pass speed with Whisper

whisper.cpp pads every request to 30 s of audio, so callrec packs a side's consecutive utterances into one
request of up to 28 s (pauses cut to 0.4 s) and maps the words back to their utterance and time by their word
timestamps. Utterances that come back from their window with no text (Whisper sometimes merges, drops or stops
early, e.g. an English line after a Spanish one) are decoded again, re-packed once and then on their own, so packing
never loses speech. On a laptop
speaker setup the mic also re-hears the other side: callrec transcribes *Them* first and skips mic audio before
decoding only when it is at least 1 s long, inside their speech, at least 10 dB quieter, tracks their loudness
closely and has no moment louder than their echo would be; anything less certain is decoded, and the old text
check still runs after. Parakeet needs neither. The live draft stays one request per utterance, so lines appear as
soon as the speaker pauses. Each meeting's `final-pass.json` records model, threads, audio and wall time, RTF,
requests, windows, re-decodes and echo skipped, and the log gets one line per pass.

`npm run bench:call` runs the real final pass on a 4-minute two-speaker ES/EN call
([test/fixtures/call](test/fixtures/README.md)) at 100 %; RTF here is wall time / call length (1.0 = a 1 h call
takes 1 h).

| model | final pass | Windows runner, 60 s | Windows runner, 4 min | 8-thread Linux VM, 4 min | WER Me (es) / Them (en), 4 min |
|---|---|---|---|---|---|
| Whisper large-v3-turbo q5_0 | before: one request per utterance | 33.4 | – | 6.58 | 4.6 % / 3.6 % |
| Whisper large-v3-turbo q5_0 | **now: packed + echo skipped** | **4.69** | **3.28** | **0.70** | 6.9 % / 2.3 % |
| Whisper large-v3 q5_0 | before | 37.2 | – | 7.84 (60 s) | – |
| Whisper large-v3 q5_0 | **now** | **5.88** | **3.53** | **0.94** | 5.4 % / 2.6 % |
| Parakeet TDT 0.6B v3 int8 | unchanged | – | 0.21 | 0.08 | 4.6 % / 3.3 % |

RTF = wall time / call length. Windows runner: `windows-latest`, 4 vCPU AMD EPYC 7763, 4 threads, below-normal
priority, as the app runs it; the 60 s rows are the first minute of the call (the old path takes ~33× call length
there, too slow for CI on the full call). The 8-thread VM is an Intel Xeon on Linux; Windows on the runner is much
slower per thread, so expect a laptop somewhere in between. The runner is noisy (about ±25 % between runs of
the same code), so treat one run as a rough figure. The Me WER is higher than with the old path mostly because the
cautious echo filter now decodes a few echo lines that Whisper translates into Spanish ("Bye." → "Adiós"), which
the text check can't match; that is the price of never dropping real speech. whisper.cpp built with clang-cl
(`-T ClangCL`) was faster in one run and slower in two (turbo 3.52 vs MSVC 3.28 on the last), so the release
keeps the static MSVC build (`CALLREC_WHISPER_TOOLCHAIN=clangcl` builds the other one).

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
npm run bench                # WER + speed of every model in vendor/models
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
