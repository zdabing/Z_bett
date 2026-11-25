#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# nftables transparent proxy: TPROXY (tcp+udp) / REDIR (tcp) / DNS hijack.
# With device access disabled, mihomo manages TUN routing. Device access
# instead uses source-filtered TUN policy routing owned by this service.

. /usr/libexec/bettbox/common.sh

MARK="0x162"
TABLE="bettbox"
DEVICE_GUARD=''

device_guard() {
	case "$(uci_get bettbox.config.device_mode)" in ''|off) return 0 ;; esac
	ucode -e 'import { device_access, device_nft } from "/usr/libexec/bettbox/device-access.uc"; import { cursor } from "uci"; print(device_nft(device_access(cursor())));'
}

mode() {
	uci_get bettbox.config.transparent_mode
}

ipv6_enabled() {
	[ "$(uci_get bettbox.config.ipv6)" = 1 ]
}

dns_listens_ipv4() {
	local l host
	l=$(uci_get bettbox.dns.listen)
	[ -n "$l" ] || l="0.0.0.0:1053"
	host="${l%:*}"
	case "$host" in '['*']') [ "$host" = '[::]' ] ;; *) return 0 ;; esac
}

dns_listens_ipv6() {
	local l host
	l=$(uci_get bettbox.dns.listen)
	[ -n "$l" ] || l="0.0.0.0:1053"
	host="${l%:*}"
	case "$host" in
	''|'['*']') return 0 ;;
	0.0.0.0) ipv6_enabled ;;
	*) return 1 ;;
	esac
}

dns_prerouting_guard() {
	if dns_listens_ipv4 && dns_listens_ipv6; then
		return 0
	elif dns_listens_ipv4; then
		printf '%s\n' 'meta nfproto != ipv4 return'
	else
		printf '%s\n' 'meta nfproto != ipv6 return'
	fi
}

dns_input_reject_rules() {
	if ! dns_listens_ipv6; then
		printf '%s\n' 'meta nfproto ipv6 tcp dport 53 reject with tcp reset'
		printf '%s\n' 'meta nfproto ipv6 udp dport 53 reject'
	fi
	if ! dns_listens_ipv4; then
		printf '%s\n' 'meta nfproto ipv4 tcp dport 53 reject with tcp reset'
		printf '%s\n' 'meta nfproto ipv4 udp dport 53 reject'
	fi
}

lan_ipv6_bypass() {
	local addrs
	addrs=$(ip -6 -o addr show dev "$1" scope global 2>/dev/null || true)
	if [ -z "$addrs" ]; then
		printf '%s\n' '::1/128, fc00::/7, fe80::/10, ff00::/8'
		return 0
	fi
	ucode -e 'import { lan_ipv6_prefixes } from "/usr/libexec/bettbox/device-access.uc"; print(lan_ipv6_prefixes(ARGV[0]));' "$addrs"
}

dns_port() {
	local l
	l=$(uci_get bettbox.dns.listen)
	[ -n "$l" ] || l="0.0.0.0:1053"
	local p="${l##*:}"
	case "$p" in ''|*[!0-9]*) die "invalid DNS listener port" ;; esac
	[ "$p" -gt 0 ] && [ "$p" -le 65535 ] || die "invalid DNS listener port"
	echo "$p"
}

tproxy_port() {
	local p
	p=$(uci_get bettbox.config.tproxy_port)
	[ -n "$p" ] || p=7894
	case "$p" in *[!0-9]*) die "invalid TPROXY port" ;; esac
	[ "$p" -gt 0 ] && [ "$p" -le 65535 ] || die "invalid TPROXY port"
	echo "$p"
}

redir_port() {
	local p
	p=$(uci_get bettbox.config.redir_port)
	case "$p" in ''|*[!0-9]*) die "REDIR requires a configured redir_port" ;; esac
	[ "$p" -gt 0 ] && [ "$p" -le 65535 ] || die "REDIR port must be between 1 and 65535"
	echo "$p"
}

