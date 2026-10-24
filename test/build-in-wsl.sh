#!/bin/bash
# build-in-wsl.sh — build the three bettbox packages inside the OpenWrt SDK.
# Logs to WSL-side file (no Windows pipe): ~/build/build.log
set -o pipefail
set -e
# Sanitize PATH: Git Bash leaks Windows path components into WSL, and the
# SDK's find refuses -execdir with a relative PATH entry ("insecure").
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SDKDIR=$(ls -d "$HOME"/build/openwrt-sdk-* | head -1)
cd "$SDKDIR"
JOBS="${JOBS:-4}"

# Copy the feed onto the native filesystem: drvfs (/mnt/d) maps every file
# to 0777, and world-writable files end up inside the .apk — rpcd-mod-ucode
# then refuses to load them. The copy gets sane modes; CI git checkouts are
# unaffected.
FEED_SRC="$HOME/feed-src"
rsync -a --delete --exclude .git --exclude dist --exclude build /mnt/d/WorkSpace/Z_betta/ "$FEED_SRC/"
find "$FEED_SRC" -type f -exec chmod 644 {} +
find "$FEED_SRC" -type f \( -name '*.sh' -o -path '*files/usr/bin/*' -o -path '*files/etc/init.d/*' \) -exec chmod 755 {} +

echo "SDK: $SDKDIR  JOBS=$JOBS" > "$HOME/build/build.log"

if [ ! -f feeds.conf ]; then
	echo "=== [1] feeds.conf ===" >> "$HOME/build/build.log"
	grep -E '^src-(git|link)' feeds.conf.default | grep -vE 'routing|telephony|video' > feeds.conf || true
	sed -i 's#https://git.openwrt.org/openwrt/openwrt\.git#https://github.com/openwrt/openwrt.git#' feeds.conf
	sed -i 's#https://git.openwrt.org/feed/packages\.git#https://github.com/openwrt/packages.git#' feeds.conf
	sed -i 's#https://git.openwrt.org/project/luci\.git#https://github.com/openwrt/luci.git#' feeds.conf
	echo "src-link bettbox $FEED_SRC" >> feeds.conf
fi

if [ ! -d feeds/bettbox ]; then
	echo "=== [2] feeds update ===" >> "$HOME/build/build.log"
	./scripts/feeds update base packages luci bettbox >> "$HOME/build/build.log" 2>&1
else
	# keep the bettbox feed symlink pinned to the (perm-fixed) local copy
	sed -i "s#^src-link bettbox.*#src-link bettbox $FEED_SRC#" feeds.conf
	./scripts/feeds update bettbox >> "$HOME/build/build.log" 2>&1
	./scripts/feeds install bettbox bettbox-forge luci-app-bettbox >> "$HOME/build/build.log" 2>&1
fi

if [ ! -e package/feeds/bettbox/bettbox ]; then
	echo "=== [3] feeds install ===" >> "$HOME/build/build.log"
	./scripts/feeds install -a >> "$HOME/build/build.log" 2>&1
	./scripts/feeds install bettbox bettbox-forge luci-app-bettbox >> "$HOME/build/build.log" 2>&1
fi

if ! grep -q '^CONFIG_PACKAGE_bettbox=y' .config 2>/dev/null; then
	echo "=== [5] defconfig ===" >> "$HOME/build/build.log"
	make defconfig >> "$HOME/build/build.log" 2>&1 || true
	echo "CONFIG_PACKAGE_bettbox-forge=y" >> .config
	echo "CONFIG_PACKAGE_bettbox=y" >> .config
	echo "CONFIG_PACKAGE_luci-app-bettbox=y" >> .config
	make defconfig >> "$HOME/build/build.log" 2>&1
fi

echo "=== [6] build bettbox-forge (rust) ===" >> "$HOME/build/build.log"
make package/bettbox-forge/compile V=s -j"$JOBS" >> "$HOME/build/build.log" 2>&1 || { echo "STAGE6-FAILED" >> "$HOME/build/build.log"; exit 1; }

echo "=== [7] build bettbox (go) ===" >> "$HOME/build/build.log"
make package/bettbox/compile V=s -j"$JOBS" >> "$HOME/build/build.log" 2>&1 || { echo "STAGE7-FAILED" >> "$HOME/build/build.log"; exit 1; }

echo "=== [8] build luci-app-bettbox ===" >> "$HOME/build/build.log"
make package/luci-app-bettbox/compile V=s -j"$JOBS" >> "$HOME/build/build.log" 2>&1 || { echo "STAGE8-FAILED" >> "$HOME/build/build.log"; exit 1; }

echo "=== [9] artifacts ===" >> "$HOME/build/build.log"
find bin/packages -name '*bettbox*' -type f >> "$HOME/build/build.log"
echo BUILD-OK >> "$HOME/build/build.log"
