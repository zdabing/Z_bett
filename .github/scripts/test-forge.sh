#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0
# Compile and verify the pure-C QuickJS-NG bettbox-forge helper on Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
QUICKJS_VERSION="0.18.0"
QUICKJS_URL="https://github.com/quickjs-ng/quickjs/releases/download/v${QUICKJS_VERSION}/quickjs-amalgam.zip"
QUICKJS_SHA256="6c05066a6b62b483e2ba0f83d7a16688c6958182b214bfd693529434cef84a9e"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$ROOT/bettbox/forge/Makefile" "$ROOT/bettbox/forge/src" "$WORK/"
mkdir -p "$WORK/vendor"

curl -fsSL --retry 3 "$QUICKJS_URL" -o "$WORK/quickjs-amalgam.zip"
printf '%s  %s\n' "$QUICKJS_SHA256" "$WORK/quickjs-amalgam.zip" | sha256sum -c -
unzip -q -o "$WORK/quickjs-amalgam.zip" -d "$WORK/vendor"

make -C "$WORK" CC="${CC:-gcc}" CFLAGS="-Werror" OUT="$WORK/bettbox-forge"

python3 - "$WORK/bettbox-forge" "$ROOT" <<'PY'
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

forge = sys.argv[1]
root = Path(sys.argv[2])

def invoke(args):
    return subprocess.run([forge, *args], capture_output=True, text=True, encoding='utf-8')

def run_script(script_text, config_obj, options=None, timeout=None, extra=None):
    with tempfile.TemporaryDirectory() as tmp:
        sp = Path(tmp) / 'script.js'
        cp = Path(tmp) / 'config.json'
        sp.write_text(script_text, encoding='utf-8')
        cp.write_text(json.dumps(config_obj) if not isinstance(config_obj, str) else config_obj, encoding='utf-8')
        args = ['run', '--script', str(sp), '--config', str(cp)]
        if options is not None:
            args += ['--options', options]
        if timeout is not None:
            args += ['--timeout', str(timeout)]
        if extra:
            args += extra
        return invoke(args)

def extract_options(script_text):
    with tempfile.TemporaryDirectory() as tmp:
        sp = Path(tmp) / 'script.js'
        sp.write_text(script_text, encoding='utf-8')
        return invoke(['options', '--script', str(sp)])

# 1. version
forge_makefile = (root / 'bettbox/forge/Makefile').read_text(encoding='utf-8')
expected_version = re.search(r'^VERSION\s*\?=\s*(\S+)', forge_makefile, re.M).group(1)
r = invoke(['version'])
assert r.returncode == 0 and r.stdout.strip() == expected_version, r

# 2. basic object mutation & arrow entry
r = run_script("function main(c) { c.mode = 'global'; return c }", {"mode": "rule"})
assert r.returncode == 0, r.stderr
assert json.loads(r.stdout)["mode"] == "global"
assert json.loads(r.stderr) == {"logs": []}

r = run_script("const main = (c) => c", {"mode": "rule"})
assert r.returncode == 0 and json.loads(r.stdout)["mode"] == "rule"

# 3. rule -> rules & proxy-providers null -> {}
r = run_script(
    "function main(c) { c.seen = [Array.isArray(c.rules), typeof c.rule, typeof c['proxy-providers']]; return c }",
    {"rule": ["MATCH,DIRECT"], "proxy-providers": None},
)
assert r.returncode == 0, r.stderr
out = json.loads(r.stdout)
assert out["seen"] == [True, "undefined", "object"]
assert out["rules"] == ["MATCH,DIRECT"]
assert out["proxy-providers"] == {}
assert "rule" not in out

# 4. non-object return preserves untouched normalized input
for body in ["{}", "{ return 1 }", "{ return [c] }", "{ c.mode = 'global'; return null }"]:
    r = run_script(f"function main(c) {body}", {"mode": "rule", "rule": []})
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == {"mode": "rule", "rules": [], "proxy-providers": {}}

