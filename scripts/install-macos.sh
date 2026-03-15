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

DMG_PATH="$ROOT_DIR/src-tauri/target/release/bundle/dmg/${PRODUCT_NAME}_${VERSION}_${ARCH}.dmg"
APP_NAME="${PRODUCT_NAME}.app"
MOUNT_POINT="/tmp/${PRODUCT_NAME// /-}-install"

echo "Building app + DMG..."
npm run build

if [[ ! -f "$DMG_PATH" ]]; then
  echo "DMG not found: $DMG_PATH"
  exit 1
fi

echo "Mounting DMG..."
mkdir -p "$MOUNT_POINT"
hdiutil detach "$MOUNT_POINT" >/dev/null 2>&1 || true
hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT" >/dev/null

if [[ ! -d "$MOUNT_POINT/$APP_NAME" ]]; then
  echo "App bundle not found in mounted DMG: $MOUNT_POINT/$APP_NAME"
  hdiutil detach "$MOUNT_POINT" >/dev/null || true
  exit 1
fi

echo "Installing to /Applications/$APP_NAME ..."
ditto "$MOUNT_POINT/$APP_NAME" "/Applications/$APP_NAME"

echo "Unmounting DMG..."
hdiutil detach "$MOUNT_POINT" >/dev/null

echo "Installed: /Applications/$APP_NAME"