lan_device() {
	local dev
	dev=$(uci_get network.lan.device)
	[ -n "$dev" ] || dev=$(uci_get network.lan.ifname)
	[ -n "$dev" ] || dev=br-lan
	case "$dev" in *[!A-Za-z0-9_.:@-]*) die "invalid LAN interface" ;; esac
	echo "$dev"
}

device_forward_handles() {
	nft -a list chain inet fw4 forward 2>/dev/null |
		awk '/comment "bettbox:device-tun"/ && $(NF-1) == "handle" { print $NF }'
}

remove_device_forward() {
	local handle
	for handle in $(device_forward_handles); do
		case "$handle" in ''|*[!0-9]*) return 1 ;; esac
		nft delete rule inet fw4 forward handle "$handle" || return 1
	done
}

ensure_device_forward() {
	[ -n "$(device_forward_handles)" ] && return 0
	# A verdict in a separate base chain cannot override fw4's forward reject.
	# Permit only our selected, marked LAN requests going into our TUN.
	nft insert rule inet fw4 forward iifname "$2" oifname "$1" \
		meta mark "$MARK" ct direction original accept comment '"bettbox:device-tun"'
}

cleanup() {
	remove_device_forward || return 1
	nft delete table inet "$TABLE" 2>/dev/null || true
	if [ -f "$BETTBOX_RUN/device-tun" ]; then
		local tun
		tun=$(cat "$BETTBOX_RUN/device-tun")
		case "$tun" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
		ip route del default dev "$tun" table 100 2>/dev/null || true
		ip -6 route del default dev "$tun" table 100 2>/dev/null || true
		rm -f "$BETTBOX_RUN/device-tun"
	fi
	rm -f "$BETTBOX_RUN/device-lan" "$BETTBOX_RUN/device-ipv6"
	while ip rule del fwmark "$MARK" table 100 2>/dev/null; do :; done
	ip route del local default dev lo table 100 2>/dev/null || true
	while ip -6 rule del fwmark "$MARK" table 100 2>/dev/null; do :; done
	ip -6 route del local default dev lo table 100 2>/dev/null || true
}

dns_chains() {
	local lan="$1" dp="$2" dns_guard dns_reject
	dns_guard=$(dns_prerouting_guard)
	dns_reject=$(dns_input_reject_rules)
	cat <<NFT
	chain dns {
		type nat hook prerouting priority dstnat; policy accept;
		iifname != "$lan" return
		$dns_guard
		$DEVICE_GUARD
		meta l4proto { tcp, udp } th dport 53 ct mark set $MARK redirect to :$dp
	}
NFT
	if [ -n "$dns_reject" ]; then
		cat <<NFT
	chain dns_input {
		type filter hook input priority -5; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$DEVICE_GUARD
		$dns_reject
	}
NFT
	fi
}

reset_forward_chain() {
	local lan="$1" tun="$2"
	printf '\tchain reset_forward {\n'
	printf '\t\ttype filter hook forward priority -5; policy accept;\n'
	printf '\t\tiifname != "%s" return\n' "$lan"
	if [ -n "$tun" ]; then
		printf '\t\toifname "%s" return\n' "$tun"
	fi
	cat <<NFT
		ct direction reply return
		ct mark $MARK meta l4proto tcp reject with tcp reset
		ct mark $MARK reject
		ip daddr 198.18.0.0/15 meta l4proto tcp reject with tcp reset
		ip daddr 198.18.0.0/15 reject
		ip6 daddr 2001:2::/48 meta l4proto tcp reject with tcp reset
		ip6 daddr 2001:2::/48 reject
	}
NFT
}

install_stop_guard() {
	local lan
	lan=$(lan_device) || return 1
	nft -f - <<NFT
table inet $TABLE {
	chain reset_input {
		type filter hook input priority -5; policy accept;
		iifname != "$lan" return
		ct direction reply return
		ct mark $MARK meta l4proto tcp reject with tcp reset
		ct mark $MARK reject
	}
$(reset_forward_chain "$lan")
}
NFT
}

