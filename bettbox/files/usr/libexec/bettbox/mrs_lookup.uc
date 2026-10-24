#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
//
// MRS 速查 (upstream core/toolbox/mrs_lookup.go semantics): reverse-lookup a
// domain across geosite.dat categories. geosite.dat is a sequence of
// varint-length-prefixed GeoSite protobuf messages:
//   GeoSite { string tag = 1; repeated Domain domain = 2 }
//   Domain  { varint type = 1; string value = 2 }
// Domain types: 0 Plain / 1 Regex / 2 Domain(suffix) / 3 Full / 4 Keyword.
//
// usage: mrs_lookup.uc <geosite.dat> <domain>
// note: ucode has no do-while; varint reads use while+break.

'use strict';

import { readfile } from 'fs';

let data = readfile(ARGV[0]);
let target = ARGV[1];
if (data == null || length(data) == 0)
	die('cannot read ' + ARGV[0] + '\n');
if (!target)
	die('no domain given\n');

let t0 = time();

function read_varint(s, pos) {
	let val = 0, shift = 0;
	while (pos < length(s)) {
		let b = ord(s, pos);
		pos++;
		val = val + ((b & 0x7f) << shift);
		shift += 7;
		if (!(b & 0x80))
			break;
	}
	return [ val, pos ];
}

function endswith(hay, needle) {
	if (length(needle) > length(hay))
		return false;
	return substr(hay, length(hay) - length(needle)) == needle;
}

function domain_hit(type, value) {
	if (type == 1)
		return null; // regex entries: not evaluated, not reported as hits
	if (type == 0 || type == 2)
		return (target == value || endswith(target, '.' + value)) ? 'suffix' : null;
	if (type == 3)
		return (target == value) ? 'full' : null;
	if (type == 4)
		return (index(target, value) >= 0) ? 'keyword' : null;
	return null;
}

let pos = 0;
let tag = '';
let entries = 0;
let hits = [];

printf('目标: %s\n数据: %s (%d bytes)\n\n', target, ARGV[0], length(data));

// whole file = one GeoSiteList message: repeated field 1 (0x0A) = GeoSite entries
while (pos < length(data)) {
	let key = ord(data, pos);
	pos++;
	if (key != 0x0A)
		break;
	let rv = read_varint(data, pos);
	let mlen = rv[0];
	pos = rv[1];
	if (mlen <= 0 || pos + mlen > length(data))
		break;
	let msg = substr(data, pos, mlen);
	pos += mlen;

	// parse GeoSite message fields
	let m = 0;
	while (m < length(msg)) {
		let key = ord(msg, m);
		m++;
		if (key == 0x0A) { // field 1: tag (string)
			let t = read_varint(msg, m);
			m = t[1];
			tag = substr(msg, m, t[0]);
			m += t[0];
		} else if (key == 0x12) { // field 2: Domain (embedded)
			let d = read_varint(msg, m);
			m = d[1];
			let dom = substr(msg, m, d[0]);
			m += d[0];
			// parse Domain: 0x08 type varint, 0x12 value string
			let dm = 0, dtype = 0;
			while (dm < length(dom)) {
				let dk = ord(dom, dm);
				dm++;
				if (dk == 0x08) {
					let dv = read_varint(dom, dm);
					dm = dv[1];
					dtype = dv[0];
				} else if (dk == 0x12) {
					let dl = read_varint(dom, dm);
					dm = dl[1];
					let value = substr(dom, dm, dl[0]);
					dm += dl[0];
					entries++;
					let hit = domain_hit(dtype, value);
					if (hit != null && length(hits) < 40)
						push(hits, { tag: tag, via: hit + ' (type ' + dtype + ')', value: value });
				} else {
					break; // unknown field, bail out of this domain
				}
			}
		} else {
			break; // unknown field
		}
	}
}

printf('扫描条目: %d\n命中分类: %d\n\n', entries, length(hits));
if (length(hits) == 0) {
	printf('%s 不在任何 geosite 分类中（走兜底规则）\n', target);
} else {
	for (let h in hits)
		printf('  geosite:%s  via=%s  value=%s\n', h.tag, h.via, h.value);
	printf('\n提示: GEOIP/IP 数据集反查请使用「IP 全能查」工具。\n');
}
printf('\n耗时: %.2fs\n', clock() - t0);
