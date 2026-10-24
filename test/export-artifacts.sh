#!/bin/bash
# export-artifacts.sh — copy built .apk files from the SDK to the workspace
# dist/ folder (visible from Windows) and print a summary.
set -e
SDKDIR=$(ls -d "$HOME"/build/openwrt-sdk-* | head -1)
DEST=/mnt/d/WorkSpace/Z_betta/dist
mkdir -p "$DEST"
find "$SDKDIR/bin/packages" -name '*bettbox*.apk' | while read -r f; do
	cp -v "$f" "$DEST/"
done
ls -la "$DEST"
