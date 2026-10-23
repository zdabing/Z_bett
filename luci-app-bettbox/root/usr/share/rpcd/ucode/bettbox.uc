// SPDX-License-Identifier: GPL-3.0
//
// rpcd ucode backend for luci-app-bettbox.
// Loaded by rpcd's ucode plugin (rpcd-mod-ucode); exposes the "bettbox"
// ubus object. Shell work is delegated to /usr/bin/bettbox and friends.

'use strict';

import { access, lsdir, popen, readfile, unlink, writefile } from 'fs';
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
	return type(sid) == 'string' && match(sid, /^[A-Za-z0-9_-]{1,64}$/);
}

function valid_name(name) {
	return type(name) == 'string' && match(name, /^[A-Za-z0-9_-]{1,64}$/);
}

const CONTROLLER_PATH = /^\/[A-Za-z0-9_\/.?=&:%~-]{0,256}$/;

function api_raw(method, path, body) {
	if (!match(path, CONTROLLER_PATH))
		return { status: 400, body: null, raw: 'bad path' };
	let ctx = cursor();
	let hc = ctx.get('bettbox', 'config', 'external_controller') ?? '127.0.0.1:9097';
	let port = split(hc, ':')[1] ?? '9097';
	let secret = ctx.get('bettbox', 'config', 'secret') ?? '';

	let bf = '/tmp/bettbox-api.body';
	let cf = '/tmp/bettbox-api.code';
	let cmd = sprintf('curl -sS -m %d -o %s -w "%%{http_code}" -X %s -H %s',
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
		profiles.push({
			id: sid,
			label: s.label ?? sid,
			url: s.url ?? '',
			auto_update: (s.auto_update == '1'),
			update_interval: int(s.update_interval) ?? 1440,
			use_script: (s.use_script == '1'),
			script: s.script ?? '',
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
	return {
		enabled: (ctx.get('bettbox', 'config', 'enabled') == '1'),
		running: (system('pgrep -q mihomo') == 0),
		core: api_raw('GET', '/version').body,
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
					for (let ent in lsdir('/etc/bettbox/scripts')) {
						if (ent?.name && ent.type == 'file' && match(ent.name, /\.js$/))
							scripts.push({ name: substr(ent.name, 0, length(ent.name) - 3), size: ent.size });
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
				if (!(tool in ['dns', 'ip', 'ping', 'speedtest', 'media']))
					return { error: 'bad tool' };
				let argv = [];
				let list = [];
				try { list = json(request.args.args_json ?? '[]'); } catch (e) { list = []; }
				for (let a in list)
					argv.push(shellquote((type(a) == 'string') ? a : sprintf('%J', a)));
				return { text: run('/usr/bin/bettbox ' + tool + ' ' + join(' ', argv) + ' 2>&1') };
			}
		}
	}
};