# 5. scope isolation & no host IO globals
r = run_script(
    "var leaked = 1; function main(c) { c.g = typeof globalThis.leaked; c.l = typeof leaked; c.io = [typeof std, typeof os, typeof process, typeof require, typeof fetch]; return c }",
    {},
)
assert r.returncode == 0, r.stderr
out = json.loads(r.stdout)
assert out["g"] == "undefined" and out["l"] == "number"
assert out["io"] == ["undefined"] * 5

# 6. customOptions merge & 2nd arg
r = run_script(
    "const ruleOptionsEnable = { ai: true, ads: true }; function main(c, custom) { c.flags = ruleOptionsEnable; c.second = custom.ads; return c }",
    {},
    options='{"ads":false,"extra":true}',
)
assert r.returncode == 0, r.stderr
out = json.loads(r.stdout)
assert out["flags"] == {"ai": True, "ads": False, "extra": True}
assert out["second"] is False

# 7. Promises
r = run_script("async function main(c) { c.mode = await Promise.resolve('global'); return c }", {"mode": "rule"})
assert r.returncode == 0 and json.loads(r.stdout)["mode"] == "global"

r = run_script("function main() { return new Promise(() => {}) }", {})
err = json.loads(r.stderr)["error"]
assert r.returncode == 1 and err["kind"] == "Runtime" and "did not settle" in err["message"]

r = run_script("async function main() { throw new Error('bad profile') }", {})
err = json.loads(r.stderr)["error"]
assert r.returncode == 1 and err["kind"] == "Runtime" and "bad profile" in err["message"]

# 8. Error kinds & stack
r = run_script("function main( {", {})
assert r.returncode == 1 and json.loads(r.stderr)["error"]["kind"] == "Syntax"

r = run_script("function main(c) { return c.dns.enable }", {})
err = json.loads(r.stderr)["error"]
assert r.returncode == 1 and err["kind"] == "Runtime" and "main" in (err["stack"] or "")

r = run_script("function main(c) { return c }", "[1]")
assert r.returncode == 1 and json.loads(r.stderr)["error"]["kind"] == "InvalidInput"

r = run_script("function main(c) { c.self = c; return c }", {})
assert r.returncode == 1 and json.loads(r.stderr)["error"]["kind"] == "InvalidOutput"

r = run_script("function main() { return dive() } function dive() { return dive() + 1 }", {})
err = json.loads(r.stderr)["error"]
assert r.returncode == 1 and err["kind"] == "Runtime" and "stack" in err["message"]

# 9. Timeout (including catastrophic regex)
t0 = time.monotonic()
r = run_script("function main() { while (true) {} }", {}, timeout=1)
assert r.returncode == 124 and json.loads(r.stderr)["error"]["kind"] == "Timeout"
assert time.monotonic() - t0 < 4.0

r = run_script("function main() { return /(a+)+$/.test('a'.repeat(40) + 'b') }", {}, timeout=1)
assert r.returncode == 124 and json.loads(r.stderr)["error"]["kind"] == "Timeout"

# 10. Console capture & key order / numbers / undefined drop
r = run_script(
    "function main(c) { console.log('a', 1, { b: 2 }); console.warn('careful'); return c }",
    {},
)
assert r.returncode == 0 and json.loads(r.stderr)["logs"] == ['log: a 1 {"b":2}', 'warn: careful']

r = run_script(
    "function main(c) { for (let i = 0; i < 500; i++) console.log('line', i); return c }",
    {},
)
assert r.returncode == 0 and len(json.loads(r.stderr)["logs"]) == 200

r = run_script(
    "function main() { console.log('before'); throw new Error('boom') }",
    {},
)
err = json.loads(r.stderr)["error"]
assert r.returncode == 1 and err["logs"] == ["log: before"]

