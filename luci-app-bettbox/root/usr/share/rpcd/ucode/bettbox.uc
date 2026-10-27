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

function run_result(cmd) {
	let fd = popen('timeout 55 sh -c ' + shellquote(cmd), 'r');
	let out = '';
	if (!fd)
		return { ok: false, code: 127, text: 'could not execute command' };
	out = fd.read('all') ?? '';
	let code = fd.close();
	return { ok: code == 0, code: code, text: out };
}

function run(cmd) {
	return run_result(cmd).text;
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
	return type(path) == 'string' && length(path) <= 2048 && match(path, /^\/[A-Za-z0-9_\/.?=&:%~-]*$/);
}

function api_raw(method, path, body) {
	if (!valid_controller_path(path))
		return { status: 400, body: null, raw: 'bad path' };
	let endpoint = split(path, '?')[0];
	if (method == 'GET' && endpoint in ['/traffic', '/memory', '/logs'])
		return { status: 400, body: null, raw: 'streaming endpoints cannot use RPC; use /connections snapshots' };
	let ctx = cursor();
	let hc = ctx.get('bettbox', 'config', 'external_controller') ?? '127.0.0.1:9097';
	let parts = split(hc, ':');
	let port = parts[length(parts) - 1] ?? '9097';
	let host = substr(hc, 0, length(hc) - length(port) - 1);
	if (host == '0.0.0.0' || host == '*' || !length(host)) host = '127.0.0.1';
	if (host == '[::]') host = '[::1]';
	let secret = ctx.get('bettbox', 'config', 'secret') ?? '';

	let dir = trim(run('umask 077; mktemp -d /tmp/bettbox-api.XXXXXX'));
	if (!match(dir, /^\/tmp\/bettbox-api\.[A-Za-z0-9]+$/))
		return { status: 500, body: null, raw: 'could not create request workspace' };
	let bf = dir + '/body';
	let cf = dir + '/code';
	// busybox timeout guard: a wedged curl inside rpcd blocks every ubus call
	let cmd = sprintf('timeout %d curl -sS -m %d -o %s -w "%%{http_code}" -X %s -H %s',
		(method == 'GET' ? 7 : 17),
		method == 'GET' ? 5 : 15,
		shellquote(bf), method, shellquote('Authorization: Bearer ' + secret));
	if (body != null && length(body) > 0)
		cmd += sprintf(" -H 'Content-Type: application/json' --data-binary %s", shellquote(body));
	cmd += sprintf(' %s > %s 2>/dev/null', shellquote('http://' + host + ':' + port + path), shellquote(cf));
	system(cmd);

	let status = int(trim(readfile(cf) ?? '')) ?? 0;
	let raw = readfile(bf) ?? '';
	unlink(cf);
	unlink(bf);
	system('rmdir ' + shellquote(dir));
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
	let service = null;
	try { service = json(run('ubus -t 2 call service list ' + shellquote('{"name":"bettbox"}'))); } catch (e) {}
	let pid=service?.bettbox?.instances?.core?.pid, rss=null;
	if(type(pid)=='int' && pid>0){let m=match(readfile('/proc/'+pid+'/status')??'',/VmRSS:\s+([0-9]+) kB/);if(m)rss=int(m[1])*1024;}
	/* instant by design: no internal curl here — views read live core state
	   straight from the external-controller (bettbox.core module) */
	return {
		enabled: (ctx.get('bettbox', 'config', 'enabled') == '1'),
		running: service?.bettbox?.instances?.core?.running == true,
		secret: ctx.get('bettbox', 'config', 'secret') ?? '',
		core: null,
		memory_rss: rss,
		mode: ctx.get('bettbox', 'config', 'mode') ?? 'rule',
		profile: ctx.get('bettbox', 'config', 'profile') ?? '',
		controller: ctx.get('bettbox', 'config', 'external_controller') ?? '127.0.0.1:9097',
		allow_lan: ctx.get('bettbox', 'config', 'allow_lan') == '1',
		transparent_mode: ctx.get('bettbox', 'config', 'transparent_mode') ?? 'tun',
		external_ui: (ctx.get('bettbox', 'config', 'external_ui') == '1') && access('/usr/share/bettbox/ui/index.html'),
		mixed_port: int(ctx.get('bettbox', 'config', 'mixed_port')) ?? 7893
	};
}

