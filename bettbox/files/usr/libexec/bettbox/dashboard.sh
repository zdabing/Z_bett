#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# zashboard external-ui installer (Bettbox "OnlinePanel" parity).

. /usr/libexec/bettbox/common.sh

URL="https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip"
DEST=/usr/share/bettbox/ui

install_ui() {
	mkdir -p "$DEST" "$BETTBOX_STATE"
	local tmp="$BETTBOX_STATE/dashboard.zip"
	if ! curl -sSL --fail -m 180 -o "$tmp" "$URL"; then
		rm -f "$tmp"
		die "zashboard download failed"
	fi
	rm -rf "$DEST"/*
	unzip -o -q "$tmp" -d "$DEST" || { rm -f "$tmp"; die "unzip failed"; }
	rm -f "$tmp"
	[ -f "$DEST/index.html" ] || die "zashboard archive malformed"
	uci -q set bettbox.config.external_ui='1'
	uci commit bettbox
	log "zashboard installed to $DEST (reload bettbox to activate)"
}

remove_ui() {
	rm -rf "$DEST"
	uci -q set bettbox.config.external_ui='0'
	uci commit bettbox
}

case "$1" in
install)
	install_ui
	;;
remove)
	remove_ui
	;;
*)
	die "usage: dashboard.sh install|remove"
	;;
esac