start_tproxy() {
	local dp tp lan payload_v6_guard='' v6_bypass v6_return=''
	dp=$(dns_port) || return 1
	tp=$(tproxy_port) || return 1
	lan=$(lan_device) || return 1
	if ! ipv6_enabled; then
		payload_v6_guard="meta nfproto != ipv4 return"
	else
		v6_bypass=$(lan_ipv6_bypass "$lan") || return 1
		v6_return="ip6 daddr { $v6_bypass } return"
	fi
	cleanup || return 1
	nft -f - <<NFT
table inet $TABLE {
$(dns_chains "$lan" "$dp")
	chain proxy_prerouting {
		type filter hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$payload_v6_guard
		$DEVICE_GUARD
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		$v6_return
		meta l4proto { tcp, udp } tproxy to :$tp meta mark set $MARK ct mark set $MARK accept
	}
$(reset_forward_chain "$lan")
}
NFT
	if [ "$?" -ne 0 ]; then cleanup; return 1; fi
	if ! ip rule add fwmark "$MARK" table 100 ||
		! ip route add local default dev lo table 100; then
		cleanup
		return 1
	fi
	if ipv6_enabled; then
		if ! ip -6 rule add fwmark "$MARK" table 100 ||
			! ip -6 route add local default dev lo table 100; then
			cleanup
			return 1
		fi
	fi
}

start_redir() {
	local dp rp lan payload_v6_guard='' v6_bypass v6_return=''
	dp=$(dns_port) || return 1
	rp=$(redir_port) || return 1
	lan=$(lan_device) || return 1
	if ! ipv6_enabled; then
		payload_v6_guard="meta nfproto != ipv4 return"
	else
		v6_bypass=$(lan_ipv6_bypass "$lan") || return 1
		v6_return="ip6 daddr { $v6_bypass } return"
	fi
	cleanup || return 1
	nft -f - <<NFT
table inet $TABLE {
$(dns_chains "$lan" "$dp")
	chain redir_prerouting {
		type nat hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$payload_v6_guard
		$DEVICE_GUARD
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		$v6_return
		meta l4proto tcp ct mark set $MARK
		meta l4proto tcp redirect to :$rp
	}
$(reset_forward_chain "$lan")
}
NFT
}

start_device_tun() {
	local dp lan tun payload_v6_guard='' v6_bypass v6_return=''
	dp=$(dns_port) || return 1
	lan=$(lan_device) || return 1
	tun=$(uci_get bettbox.tun.device)
	[ -n "$tun" ] || tun=bettbox
	case "$tun" in *[!A-Za-z0-9_.-]*) die "invalid TUN interface" ;; esac
	ip link show dev "$tun" >/dev/null 2>&1 || return 1
	if ! ipv6_enabled; then
		payload_v6_guard="meta nfproto != ipv4 return"
	else
		v6_bypass=$(lan_ipv6_bypass "$lan") || return 1
		v6_return="ip6 daddr { $v6_bypass } return"
	fi
	cleanup || return 1
	nft -f - <<NFT
table inet $TABLE {
$(dns_chains "$lan" "$dp")
	chain device_prerouting {
		type filter hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$payload_v6_guard
		$DEVICE_GUARD
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		$v6_return
		meta l4proto { tcp, udp } th dport != 53 meta mark set $MARK ct mark set $MARK
	}
$(reset_forward_chain "$lan" "$tun")
}
NFT
	if [ "$?" -ne 0 ]; then cleanup; return 1; fi
	mkdir -p "$BETTBOX_RUN" || { cleanup; return 1; }
	(umask 077; printf '%s\n' "$tun" > "$BETTBOX_RUN/device-tun") || { cleanup; return 1; }
	(umask 077; printf '%s\n' "$lan" > "$BETTBOX_RUN/device-lan") || { cleanup; return 1; }
	if ! ip route add default dev "$tun" table 100 ||
		! ip rule add fwmark "$MARK" table 100 ||
		! ensure_device_forward "$tun" "$lan"; then
		cleanup
		return 1
	fi
	if ipv6_enabled; then
		(umask 077; printf '1\n' > "$BETTBOX_RUN/device-ipv6") || { cleanup; return 1; }
		if ! ip -6 route add default dev "$tun" table 100 ||
			! ip -6 rule add fwmark "$MARK" table 100; then
			cleanup
			return 1
		fi
	fi
}