raw_cfg = '{"zeta":1,"alpha":{"b":2,"a":1},"port":7890,"ratio":1.5,"name":"🇭🇰 香港 \\"01\\""}'
r = run_script("function main(c) { c.port = c.port + 1.0; c.big = 2 ** 40; return c }", raw_cfg)
assert r.returncode == 0
assert r.stdout.strip() == '{"zeta":1,"alpha":{"b":2,"a":1},"port":7891,"ratio":1.5,"name":"🇭🇰 香港 \\"01\\"","proxy-providers":{},"big":1099511627776}'

r = run_script("function main(c) { c.fn = () => 1; c.missing = undefined; c.list = [undefined, 1]; return c }", {})
assert r.returncode == 0 and json.loads(r.stdout) == {"proxy-providers": {}, "list": [None, 1]}

# 11. --out FILE
with tempfile.TemporaryDirectory() as tmp:
    out_file = Path(tmp) / 'out.json'
    r = run_script("function main(c) { c.ok = true; return c }", {}, extra=['--out', str(out_file)])
    assert r.returncode == 0 and r.stdout == ''
    assert json.loads(out_file.read_text(encoding='utf-8'))["ok"] is True

# 12. options mode + real managed-routing.js & subscription-parser.js
r = extract_options(
    "const ruleOptionsEnable = { ai: true, ads: false };\n"
    "const serviceConfigs = [{ name: 'AI', icon: 'ai.png' }];\n"
    "const Compatible_With_Bettbox = { policyGroupOptions: ['AI', 42], nodeRegions: { 'HK 01': ['香港'] } };\n"
    "function main(c) { return c }"
)
assert r.returncode == 0
assert json.loads(r.stdout) == {
    "options": {"ai": True, "ads": False},
    "icons": {"AI": "ai.png"},
    "policyGroupOptions": ["AI"],
    "nodeRegions": {"HK 01": ["香港"]},
}

managed_js = root / 'bettbox/files/usr/libexec/bettbox/managed-routing.js'
r = invoke(['options', '--script', str(managed_js)])
assert r.returncode == 0, r.stderr
m_opts = json.loads(r.stdout)
assert isinstance(m_opts.get('options'), dict) and len(m_opts['options']) > 0

# Real ES2021 ??= + nodeRegions path in managed-routing.js
with tempfile.TemporaryDirectory() as tmp:
    sp = Path(tmp) / 'managed_with_nodes.js'
    sp.write_text('const bettboxNodeNames = ["🇭🇰 Test HK"];\n' + managed_js.read_text(encoding='utf-8'), encoding='utf-8')
    r = invoke(['options', '--script', str(sp)])
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout).get('nodeRegions') == {'🇭🇰 Test HK': ['香港']}, r.stdout

    cp = Path(tmp) / 'managed_cfg.json'
    cp.write_text('{"proxies":[{"name":"HK 01","type":"ss","server":"1.2.3.4","port":443,"cipher":"aes-128-gcm","password":"x"}]}', encoding='utf-8')
    r = invoke(['run', '--script', str(sp), '--config', str(cp)])
    assert r.returncode == 0, r.stderr
    m_out = json.loads(r.stdout)
    assert 'proxy-groups' in m_out and 'rules' in m_out
    hk_group = next((g for g in m_out['proxy-groups'] if g.get('name') == '香港'), None)
    assert hk_group and hk_group.get('x-region') == '香港' and hk_group.get('x-region-nodes') == ['🇭🇰 Test HK'], hk_group

sub_js = root / 'bettbox/files/usr/libexec/bettbox/subscription-parser.js'
with tempfile.TemporaryDirectory() as tmp:
    cp = Path(tmp) / 'sub.json'
    cp.write_text('{"content":"ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@1.2.3.4:8388#HK%2001"}', encoding='utf-8')
    r = invoke(['run', '--script', str(sub_js), '--config', str(cp)])
    assert r.returncode == 0, r.stderr
    s_out = json.loads(r.stdout)
    assert len(s_out.get('proxies', [])) == 1 and s_out['proxies'][0]['name'] == 'HK 01'

print("ALL FORGE C TESTS PASSED")
PY
