#!/bin/bash
# Download the OpenWrt 25.12.6 SDK for armsr/armv8 (aarch64_generic packages).
# Resolves the exact file name from sha256sums (no directory listing) and
# falls back across mirrors — same logic as .github/workflows/build.yml.
set -e
mkdir -p "$HOME/build"
cd "$HOME/build"

VER=25.12.6
DIR=targets/armsr/armv8
TARGET="openwrt-sdk-$VER"

for M in https://downloads.openwrt.org \
         https://mirrors.tuna.tsinghua.edu.cn/openwrt \
         https://mirror.nju.edu.cn/openwrt; do
	LINE=$(curl -sL --fail -m 60 "$M/releases/$VER/$DIR/sha256sums" | grep "$TARGET" | head -1) || LINE=""
	[ -n "$LINE" ] || continue
	SDK=$(echo "$LINE" | awk '{print $2}' | sed 's/^\*//')
	HASH=$(echo "$LINE" | awk '{print $1}')
	echo "SDK: $SDK (mirror $M)"
	if curl -sL --fail -m 1800 "$M/releases/$VER/$DIR/$SDK" -o sdk.tar.zst \
		&& echo "$HASH  sdk.tar.zst" | sha256sum -c -; then
		break
	fi
	rm -f sdk.tar.zst
done

[ -f sdk.tar.zst ] || { echo "ALL-MIRRORS-FAILED"; exit 1; }
tar axf sdk.tar.zst
echo "EXTRACTED: $(ls -d "$HOME"/build/openwrt-sdk-*)"
