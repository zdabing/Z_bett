#!/usr/bin/env bash
# Unified OpenWrt 25.12.6 co-build helper for Z_bett (bettbox + luci-app-bettbox)
# and luci-zen (luci-theme-zen + zen-traffic + luci-app-zen-traffic + zen-full).
# Sharing one SDK eliminates duplicate apt/SDK setup and shares rust/host across both projects.
set -euo pipefail

SDK_VERSION="${SDK_VERSION:-25.12.6}"
TARGET="${TARGET:-rockchip/armv8}"
Z_BETT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LUCI_ZEN_DIR="${LUCI_ZEN_DIR:-$(cd "$Z_BETT_DIR/.." && pwd)/luci-zen}"
WORK_DIR="${WORK_DIR:-$HOME/.cache/bettbox-zen-sdk}"
UI_ONLY=0

usage() {
	cat <<EOF
Usage: $(basename "$0") [options]
  --target <target>        OpenWrt target/subtarget: rockchip/armv8 (default), x86/64, mediatek/filogic, armsr/armv8
  --sdk-version <ver>      OpenWrt SDK version (default: 25.12.6)
  --zen-dir <path>         Path to luci-zen checkout (default: ../luci-zen)
  --work-dir <path>        Persistent SDK cache dir (default: ~/.cache/bettbox-zen-sdk)
  --ui-only                Only recompile luci-app-bettbox, luci-theme-zen, luci-app-zen-traffic, zen-full
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--target) TARGET="$2"; shift 2 ;;
		--sdk-version) SDK_VERSION="$2"; shift 2 ;;
		--zen-dir) LUCI_ZEN_DIR="$2"; shift 2 ;;
		--work-dir) WORK_DIR="$2"; shift 2 ;;
		--ui-only) UI_ONLY=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
	esac
done

[ -d "$LUCI_ZEN_DIR/luci-theme-zen" ] || { echo "Missing luci-zen checkout at $LUCI_ZEN_DIR" >&2; exit 1; }

SLUG="${TARGET//\//-}"
CACHE_ROOT="$WORK_DIR/${SDK_VERSION}-${SLUG}"
mkdir -p "$CACHE_ROOT"

SDK_DIR="$(find "$CACHE_ROOT" -maxdepth 1 -type d -name 'openwrt-sdk-*' | head -n1 || true)"
if [ -z "$SDK_DIR" ]; then
	echo "Downloading OpenWrt $SDK_VERSION SDK + llvm-bpf for $TARGET..."
	MIRRORS=(
		"https://downloads.openwrt.org"
		"https://mirrors.tuna.tsinghua.edu.cn/openwrt"
		"https://mirror.nju.edu.cn/openwrt"
	)
	for M in "${MIRRORS[@]}"; do
		if ! curl -fsSL --retry 2 -m 60 "$M/releases/$SDK_VERSION/targets/$TARGET/sha256sums" -o "$CACHE_ROOT/sha256sums"; then
			continue
		fi
		SDK_FILE="$(grep -oE 'openwrt-sdk-[^ ]+\.tar\.zst' "$CACHE_ROOT/sha256sums" | head -n1 || true)"
		LLVM_FILE="$(grep -oE 'llvm-bpf-[^ ]+\.tar\.zst' "$CACHE_ROOT/sha256sums" | head -n1 || true)"
		[ -n "$SDK_FILE" ] && [ -n "$LLVM_FILE" ] || continue
		grep -F "$SDK_FILE" "$CACHE_ROOT/sha256sums" > "$CACHE_ROOT/wanted.sha"
		grep -F "$LLVM_FILE" "$CACHE_ROOT/sha256sums" >> "$CACHE_ROOT/wanted.sha"
		if (cd "$CACHE_ROOT" && curl -fsSL --retry 2 -m 900 "$M/releases/$SDK_VERSION/targets/$TARGET/$SDK_FILE" -O \
			&& curl -fsSL --retry 2 -m 900 "$M/releases/$SDK_VERSION/targets/$TARGET/$LLVM_FILE" -O \
			&& sha256sum -c wanted.sha); then
			tar --zstd -xf "$CACHE_ROOT/$SDK_FILE" -C "$CACHE_ROOT"
			SDK_DIR="$(find "$CACHE_ROOT" -maxdepth 1 -type d -name 'openwrt-sdk-*' | head -n1)"
			tar --zstd -xf "$CACHE_ROOT/$LLVM_FILE" -C "$SDK_DIR"
			rm -f "$CACHE_ROOT/$SDK_FILE" "$CACHE_ROOT/$LLVM_FILE"
			break
		fi
		rm -f "$CACHE_ROOT/$SDK_FILE" "$CACHE_ROOT/$LLVM_FILE"
	done
	[ -n "$SDK_DIR" ] || { echo "Failed to download OpenWrt $SDK_VERSION SDK for $TARGET" >&2; exit 1; }
