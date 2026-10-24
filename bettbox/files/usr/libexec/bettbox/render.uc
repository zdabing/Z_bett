#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
//
// bettbox config renderer: profile JSON (+ bettbox-forge output) + UCI ->
// /var/run/bettbox/config.yaml, mirroring Bettbox's applyPatch semantics:
//   - general/dns/tun/sniffer/ntp/experimental/geox/hosts patches
//   - loopback protection + QUIC-block prepend rules (exact upstream strings)
//   - per-profile rule override (prepend/replace) and disabled groups -> PASS
//   - profile.store-selected / store-fake-ip
//
// usage: render.uc <base.json> <out.yaml>

'use strict';

import { readfile, writefile } from 'fs';
import { cursor } from 'uci';

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
	mmdb: BETT_RULES + '/country.mmdb',
	geoip: BETT_RULES + '/country.mmdb',
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
	'find-process-mode': uci('config', 'find_process_mode') ?? 'off',
	'global-ua': uci('config', 'global_ua') ?? 'clash.meta/v1.19.33',
	'allow-lan': allow_lan,
	'bind-address': bind_address,
	'external-controller': allow_lan ? replace(controller, /^127\.0\.0\.1/, '0.0.0.0') : controller,
	'geodata-loader': 'memconservative',
	'geodata-mode': (uci('config', 'geodata_mode') == '1'),
	profile: {
		'store-selected': true,
		'store-fake-ip': true
	},
	hosts: {
		'dns.msftncsi.com': [ '131.107.255.255', 'fd3e:4f5a:5b81::1' ]
	}
};

if (uci('config', 'secret'))
	patch.secret = uci('config', 'secret');

if (num(uci('config', 'mixed_port'), 0) > 0)
	patch['mixed-port'] = num(uci('config', 'mixed_port'), 0);
if (num(uci('config', 'tproxy_port'), 0) > 0)
	patch['tproxy-port'] = num(uci('config', 'tproxy_port'), 0);
if (num(uci('config', 'redir_port'), 0) > 0)
	patch['redir-port'] = num(uci('config', 'redir_port'), 0);
if (num(uci('config', 'socks_port'), 0) > 0)
	patch['socks-port'] = num(uci('config', 'socks_port'), 0);
if (num(uci('config', 'port'), 0) > 0)
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
for (let k in ['mmdb', 'geoip', 'geosite', 'asn']) {
	let v = uci('config', 'geox_' + k);
	if (v)
		geox[k] = v;
}
patch['geox-url'] = geox;

// DNS — upstream semantics: the subscription's DNS section is authoritative
// (its rule-set filters, nameserver-policy, #DIRECT/#group annotations are
// crafted by the provider); we only patch enable+listen on top so dnsmasq can
// forward to the core. A full replace happens only when the user explicitly
// turns on "覆写 DNS" (dns.override=1), matching upstream overrideDns.
if (uci('dns', 'override') == '1') {
	let nameservers = filter(uci_list('dns', 'nameserver'), v => length(v) > 0);
	if (length(nameservers) == 0)
		nameservers = [ 'system://' ];
	let dns = {
		enable: true,
		listen: uci('dns', 'listen') ?? '0.0.0.0:1053',
		ipv6: (uci('dns', 'ipv6') == '1'),
		'enhanced-mode': uci('dns', 'enhanced_mode') ?? 'fake-ip',
		'fake-ip-range': uci('dns', 'fake_ip_range') ?? '198.18.0.1/16',
		nameserver: nameservers
	};
	let defaults = filter(uci_list('dns', 'default_nameserver'), v => length(v) > 0);
	if (length(defaults) > 0)
		dns['default-nameserver'] = defaults;
	let fallback = filter(uci_list('dns', 'fallback'), v => length(v) > 0);
	if (length(fallback) > 0)
		dns.fallback = fallback;
	let psn = filter(uci_list('dns', 'proxy_server_nameserver'), v => length(v) > 0);
	if (length(psn) > 0)
		dns['proxy-server-nameserver'] = psn;
	let dns_fip = (base?.dns != null) ? base.dns['fake-ip-filter'] : null;
	if (dns_fip != null)
		dns['fake-ip-filter'] = dns_fip;
	let dns_nsp = (base?.dns != null) ? base.dns['nameserver-policy'] : null;
	if (dns_nsp != null)
		dns['nameserver-policy'] = dns_nsp;
	if (uci('dns', 'respect_rules') == '1')
		dns['respect-rules'] = true;
	patch.dns = dns;
} else if (type(base?.dns) == 'object' && base.dns.enable !== false) {
	// keep the profile DNS; only ensure it serves on the loopback listener
	patch.dns = {
		enable: true,
		listen: uci('dns', 'listen') ?? '0.0.0.0:1053'
	};
} else {
	// profile has no usable DNS: keep name resolution alive like upstream
	patch.dns = {
		enable: true,
		listen: '0.0.0.0:1053',
		'enhanced-mode': 'redir-host',
		nameserver: [ 'system://' ]
	};
}

