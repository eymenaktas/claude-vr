#!/bin/bash
# Quest'teki Claude Ses penceresinde görsel, video ya da sayfa gösterir.
#   goster.sh <dosya|url> [başlık]    göster
#   goster.sh --kapat                 gösterilen içeriği kapat
# Yerel dosya önce gözlüğe kopyalanır (uygulamanın media klasörü).
set -euo pipefail
PKG=tr.akts.claudevoice
export ANDROID_SERIAL="${ANDROID_SERIAL:-192.168.1.12:5555}"
adb connect "$ANDROID_SERIAL" >/dev/null 2>&1 || true

if [ "${1:-}" = "--kapat" ]; then
  adb shell am start -n $PKG/.MainActivity -a $PKG.HIDE >/dev/null
  echo "kapatıldı"; exit 0
fi

SRC="${1:?kullanım: goster.sh <dosya|url> [başlık]}"
TITLE="${2:-}"
if [ -f "$SRC" ]; then
  NAME="$(date +%s)-$(basename "$SRC" | tr ' ' '_')"
  DIR="/sdcard/Android/data/$PKG/files/media"
  adb shell mkdir -p "$DIR"
  adb push "$SRC" "$DIR/$NAME" >/dev/null
  URL="$NAME"
else
  URL="$SRC"
fi

# am start argümanları cihaz kabuğunda yeniden ayrıştırılır: tek tırnakla koru.
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
ARGS="-n $PKG/.MainActivity -a $PKG.SHOW --es url $(q "$URL")"
[ -n "$TITLE" ] && ARGS="$ARGS --es title $(q "$TITLE")"
adb shell "am start $ARGS" >/dev/null
echo "gösteriliyor: $URL"