fi

cd "$SDK_DIR"
cp feeds.conf.default feeds.conf
{
	printf 'src-link bettbox %s\n' "$Z_BETT_DIR"
	printf 'src-link zen %s\n' "$LUCI_ZEN_DIR"
} >> feeds.conf

if [ "$UI_ONLY" -eq 0 ] || [ ! -d feeds/packages ]; then
	./scripts/feeds update -a
	./scripts/feeds install -a
fi

RUST_MAKEFILE=feeds/packages/lang/rust/Makefile
if [ -f "$RUST_MAKEFILE" ]; then
	RUST_VERSION="$(sed -n 's/^PKG_VERSION:=//p' "$RUST_MAKEFILE")"
	CI_LLVM_URL="https://ci-artifacts.rust-lang.org/rustc-builds/ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96/rust-dev-1.96.0-x86_64-unknown-linux-gnu.tar.xz"
	if [ "$RUST_VERSION" = "1.96.0" ] && grep -qF -- '--set=llvm.download-ci-llvm=false' "$RUST_MAKEFILE" && \
	   curl -fsSIL --retry 2 "$CI_LLVM_URL" >/dev/null 2>&1; then
		sed -i 's/--set=llvm.download-ci-llvm=false/--set=llvm.download-ci-llvm=true/' "$RUST_MAKEFILE"
		echo "Enabled official CI LLVM for Rust 1.96.0"
	fi
fi

for pkg in CONFIG_PACKAGE_bettbox CONFIG_PACKAGE_luci-app-bettbox CONFIG_PACKAGE_luci-theme-zen \
           CONFIG_PACKAGE_zen-traffic CONFIG_PACKAGE_luci-app-zen-traffic CONFIG_PACKAGE_zen-full; do
	grep -q "^${pkg}=y" .config 2>/dev/null || echo "${pkg}=m" >> .config
done
make defconfig

NPROC="$(command -v nproc >/dev/null 2>&1 && nproc || echo 2)"
if [ "$UI_ONLY" -eq 1 ]; then
	make package/luci-app-bettbox/compile package/luci-theme-zen/compile \
	     package/luci-app-zen-traffic/compile package/zen-full/compile V=s -j"$NPROC"
else
	make package/bettbox/compile package/luci-app-bettbox/compile \
	     package/zen-traffic/compile package/luci-app-zen-traffic/compile \
	     package/zen-full/compile package/luci-theme-zen/compile V=s -j"$NPROC"
fi

OUT_DIR="$Z_BETT_DIR/dist/${SDK_VERSION}-${SLUG}"
mkdir -p "$OUT_DIR"
find bin/packages -type f \( \
	-name 'bettbox-*.apk' -o -name 'luci-app-bettbox-*.apk' -o \
	-name 'luci-theme-zen-*.apk' -o -name 'zen-traffic-*.apk' -o \
	-name 'luci-app-zen-traffic-*.apk' -o -name 'zen-full-*.apk' \
\) -exec cp {} "$OUT_DIR/" \;

echo "Unified APKs written to $OUT_DIR:"
ls -la "$OUT_DIR"
