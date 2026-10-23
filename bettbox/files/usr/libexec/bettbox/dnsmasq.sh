#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Optional dnsmasq hijack: forward LAN DNS into mihomo's DNS listener.

. /usr/libexec/bettbox/common.sh

MARKER="$BETTBOX_STATE/dnsmasq"
DNS_PORT=$(uci_get bettbox.dns.listen)
DNS_PORT="${DNS_PORT##*:}"
[ -n "$DNS_PORT" ] || DNS_PORT=1053

apply() {
	[ "$(uci_get bettbox.config.hijack_dnsmasq)" = "1" ] || { restore; return 0; }
	[ -f "$MARKER" ] && return 0
	uci -q add_list dhcp.@dnsmasq[0].server="127.0.0.1#${DNS_PORT}"
	uci -q set dhcp.@dnsmasq[0].noresolv='1'
	uci commit dhcp
	touch "$MARKER"
	/etc/init.d/dnsmasq restart 2>/dev/null || true
}

restore() {
	[ -f "$MARKER" ] || return 0
	uci -q del_list dhcp.@dnsmasq[0].server="127.0.0.1#${DNS_PORT}"
	uci -q delete dhcp.@dnsmasq[0].noresolv 2>/dev/null
	uci commit dhcp
	rm -f "$MARKER"
	/etc/init.d/dnsmasq restart 2>/dev/null || true
}

case "$1" in
apply)
	apply
	;;
restore)
	restore
	;;
*)
	die "usage: dnsmasq.sh apply|restore"
	;;
esac
