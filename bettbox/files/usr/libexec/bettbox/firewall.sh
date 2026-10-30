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
	if [ -f "$BETTBOX_RUN/device-tun" ]; then
		local tun
		tun=$(cat "$BETTBOX_RUN/device-tun")
		case "$tun" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
		ip route del default dev "$tun" table 100 2>/dev/null || true
		ip -6 route del default dev "$tun" table 100 2>/dev/null || true
		rm -f "$BETTBOX_RUN/device-tun"
	fi
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
		$DEVICE_GUARD
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain proxy_prerouting {
		type filter hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$DEVICE_GUARD
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
		$DEVICE_GUARD
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain redir_prerouting {
		type nat hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$DEVICE_GUARD
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } return
		meta l4proto tcp redirect to :$rp
	}
}
NFT
}

start_device_tun() {
	local dp lan tun
	dp=$(dns_port) || return 1
	lan=$(lan_device) || return 1
	tun=$(uci_get bettbox.tun.device)
	[ -n "$tun" ] || tun=bettbox
	case "$tun" in *[!A-Za-z0-9_.-]*) die "invalid TUN interface" ;; esac
	ip link show dev "$tun" >/dev/null 2>&1 || return 1
	cleanup || return 1
	nft -f - <<NFT
table inet $TABLE {
	chain dns {
		type nat hook prerouting priority dstnat; policy accept;
		iifname != "$lan" return
		$DEVICE_GUARD
		meta l4proto { tcp, udp } th dport 53 redirect to :$dp
	}
	chain device_prerouting {
		type filter hook prerouting priority -90; policy accept;
		iifname != "$lan" return
		ct direction reply return
		$DEVICE_GUARD
		fib daddr type local return
		ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4, 255.255.255.255/32 } return
		ip6 daddr { ::1/128, fc00::/7, fe80::/10, ff00::/8 } return
		meta l4proto { tcp, udp } th dport != 53 meta mark set $MARK
	}
}
NFT
	if [ "$?" -ne 0 ]; then cleanup; return 1; fi
	mkdir -p "$BETTBOX_RUN" || { cleanup; return 1; }
	(umask 077; printf '%s\n' "$tun" > "$BETTBOX_RUN/device-tun") || { cleanup; return 1; }
	if ! ip route add default dev "$tun" table 100 ||
		! ip -6 route add default dev "$tun" table 100 ||
		! ip rule add fwmark "$MARK" table 100 ||
		! ip -6 rule add fwmark "$MARK" table 100; then
		cleanup
		return 1
	fi
}

start() {
	DEVICE_GUARD=$(device_guard) || return 1
	case "$(mode)" in
	tun)
		case "$(uci_get bettbox.config.device_mode)" in
		''|off) cleanup ;;
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
		cleanup
		;;
	esac
}

stop() {
	cleanup
}

# Serialize route recovery with start/stop, including core respawn. Only a
# running service's saved interface is repaired, never unsaved UCI settings.
repair() {
	[ -f "$BETTBOX_RUN/ready" ] && [ -f "$BETTBOX_RUN/device-tun" ] || return 0
	local tun
	tun=$(cat "$BETTBOX_RUN/device-tun")
	case "$tun" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
	ip link show dev "$tun" >/dev/null 2>&1 || return 0
	if ! ip route show table 100 | grep -Fq "default dev $tun "; then
		ip route replace default dev "$tun" table 100 || return 1
	fi
	if ! ip -6 route show table 100 | grep -Fq "default dev $tun "; then
		ip -6 route replace default dev "$tun" table 100 || return 1
	fi
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
restart)
	stop
	start
	;;
*)
	die "usage: firewall.sh start|stop|restart|repair"
	;;
esac
