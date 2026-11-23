#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
// Node library & landing-node store (/etc/bettbox/nodes.json) and CLI helper.
// Note: ucode supports try/catch, not JavaScript finally.

'use strict';

import { access, chmod, lstat, mkdir, mkdtemp, popen, readfile, readlink, rename, rmdir, stat, unlink, writefile } from 'fs';
import { cursor } from 'uci';

const STORE_DIR = '/etc/bettbox';
const STORE_FILE = '/etc/bettbox/nodes.json';
const LOCK_DIR = '/etc/bettbox/.nodes.lock';
const MIHOMO_BIN = '/usr/bin/mihomo';

function q(s) {
	return sprintf("'%s'", replace('' + s, /'/g, "'\\''"));
}

function cmd_exec(cmd) {
	let fd = popen(cmd + ' 2>&1', 'r');
	if (!fd)
		return { ok: false, code: 127, text: '无法执行命令' };
	let text = '', chunk;
	while ((chunk = fd.read(4096)) != null && length(chunk)) {
		text += chunk;
		if (length(text) > 1048576)
			text = substr(text, length(text) - 1048576);
	}
	let code = fd.close();
	return { ok: code == 0 && chunk != null, code: code, text: trim(text) };
}

function ensure_dir() {
	if (!access(STORE_DIR) && !mkdir(STORE_DIR))
		die('无法创建配置目录');
	if (readlink(STORE_DIR) != null || lstat(STORE_DIR)?.type != 'directory')
		die('配置目录无效');
}

function valid_id(id) {
	return type(id) == 'string' && length(id) > 5 && length(id) <= 64 && match(id, /^node_[A-Za-z0-9_-]+$/) != null;
}

function with_lock(cb) {
	ensure_dir();
	if (access(LOCK_DIR) && time() - (stat(LOCK_DIR)?.mtime ?? time()) > 60)
		rmdir(LOCK_DIR);
	if (!mkdir(LOCK_DIR))
		die('节点库正在保存，请稍后重试');
	let result = null, err = null;
	try {
		result = cb();
	} catch (e) {
		err = e;
	}
	rmdir(LOCK_DIR);
	if (err != null)
		die(err);
	return result;
}

function clean_str(v, max_len) {
	if (type(v) != 'string')
		return '';
	let s = trim(v);
	return length(s) > max_len ? substr(s, 0, max_len) : s;
}

function clean_str_array(v, max_items, max_len) {
	if (type(v) != 'array')
		return [];
	let out = [], seen = {};
	for (let item in v) {
		let s = clean_str(item, max_len);
		if (length(s) > 0 && !seen[s]) {
			seen[s] = true;
			push(out, s);
			if (length(out) >= max_items)
				break;
		}
	}
	return out;
}

function normalize_node(raw) {
	if (type(raw) != 'object' || type(raw.proxy) != 'object')
		return null;
	let id = valid_id(raw.id) ? raw.id : null;
	if (!id)
		return null;
	let name = clean_str(raw.name ?? raw.proxy.name, 256);
	if (!length(name))
		return null;
	let proxy = {};
	for (let k in keys(raw.proxy))
		proxy[k] = raw.proxy[k];
	proxy.name = name;
	delete proxy['dialer-proxy'];
	let scope = (raw.scope in ['managed', 'all', 'profiles', 'none']) ? raw.scope : 'managed';
	return {
		id: id,
		name: name,
		enabled: raw.enabled !== false,
		landing: raw.landing === true,
		dialer: clean_str(raw.dialer, 256),
		scope: scope,
		profiles: clean_str_array(raw.profiles, 64, 64),
		groups: clean_str_array(raw.groups, 64, 128),
		beside: clean_str(raw.beside, 128),
		regions: raw.regions !== false,
		proxy: proxy
	};
}

function read_store() {
	if (!access(STORE_FILE))
		return { version: 1, nodes: [] };
	if (readlink(STORE_FILE) != null)
		die('节点库文件不能是符号链接');
	let raw = readfile(STORE_FILE);
	if (raw == null || !length(trim(raw)))
		return { version: 1, nodes: [] };
	let parsed = null;
	try {
		parsed = json(raw);
	} catch (e) {
		die('节点库 JSON 解析失败');
	}
	if (type(parsed) != 'object' || type(parsed.nodes) != 'array')
		return { version: 1, nodes: [] };
	let nodes = [];
	for (let item in parsed.nodes) {
		let norm = normalize_node(item);
		if (norm != null)
			push(nodes, norm);
	}
	return { version: 1, nodes: nodes };
}

function write_store(store) {
	ensure_dir();
	if (readlink(STORE_FILE) != null)
		die('节点库文件不能是符号链接');
	let dir = mkdtemp(STORE_DIR + '/.nodes.XXXXXX');
	if (!dir)
		die('无法创建节点库临时目录');
	let tmp = dir + '/nodes.json', err = null;
	try {
		if (writefile(tmp, sprintf('%J', store)) == null || !chmod(tmp, 0600))
			die('无法写入节点库文件');
		if (!rename(tmp, STORE_FILE))
			die('无法保存节点库文件');
	} catch (e) {
		err = e;
	}
	unlink(tmp);
	rmdir(dir);
	if (err != null)
		die(err);
}

function unique_name(base, nodes, skip_id) {
	let candidate = clean_str(base, 240);
	if (!length(candidate))
		candidate = 'Node';
	let used = {};
	for (let n in nodes) {
		if (n.id != skip_id)
			used[n.name] = true;
	}
	if (!used[candidate])
		return candidate;
	let i = 2;
	while (used[candidate + ' ' + i])
		i++;
	return candidate + ' ' + i;
}

function next_node_id(nodes, seq) {
	let used = {};
	for (let n in nodes)
		used[n.id] = true;
	let ts = time();
	while (true) {
		let candidate = sprintf('node_%d_%d', ts, seq++);
		if (!used[candidate])
			return [ candidate, seq ];
	}
}

function parse_nodes_file(input_path) {
	let res = cmd_exec('timeout 25 ' + q(MIHOMO_BIN) + ' bettbox-parse-nodes ' + q(input_path));
	if (!res.ok)
		return { proxies: [], invalid: 0, error: res.text || '节点解析命令执行失败' };
	let parsed = null;
	try {
		parsed = json(res.text);
	} catch (e) {
		return { proxies: [], invalid: 0, error: '节点解析返回格式无效' };
	}
	return parsed ?? { proxies: [], invalid: 0, error: '节点解析无返回' };
}

function controller_config() {
	let ctx = cursor();
	let hc = ctx.get('bettbox', 'config', 'external_controller') ?? '127.0.0.1:9097';
	let parts = split(hc, ':');
	let port = parts[length(parts) - 1] ?? '9097';
	let host = substr(hc, 0, length(hc) - length(port) - 1);
	if (host == '0.0.0.0' || host == '*' || !length(host))
		host = '127.0.0.1';
	if (host == '[::]')
		host = '[::1]';
	return { host: host, port: port, secret: ctx.get('bettbox', 'config', 'secret') ?? '' };
}

function controller_post(path, payload, timeout_s) {
	let ctl = controller_config();
	let dir = trim(cmd_exec('umask 077; mktemp -d /tmp/bettbox-node-api.XXXXXX').text);
	if (!match(dir, /^\/tmp\/bettbox-node-api\.[A-Za-z0-9]+$/))
		return { status: 0, body: null, raw: '无法创建请求工作区' };
	let req_file = dir + '/req', resp_file = dir + '/resp', code_file = dir + '/code';
	let status = 0, raw = '', parsed = null;
	if (writefile(req_file, sprintf('%J', payload)) != null) {
		let cmd = sprintf('timeout %d curl -sS -m %d -o %s -w "%%{http_code}" -X POST -H %s -H %s --data-binary @%s %s > %s 2>/dev/null',
			timeout_s + 3, timeout_s, q(resp_file),
			q('Authorization: Bearer ' + ctl.secret),
			q('Content-Type: application/json'),
			q(req_file),
			q('http://' + ctl.host + ':' + ctl.port + path),
			q(code_file));
		system(cmd);
		status = int(trim(readfile(code_file) ?? '')) ?? 0;
		raw = readfile(resp_file) ?? '';
		try { parsed = json(raw); } catch (e) { parsed = null; }
	}
	unlink(req_file);
	unlink(resp_file);
	unlink(code_file);
	rmdir(dir);
	return { status: status, body: parsed, raw: raw };
}

function action_list() {
	let store = read_store();
	return { ok: true, nodes: store.nodes };
}

function action_import(input_path) {
	if (!input_path || !access(input_path))
		return { ok: false, error: '导入文件不存在' };
	let parsed = parse_nodes_file(input_path);
	let list = type(parsed.proxies) == 'array' ? parsed.proxies : [];
	if (length(list) == 0)
		return { ok: false, error: parsed.error || '未识别到有效节点', invalid: int(parsed.invalid) ?? 0 };
	return with_lock(function() {
		let store = read_store();
		let seq = 1, added = [];
		for (let p in list) {
			if (type(p) != 'object')
				continue;
			let id_pair = next_node_id(store.nodes, seq);
			let id = id_pair[0];
			seq = id_pair[1];
			let name = unique_name(p.name, store.nodes, null);
			p.name = name;
			delete p['dialer-proxy'];
			let node = normalize_node({
				id: id,
				name: name,
				enabled: true,
				landing: false,
				dialer: '',
				scope: 'managed',
				profiles: [],
				groups: [],
				beside: '',
				regions: true,
				proxy: p
			});
			if (node != null) {
				push(store.nodes, node);
				push(added, node);
			}
		}
		write_store(store);
		return { ok: true, added: length(added), invalid: int(parsed.invalid) ?? 0, added_nodes: added, nodes: store.nodes };
	});
}

function action_save(json_path) {
	if (!json_path || !access(json_path))
		return { ok: false, error: '节点配置数据缺失' };
	let input = null;
	try { input = json(readfile(json_path)); } catch (e) { input = null; }
	if (type(input) != 'object' || !valid_id(input.id))
		return { ok: false, error: '无效的节点 ID' };

	let custom_proxy = null;
	if (type(input.proxy_text) == 'string' && length(trim(input.proxy_text)) > 0) {
		let dir = trim(cmd_exec('umask 077; mktemp -d /tmp/bettbox-node-val.XXXXXX').text);
		if (!match(dir, /^\/tmp\/bettbox-node-val\.[A-Za-z0-9]+$/))
			return { ok: false, error: '无法创建节点校验工作区' };
		let tf = dir + '/node.yaml';
		let parsed = null;
		if (writefile(tf, input.proxy_text) != null)
			parsed = parse_nodes_file(tf);
		unlink(tf);
		rmdir(dir);
		if (!parsed || length(parsed.proxies ?? []) != 1)
			return { ok: false, error: parsed?.error || '节点配置必须包含且仅包含一个有效节点' };
		custom_proxy = parsed.proxies[0];
	} else if (type(input.proxy) == 'object') {
		let dir = trim(cmd_exec('umask 077; mktemp -d /tmp/bettbox-node-val.XXXXXX').text);
		if (!match(dir, /^\/tmp\/bettbox-node-val\.[A-Za-z0-9]+$/))
			return { ok: false, error: '无法创建节点校验工作区' };
		let tf = dir + '/node.json';
		let parsed = null;
		if (writefile(tf, sprintf('%J', { proxies: [ input.proxy ] })) != null)
			parsed = parse_nodes_file(tf);
		unlink(tf);
		rmdir(dir);
		if (!parsed || length(parsed.proxies ?? []) != 1)
			return { ok: false, error: parsed?.error || '节点参数校验失败' };
		custom_proxy = parsed.proxies[0];
	}

	return with_lock(function() {
		let store = read_store();
		let idx = -1;
		for (let i = 0; i < length(store.nodes); i++) {
			if (store.nodes[i].id == input.id) {
				idx = i;
				break;
			}
		}
		if (idx < 0)
			return { ok: false, error: '节点不存在或已被删除' };
		let cur = store.nodes[idx];
		let proxy = custom_proxy ?? cur.proxy;
		let desired_name = clean_str(input.name ?? proxy.name ?? cur.name, 256);
		if (!length(desired_name))
			return { ok: false, error: '节点名称不能为空' };
		let final_name = unique_name(desired_name, store.nodes, cur.id);
		proxy.name = final_name;
		delete proxy['dialer-proxy'];
		let updated = normalize_node({
			id: cur.id,
			name: final_name,
			enabled: input.enabled != null ? !!input.enabled : cur.enabled,
			landing: input.landing != null ? !!input.landing : cur.landing,
			dialer: input.dialer != null ? input.dialer : cur.dialer,
			scope: input.scope != null ? input.scope : cur.scope,
			profiles: input.profiles != null ? input.profiles : cur.profiles,
			groups: input.groups != null ? input.groups : cur.groups,
			beside: input.beside != null ? input.beside : cur.beside,
			regions: input.regions != null ? !!input.regions : cur.regions,
			proxy: proxy
		});
		if (updated == null)
			return { ok: false, error: '节点数据格式无效' };
		store.nodes[idx] = updated;
		write_store(store);
		return { ok: true, node: updated, nodes: store.nodes };
	});
}

function action_delete(id) {
	if (!valid_id(id))
		return { ok: false, error: '无效的节点 ID' };
	return with_lock(function() {
		let store = read_store();
		let next = [], removed = false;
		for (let n in store.nodes) {
			if (n.id == id) removed = true;
			else push(next, n);
		}
		if (!removed)
			return { ok: false, error: '节点不存在' };
		store.nodes = next;
		write_store(store);
		return { ok: true, nodes: store.nodes };
	});
}

function action_reorder(ids_path) {
	if (!ids_path || !access(ids_path))
		return { ok: false, error: '排序数据缺失' };
	let ids = null;
	try { ids = json(readfile(ids_path)); } catch (e) { ids = null; }
	if (type(ids) != 'array')
		return { ok: false, error: '排序数据必须为数组' };
	return with_lock(function() {
		let store = read_store();
		let by_id = {};
		for (let n in store.nodes)
			by_id[n.id] = n;
		let ordered = [], seen = {};
		for (let id in ids) {
			if (valid_id(id) && by_id[id] != null && !seen[id]) {
				seen[id] = true;
				push(ordered, by_id[id]);
			}
		}
		for (let n in store.nodes) {
			if (!seen[n.id])
				push(ordered, n);
		}
		store.nodes = ordered;
		write_store(store);
		return { ok: true, nodes: store.nodes };
	});
}

function action_warp() {
	let resp = controller_post('/bettbox/warp-register', {}, 32);
	let data = resp.body;
	if (resp.status == 0) {
		let cli = cmd_exec('timeout 35 ' + q(MIHOMO_BIN) + ' bettbox-register-warp');
		try { data = json(cli.text); } catch (e) { data = null; }
		if (!data)
			return { ok: false, error: cli.text || 'Cloudflare WARP 注册失败' };
	}
	if (type(data) != 'object' || data.error || type(data.proxy) != 'object')
		return { ok: false, error: data?.error || resp.raw || 'Cloudflare WARP 注册失败' };

	return with_lock(function() {
		let store = read_store();
		let id_pair = next_node_id(store.nodes, 1);
		let name = unique_name(data.proxy.name ?? 'Cloudflare WARP', store.nodes, null);
		data.proxy.name = name;
		delete data.proxy['dialer-proxy'];
		let node = normalize_node({
			id: id_pair[0],
			name: name,
			enabled: true,
			landing: false,
			dialer: '',
			scope: 'managed',
			profiles: [],
			groups: [],
			beside: '',
			regions: true,
			proxy: data.proxy
		});
		if (node == null)
			return { ok: false, error: 'WARP 节点格式无效' };
		push(store.nodes, node);
		write_store(store);
		return { ok: true, node: node, account_id: data.id ?? '', nodes: store.nodes };
	});
}

function action_test(id, dialer_override) {
	if (!valid_id(id))
		return { ok: false, error: '无效的节点 ID' };
	let store = read_store();
	let target = null;
	for (let n in store.nodes) {
		if (n.id == id) {
			target = n;
			break;
		}
	}
	if (target == null)
		return { ok: false, error: '节点不存在' };
	let dialer = dialer_override != null ? clean_str(dialer_override, 256) : target.dialer;
	let resp = controller_post('/bettbox/test-node', { proxy: target.proxy, dialer: dialer }, 14);
	if (resp.status == 0)
		return { ok: false, error: '核心未运行或控制接口不可达，请先启动服务' };
	let body = resp.body;
	if (type(body) != 'object')
		return { ok: false, error: resp.raw || '节点测速返回无效响应' };
	if (body.error || !(int(body.delay) > 0))
		return { ok: false, error: body.error || '节点测速超时或失败' };
	return { ok: true, delay: int(body.delay) };
}

function filter_active(sid, is_managed) {
	let store = read_store();
	let managed = (is_managed == '1' || is_managed == 'true');
	let active = [];
	for (let n in store.nodes) {
		if (!n.enabled)
			continue;
		let match_scope = (n.scope == 'all') ||
			(n.scope == 'managed' && managed) ||
			(n.scope == 'profiles' && sid && (sid in n.profiles));
		if (match_scope)
			push(active, n);
	}
	return active;
}

let action = ARGV[0] ?? 'list', result = null;
try {
	if (action == 'list') {
		result = action_list();
	} else if (action == 'import') {
		result = action_import(ARGV[1]);
	} else if (action == 'save') {
		result = action_save(ARGV[1]);
	} else if (action == 'delete') {
		result = action_delete(ARGV[1]);
	} else if (action == 'reorder') {
		result = action_reorder(ARGV[1]);
	} else if (action == 'warp') {
		result = action_warp();
	} else if (action == 'test') {
		result = action_test(ARGV[1], length(ARGV) > 2 ? ARGV[2] : null);
	} else if (action == 'active-for') {
		let active = filter_active(ARGV[1] ?? '', ARGV[2] ?? '0');
		result = map(active, n => ({
			proxy: n.proxy,
			dialer: n.dialer,
			groups: n.groups,
			beside: n.beside,
			regions: n.regions,
			landing: n.landing
		}));
	} else if (action == 'active-names') {
		result = map(filter_active(ARGV[1] ?? '', ARGV[2] ?? '0'), n => n.name);
	} else {
		die('usage: node-store.uc list|import|save|delete|reorder|warp|test|active-for|active-names');
	}
} catch (e) {
	result = { ok: false, error: '' + e };
}
print(sprintf('%J\n', result));
if (type(result) == 'object' && result.ok === false)
	exit(1);
