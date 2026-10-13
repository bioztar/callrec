# HANDOVER — callrec

Notes for whoever picks the project up next.

## State

- Electron app (`main.js`, `preload.js`, `src/renderer/*`, `src/lib/*`) and the native macOS
  speech helper (`native/stt`, Swift) are in place; `npm test` covers the libraries, echo
  dedupe and an offline Spanish end-to-end run of the helper (macOS only, skipped elsewhere).
- Analyzer feed is contiguous (no explicit `bufferStartTime`), which avoids "timestamp
  overlaps" errors, garbled starts and lost last words. Results that belong to the next
  utterance are parked, so fast turn-taking neither merges nor duplicates lines. A silence
  pad closes each utterance without clipping speech; EOF drains pending results.
- The native engine refuses to start without an on-device model (no server fallback); the
  app offers the download with progress (`--model-status` / `--download-model`).

## Not yet verified on real hardware

- A live call with real mic + speakers (offline e2e only so far).
- Model-download progress in the UI (the helper flow is verified from the CLI).
- Dock/title-bar click behaviour (restore, minimise, close quits).
- Deepgram (needs a key).

## How to verify live

1. `npm start`, record about a minute of speech played through the speakers plus your own
   voice; check `~/Documents/callrec/<folder>/transcript.md`.
2. Click-test Dock restore / minimise / close-quits.

## Debug aids

- `CALLREC_STT_DEBUG=1` — timestamp diagnostics from the helper on stderr.
- `CALLREC_AUTORUN_SEC=N` — record N seconds and quit.
- `CALLREC_FAKE_MODEL_MISSING=1` (dev only) — pretend the model is missing to test the
  download card.

## Key files

- `native/stt/Sources/callrec-stt/AnalyzerEngine.swift` — analyzer feed/flush logic
- `native/stt/Sources/callrec-stt/ModelAssets.swift` — model status/download
- `test/helper-e2e.test.js` — offline regression for the helper
