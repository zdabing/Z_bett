#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Bettbox toolbox — mirrors the upstream Bettbox tool set (core/toolbox + lib/pages/toolbox):
#   dns / ip / ping / speedtest / media / trace (rule-match) / mrs / nat / age
# trace = rule-match tracing (which rule a target hits, via which chain) — NOT ICMP traceroute.

. /usr/libexec/bettbox/common.sh

proxy_arg() {
	local mp
	mp=$(uci_get bettbox.config.mixed_port)
	[ -n "$mp" ] && [ "$mp" != "0" ] && echo "-x http://127.0.0.1:$mp"
}

api_json() {
	# api_json <path> -> parsed JSON via ucode (json() works for parsing here)
	api_call GET "$1" | ucode -e 'import { readfile } from "fs"; let s = readfile("/dev/stdin"); print(s)'
}

# ---------- DNS 查询 ----------

dns_query() {
	# dns_query <name> [type] [mode] [server]   mode: follow|system|custom
	local name="$1" type="${2:-A}" mode="${3:-follow}" server="$4"
	if [ "$mode" = "follow" ]; then
		api_call GET "/dns/query?name=$(printf %s "$name" | sed 's/ /%20/g')&type=$type"
		echo
	elif [ "$mode" = "system" ]; then
		nslookup "$name" 2>&1
	else
		[ -n "$server" ] || die "custom mode needs a server"
		nslookup "$name" "$server" 2>&1
	fi
}

# ---------- IP 全能查 ----------

ip_lookup() {
	local via="$1" out="/tmp/bettbox-ip.$$" q="$2" PARG
	mkdir -p /tmp
	[ "$via" = "proxy" ] && PARG=$(proxy_arg)
	{
		echo "== ip-api.com =="
		url="https://ip-api.com/json/${q:+$q}?fields=status,country,countryCode,regionName,city,isp,org,as,query,timezone"
		curl -sS -m 10 $PARG "$url" 2>/dev/null || echo '{}'
		echo
		echo "== geojs.io =="
		curl -sS -m 10 $PARG "https://get.geojs.io/v1/ip/geo${q:+/$q}.json" 2>/dev/null || echo '{}'
		echo
		echo "== cloudflare trace =="
		curl -sS -m 10 $PARG https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep -E '^(ip|loc|colo|warp)='
		echo "via=$via"
	}
	rm -f "$out" 2>/dev/null
}

# ---------- 本地 Ping ----------

local_ping() {
	local host="$1" count="${2:-4}" interval="${3:-1}" tcpport="${4:-0}"
	if [ -n "$tcpport" ] && [ "$tcpport" != "0" ] && command -v nc >/dev/null; then
		local i ok=0
		for i in $(seq 1 "$count"); do
			if nc -z -w 2 "$host" "$tcpport" 2>/dev/null; then
				ok=$((ok + 1)); echo "tcp seq=$i ok"
			else
				echo "tcp seq=$i timeout"
			fi
			sleep "$interval"
		done
		echo "summary: ok=$ok/$count"
	else
		ping -c "$count" -i "$interval" "$host" 2>&1
	fi
}

# ---------- 网速测试 (Cloudflare, same endpoints as upstream core/toolbox/speedtest.go) ----------

speed_test() {
	local down="${1:-25000000}" up="${2:-1000000}" PARG
	PARG=$(proxy_arg)
	local lat dl ul
	lat=$(curl -sS -m 10 $PARG -o /dev/null -w '%{time_starttransfer}' "https://speed.cloudflare.com/__down?bytes=0" 2>/dev/null)
	dl=$(curl -sS -m 60 $PARG -o /dev/null -w '%{speed_download}' "https://speed.cloudflare.com/__down?bytes=$down" 2>/dev/null)
	head -c "$up" /dev/zero > /tmp/bettbox-up.$$ 2>/dev/null
	ul=$(curl -sS -m 60 $PARG -o /dev/null -w '%{speed_upload}' --data-binary @/tmp/bettbox-up.$$ "https://speed.cloudflare.com/__up" 2>/dev/null)
	rm -f /tmp/bettbox-up.$$
	printf '{"latency_s":%s,"download_bps":%s,"upload_bps":%s}\n' "${lat:-null}" "${dl:-null}" "${ul:-null}"
}

# ---------- 连通性测试 (media unlock) ----------

