#!/bin/bash
# export-artifacts.sh — copy built .apk files from the SDK to the workspace
# dist/ folder (visible from Windows) and print a summary.
set -e
SDKDIR=$(ls -d "$HOME"/build/openwrt-sdk-* | head -1)
DEST=$(cd "$(dirname "$0")/.." && pwd)/dist
mkdir -p "$DEST"
find "$SDKDIR/bin/packages" -type f \( -name 'bettbox-[0-9]*.apk' -o -name 'luci-app-bettbox-[0-9]*.apk' \) | while IFS= read -r f; do
	cp -v "$f" "$DEST/"
done
ls -la "$DEST"
