// SPDX-License-Identifier: GPL-3.0
// Serialize the same inputs as Bettbox's ManagedScript.script().
import { readfile, writefile } from 'fs';

const root = '/usr/libexec/bettbox/';
const props = json(readfile(ARGV[0]));
const catalog = json(readfile(root + 'managed-routing.json'));
const routes = [], names = {};
const icons = 'https://cdn.jsdelivr.net/gh/appshubcc/Qure_Style_SVG@main/icon/svg/';

for (let route in props.routes ?? []) {
	let name = trim(route?.name ?? '');
	if (!route.enabled) continue;
	if (!name || name in catalog.reserved || name in names)
		die('分流名称为空、重复或为保留名称');
	names[name] = true;
	let sets = [];
	for (let set in route.sets ?? []) {
		let builtin = match(set, /^(geosite|geoip):([A-Za-z0-9_@.!-]+)$/);
		if (builtin) {
			push(sets, { type: builtin[1], tag: builtin[2] });
			continue;
		}
		let custom = match(set, /^(domain|ipcidr):(https?:\/\/[^ \r\n]+)$/);
		if (!custom) die('无效的分流规则集');
		let url = custom[2], path = split(split(url, '?')[0], '#')[0];
		let file = pop(split(path, '/'));
		let format = match(lc(file), /\.mrs$/) ? 'mrs' : match(lc(file), /\.ya?ml$/) ? 'yaml' : 'text';
		let tag = replace(replace(file, /\.(mrs|ya?ml|txt|list|conf)$/i, ''), /[^A-Za-z0-9_-]/g, '_');
		if (!tag) die('自定义规则集地址缺少文件名');
		push(sets, { type: custom[1] == 'ipcidr' ? 'geoip' : 'geosite', tag: tag, url: url, format: format });
	}
	if (!length(sets)) continue;
	let entry = { name: name, sets: sets };
	if (route.icon in catalog.icons)
		entry.icon = icons + (index(route.icon, '/') >= 0 ? route.icon : 'common/' + route.icon);
	if (route.target) {
		if (!(route.target in catalog.targets)) die('无效的分流目标');
		entry.target = route.target;
	}
	push(routes, entry);
}

let source = readfile(root + 'managed-routing.js');
if (!source) die('内置托管脚本缺失');
let prelude = sprintf('const bettboxRoutes = %J;\n', routes);
if (type(props.regions) == 'array') prelude += sprintf('const bettboxRegions = %J;\n', props.regions);
if (type(props.customRegions) == 'array') prelude += sprintf('const bettboxCustomRegions = %J;\n', props.customRegions);
if (type(props.order) == 'array') prelude += sprintf('const bettboxOrder = %J;\n', props.order);
if (length(ARGV) > 2 && ARGV[2]) {
	let nodes = null;
	try { nodes = json(readfile(ARGV[2]) ?? '[]'); } catch (e) { nodes = null; }
	if (type(nodes) == 'array' && length(nodes) > 0) {
		let clean_names = filter(nodes, n => type(n) == 'string' && length(n) > 0);
		if (length(clean_names) > 0)
			prelude += sprintf('const bettboxNodeNames = %J;\n', clean_names);
	}
}
if (writefile(ARGV[1], prelude + source) == null) die('无法写入托管脚本');