media_unlock() {
	local PARG
	PARG=$(proxy_arg)
	probe() {
		local name="$1" url="$2" code
		code=$(curl -sS --connect-timeout 3 -m 8 $PARG -o /dev/null -w '%{http_code}' "$url" 2>/dev/null) || code=000
		printf '%s: HTTP %s\n' "$name" "$code"
	}
	# This is connectivity, not a subscription/region unlock guarantee.
	# Run bounded probes together so one RPC cannot occupy rpcd for minutes.
	probe "Netflix" "https://www.netflix.com/title/80018499" &
	probe "Disney+" "https://www.disneyplus.com/" &
	probe "YouTube Premium" "https://www.youtube.com/premium" &
	probe "ChatGPT" "https://api.openai.com/compliance/cookie_requirements" &
	probe "Telegram" "https://web.telegram.org/k/" &
	probe "Bilibili 港澳台" "https://api.bilibili.com/pgc/player/web/playurl?avID=182813555&cid=1063465251&qn=0&otype=json&ep_id=511408&fourk=1&fnver=0&fnval=16&module=bangumi" &
	wait
}

# ---------- 路由追踪 (rule-match trace, upstream core/toolbox/route_trace.go semantics) ----------

trace_match() {
	# trace_match <host> — which rule the target hits and via which chain.
	local host="$1"
	[ -n "$host" ] || die "usage: bettbox trace <host|domain>"
	api_call GET /rules > /tmp/bettbox-rules.$$
	api_call GET /proxies > /tmp/bettbox-proxies.$$
	printf '%s' "$host" > /tmp/bettbox-host.$$
	ucode /usr/libexec/bettbox/trace_match.uc /tmp/bettbox-rules.$$ /tmp/bettbox-proxies.$$ "$host" /tmp/bettbox-host.$$ 2>&1
	rm -f /tmp/bettbox-rules.$$ /tmp/bettbox-proxies.$$ /tmp/bettbox-host.$$
}

# ---------- MRS 速查 (upstream core/toolbox/mrs_lookup.go semantics) ----------

mrs_lookup() {
	# mrs_lookup <domain> — reverse lookup: which geosite categories contain the domain,
	# plus rule-provider context from the running core.
	local domain="$1"
	[ -n "$domain" ] || die "usage: bettbox mrs <domain|ip>"
	local dat="/etc/bettbox/geosite.dat"
	if [ ! -s "$dat" ]; then
		local url
		url=$(uci_get bettbox.config.geox_geosite)
		[ -n "$url" ] || url="https://github.com/appshubcc/bett-rules/releases/latest/download/geosite.dat"
		echo "geosite.dat 不存在，正在下载: $url"
		curl -sSL --fail -m 120 -o "$dat.tmp" "$url" && mv -f "$dat.tmp" "$dat" || { rm -f "$dat.tmp"; die "geosite.dat 下载失败"; }
	fi
	printf '%s' "$domain" > /tmp/bettbox-mrs.$$
	ucode /usr/libexec/bettbox/mrs_lookup.uc "$dat" "$domain" 2>&1
	echo
	echo "== 规则提供者 (运行中的内核) =="
	api_call GET /providers/rules | ucode -e '
		import { readfile } from "fs";
		let d;
		try { d = json(readfile("/dev/stdin")); } catch (e) { print("(解析失败)\n"); exit(); }
		let ps = (d && d.providers) ? d.providers : {};
		let n = 0;
		for (let k in keys(ps)) {
			let p = ps[k];
			printf("%s  behavior=%s ruleCount=%s updated=%s\n", p.name ?? k, p.behavior ?? "?", p.ruleCount ?? "?", (p.updatedAt ?? "-"));
			n++;
		}
		if (!n) print("(无)\n");
	' 2>/dev/null || echo "(查询失败)"
	rm -f /tmp/bettbox-mrs.$$
}

# ---------- NAT 检测 (STUN, upstream core/toolbox/stun.go fallback servers) ----------

STUN_SERVERS="stun.cloudflare.com:3478 stun.l.google.com:19302 stun.miwifi.com:3478"

