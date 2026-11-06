#!/bin/sh
# Builds "Bot Platform.app" into dist/.
#
#   macos/build.sh                 development build: runs the code in this checkout and uses its .data/
#   macos/build.sh --install       the same, also copied into ~/Applications
#   macos/build.sh --release       for other people: carries its own code and Node, keeps each person's
#                                  data in ~/Library/Application Support/Bot Platform, and makes a .dmg
#
# Release signing is optional. Without it the app is signed ad hoc, and people have to right-click
# Open it the first time. With an Apple Developer ID:
#   DEVELOPER_ID="Developer ID Application: Name (TEAMID)" NOTARY_PROFILE=profile macos/build.sh --release
# where the profile was saved once with `xcrun notarytool store-credentials profile ...`.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=dev
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --release) MODE=release ;;
    --install) INSTALL=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done
OUT="$ROOT/dist"
[ "$MODE" = release ] && OUT="$ROOT/dist/release"
APP="$OUT/Bot Platform.app"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)

# Node with built-in TypeScript and SQLite (22.18+), newest first, for bundling into a release.
pick_node() {
  best=""; best_v=""
  for n in $(which -a node 2>/dev/null; ls /usr/local/bin/node /opt/homebrew/bin/node 2>/dev/null); do
    v=$("$n" -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=18) ? process.versions.node : ""' 2>/dev/null || true)
    [ -n "$v" ] || continue
    if [ -z "$best_v" ] || [ "$(printf '%s\n%s\n' "$best_v" "$v" | sort -V | tail -1)" = "$v" ] && [ "$v" != "$best_v" ]; then best="$n"; best_v="$v"; fi
  done
  [ -n "$best" ] && realpath "$best"
}

rm -rf "$APP"
mkdir -p "$OUT" "$APP/Contents/MacOS" "$APP/Contents/Resources"

ARCHS=$(uname -m)
if [ "$MODE" = release ]; then
  NODE=$(pick_node) || { echo "Need Node 22.18 or newer on this machine to bundle." >&2; exit 1; }
  # A universal Node makes a universal app; otherwise the app runs on this Mac's architecture only.
  case "$(lipo -archs "$NODE" 2>/dev/null)" in *x86_64*arm64*|*arm64*x86_64*) ARCHS="arm64 x86_64" ;; esac
fi
for a in $ARCHS; do
  swiftc -O -swift-version 5 -target "$a-apple-macos12.0" -o "$WORK/BotPlatform-$a" "$ROOT/macos/main.swift" -framework AppKit -framework WebKit -framework UserNotifications
done
lipo -create $(for a in $ARCHS; do printf '%s ' "$WORK/BotPlatform-$a"; done) -output "$APP/Contents/MacOS/BotPlatform"

swiftc -swift-version 5 -target "$(uname -m)-apple-macos12.0" -o "$WORK/icon" "$ROOT/macos/icon.swift" -framework AppKit
"$WORK/icon" "$WORK/icon.png"
mkdir "$WORK/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

if [ "$MODE" = release ]; then
  R="$APP/Contents/Resources"
  mkdir -p "$R/app" "$R/node/bin"
  cp -R "$ROOT/src" "$ROOT/bin" "$ROOT/package.json" "$ROOT/README.md" "$R/app/"
  cp "$NODE" "$R/node/bin/node"
  for lic in "$(dirname "$NODE")/../LICENSE" /usr/local/share/doc/node/LICENSE /usr/local/include/node/LICENSE; do
    [ -f "$lic" ] && { cp "$lic" "$R/node/LICENSE"; break; }
  done
  ROOT_KEY=""
else
  ROOT_XML=$(printf '%s' "$ROOT" | sed 's/&/\&amp;/g; s/</\&lt;/g')
  ROOT_KEY="<key>BotPlatformRoot</key><string>$ROOT_XML</string>"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bot Platform</string>
  <key>CFBundleDisplayName</key><string>Bot Platform</string>
  <key>CFBundleIdentifier</key><string>local.botplatform.app</string>
  <key>CFBundleExecutable</key><string>BotPlatform</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  $ROOT_KEY
</dict>
</plist>
PLIST

if [ -n "${DEVELOPER_ID:-}" ]; then
  # Hardened runtime for notarization; Node's JIT needs the two entitlements.
  [ -f "$APP/Contents/Resources/node/bin/node" ] && codesign --force --options runtime --timestamp --entitlements "$ROOT/macos/node.entitlements" --sign "$DEVELOPER_ID" "$APP/Contents/Resources/node/bin/node"
  codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID" "$APP"
else
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
fi
codesign --verify --deep "$APP"
echo "Built $APP ($MODE, $ARCHS)"

if [ "$MODE" = release ]; then
  DMG="$OUT/BotPlatform-$VERSION-$(echo $ARCHS | tr ' ' '-').dmg"
  mkdir "$WORK/dmg"
  cp -R "$APP" "$WORK/dmg/"
  ln -s /Applications "$WORK/dmg/Applications"
  rm -f "$DMG"
  hdiutil create -quiet -volname "Bot Platform" -srcfolder "$WORK/dmg" -fs HFS+ -format UDZO "$DMG"
  if [ -n "${DEVELOPER_ID:-}" ]; then codesign --force --timestamp --sign "$DEVELOPER_ID" "$DMG"; fi
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
  echo "Built $DMG"
fi

if [ "$INSTALL" = 1 ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Bot Platform.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "Installed to $HOME/Applications/Bot Platform.app"
fi
