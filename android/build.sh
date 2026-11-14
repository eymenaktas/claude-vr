#!/usr/bin/env bash
# Gradle'sız derleme: aapt2 + javac + d8 + apksigner. Çıktı: build/claude-ses.apk
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
BT="$SDK/build-tools/37.0.0"
PLATFORM="$SDK/platforms/android-36/android.jar"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}"
export PATH="$JAVA_HOME/bin:$PATH"

KEYSTORE="${KEYSTORE:-$HOME/.android/claude-ses.keystore}"
# İmza şifresi depoda değil: anahtarın yanındaki .pass dosyasında (yoksa rastgele üretilir).
PASSFILE="${KEYSTORE%.keystore}.pass"
OUT=build
rm -rf "$OUT" && mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

"$BT/aapt2" compile --dir res -o "$OUT/res/compiled.zip"
"$BT/aapt2" link -I "$PLATFORM" --manifest AndroidManifest.xml -A assets \
  --java "$OUT/gen" -o "$OUT/unsigned.apk" "$OUT/res/compiled.zip"

javac --release 17 -nowarn -cp "$PLATFORM" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

"$BT/d8" --lib "$PLATFORM" --min-api 29 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  [ -f "$PASSFILE" ] || { openssl rand -hex 16 > "$PASSFILE"; chmod 600 "$PASSFILE"; }
  KS_PASS="$(cat "$PASSFILE")"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -alias claudeses -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Claude Ses, O=akts" >/dev/null 2>&1
fi
KS_PASS="$(cat "$PASSFILE")"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$OUT/claude-ses.apk" "$OUT/aligned.apk"

echo "OK: $(pwd)/$OUT/claude-ses.apk"