function network_info() {
	let lan = {}, wan = {};
	try { lan = json(run('ubus -t 2 call network.interface.lan status')); } catch(e) {}
	try { wan = json(run('ubus -t 2 call network.interface.wan status')); } catch(e) {}
	let ctx=cursor(), gateway='';
	for (let route in (wan.route ?? [])) if(route.target=='0.0.0.0') gateway=route.nexthop ?? '';
	return { lan: { address: lan['ipv4-address']?.[0]?.address ?? '', prefix: lan['ipv4-address']?.[0]?.mask ?? 24, device: lan.l3_device ?? '', ipv6: lan['ipv6-prefix-assignment']?.[0]?.['local-address']?.address ?? '' }, wan: { up: wan.up == true, device: wan.l3_device ?? '', address: wan['ipv4-address']?.[0]?.address ?? '', gateway: gateway, dns: wan['dns-server'] ?? [] }, mixed_port: int(ctx.get('bettbox','config','mixed_port')) ?? 0, allow_lan: ctx.get('bettbox','config','allow_lan')=='1', stack: ctx.get('bettbox','tun','stack') ?? 'mips' };
}

function valid_job(id) { return type(id)=='string' && match(id,/^bettbox-job\.[A-Za-z0-9]+$/); }
function create_job(kind, args) {
	let service = kind == 'service' || kind == 'core' || kind == 'package', active=0;
	for(let entry in (lsdir('/tmp') ?? [])){
		let name=type(entry)=='string'?entry:entry?.name;
		if(!valid_job(name))continue;
		let dir='/tmp/'+name, st=stat(dir);
		if(!st)continue;
		if(time()-st.mtime>3600){for(let file in ['request','output','code','input','worker.uc','runner.sh'])unlink(dir+'/'+file);system('rmdir '+shellquote(dir)+' 2>/dev/null');}
		else if(!access(dir+'/code') && time()-st.mtime<180){
			let old=null;
			try { old=json(readfile(dir+'/request')); } catch(e) {}
			if(old?.kind!='service' && old?.kind!='core' && old?.kind!='package')active++;
		}
	}
	if(!service && active>=3)return {ok:false,error:'已有三个诊断任务运行，请稍候'};
	let dir=trim(run('umask 077; mktemp -d /tmp/bettbox-job.XXXXXX'));
	let id=split(dir,'/')[2];
	if(!valid_job(id))return {ok:false,error:'could not create diagnostic workspace'};
	if(writefile(dir+'/request',sprintf('%J',{kind:kind,args:args}))==null)return {ok:false,error:'could not save diagnostic request'};
	if(service && writefile('/var/run/bettbox-service.lock/job',id)==null)return {ok:false,error:'could not save service job'};
	let limit=kind=='package'?2400:kind=='core'?1200:service?600:160;
	if(kind=='package'){
		let worker=readfile('/usr/libexec/bettbox/diagnostic.uc');
		let script='#!/bin/sh\numask 077\ntimeout 2400 ucode '+shellquote(dir+'/worker.uc')+' '+shellquote(dir)+' > '+shellquote(dir+'/output')+' 2>&1\nrc=$?\nprintf "%s\\n" "$rc" > '+shellquote(dir+'/code')+'\nexit "$rc"\n';
		if(!worker||writefile(dir+'/worker.uc',worker)==null||writefile(dir+'/runner.sh',script)==null)return {ok:false,error:'无法保存独立更新任务'};
		let definition={name:'bettbox-package-update',instances:{worker:{command:['/bin/sh',dir+'/runner.sh'],stdout:false,stderr:false}}};
		if(system('ubus -t 5 call service set '+shellquote(sprintf('%J',definition))+' >/dev/null 2>&1')!=0)return {ok:false,error:'无法启动独立 APK 更新任务'};
		return {ok:true,id:id,timeout_ms:2430000,reconnect:true};
	}
	// A diagnostic file-size limit must not be inherited by config/Geo writers.
	let filelimit=service?'':'ulimit -f 2048; ';
	let cmd='(umask 077; '+filelimit+'timeout '+limit+' ucode /usr/libexec/bettbox/diagnostic.uc '+shellquote(dir)+' > '+shellquote(dir+'/output')+' 2>&1; echo $? > '+shellquote(dir+'/code')+') </dev/null >/dev/null 2>&1 &';
	if(system(cmd)!=0)return {ok:false,error:'could not start diagnostic'};
	return {ok:true,id:id,timeout_ms:(limit+30)*1000};
}

