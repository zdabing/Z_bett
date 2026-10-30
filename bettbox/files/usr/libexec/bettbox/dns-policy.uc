'use strict';
// SPDX-License-Identifier: GPL-3.0
// Pure configuration checks: no DNS requests and no system configuration writes.

function dns_values(value, path) {
	if (type(value) == 'string' && length(trim(value))) return [value];
	if (type(value) == 'array' && length(value)) {
		for (let entry in value)
			if (type(entry) != 'string' || !length(trim(entry)))
				die(path + ': DNS 地址必须为非空字符串\n');
		return value;
	}
	die(path + ': 请配置至少一个 DNS 上游\n');
}

function dns_endpoint(value) {
	let text = lc(trim(value));
	let scheme = match(text, /^([a-z0-9+]+):\/\//);
	if (scheme) {
		// Only the core's plain DNS listener can be a definite self-reference.
		if (!(scheme[1] in ['udp', 'tcp'])) return null;
		text = substr(text, length(scheme[0]));
	}
	text = split(split(split(text, '#')[0], '?')[0], '/')[0];
	let host, port = '53';
	if (substr(text, 0, 1) == '[') {
		let end = index(text, ']');
		if (end < 2) return null;
		host = substr(text, 1, end - 1);
		let tail = substr(text, end + 1);
		if (length(tail)) {
			if (!match(tail, /^:[0-9]+$/)) return null;
			port = substr(tail, 1);
		}
	} else {
		let parts = split(text, ':');
		if (length(parts) > 2 || !length(parts[0])) return null;
		host = parts[0];
		if (length(parts) == 2) port = parts[1];
	}
	return match(port, /^[0-9]+$/) ? { host: host, port: int(port) } : null;
}

function dns_local(host) {
	return host in ['localhost', '::1', '::', '0.0.0.0'] || match(host, /^127\.[0-9]+\.[0-9]+\.[0-9]+$/) != null;
}

function dns_match(key, domain) {
	key = lc(key);
	if (key == domain) return 100000 + length(key);
	let prefix = match(key, /^(\+\.|\*\.|\.)/);
	if (!prefix) return 0;
	let suffix = substr(key, length(prefix[0]));
	if (domain == suffix) return prefix[0] == '+.' ? 100000 + length(suffix) : 0;
	if (length(domain) <= length(suffix) || substr(domain, length(domain) - length(suffix) - 1) != '.' + suffix) return 0;
	let left = substr(domain, 0, length(domain) - length(suffix) - 1);
	if (prefix[0] == '*.' && index(left, '.') >= 0) return 0;
	return length(suffix) * 4 + (prefix[0] == '*.' ? 2 : 1);
}

// Copy only policies for actual inline node domains, and never override an
// explicit node policy. Do not expand geosite/rule-set/regexp selectors here.
export function preserve_node_dns(config) {
	let dns = config.dns;
	if (type(dns) != 'object' || type(dns['nameserver-policy']) != 'object' ||
		type(dns['proxy-server-nameserver']) != 'array' || !length(dns['proxy-server-nameserver'])) return;
	let explicit = dns['proxy-server-nameserver-policy'] ?? {};
	if (type(explicit) != 'object') die('dns.proxy-server-nameserver-policy: 必须为映射\n');
	// An explicit rule-set/geosite/complex wildcard may already own any node.
	// Its membership is unavailable offline: preserve it without adding rules.
	for (let key in keys(explicit))
		if (!match(key, /^(\+\.|\*\.|\.)?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/)) return;
	let result = {};
	for (let key in keys(explicit)) result[key] = explicit[key];
	for (let node in config.proxies ?? []) {
		if (type(node?.server) != 'string') continue;
		let domain = lc(node.server);
		if (!match(domain, /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/) || match(domain, /^[0-9.]+$/)) continue;
		let owned = false;
		for (let key in keys(explicit)) if (dns_match(key, domain)) owned = true;
		if (owned) continue;
		let best = 0, value;
		for (let key in keys(dns['nameserver-policy'])) {
			// Mihomo evaluates blocks separated by geosite/rule-set matchers in
			// order. Membership of an opaque block cannot be inferred offline.
			if (!match(key, /^(\+\.|\*\.|\.)?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/)) break;
			let score = dns_match(key, domain);
			if (score > 0 && score >= best) { best = score; value = dns['nameserver-policy'][key]; }
		}
		if (best) result[domain] = value;
	}
	if (length(keys(result))) dns['proxy-server-nameserver-policy'] = result;
};

export function check_dns(config, forwards_dnsmasq) {
	let dns = config.dns;
	if (type(dns) != 'object' || dns.enable === false) return [];
	let warnings = [];
	let listen = dns.listen ?? '0.0.0.0:1053';
	if (type(listen) != 'string' || !match(listen, /:[0-9]+$/))
		die('dns.listen: 请输入有效的监听地址和端口\n');
	if (substr(listen, 0, 1) == ':') listen = '0.0.0.0' + listen;
	let listener = dns_endpoint(listen);
	if (!listener || listener.port < 1 || listener.port > 65535)
		die('dns.listen: 请输入有效的监听地址和端口\n');
	dns_values(dns.nameserver, 'dns.nameserver');
	if (dns['respect-rules'] === true &&
		(type(dns['proxy-server-nameserver']) != 'array' || !length(dns['proxy-server-nameserver'])))
		die('dns.proxy-server-nameserver: 开启 respect-rules 时必须配置节点域名 DNS\n');
	if (type(dns['proxy-server-nameserver-policy']) == 'object' && length(keys(dns['proxy-server-nameserver-policy'])) &&
		(type(dns['proxy-server-nameserver']) != 'array' || !length(dns['proxy-server-nameserver'])))
		die('dns.proxy-server-nameserver: 配置节点 DNS 策略时必须配置默认节点 DNS\n');
	let entries = [];
	for (let key in ['nameserver', 'fallback', 'default-nameserver', 'proxy-server-nameserver', 'direct-nameserver']) {
		if (dns[key] == null) continue;
		// Empty optional arrays are valid in Mihomo.
		if (type(dns[key]) == 'array' && !length(dns[key]) && key != 'nameserver') continue;
		for (let value in dns_values(dns[key], 'dns.' + key)) push(entries, { path: 'dns.' + key, value: value });
	}
	for (let key in ['nameserver-policy', 'proxy-server-nameserver-policy']) {
		if (dns[key] == null) continue;
		if (type(dns[key]) != 'object') die('dns.' + key + ': 必须为映射\n');
		let ordinal = 0;
		for (let domain in keys(dns[key])) {
			// Report an index, not private domain names or resolver credentials.
			let path = 'dns.' + key + '[' + ordinal++ + ']';
			for (let value in dns_values(dns[key][domain], path)) push(entries, { path: path, value: value });
		}
	}
	let wildcard = listener.host in ['0.0.0.0', '::'];
	for (let entry in entries) {
		let target = dns_endpoint(entry.value);
		if (target && target.port == listener.port &&
			(target.host == listener.host || (wildcard && dns_local(target.host)) ||
			(target.host == 'localhost' && dns_local(listener.host))))
			die(entry.path + ': DNS 上游指向核心自身监听端口，请修改该上游\n');
		if (forwards_dnsmasq && match(lc(trim(entry.value)), /^system(:\/\/)?([#?].*)?$/))
			push(warnings, entry.path + ': system DNS 与 dnsmasq 转发可能形成回环，需核对路由器 resolv.conf');
		else if (forwards_dnsmasq && target && target.port == 53 && dns_local(target.host))
			push(warnings, entry.path + ': 本地 53 端口可能经 dnsmasq 返回核心，需核对实际监听服务');
	}
	return warnings;
};
