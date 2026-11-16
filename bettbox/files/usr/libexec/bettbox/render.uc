#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
//
// bettbox config renderer: profile JSON (+ bettbox-forge output) + UCI ->
// /var/run/bettbox/config.yaml, adapting Bettbox's configuration patches:
//   - router general/dns/tun/sniffer/experimental/geox patches
//   - loopback protection + QUIC-block prepend rules (exact upstream strings)
//   - per-profile rule additions and disabled groups -> PASS
//   - profile.store-selected / store-fake-ip
//
// usage: render.uc <base.json> <out.yaml>

'use strict';

import { readfile, writefile } from 'fs';
import { cursor } from 'uci';
import { device_access, device_fallback_rules } from '/usr/libexec/bettbox/device-access.uc';
import { preserve_node_dns, check_dns, protect_real_ip, real_ip_domain } from '/usr/libexec/bettbox/dns-policy.uc';

const BETT_RULES = 'https://github.com/appshubcc/bett-rules/releases/latest/download';

let argv = filter(ARGV, a => substr(a, 0, 1) != '-');
if (length(argv) < 2) {
	die('usage: render.uc <base.json> <out.yaml> [subscription-sid]\n');
}

let base = json(readfile(argv[0]));
if (type(base) != 'object')
	die('profile JSON is not an object\n');

let sid = (length(argv) > 2) ? argv[2] : null;

let ctx = cursor();
let devices = device_access(ctx);
let uci = (section, option) => ctx.get('bettbox', section, option);
let uci_list = (section, option) => {
	let all = ctx.get_all('bettbox') ?? {};
	let sec = all[section] ?? {};
	return sec[option] ?? [];
};

/* ---------- YAML emitter (subset: maps / arrays / scalars) ---------- */

function plain_safe(s) {
	if (s == null || length(s) == 0)
		return false;
	// Character scan instead of a regex class: some ucode builds silently
	// never match escaped or \s sequences inside [...] classes.
	for (let i = 0; i < length(s); i++) {
		if (index(" \t:#{}[],&*!|>'\"%@`?", substr(s, i, 1)) >= 0)
			return false;
	}
	if (substr(s, 0, 1) == '-' || substr(s, 0, 1) == '?')
		return false;
	let lower = lc(s);
	if (lower in ['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', 'nan'])
		return false;
	if (match(s, /^[-+]?[0-9][0-9_]*$/))
		return false;
	if (match(s, /^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/))
		return false;
	return true;
}

function scalar(v) {
	switch (type(v)) {
	case 'bool':
		return v ? 'true' : 'false';
	case 'int':
	case 'double':
		return sprintf('%J', v);
	case 'string':
		return plain_safe(v) ? v : sprintf('%J', v);
	default:
		return 'null';
	}
}

function yaml(v, indent, out) {
	if (type(v) == 'object') {
		let klist = keys(v);
		if (length(klist) == 0) {
			push(out, indent == '' ? '{}' : sprintf('%s{}', indent));
			return;
		}
		for (let k in klist) {
			let key = plain_safe(k) ? k : sprintf('%J', k);
			let val = v[k];
			if (type(val) == 'object' && length(keys(val)) > 0) {
				push(out, sprintf('%s%s:', indent, key));
				yaml(val, indent + '  ', out);
			} else if (type(val) == 'array' && length(val) > 0) {
				push(out, sprintf('%s%s:', indent, key));
				yaml(val, indent + '  ', out);
			} else if (type(val) == 'object' || type(val) == 'array') {
				push(out, sprintf('%s%s: %s', indent, key, length(val) == 0 ? (type(val) == 'object' ? '{}' : '[]') : scalar(val)));
			} else {
				push(out, sprintf('%s%s: %s', indent, key, scalar(val)));
			}
		}
		return;
	}
	if (type(v) == 'array') {
		for (let item in v) {
			if (type(item) == 'object') {
				let sub = [];
				yaml(item, '', sub);
				let first = true;
				for (let line in sub) {
					push(out, first ? sprintf('%s- %s', indent, line) : sprintf('%s  %s', indent, line));
					first = false;
				}
			} else if (type(item) == 'array') {
				let sub = [];
				yaml(item, '', sub);
				for (let line in sub)
					push(out, sprintf('%s  %s', indent, line));
			} else {
				push(out, sprintf('%s- %s', indent, scalar(item)));
			}
		}
		return;
	}
	push(out, sprintf('%s%s', indent, scalar(v)));
}

