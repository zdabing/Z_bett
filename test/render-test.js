// Harness: run render.uc (ucode) under Node with ucode builtins stubbed.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const yaml = require('js-yaml');

function ucodeType(v) {
	if (v === null || v === undefined) return 'null';
	if (Array.isArray(v)) return 'array';
	switch (typeof v) {
		case 'boolean': return 'bool';
		case 'number': return Number.isInteger(v) ? 'int' : 'double';
		case 'string': return 'string';
		case 'function': return 'function';
		case 'object': return 'object';
		default: return 'null';
	}
}

function sprintfImpl(fmt, ...args) {
	let i = 0;
	return fmt.replace(/%(-?\d+)?(?:\.(\d+))?([sdJ%])/g, (m, w, p, c) => {
		if (c === '%') return '%';
		let v = args[i++];
		switch (c) {
			case 's': {
				let s = String(v);
				if (p != null) s = s.slice(0, parseInt(p));
				return s;
			}
			case 'd': return String(Math.trunc(Number(v)));
			case 'J': return JSON.stringify(v);
			default: return m;
		}
	});
}

function makeSandbox(files, uciData, argv, captured) {
	const sandbox = {
		ARGV: argv,
		print: (...a) => captured.stdout.push(a.join(' ')),
		die: (msg) => { throw new Error('die: ' + msg); },
		readfile: (p) => (p in files ? files[p] : null),
		writefile: (p, d) => { captured.written[p] = d; },
		keys: (o) => Object.keys(o || {}),
		values: (o) => Object.values(o || {}),
		length: (x) => (x == null ? 0 : (x.length != null ? x.length : 0)),
		push: (arr, ...items) => { arr.push(...items); return arr.length; },
		pop: (a) => a.pop(), shift: (a) => a.shift(),
		join: (sep, arr) => arr.join(sep),
		split: (s, sep) => String(s).split(sep),
		filter: (arr, fn) => arr.filter(fn),
		map: (arr, fn) => arr.map(fn),
		sort: (a, fn) => (fn ? [...a].sort(fn) : [...a].sort()),
		substr: (s, start, len) => (len === undefined ? String(s).slice(start) : String(s).slice(start, start + len)),
		trim: (s) => String(s).trim(),
		ltrim: (s) => String(s).replace(/^\s+/, ''),
		rtrim: (s) => String(s).replace(/\s+$/, ''),
		lc: (s) => String(s).toLowerCase(),
		uc: (s) => String(s).toUpperCase(),
		int: (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; },
		match: (s, re) => String(s).match(re),
		replace: (s, re, r) => String(s).replace(re, typeof r === 'function' ? r : r),
		starts_with: (s, p) => String(s).startsWith(p),
		ends_with: (s, p) => String(s).endsWith(p),
		index: (s, sub) => String(s).indexOf(sub),
		json: (x) => (typeof x === 'string' ? JSON.parse(x) : JSON.parse(JSON.stringify(x))),
		sprintf: sprintfImpl,
		printf: (fmt, ...args) => { captured.stdout.push(sprintfImpl(fmt, ...args)); },
		exists: (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k),
		type: ucodeType,
		cursor: () => ({
			get: (cfg, sid, opt) => (uciData[sid] ? (uciData[sid][opt] !== undefined ? uciData[sid][opt] : null) : null),
			get_all: (cfg) => uciData,
			foreach: (cfg, type, cb) => {
				for (const [name, sec] of Object.entries(uciData)) {
					if (sec['.type'] === type) cb({ ...sec, '.name': name });
				}
			}
		})
	};
	return sandbox;
}

