// SPDX-License-Identifier: GPL-3.0
// Script names are UTF-8 file basenames, never paths or shell fragments.
import { access, chmod, lstat, mkdir, mkdtemp, readfile, readlink, rename, rmdir, stat, unlink, writefile } from 'fs';

const ROOT = '/etc/bettbox/scripts';

export function valid_script_name(name) {
	if (type(name) != 'string' || !length(name) || length(name) > 192 || name != trim(name) || substr(name, 0, 1) == '.') return false;
	for (let i = 0; i < length(name); i++) {
		let b = ord(name, i);
		if (b >= 128 || b == 32 || b == 45 || b == 46 || b == 95 || (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122)) continue;
		return false;
	}
	return true;
};

export function valid_script_url(url) {
	return type(url) == 'string' && length(url) <= 2048 && match(url, /^https?:\/\/[A-Za-z0-9._~:\/?#@!$&()*+,;=%-]+$/) != null;
};

export function script_metadata(name) {
	if (!valid_script_name(name)) return null;
	try {
		let m = json(readfile(ROOT + '/' + name + '.meta.json'));
		return type(m) == 'object' && valid_script_url(m.url) ? m : null;
	} catch (e) { return null; }
};

export function script_info(name) {
	if (!valid_script_name(name)) return null;
	let path = ROOT + '/' + name + '.js', st = lstat(path);
	if (st?.type != 'file' || readlink(path) != null) return null;
	return { name: name, size: st.size, source: script_metadata(name) };
};

function directory() {
	if (!access(ROOT) && !mkdir(ROOT)) die('无法创建脚本目录');
	if (readlink(ROOT) != null || lstat(ROOT)?.type != 'directory') die('脚本目录无效');
}

function locked(callback) {
	directory();
	let lock = ROOT + '/.write-lock';
	if (access(lock) && time() - (stat(lock)?.mtime ?? time()) > 120) rmdir(lock);
	if (!mkdir(lock)) die('脚本正在保存，请稍后重试');
	let value = null, error = null;
	try { value = callback(); } catch (e) { error = e; }
	rmdir(lock);
	if (error != null) die(error);
	return value;
}

function store_source(name, url) {
	if (!valid_script_name(name) || !valid_script_url(url)) die('脚本名称或链接无效');
	if (!script_info(name)) die('脚本不存在');
	directory();
	let old = script_metadata(name), m = old?.url == url ? old : { url: url };
	let dir = mkdtemp(ROOT + '/.write.XXXXXX');
	if (!dir) die('无法保存更新来源');
	let ok = writefile(dir + '/meta', sprintf('%J', m)) != null && chmod(dir + '/meta', 0600) && rename(dir + '/meta', ROOT + '/' + name + '.meta.json');
	unlink(dir + '/meta'); rmdir(dir);
	if (!ok) die('无法保存更新来源');
	return script_info(name);
}

// Stage beside the destination: /tmp and /etc may be different filesystems.
// Preserve source metadata on manual edits and mark the local copy modified.
function store_write(name, content, source, create_only, expected, expected_url) {
	if (!valid_script_name(name)) die('脚本名称无效');
	if (type(content) != 'string' || !length(content) || length(content) > 524288) die('脚本必须为 1 B 至 512 KB');
	directory();
	let target = ROOT + '/' + name + '.js', old = readfile(target), meta = source;
	if (readlink(target) != null) die('脚本文件不能是符号链接');
	if (create_only && access(target)) die('已存在同名脚本');
	if (expected != null && (old != expected || script_metadata(name)?.url != expected_url)) die('本地脚本或来源已改变，请重新检查');
	if (meta == null) {
		meta = script_metadata(name);
		if (meta != null && old != content) { meta.modified = true; meta.options_count = null; }
	}
	let dir = mkdtemp(ROOT + '/.write.XXXXXX');
	if (!dir) die('无法创建脚本保存目录');
	let error = null;
	try {
		if (writefile(dir + '/script', content) == null || !chmod(dir + '/script', 0600)) die('无法保存脚本');
		if (old != null && (writefile(dir + '/old', old) == null || !chmod(dir + '/old', 0600))) die('无法保留旧脚本');
		if (meta != null && (writefile(dir + '/meta', sprintf('%J', meta)) == null || !chmod(dir + '/meta', 0600))) die('无法保存脚本版本');
		if (!rename(dir + '/script', target)) die('无法替换脚本，旧文件已保留');
		if (meta != null && !rename(dir + '/meta', ROOT + '/' + name + '.meta.json')) {
			if (old != null) rename(dir + '/old', target); else unlink(target);
			die('无法保存脚本版本，已恢复旧文件');
		}
	} catch (e) { error = e; }
	for (let file in ['script', 'old', 'meta']) unlink(dir + '/' + file);
	rmdir(dir);
	if (error != null) die(error);
	return script_info(name);
}

function store_delete(name) {
	if (!valid_script_name(name)) die('脚本名称无效');
	let target = ROOT + '/' + name + '.js';
	if (access(target) && !unlink(target)) die('无法删除脚本');
	unlink(ROOT + '/' + name + '.meta.json');
}

export function save_script_source(name, url) {
	return locked(function() { return store_source(name, url); });
};
export function write_script(name, content, source, create_only, expected, expected_url) {
	return locked(function() { return store_write(name, content, source, create_only, expected, expected_url); });
};
export function delete_script(name) {
	return locked(function() { return store_delete(name); });
};