stun_query() {
	# stun_query <host> <port> -> "mapped_ip mapped_port" or empty
	local host="$1" port="$2" txid reqhex resp
	command -v nc >/dev/null || return 1
	nc -h 2>&1 | grep -q '\-u' || return 1
	txid=$(od -An -N12 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
	[ ${#txid} -eq 24 ] || return 1
	reqhex="000100002112a442${txid}"
	resp=$(printf "%b" "$(echo "$reqhex" | sed 's/../\\x&/g')" | nc -u -w 3 "$host" "$port" 2>/dev/null | od -An -tx1 | tr -d ' \n')
	[ ${#resp} -ge 40 ] || return 1
	# walk attributes: header 40 hex chars, then (type 4)(len 4)(value)
	local i=40 t l vlen
	while [ $i -lt $(( ${#resp} - 8 )) ]; do
		t=$(echo "$resp" | cut -c$((i+1))-$((i+4)))
		l=$(echo "$resp" | cut -c$((i+5))-$((i+8)))
		[ -n "$t" ] && [ -n "$l" ] || break
		vlen=$(( 0x$l ))
		case "$t" in
		0020)
			# XOR-MAPPED-ADDRESS: family(1) xport(2) xaddr(4)
			local f1 p1 p2 a1 a2 a3 a4
			f1=$(( 0x$(echo "$resp" | cut -c$((i+11))$((i+12))) ))
			[ "$f1" = "1" ] || break
			p1=$(( 0x$(echo "$resp" | cut -c$((i+13))$((i+14))) ^ 0x21 ))
			p2=$(( 0x$(echo "$resp" | cut -c$((i+15))$((i+16))) ^ 0x12 ))
			a1=$(( 0x$(echo "$resp" | cut -c$((i+17))$((i+18))) ^ 0x21 ))
			a2=$(( 0x$(echo "$resp" | cut -c$((i+19))$((i+20))) ^ 0x12 ))
			a3=$(( 0x$(echo "$resp" | cut -c$((i+21))$((i+22))) ^ 0xA4 ))
			a4=$(( 0x$(echo "$resp" | cut -c$((i+23))$((i+24))) ^ 0x42 ))
			echo "$a1.$a2.$a3.$a4 $(( p1 * 256 + p2 ))"
			return 0
			;;
		esac
		i=$(( i + 8 + vlen * 2 ))
	done
	return 1
}

stun_query() {
	# stun_query <host> <port> -> "mapped_ip mapped_port" or empty
	local host="$1" port="$2" txid reqhex resp tlen i at tlen16 vlen
	command -v nc >/dev/null || return 1
	txid=$(od -An -N12 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
	[ ${#txid} -eq 24 ] || return 1
	reqhex="000100002112a442${txid}"
	resp=$(printf "%b" "$(echo "$reqhex" | sed 's/../\\x&/g')" | nc -u -w 3 "$host" "$port" 2>/dev/null | od -An -tx1 | tr -d ' \n')
	[ ${#resp} -ge 40 ] || return 1
	# walk attributes: header 40 hex chars, then (type 4)(len 4)(value)
	i=40
	while [ $i -lt $(( ${#resp} - 8 )) ]; do
		t=$(echo "$resp" | cut -c$((i+1))-$((i+4)))
		l=$(echo "$resp" | cut -c$((i+5))-$((i+8)))
		[ -n "$t" ] && [ -n "$l" ] || break
		vlen=$(( 0x$l ))
		case "$t" in
		0020)
			# XOR-MAPPED-ADDRESS: family(1) xport(2) xaddr(4)
			local f1 p1 p2 a1 a2 a3 a4
			f1=$(( 0x$(echo "$resp" | cut -c$((i+11))$((i+12))) ))
			[ "$f1" = "1" ] || break
			p1=$(( 0x$(echo "$resp" | cut -c$((i+13))$((i+14))) ^ 0x21 ))
			p2=$(( 0x$(echo "$resp" | cut -c$((i+15))$((i+16))) ^ 0x12 ))
			a1=$(( 0x$(echo "$resp" | cut -c$((i+17))$((i+18))) ^ 0x21 ))
			a2=$(( 0x$(echo "$resp" | cut -c$((i+19))$((i+20))) ^ 0x12 ))
			a3=$(( 0x$(echo "$resp" | cut -c$((i+21))$((i+22))) ^ 0xA4 ))
			a4=$(( 0x$(echo "$resp" | cut -c$((i+23))$((i+24))) ^ 0x42 ))
			echo "$a1.$a2.$a3.$a4 $(( p1 * 256 + p2 ))"
			return 0
			;;
		esac
		i=$(( i + 8 + vlen * 2 ))
	done
	return 1
}

nat_detect() {
	local wan_ip pub_ip first second s h p r
	command -v nc >/dev/null && nc -h 2>&1 | grep -q '\-u' && have_udp=1
	wan_if=$(ip -4 route show default 2>/dev/null | grep -v bettbox | head -1 | grep -oE 'dev [a-z0-9-]+' | cut -d' ' -f2)
	wan_ip=$( [ -n "$wan_if" ] && ip -4 addr show dev "$wan_if" 2>/dev/null | grep -oE 'inet [0-9.]+' | head -1 | cut -d' ' -f2 )
	pub_ip=$(curl -sS -m 8 --interface pppoe-wan https://api.ipify.org 2>/dev/null || curl -sS -m 8 https://api.ipify.org 2>/dev/null)

	if [ -z "$have_udp" ]; then
		echo "== NAT 检测（降级模式）=="
		echo "本机无 UDP 发包工具（busybox nc 不带 -u，且未安装 ucode-mod-socket/socat），"
		echo "无法发起 STUN 查询 —— 不伪造结果。"
		echo
		echo "可判定的部分："
		echo "  WAN 口 IP: ${wan_ip:-未知}"
		echo "  出口公网 IP: ${pub_ip:-未知}"
		if [ -n "$wan_ip" ] && [ -n "$pub_ip" ]; then
			if [ "$wan_ip" = "$pub_ip" ]; then
				echo "  判定: WAN IP 与公网出口一致 → 公网直连（无 NAT）"
			else
				echo "  判定: 存在 NAT（运营商侧转换）"
				echo "  NAT 类型（Full-cone/Restricted/Symmetric）需 STUN，请安装 ucode-mod-socket 或带 -u 的 nc 后重试"
			fi
		fi
		return 0
	fi

	echo "== STUN 映射查询 (binding request) =="
	for s in $STUN_SERVERS; do
		h="${s%:*}"; p="${s##*:}"
		r=$(stun_query "$h" "$p")
		if [ -n "$r" ]; then
			echo "$s -> mapped $r"
			[ -z "$first" ] && first="$r" || second="$r"
		else
			echo "$s -> 无响应"
		fi
	done
	echo
	echo "== 结果 =="
	echo "本机出口 IP: ${wan_ip:-未知}"
	if [ -z "$first" ]; then
		echo "所有 STUN 服务器无响应（UDP 443/3478 可能被拦截，或代理 TUN 未放行 STUN 直连）"
		return 0
	fi
	echo "映射地址 #1: $first"
	[ -n "$second" ] && echo "映射地址 #2: $second"
	if [ -n "$second" ]; then
		if [ "$first" = "$second" ]; then
			echo "判定: 同一映射地址 → 非对称型 NAT（cone 类）"
		else
			echo "判定: 不同服务器返回不同映射地址 → 对称型 NAT (Symmetric)"
		fi
	else
		echo "判定: 仅一个服务器响应，无法比较（多服务器响应才可判定对称型）"
	fi
	case "$first" in
	"$wan_ip "*) echo "出口 IP 与映射 IP 相同 → 公网直连（无 NAT）";;
	esac
}

# ---------- iPerf3 工具 (upstream core/toolbox/iperf.go embeds it; router uses system iperf3) ----------

iperf_run() {
	# iperf_run <host> [seconds]
	local host="$1" secs="${2:-10}"
	[ -n "$host" ] || die "usage: bettbox iperf <host> [seconds]"
	command -v iperf3 >/dev/null || die "iperf3 未安装 (apk add iperf3)"
	iperf3 -c "$host" -t "$secs" 2>&1
}

# ---------- Age 加解密 (upstream core/toolbox/age_tool.go) ----------

age_tool() {
	# age_tool <encrypt|decrypt> <key> (data on stdin)
	local mode="$1" key="$2" data
	command -v age >/dev/null || die "age 未安装 (apk add age)"
	data=$(cat)
	[ -n "$key" ] || die "usage: bettbox age encrypt <recipient-pubkey>|decrypt <identity-key>"
	local kf=/tmp/bettbox-age-key.$$ out rc
	printf '%s\n' "$key" > "$kf"; chmod 600 "$kf"
	case "$mode" in
	encrypt)
		case "$key" in
		age1*) out=$(printf '%s' "$data" | age -r "$key" 2>&1);;
		*) rm -f "$kf"; die "加密需要接收方公钥 (age1…)";;
		esac
		;;
	decrypt)
		out=$(printf '%s' "$data" | age -d -i "$kf" 2>&1);;
	*) rm -f "$kf"; die "usage: bettbox age encrypt|decrypt <key>";;
	esac
	rc=$?
	rm -f "$kf"
	if [ $rc -eq 0 ]; then printf '%s\n' "$out"; else printf '错误: %s\n' "$out" >&2; exit 1; fi
}

case "$1" in
dns) shift; dns_query "$@" ;;
ip) shift; ip_lookup "$@" ;;
ping) shift; local_ping "$@" ;;
speedtest) shift; speed_test "$@" ;;
media) media_unlock ;;
trace) shift; trace_match "$@" ;;
mrs) shift; mrs_lookup "$@" ;;
nat) nat_detect ;;
age) shift; age_tool "$@" ;;
iperf) shift; iperf_run "$@" ;;
*)
	die "usage: toolbox.sh dns|ip|ping|speedtest|media|trace|mrs|nat|age|iperf ..."
	;;
esac
