#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Forward dnsmasq to the core and restore the exact options owned by this service.

. /usr/libexec/bettbox/common.sh
umask 077

MARKER="$BETTBOX_STATE/dnsmasq"
SAVED="$MARKER.state"
DNS_PORT=$(uci_get bettbox.dns.listen | sed 's/.*://')
[ -n "$DNS_PORT" ] || DNS_PORT=1053

set_servers() {
	local server
	uci -q delete dhcp.@dnsmasq[0].server 2>/dev/null || true
	for server in $1; do
		uci -q add_list "dhcp.@dnsmasq[0].server=$server" || return 1
	done
}

restore_noresolv() {
	if [ "$(cat "$SAVED/noresolv-present")" = 1 ]; then
		uci -q set "dhcp.@dnsmasq[0].noresolv=$(cat "$SAVED/noresolv")"
	else
		uci -q delete dhcp.@dnsmasq[0].noresolv 2>/dev/null || true
	fi
}

forget_saved() {
	rm -f "$MARKER" "$SAVED/servers" "$SAVED/applied" "$SAVED/port" "$SAVED/noresolv" "$SAVED/noresolv-present"
	rmdir "$SAVED"
}

restore() {
	[ -f "$MARKER" ] || return 0
	if [ -f "$SAVED/port" ]; then
		local current owned
		owned="127.0.0.1#$(cat "$SAVED/port")"
		current=$(uci_get dhcp.@dnsmasq[0].server)
		if [ "$current" = "$(cat "$SAVED/applied")" ]; then
			set_servers "$(cat "$SAVED/servers")" || return 1
		else
			# Preserve DNS edits made by the administrator while we were active.
			uci -q del_list "dhcp.@dnsmasq[0].server=$owned" 2>/dev/null || true
			log "dnsmasq servers changed; removed only the Bettbox forwarder"
		fi
		if [ "$(uci_get dhcp.@dnsmasq[0].noresolv)" = 1 ]; then
			restore_noresolv || return 1
		fi
	else
		# Old empty markers did not record originals. Keep the previous cleanup
		# behavior for those installations, and explicitly report the limitation.
		uci -q del_list "dhcp.@dnsmasq[0].server=127.0.0.1#$DNS_PORT" 2>/dev/null || true
		uci -q delete dhcp.@dnsmasq[0].noresolv 2>/dev/null || true
		log "legacy DNS marker has no saved original options"
	fi
	uci commit dhcp || return 1
	/etc/init.d/dnsmasq restart >/dev/null 2>&1 || return 1
	if [ -d "$SAVED" ]; then forget_saved; else rm -f "$MARKER"; fi
}

apply() {
	# Source IP selection must also select DNS; excluded devices must not
	# receive fake IPs through a router-wide dnsmasq upstream override.
	case "$(uci_get bettbox.config.device_mode):$(uci_get bettbox.config.transparent_mode)" in
	include:tun|exclude:tun|include:tproxy|exclude:tproxy|include:redir|exclude:redir) restore; return $? ;;
	esac
	[ "$(uci_get bettbox.config.hijack_dnsmasq)" = 1 ] || { restore; return $?; }
	case "$DNS_PORT" in ''|*[!0-9]*) die "invalid DNS listener port" ;; esac
	[ "$DNS_PORT" -gt 0 ] && [ "$DNS_PORT" -le 65535 ] || die "invalid DNS listener port"
	if [ -f "$MARKER" ]; then
		if [ -f "$SAVED/port" ] && [ "$(cat "$SAVED/port")" = "$DNS_PORT" ]; then return 0; fi
		restore || return 1
	fi
	mkdir -p "$BETTBOX_STATE" "$SAVED" || return 1
	uci -q get dhcp.@dnsmasq[0].server > "$SAVED/servers" || true
	if uci -q get dhcp.@dnsmasq[0].noresolv > "$SAVED/noresolv"; then
		echo 1 > "$SAVED/noresolv-present"
	else
		echo 0 > "$SAVED/noresolv-present"
	fi
	printf '%s\n' "$DNS_PORT" > "$SAVED/port"
	local servers="127.0.0.1#$DNS_PORT" old
	for old in $(cat "$SAVED/servers"); do
		# Keep explicit per-domain DNS rules, but not a catch-all upstream.
		case "$old" in /#/*) ;; /*) servers="$servers $old" ;; esac
	done
	printf '%s\n' "$servers" > "$SAVED/applied"
	touch "$MARKER"
	if ! set_servers "$servers" ||
		! uci -q set dhcp.@dnsmasq[0].noresolv=1 ||
		! uci commit dhcp ||
		! /etc/init.d/dnsmasq restart >/dev/null 2>&1; then
		set_servers "$(cat "$SAVED/servers")" && restore_noresolv && uci commit dhcp || return 1
		/etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
		forget_saved
		return 1
	fi
}

case "$1" in
apply) apply ;;
restore) restore ;;
*) die "usage: dnsmasq.sh apply|restore" ;;
esac