start_global_tun() {
	local lan tun
	lan=$(lan_device) || return 1
	tun=$(uci_get bettbox.tun.device)
	[ -n "$tun" ] || tun=bettbox
	case "$tun" in *[!A-Za-z0-9_.-]*) die "invalid TUN interface" ;; esac
	cleanup || return 1
	nft -f - <<NFT
table inet $TABLE {
	chain tun_forward {
		type filter hook forward priority -5; policy accept;
		iifname != "$lan" return
		ct direction reply return
		oifname "$tun" ct mark set $MARK return
		ct mark $MARK meta l4proto tcp reject with tcp reset
		ct mark $MARK reject
		ip daddr 198.18.0.0/15 meta l4proto tcp reject with tcp reset
		ip daddr 198.18.0.0/15 reject
		ip6 daddr 2001:2::/48 meta l4proto tcp reject with tcp reset
		ip6 daddr 2001:2::/48 reject
	}
}
NFT
	if [ "$?" -ne 0 ]; then cleanup; return 1; fi
}

start() {
	DEVICE_GUARD=$(device_guard) || return 1
	case "$(mode)" in
	tun)
		case "$(uci_get bettbox.config.device_mode)" in
		''|off) start_global_tun ;;
		*) start_device_tun ;;
		esac
		;;
	tproxy)
		start_tproxy
		;;
	redir)
		start_redir
		;;
	*)
		stop
		;;
	esac
}

stop() {
	cleanup || return 1
	install_stop_guard || log "post-stop reset guard skipped"
	return 0
}

flush() {
	cleanup
}

# Serialize route recovery with start/stop, including core respawn. Only a
# running service's saved interface is repaired, never unsaved UCI settings.
repair() {
	[ -f "$BETTBOX_RUN/ready" ] && [ -f "$BETTBOX_RUN/device-tun" ] || return 0
	local tun lan
	tun=$(cat "$BETTBOX_RUN/device-tun")
	case "$tun" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
	lan=$(cat "$BETTBOX_RUN/device-lan" 2>/dev/null)
	[ -n "$lan" ] || lan=$(lan_device) || return 1
	case "$lan" in *[!A-Za-z0-9_.:@-]*) return 1 ;; esac
	ip link show dev "$tun" >/dev/null 2>&1 || return 0
	if ! ip route show table 100 | grep -Fq "default dev $tun "; then
		ip route replace default dev "$tun" table 100 || return 1
	fi
	if [ -f "$BETTBOX_RUN/device-ipv6" ] && ! ip -6 route show table 100 | grep -Fq "default dev $tun "; then
		ip -6 route replace default dev "$tun" table 100 || return 1
	fi
	ensure_device_forward "$tun" "$lan"
}

lock="$BETTBOX_RUN/firewall.lock"
mkdir -p "$BETTBOX_RUN" || exit 1
tries=0
while ! mkdir "$lock" 2>/dev/null; do
	holder=$(cat "$lock/pid" 2>/dev/null)
	case "$holder" in ''|*[!0-9]*) ;; *)
		if ! kill -0 "$holder" 2>/dev/null; then rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null; continue; fi ;;
	esac
	tries=$((tries + 1))
	[ "$tries" -lt 6 ] || die "firewall operation already running"
	sleep 1
done
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -f "$lock/pid"; rmdir "$lock" 2>/dev/null' EXIT
trap 'exit 1' INT TERM

case "$1" in
repair)
	repair
	;;
start)
	start
	;;
stop)
	stop
	;;
flush)
	flush
	;;
restart)
	stop
	start
	;;
*)
	die "usage: firewall.sh start|stop|flush|restart|repair"
	;;
esac