function dump_yaml(v) {
	let out = [];
	yaml(v, '', out);
	return join('\n', out) + '\n';
}

/* ---------- merge helpers ---------- */

function merge(base, patch) {
	if (type(base) == 'object' && type(patch) == 'object') {
		let out = {};
		for (let k in keys(base))
			out[k] = base[k];
		for (let k in keys(patch))
			out[k] = merge(base[k], patch[k]);
		return out;
	}
	return patch;
}

function concat(a, b) {
	let out = [];
	for (let x in a)
		push(out, x);
	for (let x in b)
		push(out, x);
	return out;
}

function clean(v) {
	// drop null/'' values produced from unset UCI options
	if (type(v) == 'object') {
		let out = {};
		for (let k in keys(v)) {
			let c = clean(v[k]);
			if (c !== null && c !== '')
				out[k] = c;
		}
		return out;
	}
	if (type(v) == 'array') {
		let out = [];
		for (let item in v)
			push(out, clean(item));
		return out;
	}
	return v;
}

let num = (v, d) => {
	let n = int(v);
	return n > 0 ? n : d;
};

/* ---------- UCI -> patch ---------- */

let enabled_ports = [];
let add_port = (p) => {
	p = num(p, 0);
	if (p > 0 && !(p in enabled_ports))
		push(enabled_ports, p);
};

add_port(uci('config', 'mixed_port'));
add_port(uci('config', 'tproxy_port'));
add_port(uci('config', 'redir_port'));
add_port(uci('config', 'socks_port'));
add_port(uci('config', 'port'));

let mode = uci('config', 'transparent_mode') ?? 'tun';
let controller = uci('config', 'external_controller') ?? '127.0.0.1:9097';
let allow_lan = (uci('config', 'allow_lan') == '1');
let bind_address = allow_lan ? (uci('config', 'bind_address') ?? '*') : '127.0.0.1';

let geox_defaults = {
	mmdb: BETT_RULES + '/geoip.metadb',
	geoip: BETT_RULES + '/geoip.metadb',
	geosite: BETT_RULES + '/geosite.dat',
	asn: BETT_RULES + '/GeoLite2-ASN.mmdb'
};

let patch = {
	mode: uci('config', 'mode') ?? 'rule',
	'log-level': uci('config', 'log_level') ?? 'info',
	ipv6: (uci('config', 'ipv6') == '1'),
	'tcp-concurrent': (uci('config', 'tcp_concurrent') == '1'),
	'unified-delay': (uci('config', 'unified_delay') == '1'),
	'keep-alive-interval': num(uci('config', 'keep_alive_interval'), 30),
	// Track local processes when statistics is enabled. Forwarded devices have no local process.
	'find-process-mode': uci('config', 'traffic_history') == '1' ? 'strict' : 'off',
	'global-ua': uci('config', 'global_ua') ?? 'clash.meta/v1.19.34',
	'allow-lan': allow_lan,
	'bind-address': bind_address,
	'external-controller': allow_lan ? replace(controller, /^127\.0\.0\.1/, '0.0.0.0') : controller,
	'geodata-loader': 'memconservative',
	'geodata-mode': false,
	profile: {
		'store-selected': true,
		'store-fake-ip': true,
		'bettbox-traffic-profile': uci('config', 'traffic_history') == '1' ? sid ?? '' : '',
		'bettbox-traffic-retention': num(uci('config', 'traffic_retention'), 7)
	}
};

if (uci('config', 'secret'))
	patch.secret = uci('config', 'secret');

