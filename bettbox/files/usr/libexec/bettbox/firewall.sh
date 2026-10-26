#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# nftables transparent proxy: TPROXY (tcp+udp) / REDIR (tcp) / DNS hijack.
# TUN mode needs nothing here — mihomo auto-route/auto-redirect manages its
# own nft rules.

. /usr/libexec/bettbox/common.sh

MARK="0x162"
TABLE="bettbox"

mode() {
	uci_get bettbox.config.transparent_mode
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

cleanup() {
	nft delete table inet "$TABLE" 2>/dev/null || true
	while ip rule del fwmark "$MARK" table 100 2>/dev/null; do :; done
	ip route del local default dev lo table 100 2>/dev/null || true
	while ip -6 rule del fwmark "$MARK" table 100 2>/dev/null; do :; done
	ip -6 route del local default dev lo table 100 2>/dev/null || true
}

start_tproxy() {
	local dp tp lan
	dp=$(dns_port) || return 1
	tp=$(tproxy_port) || return 1
	lan=$(lan_device) || return 1
	cleanup
	nft -f - <<NFT
table inet $TABLE {
	chain dns {
		type nat hook prerouting priority dstnat; policy accept;
		iifname != "$lan" return
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain proxy_prerouting {
		type filter hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } return
		meta l4proto { tcp, udp } tproxy to :$tp meta mark set $MARK accept
	}
}
NFT
	if [ "$?" -ne 0 ]; then cleanup; return 1; fi
	if ! ip rule add fwmark "$MARK" table 100 ||
		! ip route add local default dev lo table 100 ||
		! ip -6 rule add fwmark "$MARK" table 100 ||
		! ip -6 route add local default dev lo table 100; then
		cleanup
		return 1
	fi
}

start_redir() {
	local dp rp lan
	dp=$(dns_port) || return 1
	rp=$(redir_port) || return 1
	lan=$(lan_device) || return 1
	cleanup
	nft -f - <<NFT
table inet $TABLE {
	chain dns {
		type nat hook prerouting priority dstnat; policy accept;
		iifname != "$lan" return
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain redir_prerouting {
		type nat hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } return
		meta l4proto tcp redirect to :$rp
	}
}
NFT
}

start() {
	case "$(mode)" in
	tproxy)
		start_tproxy
		;;
	redir)
		start_redir
		;;
	*)
		cleanup
		;;
	esac
}

stop() {
	cleanup
}

case "$1" in
start)
	start
	;;
stop)
	stop
	;;
restart)
	stop
	start
	;;
*)
	die "usage: firewall.sh start|stop|restart"
	;;
esac