// Called ONLY by write-authorized apply/service_action/core_update RPCs. The
// read-only diagnostic_start allowlist rejects service and core mutations.
function service_job(action) {
	let lock='/var/run/bettbox-service.lock', old=trim(readfile(lock+'/job')??''), st=stat(lock);
	let ttl=650, oldRequest=null;
	try { oldRequest=json(readfile('/tmp/'+old+'/request')); } catch(e) {}
	if(oldRequest?.kind=='core')ttl=1250;
	if(oldRequest?.kind=='package')ttl=2450;
	if(st && ((valid_job(old) && access('/tmp/'+old+'/code')) || time()-st.mtime>ttl)){
		unlink(lock+'/job'); system('rmdir '+shellquote(lock)+' 2>/dev/null');
	}
	if(system('umask 077; mkdir '+shellquote(lock)+' 2>/dev/null')!=0)
		return {ok:false,error:'服务正在切换，请稍后重试'};
	let core=action=='core-update'||action=='core-rollback';
	let result=create_job(action=='package-update'?'package':core?'core':'service',[action=='package-update'?'update':core?substr(action,5):action]);
	if(!result.ok){unlink(lock+'/job');system('rmdir '+shellquote(lock)+' 2>/dev/null');}
	return result;
}

function diagnostic_start(request) {
	let kind=request.args.kind, args=null;
	if (!(kind in ['exit','connectivity','delay','toolbox'])) return {ok:false,error:'invalid diagnostic kind'};
	try { args=json(request.args.args_json); } catch(e) {}
	if(type(args)!='array'||length(args)>8) return {ok:false,error:'invalid diagnostic arguments'};
	for(let arg in args) if(type(arg)!='string'||length(arg)>65536) return {ok:false,error:'invalid diagnostic argument'};
	if(kind=='exit' && !(args[0] in ['direct','proxy'])) return {ok:false,error:'invalid exit mode'};
	if(kind=='toolbox' && !(args[0] in ['dns','ip','ping','speedtest','media','trace','mrs','nat','age','iperf'])) return {ok:false,error:'invalid tool'};
	return create_job(kind,args);
}

function resource_info() {
	let files=[];
	for(let item in [{name:'GeoSite',file:'geosite.dat'},{name:'GeoIP / MMDB',file:'country.mmdb'},{name:'GeoIP DAT',file:'geoip.dat'},{name:'ASN',file:'ASN.mmdb'}]){
		let found=null;
		for(let path in ['/etc/bettbox/'+item.file,'/etc/bettbox/geo/'+item.file]){let st=stat(path);if(st){found={path:path,size:st.size,modified:st.mtime};break;}}
		push(files,{name:item.name,file:item.file,installed:found!=null,info:found});
	}
	return {files:files,dashboard:access('/usr/share/bettbox/ui/index.html')};
}

