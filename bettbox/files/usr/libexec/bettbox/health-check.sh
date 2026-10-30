#!/bin/sh
# SPDX-License-Identifier: GPL-3.0
# Read-only layered probes. No firewall, DNS, routes or core configuration writes.
. /usr/libexec/bettbox/common.sh
umask 077
domain=${1:-www.baidu.com}
case "$domain" in ''|-*|*[!A-Za-z0-9._-]*) die '请输入有效的测试域名' ;; esac
[ "${#domain}" -le 253 ] || die '测试域名过长'
work=$(mktemp -d /tmp/bettbox-health.XXXXXX) || exit 1
trap 'rm -rf "$work"' EXIT
trap 'exit 1' INT TERM HUP
printf '%s' "$domain" > "$work/target"
runtime="$BETTBOX_RUN/config.yaml"
ubus -t 2 call service list '{"name":"bettbox"}' > "$work/service.json" 2>/dev/null || :
stamp() { ucode -e 'import {stat} from "fs"; let s=stat(ARGV[0]); print(sprintf("%s:%s:%s",s?.mtime??0,s?.size??0,s?.ino??0));' "$BETTBOX_RUN/config.yaml"; }
stamp > "$work/stamp"
mark() { printf '%s' "$2" > "$work/$1.code"; printf '%s' "$3" > "$work/$1.reason"; }
value() { yq -r "$1 // \"\"" "$runtime" 2>/dev/null; }
dns_probe() {
	local key=$1 address=$2 host output rc name answer seen_unknown=0
	command -v nslookup >/dev/null 2>&1 || { mark "$key" 3 missing_nslookup; return; }
	case "$address" in udp://*) address=${address#udp://} ;; *://*) mark "$key" 2 unsupported_dns_transport; return ;; esac
	address=${address%%#*}
	if ! printf '%s' "$address" | grep -Eq '^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:[0-9]+)?$'; then mark "$key" 3 invalid_dns_endpoint; return; fi
	# BusyBox FEATURE_NSLOOKUP_BIG uses xhost2sockaddr(), accepting IP:port.
	for name in "$domain" www.gstatic.com; do
		output="$work/$key.answer"
		timeout 4 nslookup -type=A "$name" "$address" > "$output" 2>&1; rc=$?
		if grep -Eiq 'usage:|unrecognized option|invalid option|bad address' "$output"; then seen_unknown=1; continue; fi
		if [ "$rc" = 0 ] && awk '/^Name:/{seen=1} seen && /^Address([[:space:]]+[0-9]+)?:[[:space:]]/{found=1} END {exit found?0:1}' "$output"; then mark "$key" 0 ''; return; fi
	done
	if [ "$seen_unknown" = 1 ]; then mark "$key" 3 unsupported_nslookup; else mark "$key" 1 no_address; fi
}
http_probe() {
	local key=$1 proxy=$2 url rc=0 code
	for url in "https://$domain/" https://www.gstatic.com/generate_204; do
		if [ -n "$proxy" ]; then
			curl -sS --proxy "$proxy" --noproxy '' --connect-timeout 2 --max-time 4 -I -o /dev/null -w '%{http_code} %{time_total}' "$url" > "$work/$key.http" 2>/dev/null; rc=$?
		else
			curl -sS --noproxy '*' --connect-timeout 2 --max-time 4 -I -o /dev/null -w '%{http_code} %{time_total}' "$url" > "$work/$key.http" 2>/dev/null; rc=$?
		fi
		code=$(cut -d ' ' -f1 "$work/$key.http")
		case "$code" in 407) mark "$key" 1 proxy_authentication; return ;; [2345][0-9][0-9]) [ "$rc" = 0 ] && { mark "$key" 0 ''; return; } ;; esac
	done
	mark "$key" 1 connection_failed
}
controller_probe() {
	local endpoint secret
	endpoint=$(value '.external-controller'); secret=$(value '.secret')
	case "$endpoint" in 0.0.0.0:*) endpoint="127.0.0.1:${endpoint##*:}" ;; '[::]':*) endpoint="[::1]:${endpoint##*:}" ;; esac
	if ! printf '%s' "$endpoint" | grep -Eq '^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):[0-9]+$'; then mark controller 3 invalid_controller_endpoint; return; fi
	if curl -fsS --noproxy '*' --connect-timeout 1 --max-time 2 -H "Authorization: Bearer $secret" "http://$endpoint/version" > "$work/controller.json" 2>/dev/null &&
		yq -e '.version != null' "$work/controller.json" >/dev/null 2>&1; then mark controller 0 ''; else mark controller 1 api_failed; fi
}
if yq -e 'tag == "!!map" and .error == null and .bettbox.instances.core.running != true' "$work/service.json" >/dev/null 2>&1; then
	for key in controller core_dns dnsmasq upstream explicit router_access; do mark "$key" 2 service_stopped; done
elif [ -s "$runtime" ]; then
	cp "$runtime" "$work/runtime.yaml" || exit 1
	runtime="$work/runtime.yaml"
	controller_probe &
	listen=$(value '.dns.listen')
	case "$listen" in 0.0.0.0:*|:*) listen="127.0.0.1:${listen##*:}" ;; '[::]':*) listen="[::1]:${listen##*:}" ;; esac
	dns_probe core_dns "$listen" &
	if [ -f "$BETTBOX_STATE/dnsmasq" ]; then dns_probe dnsmasq 127.0.0.1:53 & else mark dnsmasq 2 not_owned; fi
	upstream=$(value '.dns."direct-nameserver"[0] // .dns."default-nameserver"[0]')
	if [ -n "$upstream" ]; then dns_probe upstream "$upstream" & else mark upstream 2 not_configured; fi
	port=$(value '."mixed-port"'); case "$port" in ''|*[!0-9]*) port=0 ;; esac
	if [ "$port" -gt 0 ] && [ "$port" -le 65535 ]; then http_probe explicit "http://127.0.0.1:$port" & else mark explicit 2 mixed_disabled; fi
	http_probe router_access '' &
	wait
else
	for key in controller core_dns dnsmasq upstream explicit router_access; do mark "$key" 3 runtime_missing; done
fi
if [ "$2" = '--summary' ]; then
	ucode /usr/libexec/bettbox/health-report.uc "$work" summary
else
	ucode /usr/libexec/bettbox/health-report.uc "$work" > "$work/report.json" || exit 1
	if [ "$2" = '--record' ] && [ -d "$BETTBOX_RUN" ] && [ "$(stamp)" = "$(cat "$work/stamp")" ]; then
		cache=$(mktemp "$BETTBOX_RUN/health.XXXXXX") || exit 1
		cp "$work/report.json" "$cache" && mv -f "$cache" "$BETTBOX_RUN/health.json" || { rm -f "$cache"; exit 1; }
	fi
	cat "$work/report.json"
fi
