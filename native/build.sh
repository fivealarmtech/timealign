#!/bin/bash
# Builds TimeAlign.app (universal: Apple Silicon + Intel), a .dmg and a .zip into dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
BUILD="${GITHUB_RUN_NUMBER:-1}"
rm -rf dist && mkdir -p dist
APP=dist/TimeAlign.app
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc --version
for ARCH in arm64 x86_64; do
  echo "== compiling $ARCH"
  swiftc -O -swift-version 5 -target "$ARCH-apple-macos11.0" -o "dist/TimeAlign-$ARCH" native/main.swift \
    -framework Cocoa -framework WebKit -framework CoreAudio -framework AudioToolbox -framework AVFoundation
done
lipo -create -output "$APP/Contents/MacOS/TimeAlign" dist/TimeAlign-arm64 dist/TimeAlign-x86_64
sed "s/BUILDNUM/$BUILD/" native/Info.plist > "$APP/Contents/Info.plist"
cp app/index.html "$APP/Contents/Resources/index.html"
cp build/icon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$APP"
codesign --verify --verbose "$APP"
STAGE=dist/dmg && mkdir -p "$STAGE" && cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
(cd dist && ditto -c -k --keepParent TimeAlign.app TimeAlign-mac.zip)
for TRY in 1 2 3 4 5; do
  hdiutil create -volname TimeAlign -srcfolder "$STAGE" -ov -format UDZO dist/TimeAlign.dmg && break
  echo "hdiutil busy, retrying ($TRY)"; sleep 5
done
ls -la dist
