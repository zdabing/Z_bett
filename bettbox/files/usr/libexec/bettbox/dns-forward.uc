#!/usr/bin/ucode
// DNS upstreams live in one SIGHUP-reloadable file, never in two default pools.
// Serialized by dnsmasq.sh. DHCP and more-specific domain rules stay in dnsmasq.
import { chmod, mkdir, popen, readfile, rename, stat, unlink, writefile } from 'fs';
import { cursor } from 'uci';

const STATE='/etc/bettbox/state/dns-forward.json';
const ROOT='/var/run/dnsmasq/bettbox';
const SERVERS=ROOT+'/servers';
const TARGET=ROOT+'/target.json';
const INCLUDE='servers-file='+SERVERS;
let ctx=cursor();

function q(s) { return sprintf("'%s'",replace(''+s,/'/g,"'\\''")); }
function command(cmd) {
	let fd=popen(cmd+' 2>/dev/null','r');
	if(!fd)die('cannot execute DNS control command');
	let text=fd.read('all'),code=fd.close();
	return {text:text??'',code:code};
}
function metadata(path) {
	let text=readfile(path);
	if(text==null)return null;
	try { let v=json(text); if(type(v)=='object')return v; } catch(e) {}
	die('invalid DNS forwarding state');
}
function atomic(path,text,mode) {
	let tmp=path+'.new';
	if(writefile(tmp,text)==null || !chmod(tmp,mode) || !rename(tmp,path)) {
		unlink(tmp); die('cannot publish DNS forwarding state');
	}
}
function ensure() {
	for(let path in ['/var/run/dnsmasq',ROOT,'/etc/bettbox/state'])
		if(!stat(path) && !mkdir(path,0755))die('cannot create DNS forwarding directory');
	// The shell's private umask must not hide this directory after dnsmasq
	// drops privileges. Only the public upstream file is readable here.
	if(!chmod(ROOT,0755))die('cannot grant dnsmasq directory traversal');
}
function list(v) { return v==null?[]:type(v)=='array'?v:[v]; }
function same(a,b) { return sprintf('%J',a)==sprintf('%J',b); }
function conditional(s) { return substr(s,0,1)=='/' && substr(s,0,3)!='/#/'; }
function set(key,value,section) {
	if(value==null || (type(value)=='array' && !length(value)))ctx.delete('dhcp',section,key);
	else if(!ctx.set('dhcp',section,key,value))die('cannot update DNS registration');
}
function clean_extra(text) {
	return join('\n',filter(split(text??'','\n'),line=>trim(line)!=INCLUDE));
}
function current(meta) {
	let sid=meta.section;
	return {server:ctx.get('dhcp',sid,'server'),noresolv:ctx.get('dhcp',sid,'noresolv'),
		resolvfile:ctx.get('dhcp',sid,'resolvfile'),extraconftext:ctx.get('dhcp',sid,'extraconftext')};
}
function original(meta) {
	let now=current(meta),result={...meta.original};
	// Preserve administrator edits. The values we still own map to their
	// saved originals; changed values are used as the new system DNS policy.
	for(let key in ['server','noresolv','resolvfile'])
		if(!same(now[key],meta.managed[key]))result[key]=now[key];
	return result;
}
function normal(meta) {
	let config=original(meta),servers=filter(list(config.server),s=>!conditional(s));
	if(config.noresolv!='1') {
		let path=config.resolvfile??'/tmp/resolv.conf.d/resolv.conf.auto';
		if(type(path)!='string' || substr(path,0,1)!='/')die('invalid system resolver path');
		for(let line in split(readfile(path)??'','\n')) {
			let m=match(line,/^[ \t]*nameserver[ \t]+([^ \t#\r\n]+)/);
			if(m && !(m[1] in servers))push(servers,m[1]);
		}
	}
	let lines=[];
	for(let server in servers) {
		if(type(server)!='string' || match(server,/[\r\n]/))die('invalid system DNS upstream');
		if(!(server in map(lines,l=>substr(l,7))))push(lines,'server='+server);
	}
	return length(lines)?join('\n',lines)+'\n':'';
}
function process(meta,verify) {
	let result=command("ubus -t 3 call service list '{\"name\":\"dnsmasq\"}'"),data;
	try { data=json(result.text); } catch(e) { die('dnsmasq service is unavailable'); }
	let instance=data?.dnsmasq?.instances?.[meta.section],pid=instance?.pid;
	if(!instance?.running || type(pid)!='int' || pid<2 ||
		index(readfile('/proc/'+pid+'/cmdline')??'','dnsmasq')<0)die('dnsmasq process is unavailable');
	if(verify) {
		let confdir=ctx.get('dhcp',meta.section,'confdir')??('/tmp/dnsmasq.'+meta.section+'.d');
		confdir=split(confdir,',')[0];
		let content=readfile('/proc/'+pid+'/root'+confdir+'/extraconfig.conf')??'';
		if(!(INCLUDE in map(split(content,'\n'),line=>trim(line))))die('dnsmasq hot forwarding is not attached');
	}
	return pid;
}
function publish(meta,target,notify) {
	let port=target?.port;
	if(port!=null && (type(port)!='int' || port<1 || port>65535))die('invalid core DNS port');
	let text=port==null?normal(meta):('server=127.0.0.1#'+port+'\n');
	let old=readfile(SERVERS),previous=readfile(TARGET);
	if(old==text && previous==sprintf('%J',target))return;
	let pid=notify?process(meta,true):null;
	atomic(SERVERS,text,0644);
	atomic(TARGET,sprintf('%J',target),0600);
	if(pid!=null && command('kill -HUP '+pid).code!=0) {
		atomic(SERVERS,old??'',0644);atomic(TARGET,previous??'{}',0600);
		die('cannot signal dnsmasq; previous DNS target retained');
	}
}
function stage() {
	let meta=metadata(STATE);
	if(meta) {
		if(meta.version!=1 || !same(current(meta),meta.managed))
			die('DNS settings changed; restore the DNS integration before applying again');
		print('ready');return;
	}
	let sections=[];
	ctx.foreach('dhcp','dnsmasq',s=>{if(s.disabled!='1')push(sections,s);});
	if(length(sections)!=1)die('hot forwarding requires one enabled dnsmasq instance');
	let sid=sections[0]['.name'];
	if(length(list(ctx.get('dhcp',sid,'serversfile'))))die('another DNS serversfile is configured');
	meta={version:1,section:sid};
	meta.original=current(meta);
	let extra=meta.original.extraconftext??'';
	if(match(extra,/(^|\n)[ \t]*(server|rev-server|servers-file|no-resolv|resolv-file)[ \t]*(=|$)/))
		die('custom DNS upstream directives require manual integration');
	meta.managed={...meta.original,server:filter(list(meta.original.server),conditional),noresolv:'1',
		extraconftext:extra+(length(extra)?'\n':'')+INCLUDE};
	if(!length(meta.managed.server))meta.managed.server=null;
	// Persist the recovery snapshot before changing any UCI values.
	atomic(STATE,sprintf('%J',meta),0600);
	// Build system DNS from the saved originals before managed UCI is applied.
	for(let key in ['server','noresolv','extraconftext'])set(key,meta.managed[key],sid);
	if(!ctx.commit('dhcp'))die('cannot save DNS registration');
	ctx=cursor();
	publish(meta,{},false);
	print('setup');
}
function unregister(meta) {
	if(!meta)return;
	let now=current(meta);
	for(let key in ['server','noresolv'])
		if(same(now[key],meta.managed[key]))set(key,meta.original[key],meta.section);
	let extra=same(now.extraconftext,meta.managed.extraconftext)?meta.original.extraconftext:clean_extra(now.extraconftext);
	set('extraconftext',length(extra??'')?extra:null,meta.section);
	if(!ctx.commit('dhcp'))die('cannot restore system DNS settings');
	unlink(STATE);unlink(TARGET);
}

ensure();
let action=ARGV[0],meta=metadata(STATE);
if(action=='stage')stage();
else if(action=='prepare') {
	if(readfile(SERVERS)==null) {
		if(meta)publish(meta,{},false);
		else atomic(SERVERS,'',0644);
	}
}
else if(action=='core') {
	if(!meta)die('DNS integration is not registered');
	if(!match(ARGV[1]??'',/^[0-9]+$/))die('invalid core DNS port');
	publish(meta,{port:int(ARGV[1])},true);
}
else if(action=='system') { if(meta)publish(meta,{},true); }
else if(action=='attached') { if(!meta)die('DNS integration is not registered'); process(meta,true); }
else if(action=='sync') {
	if(meta && metadata(TARGET)?.port==null)publish(meta,{},true);
}
else if(action=='unregister')unregister(meta);
else die('usage: dns-forward.uc stage|prepare|core PORT|system|sync|attached|unregister');
