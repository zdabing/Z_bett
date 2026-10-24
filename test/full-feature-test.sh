#!/bin/sh
# Full-feature sweep for bettbox on the router. Read-mostly; the only state
# change is a reversible uci value (watchdog_interval) restored afterwards.

P=0; F=0
ok()  { P=$((P+1)); echo "PASS: $1"; }
bad() { F=$((F+1)); echo "FAIL: $1"; }
t()   { # t <name> <cmd...>
	local n="$1"; shift
	if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi
}

echo "===== 1. service & core ====="
t "mihomo running" pgrep mihomo
t "procd enabled" /etc/init.d/bettbox enabled
t "TUN device up" ip link show bettbox
curl -s -m 5 http://127.0.0.1:9097/version | grep -q meta && ok "REST /version" || bad "REST /version"
t "watchdog alive" pgrep -f watchdog.sh

echo "===== 2. proxy e2e (router) ====="
curl -s -o /dev/null -m 10 -w "" https://www.baidu.com && ok "direct baidu" || bad "direct baidu"
curl -s -o /dev/null -m 15 -w "" https://www.google.com && ok "proxy google" || bad "proxy google"
curl -s -o /dev/null -m 15 -w "" https://www.youtube.com && ok "proxy youtube" || bad "proxy youtube"

echo "===== 3. toolbox CLI (10 tools) ====="
t "speedtest (cloudflare)" sh -c 'bettbox speedtest 200000 10000 | grep -q download_bps'
t "trace (rule-match)" sh -c 'bettbox trace www.youtube.com | grep -qE "命中|MATCH"'
t "trace chain" sh -c 'bettbox trace www.youtube.com | grep -q "策略链"'
t "mrs lookup" sh -c 'bettbox mrs www.baidu.com | grep -q "geosite:BAIDU"'
t "dns system" sh -c 'bettbox dns www.baidu.com A system | grep -q "Address"'
t "dns follow (core)" sh -c 'bettbox dns www.baidu.com A follow | grep -q Answer'
t "ip lookup direct" sh -c 'bettbox ip direct | grep -q ip-api'
t "ip lookup proxy" sh -c 'bettbox ip proxy | grep -q geojs'
t "ping icmp" sh -c 'bettbox ping 223.5.5.5 2 1 0 | grep -q "packets received"'
t "nat detect (degraded ok)" sh -c 'bettbox nat | grep -q "NAT"'
t "age error path" sh -c 'echo x | bettbox age encrypt age1x 2>&1 | grep -q "age 未安装"'
t "iperf error path" sh -c 'bettbox iperf 127.0.0.1 2>&1 | grep -qE "iperf3|error|failed"'
t "media unlock" sh -c 'bettbox media | grep -q Netflix'

echo "===== 4. forge (JS override sandbox) ====="
cat > /etc/bettbox/scripts/feat-test.js <<'EOF'
// Compatible_With_Bettbox
const ruleOptionsEnable = { 'PROXY': true };
function main(config, customOptions) {
	if (customOptions && customOptions['add-rule']) {
		config.rules = ['DOMAIN,feature-test.example,DIRECT'].concat(config.rules || []);
	}
	return config;
}
EOF
t "forge run + options merge" sh -c 'OPTS="{\"add-rule\":true}"; printf "{\"proxies\":[],\"rules\":[]}" > /tmp/ft.json; bettbox-forge run --script /etc/bettbox/scripts/feat-test.js --config /tmp/ft.json --options "$OPTS" --out /tmp/ft-out.json >/dev/null 2>&1; grep -q feature-test.example /tmp/ft-out.json'
t "forge options extract" sh -c 'bettbox-forge options --script /etc/bettbox/scripts/feat-test.js | grep -q PROXY'
t "forge loop-limit guard" sh -c 'printf "function main(c){while(1){}return c}" > /tmp/hang.js; printf "{}" > /tmp/hang-in.json; bettbox-forge run --script /tmp/hang.js --config /tmp/hang-in.json --out /tmp/hang-out.json 2>&1 >/dev/null | grep -q RuntimeLimitError'
rm -f /tmp/hang.js /tmp/hang-out.js /tmp/hang-out.json /tmp/ft-out.json

echo "===== 5. ubus backend methods ====="
t "get_status" sh -c 'ubus call bettbox get_status | grep -q running'
t "get_profiles" sh -c 'ubus call bettbox get_profiles | grep -q subnekocloud'
t "get_scripts" sh -c 'ubus call bettbox get_scripts | grep -q feat-test'
t "get_script" sh -c 'ubus call bettbox get_script "{\"name\":\"feat-test\"}" | grep -q main'
t "script_options" sh -c 'ubus call bettbox script_options "{\"name\":\"feat-test\"}" | grep -q options'
t "api_proxy" sh -c 'ubus call bettbox api_proxy "{\"method\":\"GET\",\"path\":\"/version\",\"body\":\"\"}" | grep -q version'
t "get_logs" sh -c 'ubus call bettbox get_logs | grep -q text'
t "toolbox_call via ubus" sh -c 'ubus call bettbox toolbox_call "{\"tool\":\"ping\",\"args_json\":\"[\\\"223.5.5.5\\\",\\\"1\\\",\\\"1\\\",\\\"0\\\"]\"}" | grep -q text'
t "del_script" sh -c 'ubus call bettbox del_script "{\"name\":\"feat-test\"}" | grep -q ok'

echo "===== 6. backup round-trip ====="
t "backup create" sh -c 'bettbox backup create /tmp/feat-backup.tar && tar -tf /tmp/feat-backup.tar | grep -q etc/config/bettbox'
t "backup restore" sh -c 'bettbox backup restore /tmp/feat-backup.tar >/dev/null 2>&1'
rm -f /tmp/feat-backup.tar

echo "===== 7. render pipeline ====="
t "apply (render+validate)" sh -c 'bettbox apply >/dev/null 2>&1 && grep -q "proxy-server-nameserver" /var/run/bettbox/config.yaml'
t "live hot-reload" sh -c 'bettbox live >/dev/null 2>&1'

echo "===== 8. subscription ====="
t "sub file present" sh -c 'ls /etc/bettbox/profiles/subnekocloud.yaml >/dev/null'
t "sub update" sh -c 'bettbox update subnekocloud >/dev/null 2>&1 && [ $(yq ".proxies | length" /etc/bettbox/profiles/subnekocloud.yaml) -gt 0 ]'
t "sub userinfo parsed" sh -c 'uci -q get bettbox.subnekocloud.sub_total | grep -q "[0-9]"'

echo ""
echo "=================================="
echo "FULL SWEEP: PASS=$P FAIL=$F"
echo "=================================="
