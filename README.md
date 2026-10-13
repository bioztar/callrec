# callrec

A desktop meeting recorder. It records both sides of a call — the other side through
system audio ("Them") and you through the microphone ("Me") — transcribes them live,
and saves one folder per meeting: `audio.webm`, `transcript.md`, `transcript.json`.

It does not join meetings, has no account and no cloud backend. It works with any call
app (Zoom, Meet, Teams, a browser tab…) because it listens to the computer's output.

## Run from source (macOS)

Requires Node 20+ and, for the on-device engine, Xcode 26+ (macOS 26 SDK).

```
npm install
bash native/stt/build.sh     # builds the on-device speech helper
npm start
npm test                     # node --test
npm run dist                 # unsigned .app + .dmg in dist/
```

If `npm start` says "Electron failed to install correctly" (seen with very new Node
versions, where `electron`'s postinstall can skip extraction), unzip the cached Electron
zip into `node_modules/electron/dist` and write `Electron.app/Contents/MacOS/Electron` to
`node_modules/electron/path.txt`.

## Permissions (first run, macOS)

Microphone, Screen & System Audio Recording (for the other side), Speech Recognition
(native engine). The app shows a card with buttons that open the right System Settings
panes.

## Engines and languages

- **Native Mac** (default): Apple's on-device speech engine, free. The Spanish model may
  need a one-time download, which the app offers. Cannot code-switch: "Spanish (+ English
  words)" listens in Spanish only (the UI says so).
- **Deepgram Nova-3**: needs your own API key, entered in Settings and stored encrypted
  with the OS keychain (Electron `safeStorage`). Mixed = Deepgram `multi`.

Global shortcut Cmd+Shift+R (configurable in Settings) and the Recording menu start/stop.

## Output

`<root>/YYYY-MM-DD HHmm <title>/` (default root `~/Documents/callrec`). Audio chunks
(every 3 s) and every final transcript line are written as they arrive, so a crash keeps
everything recorded so far.

## Privacy

With the Native engine, audio never leaves the device. With Deepgram, audio is streamed to
Deepgram's API under your key. callrec has no telemetry.

## Test hook

`CALLREC_AUTORUN_SEC=N npm start` records N seconds and quits. It records real audio, so
use it deliberately.

## License

MIT — see [LICENSE](LICENSE).
