#!/bin/sh
# Bounded, read-only dashboard checks. Never change routing or core settings.
. /usr/libexec/bettbox/common.sh
umask 077
work=$(mktemp -d /tmp/bettbox-check.XXXXXX) || exit 1
trap 'rm -rf "$work"' EXIT INT TERM

core_proxy() {
	port=$(uci_get bettbox.config.mixed_port)
	case "$port" in ''|*[!0-9]*) die "Mixed 代理端口未配置";; esac
	[ "$port" -gt 0 ] && [ "$port" -le 65535 ] || die "Mixed 代理端口未开启"
	proxy="http://127.0.0.1:$port"
}

exit_info() {
	local via="$1" wan rc resolved
	case "$via" in direct|proxy) ;; *) die "invalid exit mode";; esac
	if [ "$via" = proxy ]; then
		core_proxy
		curl -fsS --proxy "$proxy" --noproxy '' --connect-timeout 3 -m 8 https://get.geojs.io/v1/ip/geo.json > "$work/ip.json" 2> "$work/error"
	else
		wan=$(ubus -t 2 call network.interface.wan status | ucode -e 'import {readfile} from "fs"; print(json(readfile("/dev/stdin")).l3_device ?? "");')
		case "$wan" in ''|*[!A-Za-z0-9_.:@-]*) die "WAN 接口不可用";; esac
		# The system resolver may return a TUN fake IP. Resolve through the core's
		# DNS API before binding the actual WAN socket, so the request stays direct.
		resolved=$(api_call GET '/dns/query?name=get.geojs.io&type=A' 2>/dev/null | ucode -e 'import {readfile} from "fs"; try {let d=json(readfile("/dev/stdin")); for(let r in d.Answer??[]){if(r.type==1){print(r.data);break;}}}catch(e){}')
		case "$resolved" in ''|*[!0-9.]*) resolved="";; esac
		if [ -n "$resolved" ]; then
			curl -4 -fsS --noproxy '*' --interface "$wan" --resolve "get.geojs.io:443:$resolved" --connect-timeout 3 -m 8 https://get.geojs.io/v1/ip/geo.json > "$work/ip.json" 2> "$work/error"
		else
			curl -fsS --noproxy '*' --interface "$wan" --connect-timeout 3 -m 8 https://get.geojs.io/v1/ip/geo.json > "$work/ip.json" 2> "$work/error"
		fi
	fi
	rc=$?
	if [ "$rc" = 0 ] && ucode -e 'import {readfile} from "fs"; let s=json(readfile(ARGV[0])); if(!s?.ip) exit(1);' "$work/ip.json"; then
		cat "$work/ip.json"
		return 0
	fi
	if [ "$via" = proxy ]; then
		curl -fsS --proxy "$proxy" --noproxy '' --connect-timeout 3 -m 5 https://1.1.1.1/cdn-cgi/trace > "$work/trace" 2> "$work/error"
	else
		curl -fsS --noproxy '*' --interface "$wan" --connect-timeout 3 -m 5 https://1.1.1.1/cdn-cgi/trace > "$work/trace" 2> "$work/error"
	fi
	[ "$?" = 0 ] || die "出口查询失败，请稍后重试（网络不可达或代理需要认证）"
	ucode -e 'import {readfile} from "fs"; let out={source:"cloudflare"}; for(let line in split(readfile(ARGV[0]),"\n")){ let p=split(line,"="); if(p[0]=="ip")out.ip=p[1]; if(p[0]=="loc")out.country_code=p[1]; } if(!out.ip)exit(1); print(sprintf("%J",out));' "$work/trace"
}

probe() {
	local id="$1" url="$2" rc=0
	curl -sS --proxy "$proxy" --noproxy '' --connect-timeout 3 -m 7 -o /dev/null -w '%{http_code} %{time_total}' "$url" > "$work/$id" 2>/dev/null || rc=$?
	printf ' %s\n' "$rc" >> "$work/$id"
}

connectivity() {
	core_proxy
	probe baidu https://www.baidu.com/ &
	probe google https://www.gstatic.com/generate_204 &
	probe youtube https://www.youtube.com/generate_204 &
	probe github https://github.com/ &
	probe netflix https://www.netflix.com/ &
	probe openai https://www.openai.com/ &
	wait
	ucode -e 'import {readfile} from "fs"; let result=[]; for(let id in ["baidu","google","youtube","github","netflix","openai"]){let s=split(trim(readfile(ARGV[0]+"/"+id)??"")," "); push(result,{id:id,http:int(s[0])??0,latency_ms:((+s[1])||0)*1000,code:int(s[2])??1});} print(sprintf("%J",{results:result}));' "$work"
}

case "$1" in
exit) exit_info "$2";;
connectivity) connectivity;;
delay)
	case "$2$3" in ''|*[!A-Za-z0-9_.~%/-]*) die "invalid delay target";; esac
	api_call GET "/proxies/$2/delay?url=$3&timeout=4000" ''
	;;
*) die "usage: network-check.sh exit <direct|proxy> | connectivity | delay <encoded-name> <encoded-url>";;
esac