return {
	bettbox: {
		package_info: {call:function(){
			let result=run_result('/usr/bin/bettbox package status');if(!result.ok)return result;
			try {return json(result.text);}catch(e){return {ok:false,error:'无法读取 APK 版本信息'};}
		}},
		package_check: {call:function(){return create_job('package-check',[]);}},
		package_update: {call:function(){return service_job('package-update');}},
		core_info: {call:function(){
			let result=run_result('/usr/bin/bettbox core status');
			if(!result.ok)return result;
			try { return json(result.text); } catch(e) {return {ok:false,error:'无法读取核心信息'};}
		}},
		core_check: {call:function(){return create_job('core-check',[]);}},
		core_update: {args:{action:''},call:function(request){
			let action=request.args.action;
			if(!(action in ['update','rollback']))return {ok:false,error:'invalid core action'};
			return service_job('core-'+action);
		}},
		get_network: {call:function(){return network_info();}},
		get_resources: {call:function(){return resource_info();}},
		backup_file: {args:{action:'',file:''},call:function(request){
			if(request.args.action=='prepare'){let file=trim(run('umask 077; mktemp /tmp/bettbox-ui-backup.XXXXXX'));if(!match(file,/^\/tmp\/bettbox-ui-backup\.[A-Za-z0-9]+$/))return {ok:false,error:'could not create backup workspace'};return {ok:true,file:file};}
			if(request.args.action=='remove'&&match(request.args.file??'',/^\/tmp\/bettbox-ui-backup\.[A-Za-z0-9]+$/)){unlink(request.args.file);return {ok:true};}
			return {ok:false,error:'invalid backup workspace'};
		}},
		diagnostic_start: {args:{kind:'',args_json:'[]'},call:diagnostic_start},
		diagnostic_status: {
			args:{id:''},call:function(request){
				let id=request.args.id;if(!valid_job(id))return {error:'invalid job id'};
				let dir='/tmp/'+id;if(!access(dir+'/request'))return {error:'任务不存在或已过期'};
				let code=access(dir+'/code')?int(trim(readfile(dir+'/code')??'')):null;
				return {done:code!=null,ok:code==0,code:code,text:readfile(dir+'/output')??''};
			}
		},
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
				return run_result(cmd + ' 2>&1');
			}
		},
		del_profile: {
			args: { sid: '' },
			call: function(request) {
				if (!valid_sid(request.args.sid))
					return { error: 'invalid sid' };
				let ctx = cursor();
				if (ctx.get('bettbox', 'config', 'profile') == request.args.sid)
					return { ok: false, error: 'select another profile before deleting the active profile' };
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
				if (writefile('/etc/bettbox/scripts/' + request.args.name + '.js', request.args.content) == null)
					return { ok: false, error: 'could not save script' };
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
				if (!(method in ['GET', 'PUT', 'PATCH', 'POST', 'DELETE']))
					return { error: 'bad method' };
				let res = api_raw(method, request.args.path ?? '/', request.args.body);
				return { status: res.status, data: res.body, raw: res.raw };
			}
		},
		apply: {
			call: function() {
				return service_job('apply');
			}
		},
		service_action: {
			args: { action: '' },
			call: function(request) {
				let action = request.args.action;
				if (!(action in ['start', 'stop', 'restart', 'enable', 'disable']))
					return { error: 'bad action' };
				if (action in ['start','stop','restart'])return service_job(action);
				let cmd = '/etc/init.d/bettbox ' + action;
				if (action == 'start' || action == 'restart')
					cmd = '/etc/init.d/bettbox enable && ' + cmd;
				return run_result(cmd + ' 2>&1');
			}
		},
		dashboard: {
			args: { action: 'install' },
			call: function(request) {
				let action = request.args.action;
				if (!(action in ['install', 'remove']))
					return { error: 'bad action' };
				return run_result('/usr/libexec/bettbox/dashboard.sh ' + action + ' 2>&1');
			}
		},
		geo_update: {
			call: function() {
				let res = api_raw('POST', '/configs/geo', '');
				return { ok: res.status >= 200 && res.status < 300,
					text: res.status >= 200 && res.status < 300 ? 'Geo resources updated' :
						'Geo update failed; check core logs', status: res.status };
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
				let body = trim(run('umask 077; mktemp /tmp/bettbox-import.XXXXXX'));
				if (!match(body, /^\/tmp\/bettbox-import\.[A-Za-z0-9]+$/))
					return { error: 'could not create download workspace' };
				let cmd = sprintf('curl -sSL --fail --max-filesize 524288 -m 30 -o %s %s 2>/dev/null && grep -q "function main" %s && wc -c < %s',
					shellquote(body), shellquote(url), shellquote(body), shellquote(body));
				let out = run(cmd);
				let size = int(trim(out));
				if (type(size) != 'int' || size <= 0) {
					unlink(body);
					return { error: 'download failed or no main() in script' };
				}
				if (size > 512 * 1024) {
					unlink(body);
					return { error: 'script too large' };
				}
				let content = readfile(body) ?? '';
				unlink(body);
				if (length(content) == 0)
					return { error: 'downloaded script is empty' };
				if (writefile('/etc/bettbox/scripts/' + name + '.js', content) == null)
					return { ok: false, error: 'could not save script' };
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
				return run_result(cmd + ' 2>&1');
			}
		}
	}
};