// Zero explicitly disables an inbound, overriding any subscription value.
patch['mixed-port'] = num(uci('config', 'mixed_port'), 0);
patch['tproxy-port'] = num(uci('config', 'tproxy_port'), 0);
patch['redir-port'] = num(uci('config', 'redir_port'), 0);
patch['socks-port'] = num(uci('config', 'socks_port'), 0);
patch.port = num(uci('config', 'port'), 0);

let auth = filter(uci_list('config', 'authentication'), v => length(v) > 0);
if (length(auth) > 0)
	patch.authentication = auth;
let skips = filter(uci_list('config', 'skip_auth_prefixes'), v => length(v) > 0);
if (length(skips) > 0)
	patch['skip-auth-prefixes'] = skips;

// external-ui (zashboard)
if (uci('config', 'external_ui') == '1' && readfile('/usr/share/bettbox/ui/index.html') != null)
	patch['external-ui'] = '/usr/share/bettbox/ui';

// geox
let geo_update = {
	'geo-auto-update': (uci('config', 'geo_auto_update') == '1'),
	'geo-update-interval': num(uci('config', 'geo_update_interval'), 24)
};
patch = merge(patch, geo_update);
let geox = {};
for (let k in keys(geox_defaults))
	geox[k] = geox_defaults[k];
for (let k in ['mmdb', 'geosite', 'asn']) {
	let v = uci('config', 'geox_' + k);
	if (v) {
		geox[k] = v;
		if (k == 'mmdb')
			geox.geoip = v;
	}
}
patch['geox-url'] = geox;

// Keep subscription or script DNS by default and set the router's listener.
if (devices.enabled && mode != 'off' && !match(uci('dns', 'listen') ?? '0.0.0.0:1053', /^(0\.0\.0\.0|\[::\]):[0-9]+$/))
	die('设备控制需要 DNS 监听 0.0.0.0:端口 或 [::]:端口\n');
if (type(base?.dns) == 'object' && base.dns.enable !== false) {
	// keep the profile DNS; only ensure it serves on the loopback listener
	patch.dns = {
		enable: true,
		listen: uci('dns', 'listen') ?? '0.0.0.0:1053'
	};
} else {
	// profile has no usable DNS: keep name resolution alive like upstream
	patch.dns = {
		enable: true,
		listen: uci('dns', 'listen') ?? '0.0.0.0:1053',
		'enhanced-mode': 'redir-host',
		// dnsmasq may forward to us; using system:// here would form a loop.
		nameserver: [ '223.5.5.5', '119.29.29.29' ]
	};
}

// Router TUN: keep LAN/loopback out of the tunnel. Stack and forwarding
// parameters are core networking features, not desktop application settings.
if (mode == 'tun') {
	let dns_hijack = trim(uci('tun', 'dns_hijack') ?? 'any:53');
	patch.tun = {
		enable: true,
		stack: uci('tun', 'stack') ?? 'mips',
		device: uci('tun', 'device') ?? 'bettbox',
		// Device access uses source-filtered policy routing, including with
		// official cores; do not also install the core's all-device takeover.
		'auto-route': !devices.enabled && (uci('tun', 'auto_route') != '0'),
		'auto-redirect': !devices.enabled && (uci('tun', 'auto_redirect') != '0'),
		'strict-route': (uci('tun', 'strict_route') == '1'),
		'auto-detect-interface': true,
		'dns-mode': length(dns_hijack) > 0 ? 'hijack' : 'disabled',
		'dns-hijack': length(dns_hijack) > 0 ? [ dns_hijack ] : [],
		'endpoint-independent-nat': (uci('tun', 'endpoint_independent_nat') == '1'),
		mtu: num(uci('tun', 'mtu'), 9000),
		'route-exclude-address': [
			'127.0.0.0/8', '::1/128',
			'10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
			'fd00::/8', 'fe80::/10'
		],
		'disable-icmp-forwarding': true
	};
} else {
	// A subscription or override must not retain a second, all-device TUN
	// takeover when the router is configured for TPROXY or REDIR.
	patch.tun = { enable: false, 'auto-route': false, 'auto-redirect': false };
}

