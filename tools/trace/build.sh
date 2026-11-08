#!/bin/bash
# build.sh — the instrumented APK of the original for the GR-M5 trace
# (operator only; Claude does not run builds — CLAUDE.md). Steps and why:
#
#   1. GRTracer.dll   csc against the APK's own mscorlib/UnityEngine (no
#                     NuGet, the .NET 3.5 API level of Unity 5.6 Mono)
#   2. GRPatch        dotnet build/run: the Cecil hooks into Assembly-CSharp.dll
#   3. the APK        the original's zip with META-INF removed, the two DLLs
#                     swapped in, zipalign, apksigner with a throw-away debug
#                     key (the signature is ours, so the store's copy must be
#                     uninstalled first)
#
# Everything lands in sources/extract/trace/ (outside git). Nothing from the
# original goes anywhere else.
#
# usage: tools/trace/build.sh [apk]      default sources/apk/…-1.9.7.apk
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APK="${1:-$ROOT/sources/apk/com.crimsonpine.geometryrace-1.9.7.apk}"
OUT="$ROOT/sources/extract/trace"
MANAGED="$ROOT/sources/extract/apk197/assets/bin/Data/Managed"
SDK="$(dirname "$(readlink -f "$(command -v dotnet)")")/sdk/$(dotnet --version)"
CSC="$SDK/Roslyn/bincore/csc.dll"
BT="$HOME/Android/build-tools/34.0.0"
KS="$HOME/.android/gr-trace.keystore"

[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }
[ -d "$MANAGED" ] || { echo "unpacked APK not found: $MANAGED (nastroje.md kap. 4: unzip apk into extract/apk197)"; exit 1; }
[ -f "$CSC" ] || { echo "csc.dll not found under $SDK"; exit 1; }
mkdir -p "$OUT"

echo "== 1. GRTracer.dll (csc, -nostdlib against the APK's Managed/)"
dotnet "$CSC" -nologo -nostdlib -noconfig -target:library -optimize+ -debug- \
  -langversion:7.3 \
  -r:"$MANAGED/mscorlib.dll" -r:"$MANAGED/System.dll" -r:"$MANAGED/System.Core.dll" -r:"$MANAGED/UnityEngine.dll" \
  -out:"$OUT/GRTracer.dll" "$ROOT/tools/trace/GRTracer.cs"

echo "== 2. GRPatch → Assembly-CSharp.dll with the hooks"
dotnet run --project "$ROOT/tools/trace/GRPatch" -c Release -- "$MANAGED" "$OUT/GRTracer.dll" "$OUT/patched"

echo "== 3. the APK"
cp "$APK" "$OUT/gr-trace-unsigned.apk"
zip -q -d "$OUT/gr-trace-unsigned.apk" 'META-INF/*'
( cd "$OUT/patched" && mkdir -p assets/bin/Data/Managed && cp Assembly-CSharp.dll ../GRTracer.dll assets/bin/Data/Managed/ \
  && zip -q "$OUT/gr-trace-unsigned.apk" assets/bin/Data/Managed/Assembly-CSharp.dll assets/bin/Data/Managed/GRTracer.dll )
"$BT/zipalign" -f -p 4 "$OUT/gr-trace-unsigned.apk" "$OUT/gr-trace-aligned.apk"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass grtrace -keypass grtrace -alias grtrace \
    -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=gr-trace, OU=study, O=local" >/dev/null
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:grtrace --key-pass pass:grtrace --ks-key-alias grtrace \
  --out "$OUT/gr-trace-1.9.7.apk" "$OUT/gr-trace-aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/gr-trace-1.9.7.apk" | head -3
rm -f "$OUT/gr-trace-unsigned.apk" "$OUT/gr-trace-aligned.apk"
sha256sum "$OUT/gr-trace-1.9.7.apk"
echo "done: $OUT/gr-trace-1.9.7.apk  (adb uninstall com.crimsonpine.geometryrace; adb install …; nastroje.md kap. 6)"
