#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Forward dnsmasq without restarting its listener at each proxy transition.

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

restore_legacy() {
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
	[ -z "$(uci -q changes dhcp)" ] || die "save or discard pending DHCP edits before DNS integration"
	restore_legacy || return 1
	local result
	result=$(hot stage) || return 1
	if [ "$result" = setup ]; then
		if ! /etc/init.d/dnsmasq restart >/dev/null 2>&1; then
			hot unregister && /etc/init.d/dnsmasq restart >/dev/null 2>&1
			return 1
		fi
		# procd acknowledges restart before the new listener is running.
		# Wait only during registration; ordinary transitions use SIGHUP.
		local tries=0
		while ! hot attached >/dev/null 2>&1; do
			tries=$((tries + 1))
			[ "$tries" -lt 10 ] || return 1
			sleep 1
		done
	fi
	hot core "$DNS_PORT"
}

hot() { ucode /usr/libexec/bettbox/dns-forward.uc "$@"; }
restore() {
	restore_legacy || return 1
	hot system
}

if [ "$1" = watch ]; then
	while sleep 5; do "$0" sync >/dev/null 2>&1; done
	exit 0
fi

# Serialize main service, early boot and WAN resolver refreshes. A slow
# watcher must never overwrite a concurrent core/system target switch.
lock="$BETTBOX_RUN/dns-forward.lock"
mkdir -p "$BETTBOX_RUN" || exit 1
tries=0
while ! mkdir "$lock" 2>/dev/null; do
	holder=$(cat "$lock/pid" 2>/dev/null)
	case "$holder" in ''|*[!0-9]*) ;; *)
		if ! kill -0 "$holder" 2>/dev/null; then rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null; continue; fi ;;
	esac
	tries=$((tries + 1))
	[ "$tries" -lt 12 ] || die "DNS forwarding operation already running"
	sleep 1
done
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null' EXIT
trap 'exit 1' INT TERM

case "$1" in
apply) apply ;;
restore) restore ;;
prepare|sync) hot "$1" ;;
unregister)
	restore_legacy && hot unregister && /etc/init.d/dnsmasq restart
	;;
*) die "usage: dnsmasq.sh apply|restore|prepare|sync|unregister|watch" ;;
esac