// ---------- fixtures ----------
const profileJson = JSON.stringify({
	'mixed-port': 7890,
	mode: 'rule',
	'log-level': 'info',
	proxies: [
		{ name: 'A 节点', type: 'ss', server: 'a.com', port: 443, cipher: 'aes-128-gcm', password: 'x' },
		{ name: 'B 节点', type: 'vmess', server: 'b.com', port: 443, uuid: 'u', 'alterId': 0, cipher: 'auto' }
	],
	'proxy-groups': [
		{ name: '🚀 节点选择', type: 'select', proxies: ['♻️ 自动选择', 'DIRECT'] },
		{ name: '♻️ 自动选择', type: 'url-test', proxies: ['A 节点', 'B 节点'] },
		{ name: '🛑 广告拦截', type: 'select', proxies: ['REJECT'] }
	],
	rules: [
		'DOMAIN-SUFFIX,google.com,🚀 节点选择',
		'DOMAIN-SUFFIX,ads.example.com,🛑 广告拦截',
		'GEOIP,CN,DIRECT',
		'MATCH,🚀 节点选择'
	],
	dns: { enable: true, nameserver: ['119.29.29.29'], 'fake-ip-filter': ['*.lan'] },
	hosts: { 'nas.lan': '10.0.0.194' }
}, null, 0);

const uciData = {
	config: {
		'.type': 'core', '.name': 'config',
		enabled: '1', profile: 'test1', mode: 'rule', log_level: 'info', ipv6: '0',
		tcp_concurrent: '1', unified_delay: '1', keep_alive_interval: '30',
		global_ua: 'clash.meta/v1.19.33',
		allow_lan: '1', bind_address: '*',
		mixed_port: '7893', tproxy_port: '7894', redir_port: '0', socks_port: '0', port: '0',
		transparent_mode: 'tun', hijack_dnsmasq: '0',
		external_controller: '127.0.0.1:9097',
		test_url: 'https://www.gstatic.com/generate_204',
		geodata_mode: '0', geo_auto_update: '1', geo_update_interval: '24',
		watchdog: '1', watchdog_interval: '30',
		skip_auth_prefixes: ['127.0.0.1', '::1']
	},
	tun: { '.type': 'tun', '.name': 'tun', stack: 'mixed', device: 'bettbox', auto_route: '1', auto_redirect: '1', strict_route: '0', mtu: '9000', dns_hijack: 'any:53' },
	dns: { '.type': 'dns', '.name': 'dns', override: '1', listen: '0.0.0.0:1053', ipv6: '0', enhanced_mode: 'fake-ip', fake_ip_range: '198.18.0.1/16', respect_rules: '0', nameserver: ['https://223.5.5.5/dns-query', 'https://doh.pub/dns-query'], default_nameserver: ['223.5.5.5', '119.29.29.29'], fallback: ['https://1.1.1.1/dns-query'] },
	quic: { '.type': 'quic', '.name': 'quic', block: '1', exclude_china: '1' },
	sniffer: { '.type': 'sniffer', '.name': 'sniffer', enabled: '0', override_destination: '0' },
	experimental: { '.type': 'experimental', '.name': 'experimental', quic_gso: '1', quic_ecn: '0' },
	test1: { '.type': 'subscription', '.name': 'test1', label: '测试订阅', url: 'https://example.com/sub', override_rules: JSON.stringify({ mode: 'prepend', rules: ['DOMAIN,example.net,DIRECT'] }) }
};

const files = { '/tmp/base.json': profileJson };
const captured = { stdout: [], written: {} };
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '../bettbox/files/usr/libexec/bettbox/render.uc'), 'utf8')
	.replace(/^import .*$/gm, '')
	.replace(/for \((let \w+) in /g, 'for ($1 of ');
const sandbox = makeSandbox(files, uciData, ['/tmp/base.json', '/tmp/out.yaml', 'test1'], captured);

try {
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: 'render.uc' });
} catch (e) {
	console.error('RENDER FAILED:', e.message);
	process.exit(1);
}

const out = captured.written['/tmp/out.yaml'];
if (!out) { console.error('no output written'); process.exit(1); }
console.log('=== rendered YAML (first 70 lines) ===');
console.log(out.split('\n').slice(0, 70).join('\n'));

