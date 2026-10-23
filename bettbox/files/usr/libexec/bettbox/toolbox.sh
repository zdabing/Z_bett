#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Bettbox toolbox: DNS query, IP lookup, ping, Cloudflare speed test,
# media unlock detection. Output is JSON on stdout.

. /usr/libexec/bettbox/common.sh

proxy_arg() {
	local mp
	mp=$(uci_get bettbox.config.mixed_port)
	[ -n "$mp" ] && [ "$mp" != "0" ] && echo "-x http://127.0.0.1:$mp"
}

# ---------- DNS ----------

dns_query() {
	# dns_query <name> [type] [mode] [server]   mode: follow|system|custom
	local name="$1" type="${2:-A}" mode="${3:-follow}" server="$4"
	if [ "$mode" = "follow" ]; then
		api_call GET "/dns/query?name=$(printf %s "$name" | sed 's/ /%20/g')&type=$type"
		echo
	elif [ "$mode" = "system" ]; then
		local out
		out=$(nslookup "$name" 2>&1)
		printf '{"mode":"system","text":%s}\n' "$(json_str "$out")"
	else
		[ -n "$server" ] || die "custom mode needs a server"
		local out
		out=$(nslookup "$name" "$server" 2>&1)
		printf '{"mode":"custom","server":"%s","text":%s}\n' "$server" "$(json_str "$out")"
	fi
}

# ---------- IP lookup ----------

ip_lookup() {
	local via="$1" out="/tmp/bettbox-ip.$$" q="$2"
	mkdir -p /tmp
	if [ "$via" = "proxy" ]; then
		PARG=$(proxy_arg)
	else
		PARG=""
	fi
	for src in "ip-api:https://ip-api.com/json/?fields=status,country,countryCode,regionName,city,isp,org,as,query,timezone" \
		"geojs:https://get.geojs.io/v1/ip/geo.json"; do
		name="${src%%:*}"
		url="${src#*:}"
		[ -n "$q" ] && [ "$name" = "ip-api" ] && url="https://ip-api.com/json/$q?fields=status,country,countryCode,regionName,city,isp,org,as,query,timezone"
		curl -sS -m 10 $PARG "$url" > "$out.$name" 2>/dev/null || echo '{}' > "$out.$name"
	done
	local trace
	trace=$(curl -sS -m 10 $PARG https://1.1.1.1/cdn-cgi/trace 2>/dev/null | grep -E '^(ip|loc|colo|warp)=' | tr '\n' ' ')
	ucode -e "
import { readfile } from 'fs';
let ipapi = null, geojs = null;
try { ipapi = json(readfile('$out.ip-api')); } catch (e) {}
try { geojs = json(readfile('$out.geojs')); } catch (e) {}
print(json({ via: '$via', ipapi: ipapi, geojs: geojs, cloudflare: '$(printf %s "$trace" | sed 's/\"/\\\\\"/g')' }));
" 2>/dev/null
	echo
	rm -f "$out".*
}

# ---------- Ping ----------

local_ping() {
	# local_ping <host> [count] [interval] [tcpport]
	local host="$1" count="${2:-4}" interval="${3:-1}" tcpport="${4:-0}"
	if [ -n "$tcpport" ] && [ "$tcpport" != "0" ] && command -v nc >/dev/null; then
		local i rtt ok=0 total=0
		for i in $(seq 1 "$count"); do
			local t0 t1
			t0=$(date +%s%N 2>/dev/null || date +%s)
			if nc -z -w 2 "$host" "$tcpport" 2>/dev/null; then
				t1=$(date +%s%N 2>/dev/null || date +%s)
				ok=$((ok + 1))
				total=$((total + t1 - t0))
				echo "tcp seq=$i ok"
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

# ---------- Cloudflare speed test ----------

speed_test() {
	# speed_test [down_bytes] [up_bytes]
	local down="${1:-25000000}" up="${2:-1000000}" PARG
	PARG=$(proxy_arg)
	local dl ul lat
	lat=$(curl -sS -m 10 $PARG -o /dev/null -w '%{time_starttransfer}' "https://speed.cloudflare.com/__down?bytes=0" 2>/dev/null)
	dl=$(curl -sS -m 60 $PARG -o /dev/null -w '%{speed_download}' "https://speed.cloudflare.com/__down?bytes=$down" 2>/dev/null)
	head -c "$up" /dev/zero > /tmp/bettbox-up.$$ 2>/dev/null
	ul=$(curl -sS -m 60 $PARG -o /dev/null -w '%{speed_upload}' --data-binary @/tmp/bettbox-up.$$ "https://speed.cloudflare.com/__up" 2>/dev/null)
	rm -f /tmp/bettbox-up.$$
	printf '{"latency_s":%s,"download_bps":%s,"upload_bps":%s}\n' "${lat:-null}" "${dl:-null}" "${ul:-null}"
}

# ---------- media unlock ----------

media_unlock() {
	local PARG
	PARG=$(proxy_arg)
	local res
	res() {
		printf '{"name":"%s","status":"%s","region":"%s"}\n' "$1" "$2" "$(json_str "${3:-}")"
	}
	# Netflix
	nf=$(curl -sS -m 10 $PARG -o /dev/null -w '%{http_code}' "https://www.netflix.com/title/80018499" 2>/dev/null)
	[ "$nf" = "200" ] || [ "$nf" = "301" ] && res Netflix yes || res Netflix no
	# Disney+
	dis=$(curl -sS -m 10 $PARG -o /dev/null -w '%{http_code}' "https://www.disneyplus.com/home" 2>/dev/null)
	[ "$dis" = "200" ] && res Disney yes || res Disney no
	# YouTube Premium
	yt=$(curl -sS -m 10 $PARG "https://www.youtube.com/premium" 2>/dev/null | grep -o '"countryCode":"[A-Z]*"' | head -1)
	[ -n "$yt" ] && res YouTubePremium yes "${yt##*:}" || res YouTubePremium no
	# ChatGPT
	gpt=$(curl -sS -m 10 $PARG "https://api.openai.com/compliance/cookie_requirements" 2>/dev/null | grep -o '"unsupported_country":"[a-z]*"' | head -1)
	[ -n "$gpt" ] && res ChatGPT yes || res ChatGPT no
	# Telegram
	tg=$(curl -sS -m 10 $PARG -o /dev/null -w '%{http_code}' "https://web.telegram.org/k/" 2>/dev/null)
	[ "$tg" = "200" ] && res Telegram yes || res Telegram no
	# bilibili港澳台
	bili=$(curl -sS -m 10 $PARG "https://api.bilibili.com/pgc/player/web/playurl?avID=182813555&cid=1063465251&qn=0&type=&otype=json&ep_id=511408&fourk=1&fnver=0&fnval=16&module=bangumi" 2>/dev/null | grep -o '"code":[0-9]*' | head -1)
	[ "$bili" = '"code":0' ] && res BilibiliHKMCTW yes || res BilibiliHKMCTW no
}

case "$1" in
dns)
	shift
	dns_query "$@"
	;;
ip)
	shift
	ip_lookup "$@"
	;;
ping)
	shift
	local_ping "$@"
	;;
speedtest)
	shift
	speed_test "$@"
	;;
media)
	media_unlock
	;;
*)
	die "usage: toolbox.sh dns|ip|ping|speedtest|media ..."
	;;
esac
