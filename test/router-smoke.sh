#!/bin/sh
# router-smoke.sh — run ON the router: install packages + functional smoke test.
# Non-invasive by default: transparent proxy stays off; a DIRECT-mode local
# profile is used so nothing on the LAN is proxied.
# shellcheck disable=SC3043

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { # check <desc> <cmd...>
	local d="$1"; shift
	if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}

echo "=== install ==="
apk add --allow-untrusted /tmp/bettbox-forge-*.apk /tmp/bettbox-[0-9]*.apk /tmp/luci-app-bettbox-*.apk 2>&1 | tail -3

echo "=== files ==="
for f in /usr/bin/bettbox /usr/bin/bettbox-forge /usr/bin/mihomo \
	/usr/libexec/bettbox/apply.sh /usr/libexec/bettbox/render.uc \
	/etc/init.d/bettbox /etc/config/bettbox \
	/usr/share/rpcd/ucode/bettbox.uc /usr/share/luci/menu.d/luci-app-bettbox.json \
	/usr/libexec/bettbox/backup.sh /usr/libexec/bettbox/toolbox.sh; do
	[ -f "$f" ] && ok "file $f" || bad "file $f"
done
[ -x /usr/bin/bettbox-forge ] && ok "forge executable" || bad "forge executable"

echo "=== versions ==="
mihomo -v 2>/dev/null | head -1
bettbox-forge version 2>&1 | head -1
apk info bettbox bettbox-forge luci-app-bettbox 2>/dev/null | grep -E '^(bettbox|luci)'

echo "=== forge smoke (JS override sandbox) ==="
cat > /etc/bettbox/scripts/smoke.js <<'EOF'
// Compatible_With_Bettbox
function main(config, customOptions) {
	config.smoke_test = true;
	return config;
}
EOF
echo '{"proxies":[],"rules":[]}' > /tmp/smoke-cfg.json
if bettbox-forge run --script /etc/bettbox/scripts/smoke.js --config /tmp/smoke-cfg.json --out /tmp/smoke-out.json 2>/tmp/smoke-err && grep -q smoke_test /tmp/smoke-out.json; then
	ok "forge run mode"
else
	bad "forge run mode: $(cat /tmp/smoke-err 2>/dev/null)"
fi
if bettbox-forge options --script /etc/bettbox/scripts/smoke.js 2>/dev/null | grep -q options; then
	ok "forge options mode"
else
	bad "forge options mode"
fi
rm -f /etc/bettbox/scripts/smoke.js /tmp/smoke-cfg.json /tmp/smoke-out.json /tmp/smoke-err

echo "=== test profile + render + service ==="
# clean slate
/etc/init.d/bettbox stop 2>/dev/null
uci -q delete bettbox.tsub 2>/dev/null
uci set bettbox.tsub=subscription
uci set bettbox.tsub.label='smoke-test'
uci set bettbox.tsub.url='file:///etc/bettbox/profiles/tsub.yaml'
uci set bettbox.tsub.auto_update='0'
uci set bettbox.config.profile='tsub'
uci set bettbox.config.enabled='1'
uci set bettbox.config.transparent_mode='off'
uci set bettbox.config.mode='direct'
cat > /etc/bettbox/profiles/tsub.yaml <<'EOF'
proxies:
  - name: "TEST-NODE"
    type: socks5
    server: 127.0.0.1
    port: 1080
proxy-groups:
  - name: "PROXY"
    type: select
    proxies:
      - TEST-NODE
rules:
  - MATCH,PROXY
EOF
/usr/libexec/bettbox/subscription.sh update tsub >/dev/null 2>&1 && ok "subscription update (file://)" || bad "subscription update"
[ -f /var/run/bettbox/config.yaml ] && ok "render produced config" || bad "render produced config"
grep -q 'TEST-NODE' /var/run/bettbox/config.yaml 2>/dev/null && ok "rendered config contains profile nodes" || bad "rendered config content"
grep -q 'geodata-mode' /var/run/bettbox/config.yaml 2>/dev/null && echo "note: geodata-mode present" || true

/etc/init.d/bettbox enable >/dev/null 2>&1
/etc/init.d/bettbox start >/dev/null 2>&1
sleep 6
check "mihomo process running" pgrep mihomo
curl -s -m 5 http://127.0.0.1:9097/version | grep -q version && ok "controller API /version" || bad "controller API /version"

echo "=== toolbox ==="
bettbox dns www.baidu.com A system 2>/dev/null | grep -q . && ok "toolbox dns (system)" || bad "toolbox dns"
bettbox ping 223.5.5.5 2 1 0 2>/dev/null | grep -q . && ok "toolbox ping" || bad "toolbox ping"
bettbox trace 223.5.5.5 6 2>/dev/null | grep -q . && ok "toolbox trace" || bad "toolbox trace"
bettbox rules 2>/dev/null | grep -q . && ok "toolbox rules" || bad "toolbox rules"
bettbox ip direct 2>/dev/null | grep -q ipapi && ok "toolbox ip" || bad "toolbox ip"
bettbox speedtest 100000 10000 2>/dev/null | grep -q download_bps && ok "toolbox speedtest" || bad "toolbox speedtest"
bettbox backup create /tmp/smoke-backup.tar >/dev/null 2>&1 && tar -tf /tmp/smoke-backup.tar | grep -q etc/config/bettbox && ok "backup create" || bad "backup create"

echo "=== watchdog ==="
check "watchdog script present" test -f /usr/libexec/bettbox/watchdog.sh

echo "=== rpcd/LuCI ==="
/etc/init.d/rpcd restart >/dev/null 2>&1; sleep 2
ubus list 2>/dev/null | grep -q '^bettbox$' && ok "ubus bettbox object registered" || bad "ubus bettbox object"
if ubus call bettbox get_status 2>/dev/null | grep -q running; then ok "ubus get_status"; else bad "ubus get_status"; fi
if ubus call bettbox toolbox_call '{"tool":"ping","args_json":"[\"223.5.5.5\",\"1\",\"1\",\"0\"]"}' 2>/dev/null | grep -q .; then ok "ubus toolbox_call"; else bad "ubus toolbox_call"; fi
if ubus call bettbox backup_call '{"action":"list"}' 2>/dev/null | grep -qE 'error|text'; then ok "ubus backup_call reachable"; else bad "ubus backup_call"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1/cgi-bin/luci/)
[ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "403" ] && ok "LuCI responds (HTTP $code)" || bad "LuCI responds (HTTP $code)"

echo "=== hot reload (live apply) ==="
bettbox live >/dev/null 2>&1 && ok "bettbox live" || bad "bettbox live"
sleep 3
curl -s -m 5 http://127.0.0.1:9097/version | grep -q version && ok "API alive after live" || bad "API alive after live"

echo ""
echo "================================"
echo "SMOKE RESULT: PASS=$PASS FAIL=$FAIL"
echo "================================"