// TUN — upstream injects a default tun block (route-exclude-address keeps
// LAN/loopback out of the tunnel; bbr3 + icmp guard match the app defaults)
if (mode == 'tun') {
	patch.tun = {
		enable: true,
		stack: uci('tun', 'stack') ?? 'mixed',
		device: uci('tun', 'device') ?? 'bettbox',
		'auto-route': (uci('tun', 'auto_route') != '0'),
		'auto-redirect': (uci('tun', 'auto_redirect') != '0'),
		'strict-route': (uci('tun', 'strict_route') == '1'),
		'auto-detect-interface': true,
		'dns-hijack': [ uci('tun', 'dns_hijack') ?? 'any:53' ],
		mtu: num(uci('tun', 'mtu'), 9000),
		'route-exclude-address': [
			'127.0.0.0/8', '::1/128',
			'10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16',
			'fd00::/8', 'fe80::/10'
		],
		'disable-icmp-forwarding': true,
		'congestion-controller': 'bbr3'
	};
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
		},
		'force-domain': [ '+v2ex.com' ],
		'skip-domain': [ 'Mijia Cloud' ]
	};
}

// ntp
if (uci('ntp', 'enabled') == '1') {
	patch.ntp = {
		enable: true,
		server: uci('ntp', 'server') ?? 'time.apple.com',
		port: num(uci('ntp', 'port'), 123),
		interval: num(uci('ntp', 'interval'), 30),
		'write-to-system': (uci('ntp', 'write_system') == '1')
	};
}

// experimental
patch.experimental = {
	'quic-go-disable-gso': (uci('experimental', 'quic_gso') != '0'),
	'quic-go-disable-ecn': (uci('experimental', 'quic_ecn') == '1')
};

/* ---------- rules assembly (upstream prepend-rules semantics) ---------- */

let prepend = [];

// loopback protection, one rule per enabled inbound port
for (let p in enabled_ports) {
	push(prepend, 'AND,((DST-PORT,' + p + '),(IP-CIDR,127.0.0.0/8,no-resolve)),REJECT');
	push(prepend, 'AND,((DST-PORT,' + p + '),(IP-CIDR,::1/128,no-resolve)),REJECT');
}

// QUIC block (exact upstream strings, lib/state.dart buildPatchParams)
if (uci('quic', 'block') == '1') {
	if (uci('quic', 'exclude_china') == '1')
		push(prepend, 'AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((OR,((GEOSITE,geolocation-cn),(GEOIP,CN,no-resolve)))))),REJECT');
	else
		push(prepend, 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT');
}

let replace_rules = null;
// per-subscription rule override (UCI, LuCI profiles page)
if (sid != null) {
	let ov_text = uci(sid, 'override_rules');
	if (ov_text) {
		let ov = null;
		try { ov = json(ov_text); } catch (e) { ov = null; }
		if (type(ov) == 'object' && type(ov.rules) == 'array') {
			if (ov.mode == 'replace')
				replace_rules = ov.rules;
			else
				prepend = concat(prepend, ov.rules);
		}
	}
}
// profile-carried override (upstream override-rules patch)
let override = base['override-rules'] ?? null;
if (type(override) == 'object' && type(override.rules) == 'array') {
	if (override.mode == 'replace')
		replace_rules = override.rules;
	else
		prepend = concat(prepend, override.rules);
}

if (type(base.rules) != 'array')
	base.rules = [];
base.rules = (replace_rules != null) ? concat(prepend, replace_rules) : concat(prepend, base.rules);
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
		let target = (parts[0] == 'MATCH' || (parts[0] == 'GEOIP' && length(parts) == 2)) ? parts[1] : parts[2];
		if (target != null && is_disabled[target]) {
			let idx = (length(parts) == 2) ? 1 : 2;
			let out = [];
			let pos = 0;
			for (let seg in parts) {
				push(out, (pos == idx) ? 'PASS' : seg);
				pos++;
			}
			return join(',', out);
		}
		return rule;
	});
	delete base['disabled-groups'];
}

/* ---------- output ---------- */

let final = merge(base, clean(patch));
writefile(argv[1], dump_yaml(final));
