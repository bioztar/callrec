#!/usr/bin/env bash
#
# Build the native STT helper (callrec-stt). Run this on a Mac — it cannot be
# built anywhere else.
#
#   ./build.sh                 both engines; SpeechAnalyzer preferred at runtime
#   ./build.sh --no-analyzer   SFSpeechRecognizer only — use this if the
#                              SpeechAnalyzer source does not compile against
#                              your SDK. Same protocol, same behaviour, older API.
#
# Requires Xcode 26+ for the default build (macOS 26 SDK). The --no-analyzer
# build needs only a recent Swift toolchain.
#
# Note: macOS ships bash 3.2, where "${ARR[@]}" on an empty array trips `set -u`.
# Hence the ${ARR[@]+"${ARR[@]}"} spelling below.

set -euo pipefail
cd "$(dirname "$0")"

FLAGS=()
for arg in "$@"; do
  case "$arg" in
    --no-analyzer) FLAGS+=(-Xswiftc -DINTERG_NO_ANALYZER) ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "build.sh: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

if ! command -v swift >/dev/null 2>&1; then
  echo "build.sh: no swift toolchain found — install Xcode and run 'xcode-select --install'" >&2
  exit 1
fi

PLIST="$PWD/Info.plist"
[ -f "$PLIST" ] || { echo "build.sh: missing $PLIST" >&2; exit 1; }

echo "== toolchain =="
swift --version 2>&1 | head -2
xcrun --sdk macosx --show-sdk-version 2>/dev/null | sed 's/^/macOS SDK: /' || true
echo

# -sectcreate embeds Info.plist into the executable's __TEXT segment, which is
# how a non-bundled Mach-O carries NSSpeechRecognitionUsageDescription.
swift build -c release \
  ${FLAGS[@]+"${FLAGS[@]}"} \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST"

BIN="$PWD/.build/release/callrec-stt"
echo
echo "built: $BIN"

# Prove the usage string actually made it in — if this section is missing, the
# first call to requestAuthorization will crash rather than prompt.
if otool -s __TEXT __info_plist "$BIN" 2>/dev/null | grep -q .; then
  echo "embedded Info.plist: present"
else
  echo "embedded Info.plist: MISSING — the helper will crash on first use" >&2
  exit 1
fi

echo
echo "next: $BIN --selftest    (expect one {\"type\":\"ready\",...} line)"