// round-trip parse
const parsed = yaml.load(out);
console.log('=== round-trip assertions ===');
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); };

assert(parsed['mixed-port'] === 7893, 'mixed-port patched to 7893');
assert(parsed['tproxy-port'] === 7894, 'tproxy-port patched');
assert(parsed['external-controller'] === '0.0.0.0:9097', 'controller bound 0.0.0.0 when allow_lan');
assert(parsed['geodata-mode'] === false, 'geodata-mode false');
assert(parsed.profile['store-selected'] === true, 'store-selected');
assert(parsed.hosts['dns.msftncsi.com'] === undefined, 'no Windows NCSI host injected');
assert(parsed.hosts['nas.lan'] === '10.0.0.194', 'explicit profile hosts preserved');
assert(parsed['find-process-mode'] === 'off', 'router process lookup disabled');
assert(parsed.ntp === undefined, 'no duplicate core NTP client');
assert(parsed.tun && parsed.tun.enable === true && parsed.tun['auto-redirect'] === true, 'tun section');
assert(parsed.tun.stack === 'mixed', 'explicitly configured TUN stack is preserved');
assert(parsed.dns['enhanced-mode'] === 'fake-ip' && Array.isArray(parsed.dns.nameserver), 'dns section');
assert(parsed.experimental['quic-go-disable-gso'] === true, 'experimental gso');
assert(parsed['geox-url'].mmdb.includes('bett-rules'), 'geox-url default from bett-rules');
assert(parsed['fake-ip-filter'] === undefined, 'base keys preserved, no junk at top');
assert(parsed.dns['fake-ip-filter'] && parsed.dns['fake-ip-filter'][0] === '*.lan', 'profile fake-ip-filter carried over');
// rules: prepend order = loopback(2 ports x2) + quic(1) + uci override(1) + profile rules
const r = parsed.rules;
assert(r[0] === 'AND,((DST-PORT,7893),(IP-CIDR,127.0.0.0/8,no-resolve)),REJECT', 'loopback rule 1');
assert(r[1] === 'AND,((DST-PORT,7893),(IP-CIDR,::1/128,no-resolve)),REJECT', 'loopback rule v6');
assert(r.includes('AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,geolocation-cn),(GEOIP,CN,no-resolve)))))),REJECT'), 'quic block w/ cn exception');
assert(r.includes('DOMAIN,example.net,DIRECT'), 'uci override_rules prepended');
assert(r.includes('DOMAIN-SUFFIX,google.com,🚀 节点选择'), 'profile rules kept');
// disabled groups -> PASS (declare one via profile to exercise rewrite)
assert(Array.isArray(parsed['proxy-groups']), 'proxy-groups is array');
assert(parsed['proxy-groups'].every(g => g && g.name && g.proxies), 'groups structure intact');
const passRules = parsed.rules.filter(x => String(x).endsWith(',PASS'));
console.log('PASS rules (expected none — disabled-groups not declared in this fixture):', passRules.length);

// ---------- scenario 2: disabled-groups rewrite + replace-mode override ----------
const uciData2 = JSON.parse(JSON.stringify(uciData));
delete uciData2.test1.override_rules;
const base2 = JSON.parse(profileJson);
base2['disabled-groups'] = ['🛑 广告拦截'];
const files2 = { '/tmp/base2.json': JSON.stringify(base2) };
const captured2 = { stdout: [], written: {} };
const sandbox2 = makeSandbox(files2, uciData2, ['/tmp/base2.json', '/tmp/out2.yaml', 'test1'], captured2);
try {
	vm.createContext(sandbox2);
	vm.runInContext(src, sandbox2, { filename: 'render2.uc' });
} catch (e) {
	console.error('SCENARIO2 FAILED:', e.message);
	process.exit(1);
}
const out2 = yaml.load(captured2.written['/tmp/out2.yaml']);
assert(!out2['proxy-groups'].some(g => g.name === '🛑 广告拦截'), 'scenario2: disabled group removed');
assert(out2.rules.includes('DOMAIN-SUFFIX,ads.example.com,PASS'), 'scenario2: rule targeting disabled group -> PASS');
assert(!out2['disabled-groups'], 'scenario2: disabled-groups key deleted');

