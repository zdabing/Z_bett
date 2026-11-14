// SPDX-License-Identifier: GPL-3.0

const BUILTINS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];

function same(a, b) {
	if (type(a) != type(b)) return false;
	if (type(a) == 'object') {
		if (length(keys(a)) != length(keys(b))) return false;
		for (let key in keys(a))
			if (!(key in b) || !same(a[key], b[key])) return false;
		return true;
	}
	if (type(a) == 'array') {
		if (length(a) != length(b)) return false;
		for (let i = 0; i < length(a); i++)
			if (!same(a[i], b[i])) return false;
		return true;
	}
	return a === b;
}

function named_items(value, kind) {
	if (value == null) return [];
	if (type(value) != 'array') die(kind + ' 必须是列表');
	let seen = {};
	for (let item in value) {
		let name = item?.name;
		if (type(name) != 'string' || !length(trim(name)) || match(name, /[,\r\n]/) ||
		    name in BUILTINS || name in seen)
			die(kind + ' 含有无效或重复的名称');
		seen[name] = true;
	}
	return value;
}

function append_unique(target, values) {
	let seen = {};
	for (let value in target) seen[value] = true;
	for (let value in values) {
		if (value in seen) continue;
		seen[value] = true;
		push(target, value);
	}
}

function merge_map(target, incoming, kind) {
	if (incoming == null) return;
	if (type(incoming) != 'object') die(kind + ' 必须是映射');
	for (let key in keys(incoming)) {
		if (key in target && !same(target[key], incoming[key]))
			die(kind + ' 存在冲突：' + key);
		target[key] = incoming[key];
	}
}

// The first profile supplies the rules and top-level settings. Subsequent
// profiles contribute nodes and groups, keeping the first profile's rule targets.
export function merge_profiles(profiles) {
	if (type(profiles) != 'array' || length(profiles) < 2 || length(profiles) > 8)
		die('请选择 2 至 8 份订阅');
	for (let profile in profiles) {
		if (type(profile) != 'object') die('订阅配置必须是映射');
	}

	let result = profiles[0], nodes = [], groups = [], group_index = {}, occupied = {};
	let hosts = {}, rule_providers = {}, proxy_providers = {}, dns = null;
	for (let name in BUILTINS) occupied[name] = true;
	for (let config in profiles)
		for (let group in named_items(config['proxy-groups'], '策略组'))
			occupied[group.name] = true;

	for (let i = 0; i < length(profiles); i++) {
		let config = profiles[i], renamed = {};
		let proxies = named_items(config.proxies, '节点');
		for (let proxy in proxies) {
			let name = proxy.name, candidate = name, suffix = i + 1;
			if (i == 0 && name in occupied) die('主订阅节点与策略组重名：' + name);
			while (candidate in occupied) candidate = name + ' [' + suffix++ + ']';
			renamed[name] = candidate;
			occupied[candidate] = true;
		}
		for (let proxy in proxies) {
			proxy.name = renamed[proxy.name];
			let dialer = proxy['dialer-proxy'];
			if (type(dialer) == 'string' && dialer in renamed)
				proxy['dialer-proxy'] = renamed[dialer];
			push(nodes, proxy);
		}
		for (let group in config['proxy-groups'] ?? []) {
			for (let field in ['proxies', 'use']) {
				if (group[field] != null && (type(group[field]) != 'array' ||
				    length(filter(group[field], name => type(name) != 'string'))))
					die('策略组 ' + group.name + ' 的 ' + field + ' 必须是字符串列表');
			}
			if (group.proxies != null)
				group.proxies = map(group.proxies, name => renamed[name] ?? name);
			let current = group_index[group.name];
			if (!current) {
				group_index[group.name] = group;
				push(groups, group);
				continue;
			}
			for (let key in keys(group))
				if (!(key in ['proxies', 'use']) && !same(current[key], group[key]))
					die('同名策略组配置不一致：' + group.name);
			for (let key in keys(current))
				if (!(key in ['proxies', 'use']) && !(key in group))
					die('同名策略组配置不一致：' + group.name);
			for (let field in ['proxies', 'use']) {
				if (group[field] == null) continue;
				if (current[field] == null) current[field] = [];
				append_unique(current[field], group[field]);
			}
		}
		merge_map(hosts, config.hosts, 'hosts');
		merge_map(rule_providers, config['rule-providers'], '规则集');
		merge_map(proxy_providers, config['proxy-providers'], '代理集');
		if (config.dns != null) {
			if (type(config.dns) != 'object') die('DNS 配置必须是映射');
			if (!dns) {
				dns = config.dns;
				for (let field in ['nameserver-policy', 'proxy-server-nameserver-policy'])
					if (dns[field] != null && type(dns[field]) != 'object') die('DNS ' + field + ' 必须是映射');
				continue;
			}
			for (let field in ['nameserver-policy', 'proxy-server-nameserver-policy']) {
				if (config.dns[field] == null) continue;
				if (dns[field] == null) dns[field] = {};
				merge_map(dns[field], config.dns[field], 'DNS ' + field);
			}
		}
	}
	result.proxies = nodes;
	result['proxy-groups'] = groups;
	if (length(keys(hosts))) result.hosts = hosts;
	if (length(keys(rule_providers))) result['rule-providers'] = rule_providers;
	if (length(keys(proxy_providers))) result['proxy-providers'] = proxy_providers;
	if (dns) result.dns = dns;
	return result;
};
