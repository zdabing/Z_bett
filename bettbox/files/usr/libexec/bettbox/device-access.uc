'use strict';
// SPDX-License-Identifier: GPL-3.0

function ipv4_bytes(text) {
	let parts = split(text, '.');
	if (length(parts) != 4) return null;
	let bytes = [];
	for (let p in parts) {
		if (!match(p, /^(0|[1-9][0-9]{0,2})$/) || int(p) > 255) return null;
		push(bytes, int(p));
	}
	return bytes;
}

function ipv6_bytes(text) {
	let halves = split(lc(text), '::');
	if (length(halves) > 2) return null;
	let sides = [];
	for (let half in halves) {
		let words = [];
		let tokens = half == '' ? [] : split(half, ':');
		for (let i = 0; i < length(tokens); i++) {
			let token = tokens[i];
			if (index(token, '.') >= 0) {
				if (i != length(tokens) - 1 || substr(text, length(text) - length(token)) != token) return null;
				let bytes = ipv4_bytes(token);
				if (bytes == null) return null;
				push(words, bytes[0] * 256 + bytes[1], bytes[2] * 256 + bytes[3]);
			} else {
				if (!match(token, /^[0-9a-f]{1,4}$/)) return null;
				let value = 0;
				for (let j = 0; j < length(token); j++) value = value * 16 + index('0123456789abcdef', substr(token, j, 1));
				push(words, value);
			}
		}
		push(sides, words);
	}
	let used = length(sides[0]) + (sides[1] == null ? 0 : length(sides[1]));
	if (length(halves) == 1 ? used != 8 : used >= 8) return null;
	let words = sides[0];
	if (length(halves) == 2) {
		for (let i = used; i < 8; i++) push(words, 0);
		for (let word in sides[1]) push(words, word);
	}
	let bytes = [];
	for (let word in words) push(bytes, int(word / 256), word % 256);
	return bytes;
}

function prefix(text) {
	if (type(text) != 'string') return null;
	let parts = split(trim(text), '/');
	if (length(parts) > 2) return null;
	let family = index(parts[0], ':') >= 0 ? 6 : 4;
	let bytes = family == 4 ? ipv4_bytes(parts[0]) : ipv6_bytes(parts[0]);
	let bits = family == 4 ? 32 : 128;
	if (bytes == null || (length(parts) == 2 && !match(parts[1], /^(0|[1-9][0-9]{0,2})$/))) return null;
	let size = length(parts) == 2 ? int(parts[1]) : bits;
	if (size > bits) return null;
	let masks = [0,128,192,224,240,248,252,254,255];
	for (let i = 0; i < length(bytes); i++) {
		let remain = size - i * 8;
		bytes[i] = bytes[i] & masks[remain < 0 ? 0 : remain > 8 ? 8 : remain];
	}
	let address;
	if (family == 4) address = join('.', map(bytes, v => '' + v));
	else {
		let words = [];
		for (let i = 0; i < 16; i += 2) push(words, sprintf('%x', bytes[i] * 256 + bytes[i+1]));
		address = join(':', words);
	}
	return { family: family, bytes: bytes, size: size, address: address + '/' + size };
}

function contains(a, b) {
	if (a.family != b.family || a.size > b.size) return false;
	let masks = [0,128,192,224,240,248,252,254,255];
	for (let i = 0; i < length(a.bytes); i++) {
		let remain = a.size - i * 8;
		let mask = masks[remain < 0 ? 0 : remain > 8 ? 8 : remain];
		if ((a.bytes[i] & mask) != (b.bytes[i] & mask)) return false;
	}
	return true;
}

export function device_access(ctx) {
	let mode = ctx.get('bettbox', 'config', 'device_mode') ?? 'off';
	if (mode != 'off' && mode != 'include' && mode != 'exclude') die('设备控制模式无效\n');
	let result = { mode: mode, enabled: mode != 'off', ipv4: [], ipv6: [] };
	if (!result.enabled) return result;
	let values = ctx.get('bettbox', 'config', 'device_ips') ?? [];
	if (type(values) == 'string') values = trim(values) == '' ? [] : split(trim(values), /\s+/);
	if (type(values) != 'array' || length(values) > 256) die('设备 IP 列表最多 256 项\n');
	let entries = [];
	for (let text in values) {
		let item = prefix(text);
		if (item == null) die('设备 IP 或网段无效：' + text + '\n');
		if (length(filter(entries, old => contains(old, item))) > 0) continue;
		entries = filter(entries, old => !contains(item, old));
		push(entries, item);
	}
	for (let item in entries) push(item.family == 4 ? result.ipv4 : result.ipv6, item.address);
	return result;
};

export function device_nft(access) {
	let lines = [];
	if (!access.enabled) return '';
	for (let family in [4,6]) {
		let values = family == 4 ? access.ipv4 : access.ipv6;
		let field = family == 4 ? 'ip' : 'ip6';
		if (length(values)) push(lines, field + ' saddr ' + (access.mode == 'include' ? '!= ' : '') + '{ ' + join(', ', values) + ' } return');
		else if (access.mode == 'include') push(lines, 'meta nfproto ipv' + family + ' return');
	}
	return join('\n', lines);
};
