#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCT_NAME="$(node -e "console.log(require('./src-tauri/tauri.conf.json').productName)")"
VERSION="$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")"
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  ARCH="aarch64"
fi

APP_PATH="$ROOT_DIR/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
DMG_PATH="$DMG_DIR/${PRODUCT_NAME}_${VERSION}_${ARCH}.dmg"

if [[ ! -d "$APP_PATH" ]]; then
  echo "App bundle not found at: $APP_PATH"
  exit 1
fi

mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

echo "Creating DMG at: $DMG_PATH"
hdiutil create -volname "$PRODUCT_NAME" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH" >/dev/null
echo "DMG created: $DMG_PATH"
