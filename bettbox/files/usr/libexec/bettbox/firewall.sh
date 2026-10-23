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
	echo "${l##*:}"
}

tproxy_port() {
	local p
	p=$(uci_get bettbox.config.tproxy_port)
	[ -n "$p" ] || p=7894
	echo "$p"
}

mixed_port() {
	local p
	p=$(uci_get bettbox.config.mixed_port)
	[ -n "$p" ] || p=7893
	echo "$p"
}

cleanup() {
	nft delete table inet "$TABLE" 2>/dev/null || true
	while ip rule del fwmark "$MARK" table 100 2>/dev/null; do :; done
	ip route del local default dev lo table 100 2>/dev/null || true
}

start_tproxy() {
	local dp tp
	dp=$(dns_port)
	tp=$(tproxy_port)
	cleanup
	nft -f - <<NFT
table inet $TABLE {
	chain dns {
		type nat hook prerouting priority dstnat; policy accept;
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain tproxy {
		type filter hook prerouting priority -90; policy accept;
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } return
		ct state established,related return
		meta l4proto { tcp, udp } tproxy to :$tp meta mark set $MARK accept
	}
}
NFT
	ip rule add fwmark "$MARK" table 100
	ip route add local default dev lo table 100
}

start_redir() {
	local dp mp
	dp=$(dns_port)
	mp=$(mixed_port)
	cleanup
	nft -f - <<NFT
table inet $TABLE {
	chain dns {
		type nat hook prerouting priority dstnat; policy accept;
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain redirect {
		type nat hook prerouting priority -90; policy accept;
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } return
		meta l4proto tcp redirect to :$mp
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