// sniffer
if (uci('sniffer', 'enabled') == '1') {
	let override_dest = (uci('sniffer', 'override_destination') == '1');
	patch.sniffer = {
		enable: true,
		'parse-pure-ip': true,
		'override-destination': override_dest,
		sniff: {
			HTTP: { ports: [ 80, '8080-8880' ], 'override-destination': override_dest },
			TLS: { ports: [ 443, 8443 ] },
			QUIC: { ports: [ 443, 8443 ] }
		}
	};
}

// OpenWrt's system time service owns router clock synchronization. Do not
// inherit an app/profile NTP client that could also write the system clock.
delete base.ntp;

// experimental
patch.experimental = {
	'quic-go-disable-gso': (uci('experimental', 'quic_gso') != '0'),
	'quic-go-disable-ecn': (uci('experimental', 'quic_ecn') != '0')
};

/* ---------- rules assembly (upstream prepend-rules semantics) ---------- */

let prepend = [];

// loopback protection, one rule per enabled inbound port
for (let p in enabled_ports) {
	push(prepend, 'AND,((DST-PORT,' + p + '),(IP-CIDR,127.0.0.0/8,no-resolve)),REJECT');
	push(prepend, 'AND,((DST-PORT,' + p + '),(IP-CIDR6,::1/128,no-resolve)),REJECT');
}