// Legacy settings and app-oriented profiles must not re-enable retired features.
const uciData3 = JSON.parse(JSON.stringify(uciData));
uciData3.config.find_process_mode = 'always';
uciData3.ntp = { enabled: '1', server: 'time.apple.com', write_system: '1' };
const base3 = JSON.parse(profileJson);
base3['find-process-mode'] = 'always';
base3.ntp = { enable: true, 'write-to-system': true, server: 'time.apple.com' };
base3.hosts['dns.msftncsi.com'] = ['192.0.2.1'];
const captured3 = { stdout: [], written: {} };
const sandbox3 = makeSandbox({ '/tmp/base3.json': JSON.stringify(base3) }, uciData3,
	['/tmp/base3.json', '/tmp/out3.yaml', 'test1'], captured3);
vm.createContext(sandbox3);
vm.runInContext(src, sandbox3, { filename: 'render3.uc' });
const out3 = yaml.load(captured3.written['/tmp/out3.yaml']);
assert(out3['find-process-mode'] === 'off', 'legacy UCI/profile cannot enable process lookup');
assert(out3.ntp === undefined, 'legacy UCI/profile cannot enable core NTP or clock writes');
assert(out3.hosts['dns.msftncsi.com'][0] === '192.0.2.1', 'explicit user NCSI override preserved');
assert(out3.tun.enable && out3.dns.enable, 'router TUN and DNS remain enabled');

const uciData4 = JSON.parse(JSON.stringify(uciData));
uciData4.dns.override = '0';
uciData4.config.hijack_dnsmasq = '1';
const base4 = JSON.parse(profileJson);
delete base4.dns;
base4.port = 8888;
base4['socks-port'] = 8889;
base4['redir-port'] = 8890;
const captured4 = { stdout: [], written: {} };
const sandbox4 = makeSandbox({ '/tmp/base4.json': JSON.stringify(base4) }, uciData4,
	['/tmp/base4.json', '/tmp/out4.yaml', 'test1'], captured4);
vm.createContext(sandbox4);
vm.runInContext(src, sandbox4, { filename: 'render4.uc' });
const out4 = yaml.load(captured4.written['/tmp/out4.yaml']);
assert(out4.port === 0 && out4['socks-port'] === 0 && out4['redir-port'] === 0, 'zero ports override enabled subscription listeners');
assert(out4.dns.nameserver.indexOf('system://') < 0, 'fallback DNS cannot loop back through dnsmasq');

// Missing UCI values use the upstream Bettbox default; all four stacks round-trip.
for (const stack of [undefined, 'mips', 'mixed', 'gvisor', 'system']) {
	const stackUci = JSON.parse(JSON.stringify(uciData));
	if (stack === undefined) delete stackUci.tun.stack;
	else stackUci.tun.stack = stack;
	const stackCaptured = { stdout: [], written: {} };
	const stackSandbox = makeSandbox({ '/tmp/stack-base.json': profileJson }, stackUci,
		['/tmp/stack-base.json', '/tmp/stack-out.yaml', 'test1'], stackCaptured);
	vm.createContext(stackSandbox);
	vm.runInContext(src, stackSandbox, { filename: 'render-stack.uc' });
	const stackOut = yaml.load(stackCaptured.written['/tmp/stack-out.yaml']);
	assert(stackOut.tun.stack === (stack || 'mips'), 'TUN stack renders ' + (stack || 'upstream default mips'));
}
console.log('all scenarios done');
// round-trip again to ensure emitter output is stable-valid
const yaml2 = require('js-yaml').dump(parsed);
assert(typeof yaml2 === 'string' && yaml2.length > 100, 're-dumpable');
console.log('=== rules head ===');
console.log(r.slice(0, 8).join('\n'));
