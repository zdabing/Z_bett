#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
// Download/validate a bounded candidate; install exactly the version previewed.
import { access, lsdir, mkdtemp, popen, readfile, rmdir, stat, unlink, writefile } from 'fs';
import { valid_script_name, valid_script_url, script_info, script_metadata, write_script } from '/usr/libexec/bettbox/script-store.uc';

const ROOT = '/etc/bettbox/scripts';
let action = ARGV[0], name = ARGV[1], argument = ARGV[2], work = null;
function q(s) { return sprintf("'%s'", replace('' + s, /'/g, "'\\''")); }
function command(cmd) {
	let fd = popen(cmd + ' 2>&1', 'r');
	if (!fd) die('无法执行脚本管理命令');
	let text = '', chunk;
	while ((chunk = fd.read(4096)) != null && length(chunk)) {
		text += chunk;
		if (length(text) > 65536) text = substr(text, length(text) - 65536);
	}
	let code = fd.close();
	if (code != 0 || chunk == null) die(trim(text) || '脚本管理命令失败');
	return trim(text);
}
function hash(path) {
	let result = split(command('sha256sum ' + q(path)), ' ')[0];
	if (length(result) != 64 || !match(result, /^[a-f0-9]+$/)) die('无法计算脚本校验值');
	return result;
}
function fetch(url, path, limit, headers) {
	if (!valid_script_url(url)) die('脚本链接无效');
	command('curl -fsSL --proto "=http,https" --proto-redir "=http,https" --connect-timeout 8 --max-time 25 --max-filesize ' + limit +
		' -H ' + q('User-Agent: Bettbox-OpenWrt') + (headers ? ' -D ' + q(headers) : '') + ' -o ' + q(path) + ' ' + q(url));
	let size = stat(path)?.size;
	if (type(size) != 'int' || size <= 0 || size > limit) die('下载文件为空或超过大小限制');
}
function encode(s) {
	let out = '';
	for (let i = 0; i < length(s); i++) {
		let b = ord(s, i), c = substr(s, i, 1);
		out += match(c, /^[A-Za-z0-9_.~-]$/) ? c : sprintf('%%%02X', b);
	}
	return out;
}
function github(url) {
	let m = match(url, /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(.+)$/);
	if (!m) {
		let blob = match(url, /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(blob|raw)\/(.+)$/);
		if (blob) m = [blob[0], blob[1], blob[2], blob[4]];
	}
	if (!m) return null;
	let raw_url = 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
	let rest = replace(m[3], /^refs\/(heads|tags)\//, '');
	rest = split(split(rest, '?')[0], '#')[0];
	let parts = split(rest, '/'), ref = shift(parts), path = join('/', parts);
	if (!length(ref) || !length(path)) return null;
	return { owner: m[1], repo: m[2], ref: ref, path: path, raw_url: raw_url };
}
function candidate(url) {
	let meta = { url: url, commit: null, committed_at: null, message: null, options_count: null, updated_at: time(), modified: false };
	let source = github(url), download = url;
	if (source != null) {
		download = source.raw_url;
		try {
			let api = 'https://api.github.com/repos/' + source.owner + '/' + source.repo + '/commits?per_page=1&sha=' + encode(source.ref) + '&path=' + encode(source.path);
			fetch(api, work + '/commit', 1048576, null);
			let commits = json(readfile(work + '/commit')), info = commits?.[0];
			if (type(info?.sha) != 'string' || length(info.sha) != 40 || !match(info.sha, /^[a-f0-9]+$/)) die('无提交信息');
			meta.commit = info.sha; meta.committed_at = info.commit?.committer?.date;
			meta.message = substr(info.commit?.message ?? '', 0, 4096);
			download = 'https://raw.githubusercontent.com/' + source.owner + '/' + source.repo + '/' + info.sha + '/' + source.path;
		} catch (e) { meta.metadata_note = '上游提交信息暂不可用'; }
	}
	let original_url = source?.raw_url ?? url;
	if (meta.commit != null) {
		// Raw URLs can contain branch names with slashes. Only attach Git
		// metadata when the resolved revision matches the requested file.
		try { fetch(download, work + '/script', 524288, null); }
		catch (e) { meta.commit = null; meta.committed_at = null; meta.message = null; }
		fetch(original_url, work + '/original', 524288, work + '/headers');
		let original = readfile(work + '/original');
		if (meta.commit == null || original != readfile(work + '/script')) {
			meta.commit = null; meta.committed_at = null; meta.message = null;
			meta.metadata_note = '提交内容与来源不一致，按来源文件展示校验值';
			if (writefile(work + '/script', original) == null) die('无法保存下载脚本');
		}
	} else fetch(original_url, work + '/script', 524288, work + '/headers');
	let content = readfile(work + '/script');
	// Compile/evaluate once in the bounded QuickJS helper, then count the real
	// declared switches. No regular-expression counting or fabricated metadata.
	if (writefile(work + '/validate.js', content + '\n;if (typeof main !== "function") throw new Error("脚本未定义 main()");\n') == null) die('无法校验下载脚本');
	let opts;
	try { opts = json(command('(timeout 8 /usr/bin/bettbox-forge options --script ' + q(work + '/validate.js') + ' 2>' + q(work + '/forge.err') + ')')); }
	catch (e) { die('脚本校验失败：' + substr(readfile(work + '/forge.err') ?? ('' + e), 0, 512)); }
	meta.options_count = type(opts.options) == 'object' ? length(keys(opts.options)) : 0;
	meta.sha256 = hash(work + '/script'); meta.size = stat(work + '/script').size;
	let headers = readfile(work + '/headers') ?? '', modified = null;
	for (let line in split(headers, '\n')) {
		if (match(line, /^HTTP\//)) modified = null;
		let header = match(line, /^[Ll]ast-[Mm]odified:\s*([^\r\n]+)/);
		if (header) modified = trim(header[1]);
	}
	if (meta.committed_at == null && modified != null) meta.last_modified = modified;
	return meta;
}
function cleanup(dir) {
	for (let file in ['script', 'original', 'base', 'headers', 'commit', 'validate.js', 'forge.err', 'candidate.json']) unlink(dir + '/' + file);
	rmdir(dir);
}

let keep = false, output = null, failure = null;
try {
	if (!(action in ['import', 'check', 'update']) || !valid_script_name(name)) die('脚本名称或操作无效');
	if (action == 'update') {
		if (!match(argument ?? '', /^bettbox-script\.[A-Za-z0-9]+$/)) die('更新预览无效，请重新检查');
		work = '/tmp/' + argument;
		let saved = json(readfile(work + '/candidate.json'));
		if (saved.name != name || type(saved.created) != 'int' || time() - saved.created > 600 || time() < saved.created) die('更新预览已过期，请重新检查');
		let source = script_metadata(name);
		if (source?.url != saved.source.url || hash(ROOT + '/' + name + '.js') != saved.base_hash) die('本地脚本或来源已改变，请重新检查');
		if (hash(work + '/script') != saved.source.sha256) die('更新文件校验失败');
		let original = readfile(work + '/base');
		if (original == null || hash(work + '/base') != saved.base_hash) die('更新预览校验失败');
		write_script(name, readfile(work + '/script'), saved.source, false, original, saved.source.url);
		output = { ok: true, name: name, source: saved.source };
	} else {
		let existing = script_info(name), source = action == 'import' ? { url: argument } : script_metadata(name);
		if (action == 'import' && existing != null) die('已存在同名脚本');
		if (action == 'check' && existing == null) die('脚本不存在');
		if (!valid_script_url(source?.url)) die('请先设置脚本更新来源');
		// Expired previews contain no needed user data. Limit leftover candidates.
		for (let ent in lsdir('/tmp') ?? []) {
			if (match(ent, /^bettbox-script\.[A-Za-z0-9]+$/) && time() - (stat('/tmp/' + ent)?.mtime ?? time()) > 600) cleanup('/tmp/' + ent);
		}
		work = mkdtemp('/tmp/bettbox-script.XXXXXX');
		if (!work) die('无法创建下载目录');
		let latest = candidate(source.url);
		if (action == 'import') {
			write_script(name, readfile(work + '/script'), latest, true);
			output = { ok: true, name: name, source: latest };
		} else {
			let original = readfile(ROOT + '/' + name + '.js');
			if (original == null || writefile(work + '/base', original) == null) die('无法读取当前脚本');
			let base = hash(work + '/base'), available = base != latest.sha256;
			output = { ok: true, name: name, available: available, current: source, latest: latest, local_modified: source.sha256 != null && base != source.sha256 };
			if (available) {
				if (writefile(work + '/candidate.json', sprintf('%J', { name: name, created: time(), base_hash: base, source: latest })) == null) die('无法保存更新预览');
				output.token = split(work, '/')[2]; keep = true;
			}
		}
	}
} catch (e) { failure = '' + e; }
if (work != null && !keep) cleanup(work);
if (failure != null) { print(failure); exit(1); }
print(sprintf('%J', output));
