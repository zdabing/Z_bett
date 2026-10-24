#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
//
// Rule-match tracing (upstream Bettbox core/toolbox/route_trace.go semantics):
// walk the running core's rules in order, find the first rule a target hits,
// then expand the adapter chain. Dataset rules (GEOSITE/GEOIP/RULE-SET...) are
// marked skipped — they need the core's own data to evaluate.
//
// usage: trace_match.uc <rules.json> <proxies.json> <host>

'use strict';

import { readfile } from 'fs';

function is_ipv4(s) {
	if (length(s) < 7 || length(s) > 15)
		return false;
	let parts = split(s, '.');
	if (length(parts) != 4)
		return false;
	for (let p in parts) {
		if (length(p) == 0 || length(p) > 3)
			return false;
		for (let i = 0; i < length(p); i++) {
			let c = substr(p, i, 1);
			if (index('0123456789', c) < 0)
				return false;
		}
		if (int(p) > 255)
			return false;
	}
	return true;
}

function ip_to_int(s) {
	let parts = split(s, '.');
	return ((int(parts[0]) * 256 + int(parts[1])) * 256 + int(parts[2])) * 256 + int(parts[3]);
}

function ip_in_cidr(ip, cidr) {
	let seg = split(cidr, '/');
	if (length(seg) != 2)
		return false;
	let mask = int(seg[1]);
	if (mask <= 0)
		return true;
	return (ip_to_int(ip) >> (32 - mask)) == (ip_to_int(seg[0]) >> (32 - mask));
}

function host_matches(rule_type, payload, host, host_ip) {
	// mihomo /rules returns CamelCase enum names ("DomainSuffix", "Match");
	// normalize both spellings to bare upper-case.
	let rt = replace(uc(rule_type), '-', '');
	switch (rt) {
	case 'DOMAIN':
		return (host == payload);
	case 'DOMAINSUFFIX':
		return (host == payload || substr(host, length(host) - length(payload) - 1) == '.' + payload);
	case 'DOMAINKEYWORD':
		return (index(host, payload) >= 0);
	case 'DOMAINREGEX':
		return null; // regex engine differences: mark unevaluated
	case 'IPCIDR':
	case 'IPCIDR6':
		if (host_ip == null)
			return false;
		return ip_in_cidr(host_ip, payload);
	case 'GEOIP':
	case 'GEOSITE':
	case 'RULESET':
	case 'AND':
	case 'OR':
	case 'NOT':
	case 'PROCESSPATH':
	case 'PROCESSPATHREGEX':
	case 'NETWORK':
	case 'UID':
	case 'INUSER':
	case 'INTYPE':
	case 'SUBRULE':
		return null; // dataset/logic rules: cannot evaluate without core data
	default:
		return null;
	}
}

let rules_data = json(readfile(ARGV[0]));
let proxies_data = json(readfile(ARGV[1]));
let host = ARGV[2];

let rules = (rules_data && rules_data.rules) ? rules_data.rules : [];
let proxies = (proxies_data && proxies_data.proxies) ? proxies_data.proxies : {};

printf('目标: %s (%s)\n', host, is_ipv4(host) ? 'IP' : '域名');
printf('规则总数: %d\n\n', length(rules));

// resolve domain to an IP for IP-rule matching
let host_ip = is_ipv4(host) ? host : null;
if (host_ip == null) {
	// resolved later below if dns fails, stays null and IP rules are skipped
}

let matched = null;
let steps = 0;
for (let r in rules) {
	let m = host_matches(r.type ?? '', r.payload ?? '', host, host_ip);
	steps++;
	if (m === true) {
		matched = r;
		printf('  → 命中 #%d: %s,%s → %s\n', steps, r.type ?? '', r.payload ?? '', r.proxy ?? '');
		break;
	}
	if (steps <= 12 && m === null && r.type != 'MATCH')
		printf('    #%d %s,%s → %s  [数据集规则，未求值]\n', steps, r.type ?? '', r.payload ?? '', r.proxy ?? '');
	if (replace(uc(r.type), '-', '') == 'MATCH') {
		matched = r;
		printf('  → 兜底命中 #%d: MATCH → %s\n', steps, r.proxy ?? '');
		break;
	}
}

if (matched == null) {
	print('未找到 MATCH 兜底规则（配置异常）\n');
	exit(1);
}

// expand the adapter chain: group now -> member groups -> node
let seen = {};
let chain = [];
let cur = matched.proxy ?? '';
while (cur != '' && cur != null && !seen[cur]) {
	seen[cur] = true;
	push(chain, cur);
	let p = proxies[cur];
	if (p == null)
		break;
	cur = p.now ?? '';
}

printf('\n策略链: %s\n', join(' → ', chain));

// current exit node detail
let exit_name = chain[length(chain) - 1] ?? '';
let exit_p = proxies[exit_name];
if (exit_p != null && exit_p.all != null) {
	printf('出口「%s」类型: %s，可选 %d 项\n', exit_name, exit_p.type ?? '?', length(exit_p.all));
} else if (exit_name == 'DIRECT') {
	print('出口: DIRECT 直连\n');
} else if (exit_name == 'REJECT' || exit_name == 'REJECT-DROP') {
	print('出口: REJECT 拒绝\n');
} else {
	printf('出口: %s\n', exit_name);
}
