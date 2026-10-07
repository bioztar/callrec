# callrec

Mac meeting recorder: records both sides of a call (system audio = "Them", mic = "Me"), transcribes live with the native macOS speech engine or Deepgram, and saves a folder per meeting (audio + transcript.md + transcript.json). Extracted from InterG's live-capture code; nothing else from InterG.

## Run

```
npm install
bash native/stt/build.sh     # builds the on-device speech helper (needs Xcode / Swift)
npm start
npm test                     # node --test
npm run dist                 # unsigned .app + .dmg in dist/
```

Note: with Node 26, `electron`'s postinstall may silently skip extraction; if `npm start` says "Electron failed to install correctly", unzip the cached Electron zip into `node_modules/electron/dist` and write `Electron.app/Contents/MacOS/Electron` to `node_modules/electron/path.txt`.

## Output

`<root>/YYYY-MM-DD HHmm <title>/` (default root `~/Documents/callrec`): `audio.webm`, `transcript.md`, `transcript.json`. Audio chunks (every 3 s) and each final transcript line are written as they arrive, so a crash keeps everything so far.

## Permissions (first run)

Microphone, Screen & System Audio Recording (for the other side), Speech Recognition (native engine). The app shows a card with buttons that open the right System Settings panes.

## Engines / languages

- Native Mac (default): on-device, free. Cannot code-switch: "English + Spanish (mixed)" uses the system locale only (the UI says so). Spanish model may download on first use.
- Deepgram Nova-3: key entered in Settings, stored with Electron `safeStorage`. Mixed = `multi`.

Global shortcut Cmd+Shift+R (configurable in Settings) and Recording menu item start/stop.

Test hook: `CALLREC_AUTORUN_SEC=N npm start` records N seconds and quits (records real audio — use deliberately).