// QUIC block (exact upstream strings, lib/state.dart buildPatchParams)
let merge_members = sid != null ? uci(sid, 'merge_members') : null;
let is_managed = sid != null && (
	uci(sid, 'use_managed') == '1' ||
	(type(merge_members) == 'array' ? length(merge_members) > 0 : length(merge_members ?? '') > 0)
);
if (uci('quic', 'block') == '1' && !is_managed)
	push(prepend, 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT');

if (sid != null) {
	let preset = uci(sid, 'rule_preset');
	let text = uci('config', 'rule_presets');
	if (preset) {
		let presets = text ? json(text) : {};
		let rules = presets?.[preset];
		if (type(rules) != 'array' || length(filter(rules, rule => type(rule) != 'string')))
			die('所选分流预设无效或已删除');
		prepend = concat(prepend, rules);
	}
}
// per-subscription rule override (UCI, LuCI profiles page)
if (sid != null) {
	let ov_text = uci(sid, 'override_rules');
	if (ov_text) {
		let ov = null;
		try { ov = json(ov_text); } catch (e) { ov = null; }
		if (type(ov) == 'object' && type(ov.rules) == 'array') {
			prepend = concat(prepend, ov.rules);
		}
	}
}
// Profile-carried rule additions.
let override = base['override-rules'] ?? null;
if (type(override) == 'object' && type(override.rules) == 'array') {
	prepend = concat(prepend, override.rules);
}

if (type(base.rules) != 'array')
	base.rules = [];
base.rules = concat(prepend, base.rules);
delete base['override-rules'];

/* ---------- disabled groups -> PASS (upstream disabled-groups) ---------- */

let disabled = base['disabled-groups'] ?? null;
if (type(disabled) == 'array' && length(disabled) > 0 && type(base['proxy-groups']) == 'array') {
	let groups = base['proxy-groups'];
	let is_disabled = {};
	for (let name in disabled)
		is_disabled[name] = true;
	base['proxy-groups'] = filter(groups, g => !is_disabled[g?.name]);
	base.rules = map(base.rules, (rule) => {
		if (type(rule) != 'string')
			return rule;
		let parts = split(rule, ',');
		let action = uc(trim(parts[0])), idx = length(parts) - 1;
		if (action == 'SUB-RULE') return rule;
		// Logical rules contain commas inside their expression. The target
		// follows it, before any optional src/no-resolve suffixes.
		while (idx > 1 && index(['src', 'no-resolve'], trim(parts[idx])) >= 0) idx--;
		let has_target = idx >= 2 || (idx == 1 && (action == 'MATCH' || action == 'FINAL'));
		if (!has_target || !is_disabled[trim(parts[idx])]) return rule;
		parts[idx] = 'PASS';
		return join(',', parts);
	});
	delete base['disabled-groups'];
}

function ensure_bettbox_rule_providers(cfg) {
	let names = {};
	let add_name = (raw) => {
		let n = trim(raw ?? '');
		if (length(n) > 8 && substr(n, -8) == '_bettbox' && match(n, /^[A-Za-z0-9._@-]+$/))
			names[n] = true;
	};
	for (let rule in (cfg.rules ?? [])) {
		if (type(rule) != 'string')
			continue;
		let rest = rule;
		while (length(rest) > 0) {
			let m = match(rest, /(^|[^A-Za-z0-9_-])RULE-SET,[ \t]*([^,() \t\r\n]+)/i);
			if (!m)
				break;
			add_name(m[2]);
			let pos = index(rest, m[0]);
			if (pos < 0)
				break;
			rest = substr(rest, pos + length(m[0]));
		}
	}
	let add_entry = (entry) => {
		if (type(entry) != 'string')
			return;
		let s = trim(entry);
		if (length(s) <= 9 || lc(substr(s, 0, 9)) != 'rule-set:')
			return;
		for (let part in split(substr(s, 9), ','))
			add_name(part);
	};
	if (type(cfg.dns?.['fake-ip-filter']) == 'array') {
		for (let entry in cfg.dns['fake-ip-filter'])
			add_entry(entry);
	}
	for (let pk in ['nameserver-policy', 'proxy-server-nameserver-policy']) {
		if (type(cfg.dns?.[pk]) != 'object')
			continue;
		for (let k in keys(cfg.dns[pk]))
			add_entry(k);
	}
	if (length(keys(names)) == 0)
		return;
	if (type(cfg['rule-providers']) != 'object')
		cfg['rule-providers'] = {};
	for (let name in keys(names)) {
		if (cfg['rule-providers'][name] != null)
			continue;
		let tag = substr(name, 0, length(name) - 8);
		let kind = 'geosite', behavior = 'domain';
		if (length(tag) > 3 && substr(tag, -3) == '_ip') {
			tag = substr(tag, 0, length(tag) - 3);
			kind = 'geoip';
			behavior = 'ipcidr';
		}
		let file = kind + '/' + tag + '.mrs';
		cfg['rule-providers'][name] = {
			type: 'http',
			behavior: behavior,
			format: 'mrs',
			interval: 86400,
			url: 'https://cdn.jsdelivr.net/gh/appshubcc/bett-rules@meta/geo/' + file,
			path: './rules/' + name + '.mrs',
			'path-in-bundle': 'geo/' + file
		};
	}
}

/* ---------- output ---------- */

let final = merge(base, clean(patch));
let fallback_targets = { DIRECT: true, REJECT: true };
for (let group in (final['proxy-groups'] ?? [])) fallback_targets[group.name] = true;
for (let proxy in (final.proxies ?? [])) fallback_targets[proxy.name] = true;
let device_rules = device_fallback_rules(ctx, fallback_targets);
if (length(device_rules)) {
	let ordered = [], inserted = false;
	for (let rule in (final.rules ?? [])) {
		if (!inserted && match(rule, /^\s*(MATCH|FINAL)\s*,/)) {
			ordered = concat(ordered, device_rules);
			inserted = true;
		}
		push(ordered, rule);
	}
	final.rules = inserted ? ordered : concat(ordered, device_rules);
}
ensure_bettbox_rule_providers(final);
let real_domains=uci_list('dns','real_ip_domains');
if(type(real_domains)=='string')real_domains=[real_domains];
else real_domains=map(real_domains,d=>d);
ctx.foreach('ddns','service',s=>{
	if(s.enabled!='1')return;
	let domain=real_ip_domain(s.lookup_host??s.domain);
	if(domain!=null)push(real_domains,domain);
});
protect_real_ip(final,real_domains);
preserve_node_dns(final);
let dns_warnings = check_dns(final, uci('config', 'hijack_dnsmasq') == '1' && !devices.enabled);
for (let message in dns_warnings) warn('DNS 配置检查: ' + message + '\n');
writefile(argv[1], dump_yaml(final));
