#!/bin/zsh
# Claude Ses Sunucu.app'i derler: menü çubuğu uygulaması (Whisper'ı Quest isteyince başlatır).
set -e
cd "$(dirname "$0")"
APP="build/Claude Ses Sunucu.app"
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
python3 icons.py ../android/res/drawable/ic_launcher.xml build
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
cp build/spark.png "$APP/Contents/Resources/spark.png"
swiftc -O -o "$APP/Contents/MacOS/ClaudeSesSunucu" main.swift -framework AppKit -framework Network
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claude Ses Sunucu</string>
  <key>CFBundleDisplayName</key><string>Claude Ses Sunucu</string>
  <key>CFBundleIdentifier</key><string>tr.akts.claudeses.server</string>
  <key>CFBundleExecutable</key><string>ClaudeSesSunucu</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>Quest'teki Claude Ses uygulamasının bu Mac'i bulup Whisper ile dikte yapabilmesi için.</string>
  <key>NSBonjourServices</key><array><string>_claudeses._tcp</string></array>
</dict></plist>
PL
codesign --force --deep -s - "$APP"
echo "OK: $APP"
