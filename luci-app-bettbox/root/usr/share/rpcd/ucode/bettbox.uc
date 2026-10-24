// SPDX-License-Identifier: GPL-3.0
//
// rpcd ucode backend for luci-app-bettbox.
// Loaded by rpcd's ucode plugin (rpcd-mod-ucode); exposes the "bettbox"
// ubus object. Shell work is delegated to /usr/bin/bettbox and friends.

'use strict';

import { access, lsdir, popen, readfile, stat, unlink, writefile } from 'fs';
import { cursor } from 'uci';

function shellquote(s) {
	return sprintf("'%s'", replace(s, /'/g, "'\\''"));
}

function run(cmd) {
	let fd = popen(cmd, 'r');
	let out = '';
	if (fd) {
		out = fd.read('all') ?? '';
		fd.close();
	}
	return out;
}

function valid_sid(sid) {
	// no {n,m} quantifiers: older ucode regex builds reject them
	return type(sid) == 'string' && length(sid) <= 64 && match(sid, /^[A-Za-z0-9_-]+$/);
}

function valid_name(name) {
	return type(name) == 'string' && length(name) <= 64 && match(name, /^[A-Za-z0-9_-]+$/);
}

function valid_path(p) {
	return type(p) == 'string' && length(p) <= 200 && match(p, /^\/[A-Za-z0-9._\/-]+$/);
}

function valid_controller_path(path) {
	return type(path) == 'string' && length(path) <= 257 && match(path, /^\/[A-Za-z0-9_\/.?=&:%~-]*$/);
}

function api_raw(method, path, body) {
	if (!valid_controller_path(path))
		return { status: 400, body: null, raw: 'bad path' };
	let ctx = cursor();
	let hc = ctx.get('bettbox', 'config', 'external_controller') ?? '127.0.0.1:9097';
	let port = split(hc, ':')[1] ?? '9097';
	let secret = ctx.get('bettbox', 'config', 'secret') ?? '';

	let bf = '/tmp/bettbox-api.body';
	let cf = '/tmp/bettbox-api.code';
	// busybox timeout guard: a wedged curl inside rpcd blocks every ubus call
	let cmd = sprintf('timeout %d curl -sS -m %d -o %s -w "%%{http_code}" -X %s -H %s',
		(method == 'GET' ? 7 : 17),
		method == 'GET' ? 5 : 15,
		shellquote(bf), method, shellquote('Authorization: Bearer ' + secret));
	if (body != null && length(body) > 0)
		cmd += sprintf(" -H 'Content-Type: application/json' --data-binary %s", shellquote(body));
	cmd += sprintf(' %s > %s 2>/dev/null', shellquote('http://127.0.0.1:' + port + path), shellquote(cf));
	system(cmd);

	let status = int(trim(readfile(cf) ?? '')) ?? 0;
	let raw = readfile(bf) ?? '';
	unlink(cf);
	unlink(bf);
	let parsed = null;
	try { parsed = json(raw); } catch (e) { parsed = null; }
	return { status: status, body: parsed, raw: (parsed == null) ? raw : null };
}

function profile_list() {
	let profiles = [];
	cursor().foreach('bettbox', 'subscription', (s) => {
		let sid = s['.name'];
		let file = '/etc/bettbox/profiles/' + sid + '.yaml';
		push(profiles, {
			id: sid,
			label: s.label ?? sid,
			url: s.url ?? '',
			auto_update: (s.auto_update == '1'),
			update_interval: int(s.update_interval) ?? 1440,
			use_script: (s.use_script == '1'),
				script: s.script ?? '',
				age_identity: s.age_identity ?? '',
				custom_options: s.custom_options ?? '{}',
			override_rules: s.override_rules ?? '',
			last_update: int(s.last_update) ?? 0,
			sub_upload: int(s.sub_upload) ?? 0,
			sub_download: int(s.sub_download) ?? 0,
			sub_total: int(s.sub_total) ?? 0,
			sub_expire: int(s.sub_expire) ?? 0,
			file: access(file) ? file : null
		});
	});
	return profiles;
}

function status_obj() {
	let ctx = cursor();
	/* instant by design: no internal curl here — views read live core state
	   straight from the external-controller (bettbox.core module) */
	return {
		enabled: (ctx.get('bettbox', 'config', 'enabled') == '1'),
		// busybox pgrep has no -q on all builds; redirect instead
		running: (system('pgrep mihomo >/dev/null') == 0),
		secret: ctx.get('bettbox', 'config', 'secret') ?? '',
		core: null,
		mode: ctx.get('bettbox', 'config', 'mode') ?? 'rule',
		profile: ctx.get('bettbox', 'config', 'profile') ?? '',
		controller: ctx.get('bettbox', 'config', 'external_controller') ?? '127.0.0.1:9097',
		transparent_mode: ctx.get('bettbox', 'config', 'transparent_mode') ?? 'tun',
		external_ui: (ctx.get('bettbox', 'config', 'external_ui') == '1') && access('/usr/share/bettbox/ui/index.html'),
		mixed_port: int(ctx.get('bettbox', 'config', 'mixed_port')) ?? 7893
	};
}

return {
	bettbox: {
		get_status: {
			call: function() {
				return status_obj();
			}
		},
		get_profiles: {
			call: function() {
				return { profiles: profile_list() };
			}
		},
		add_profile: {
			args: { url: '', label: '' },
			call: function(request) {
				let url = request.args.url ?? '';
				if (!(match(url, /^(https?|file):\/\/[A-Za-z0-9._~:\/?#@!$&()*+,;=%-]+$/)))
					return { error: 'bad url' };
				let label = request.args.label ?? '';
				let out = run('/usr/bin/bettbox add ' + shellquote(url) + ' ' + shellquote(label) + ' 2>&1');
				// sid is echoed on the last line only on success
				let lines = split(trim(out), '\n');
				let sid = trim(lines[length(lines) - 1] ?? '');
				if (match(sid, /^sub[A-Za-z0-9]+$/))
					return { ok: true, sid: sid, text: out };
				return { ok: false, text: out };
			}
		},
		update_profile: {
			args: { sid: '', all: '0' },
			call: function(request) {
				let all = (request.args.all == '1');
				if (!all && !valid_sid(request.args.sid))
					return { error: 'invalid sid' };
				let cmd = all ? '/usr/bin/bettbox update-all' : '/usr/bin/bettbox update ' + shellquote(request.args.sid);
				return { ok: true, text: run(cmd + ' 2>&1') };
			}
		},
		del_profile: {
			args: { sid: '' },
			call: function(request) {
				if (!valid_sid(request.args.sid))
					return { error: 'invalid sid' };
				let ctx = cursor();
				ctx.delete('bettbox', request.args.sid);
				ctx.commit('bettbox');
				unlink('/etc/bettbox/profiles/' + request.args.sid + '.yaml');
				return { ok: true };
			}
		},
		get_scripts: {
			call: function() {
				let scripts = [];
				if (access('/etc/bettbox/scripts')) {
					// ucode builds differ: lsdir may return strings or {name,...} objects
					for (let ent in lsdir('/etc/bettbox/scripts')) {
						let name = (type(ent) == 'string') ? ent : ent?.name;
						if (name && match(name, /\.js$/)) {
							let st = stat('/etc/bettbox/scripts/' + name);
							push(scripts, { name: substr(name, 0, length(name) - 3), size: (st != null) ? st.size : 0 });
						}
					}
				}
				return { scripts: scripts };
			}
		},
		get_script: {
			args: { name: '' },
			call: function(request) {
				if (!valid_name(request.args.name))
					return { error: 'invalid name' };
				let path = '/etc/bettbox/scripts/' + request.args.name + '.js';
				if (!access(path))
					return { error: 'not found' };
				return { name: request.args.name, content: readfile(path) ?? '' };
			}
		},
		save_script: {
			args: { name: '', content: '' },
			call: function(request) {
				if (!valid_name(request.args.name))
					return { error: 'invalid name' };
				if (length(request.args.content) > 512 * 1024)
					return { error: 'script too large' };
				writefile('/etc/bettbox/scripts/' + request.args.name + '.js', request.args.content);
				return { ok: true };
			}
		},
		del_script: {
			args: { name: '' },
			call: function(request) {
				if (!valid_name(request.args.name))
					return { error: 'invalid name' };
				unlink('/etc/bettbox/scripts/' + request.args.name + '.js');
				return { ok: true };
			}
		},
		script_options: {
			args: { name: '' },
			call: function(request) {
				if (!valid_name(request.args.name))
					return { error: 'invalid name' };
				let path = '/etc/bettbox/scripts/' + request.args.name + '.js';
				if (!access(path))
					return { error: 'not found' };
				if (!access('/usr/bin/bettbox-forge'))
					return { error: 'bettbox-forge not installed' };
				let out = run('/usr/bin/bettbox-forge options --script ' + shellquote(path) + ' 2>/dev/null');
				if (!length(out))
					return { error: 'options extraction failed' };
				try {
					return { ok: true, options: json(out) };
				} catch (e) {
					return { error: 'options parse failed' };
				}
			}
		},
		api_proxy: {
			args: { method: 'GET', path: '/', body: '' },
			call: function(request) {
				let method = uc(request.args.method ?? 'GET');
				if (!(method in ['GET', 'PUT', 'POST', 'DELETE']))
					return { error: 'bad method' };
				let res = api_raw(method, request.args.path ?? '/', request.args.body);
				return { status: res.status, data: res.body, raw: res.raw };
			}
		},
		apply: {
			call: function() {
				let out = run('/usr/bin/bettbox apply 2>&1');
				let ok = (system('/usr/bin/bettbox apply >/dev/null 2>&1') == 0);
				return { ok: ok, text: out };
			}
		},
		service_action: {
			args: { action: '' },
			call: function(request) {
				let action = request.args.action;
				if (!(action in ['start', 'stop', 'restart', 'enable', 'disable']))
					return { error: 'bad action' };
				system('/etc/init.d/bettbox ' + action);
				return { ok: true };
			}
		},
		dashboard: {
			args: { action: 'install' },
			call: function(request) {
				let action = request.args.action;
				if (!(action in ['install', 'remove']))
					return { error: 'bad action' };
				let out = run('/usr/libexec/bettbox/dashboard.sh ' + action + ' 2>&1');
				return { ok: (match(out, /failed|malformed/) == null), text: out };
			}
		},
		geo_update: {
			call: function() {
				system('rm -f /etc/bettbox/geo/*');
				system('/etc/init.d/bettbox restart');
				return { ok: true };
			}
		},
		get_logs: {
			call: function() {
				return { text: run("logread | grep -E 'bettbox|mihomo' | tail -n 300") };
			}
		},
		toolbox_call: {
			args: { tool: '', args_json: '[]' },
			call: function(request) {
				let tool = request.args.tool;
				if (!(tool in ['dns', 'ip', 'ping', 'speedtest', 'media', 'trace', 'mrs', 'nat', 'age', 'iperf']))
					return { error: 'bad tool' };
				let argv = [];
				let list = [];
				try { list = json(request.args.args_json ?? '[]'); } catch (e) { list = []; }
				for (let a in list)
					push(argv, shellquote((type(a) == 'string') ? a : sprintf('%J', a)));
				return { text: run('/usr/bin/bettbox ' + tool + ' ' + join(' ', argv) + ' 2>&1') };
			}
		},
		import_script_url: {
			args: { url: '', name: '' },
			call: function(request) {
				let url = request.args.url ?? '';
				if (!(match(url, /^https?:\/\/[A-Za-z0-9._~:\/?#@!$&()*+,;=%-]+$/)))
					return { error: 'bad url' };
				let name = request.args.name ?? '';
				if (!length(name)) {
					let base = replace(url, /^.*\//, '');
					name = replace(base, /\?.*$/, '');
					name = replace(name, /\.js$/, '');
				}
				if (!(type(name) == 'string' && length(name) <= 64 && match(name, /^[A-Za-z0-9_-]+$/)))
					return { error: 'invalid script name' };
				let body = '/tmp/bettbox-import.$$';
				let cmd = sprintf('curl -sSL --fail -m 30 -o %s %s 2>/dev/null && grep -q "function main" %s && wc -c < %s',
					shellquote(body), shellquote(url), shellquote(body), shellquote(body));
				let out = run(cmd);
				let size = int(trim(out));
				if (type(size) != 'int' || size <= 0)
					return { error: 'download failed or no main() in script' };
				if (size > 512 * 1024)
					return { error: 'script too large' };
				let content = readfile(body) ?? '';
				unlink(body);
				if (length(content) == 0)
					return { error: 'downloaded script is empty' };
				writefile('/etc/bettbox/scripts/' + name + '.js', content);
				return { ok: true, name: name, size: size };
			}
		},
		backup_call: {
			args: { action: '', file: '' },
			call: function(request) {
				let action = request.args.action;
				if (!(action in ['create', 'restore', 'push', 'pull', 'list']))
					return { error: 'bad action' };
				let f = request.args.file ?? '';
				if ((action == 'create' || action == 'restore') && !valid_path(f))
					return { error: 'invalid file path' };
				let cmd = '/usr/libexec/bettbox/backup.sh ' + action + ((f && (action == 'create' || action == 'restore')) ? ' ' + shellquote(f) : '');
				let out = run(cmd + ' 2>&1');
				return { ok: (match(out, /usage|failed|not configured|error/i) == null), text: out };
			}
		}
	}
};
