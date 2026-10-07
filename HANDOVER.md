# HANDOVER — callrec — 2026-10-07
## State: app built, unit tests green, packaging works; audible end-to-end test NOT yet run (helm blocked speaker playback).
## Done this session
- Electron app: main.js, preload.js, src/renderer/{index.html,app.js,stt.js,styles.css,pcm-worklet.js}, src/lib/*, src/native-stt.js
- native/stt copied from InterG, renamed callrec-stt; fixed 2 Swift compile errors (never compiled before); builds on Swift 6.3.3.
- `npm test` 9 green; `npm run dist` → dist/callrec-0.1.0-arm64.dmg + .app, helper bundled in Resources/native/stt.
- UI screenshot (window-only) checked: renders, permissions card hidden (already granted).
## In flight / partially done
- Done criteria 1/2/4 unverified: 2-minute native test (Me + Them), Deepgram test (no key — untested), Dock/titlebar click-through.
## Next steps (ordered)
1. When helm says go: `CALLREC_AUTORUN_SEC=120 npm start` while playing audio via speakers and speaking; inspect folder in ~/Documents/callrec.
2. Click-test Dock restore/minimize/close-quits.
3. Check es-ES native model download if Spanish is wanted.
## Blockers / needs human
- Audible test needs go-ahead (user may be on a call).
## Key files touched
- main.js — window, loopback grant, IPC, shortcut/menu; src/lib/session-writer.js — incremental folder writing; src/renderer/app.js — capture + transcript
