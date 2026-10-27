#!/usr/bin/ucode
// Official stable releases only. Download and verify before a serialized switch.
import { access, chmod, lstat, lsdir, mkdir, mkdtemp, open, popen, readfile, readlink, rename, rmdir, stat, symlink, unlink, writefile } from 'fs';

const ROOT='/etc/bettbox/core';
const CACHE='/etc/bettbox/state/core-release.json';
const PACKAGE='/usr/bin/mihomo';
const API='https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const MAX_BINARY=268435456;

function q(s) { return sprintf("'%s'",replace(''+s,/'/g,"'\\''")); }
function command(cmd, required) {
	let fd=popen(cmd+' 2>&1','r');
	if(!fd)die('无法执行核心管理命令');
	let text='',part;
	while((part=fd.read(4096))!=null && length(part)){
		text+=part; if(length(text)>65536)text=substr(text,length(text)-65536);
	}
	let code=fd.close();
	if(required && code!=0)die(trim(text)||'核心管理命令执行失败');
	return {code:code,text:trim(text)};
}
function ensure() {
	command('mkdir -p '+q(ROOT+'/releases')+' '+q('/etc/bettbox/state'),true);
	if(readlink(ROOT)!=null || readlink(ROOT+'/releases')!=null)die('核心存储目录不能是符号链接');
}
function valid_tag(tag) { return type(tag)=='string' && length(tag)<40 && match(tag,/^v[0-9]+\.[0-9]+\.[0-9]+$/); }
function valid_hash(hash) { return type(hash)=='string' && length(hash)==64 && match(hash,/^[a-f0-9]+$/); }
function valid_target(target) {
	return target=='package' || (type(target)=='string' && length(target)<180 && match(target,/^releases\/v[0-9]+\.[0-9]+\.[0-9]+-(amd64-compatible|arm64|armv7|armv6)-[a-f0-9]+$/));
}
function pointer(name, fallback) {
	let value=readlink(ROOT+'/'+name);
	if(value==null){if(lstat(ROOT+'/'+name))die('核心选择记录损坏');return fallback;}
	if(!valid_target(value))die('核心选择记录包含无效路径');
	return value;
}
function binary(target) { return target=='package'?PACKAGE:ROOT+'/'+target+'/mihomo'; }
function set_pointer(name,target) {
	let tmp=ROOT+'/'+name+'.new'; unlink(tmp);
	if(target=='none'){unlink(ROOT+'/'+name);return;}
	if(!valid_target(target) || !symlink(target,tmp) || !rename(tmp,ROOT+'/'+name))die('无法原子切换核心');
}
function version(path) {
	let result=command('timeout 5 '+q(path)+' -v',false);
	let tag=match(result.text,/v[0-9]+\.[0-9]+\.[0-9]+/);
	return result.code==0 && match(result.text,/[Mm]ihomo/) && tag?tag[0]:null;
}
function arch() {
	let machine=command('uname -m',true).text;
	let names={x86_64:'amd64-compatible',aarch64:'arm64',arm64:'arm64',armv7l:'armv7',armv6l:'armv6'};
	return {machine:machine,name:names[machine]??null};
}
function newer(a,b) {
	if(!valid_tag(a))return false;
	if(!valid_tag(b))return true;
	let x=split(substr(a,1),'.'),y=split(substr(b,1),'.');
	for(let i=0;i<3;i++){if(int(x[i])!=int(y[i]))return int(x[i])>int(y[i]);}
	return false;
}
function metadata(path) {
	try { let data=json(readfile(path)); return type(data)=='object'?data:null; } catch(e) {return null;}
}
function info() {
	let current=pointer('current','package'), previous=pointer('previous','none'), platform=arch();
	let installed=version(binary(current)), latest=metadata(CACHE);
	if(latest && (!valid_tag(latest.version)||latest.arch!=platform.name))latest=null;
	return {ok:true,current:installed,source:current=='package'?'package':'managed',architecture:platform.name??platform.machine,
		supported:platform.name!=null,latest:latest?.version??null,checked:latest?.checked??null,
		available:platform.name!=null && latest!=null && newer(latest.version,installed),
		rollback:previous!='none' && previous!=current && access(binary(previous),'x'),
		previous_source:previous=='none'?null:previous=='package'?'package':'managed',
		previous:previous!='none'?version(binary(previous)):null};
}
function fetch(url,path,maxsize) {
	let seconds=maxsize<=2097152?35:120;
	command('curl -fLsS --proto '+q('=https')+' --proto-redir '+q('=https')+
		' --connect-timeout 10 --max-time '+seconds+' --retry 1 --retry-delay 1 --max-filesize '+maxsize+
		' -H '+q('Accept: application/vnd.github+json')+' -H '+q('User-Agent: Bettbox-OpenWrt')+' -o '+q(path)+' '+q(url),true);
	let st=stat(path);if(!st || st.size<=0 || st.size>maxsize)die('下载文件大小无效');
}
function release(folder,platform) {
	if(!platform.name)die('当前架构暂不支持一键更新核心');
	let path=folder+'/release.json';fetch(API,path,2097152);
	let data=metadata(path);
	if(!data || type(data.draft)!='bool' || data.draft || type(data.prerelease)!='bool' || data.prerelease || !valid_tag(data.tag_name) || type(data.assets)!='array')die('上游未返回有效的稳定版信息');
	let filename='mihomo-linux-'+platform.name+'-'+data.tag_name+'.gz', found=null;
	for(let asset in data.assets)if(asset.name==filename){found=asset;break;}
	let url='https://github.com/MetaCubeX/mihomo/releases/download/'+data.tag_name+'/'+filename;
	let hash=type(found?.digest)=='string'?substr(found.digest,7):null;
	if(!found || found.browser_download_url!=url || substr(found.digest??'',0,7)!='sha256:' || !valid_hash(hash) ||
		type(found.size)!='int' || found.size<=0 || found.size>67108864)die('上游缺少匹配架构或可信 SHA-256 的核心文件');
	let result={version:data.tag_name,arch:platform.name,url:url,sha256:hash,size:found.size,checked:time()};
	if(writefile(folder+'/cache.json',sprintf('%J',result))==null || !rename(folder+'/cache.json',CACHE))die('无法保存核心版本信息');
	return result;
}
function sha256(path) {
	let hash=substr(command('sha256sum '+q(path),true).text,0,64);
	if(!valid_hash(hash))die('无法计算核心文件 SHA-256');return hash;
}
function space(path,required) {
	let value=command('df -Pk '+q(path)+' | tail -n 1 | awk '+q('{print $4}'),true).text;
	if(!match(value,/^[0-9]+$/) || int(value)*1024<required)die('空间不足，旧核心未切换');
}
function elf(path,platform) {
	let fd=open(path,'r'), head=fd?fd.read(20):null;if(fd)fd.close();
	let bits=platform.name=='arm64'||platform.name=='amd64-compatible'?2:1;
	let machine=platform.name=='arm64'?183:platform.name=='amd64-compatible'?62:40;
	if(!head || length(head)<20 || substr(head,0,4)!='\x7fELF' || ord(head,4)!=bits || ord(head,5)!=1 ||
		ord(head,18)+ord(head,19)*256!=machine)die('核心文件不是匹配设备架构的 ELF');
}
function validate(target) {
	if(!valid_target(target) || !access(binary(target),'x'))die('待切换核心不存在或不可执行');
	let path=binary(target), platform=arch();
	if(target!='package'){
		let saved=metadata(ROOT+'/'+target+'/release.json');
		if(!saved || !valid_hash(saved.binary_sha256) || sha256(path)!=saved.binary_sha256)die('已保存的核心文件校验失败');
		elf(path,platform);
		if(version(path)!=saved.version)die('核心版本与下载记录不一致');
	}
	let config='/var/run/bettbox/config.yaml', temporary=null;
	if(!access(config)){
		temporary=mkdtemp('/tmp/bettbox-core-config.XXXXXX');if(!temporary)die('无法创建配置校验目录');
		config=temporary+'/config.yaml';
		if(writefile(config,'mode: direct\nproxies: []\nrules: ["MATCH,DIRECT"]\n')==null)die('无法创建校验配置');
	}
	let result=command('timeout 120 '+q(path)+' -t -d /etc/bettbox -f '+q(config),false);
	if(temporary){unlink(config);rmdir(temporary);}
	if(result.code!=0)die('新核心不兼容当前配置：'+result.text);
}
function prune() {
	let current=pointer('current','package'),previous=pointer('previous','none');
	for(let name in (lsdir(ROOT+'/releases')??[])){
		let target='releases/'+name,path=ROOT+'/'+target;
		if(!valid_target(target)||target==current||target==previous||readlink(path)!=null)continue;
		unlink(path+'/mihomo');unlink(path+'/release.json');rmdir(path);
	}
}

let action=ARGV[0]??'status', work=null, stage=null, lock=null, lockHeld=false, failure=null;
try {
	if(action=='status')print(sprintf('%J',info()));
	else if(action=='target'){
		if(!(ARGV[1] in ['current','previous']))die('无效核心选择项');
		print(pointer(ARGV[1],ARGV[1]=='current'?'package':'none'));
	} else if(action=='validate')validate(ARGV[1]);
	else if(action=='select'){
		ensure();let target=ARGV[1];
		if(!valid_target(target)||!access(binary(target),'x'))die('待切换核心不存在');
		let old=pointer('current','package');
		set_pointer('previous',old);set_pointer('current',target);
	} else if(action=='restore'){
		ensure();
		if(!valid_target(ARGV[1]) || (ARGV[2]!='none' && !valid_target(ARGV[2])))die('无效核心回退记录');
		set_pointer('current',ARGV[1]);set_pointer('previous',ARGV[2]);
	} else if(action in ['check','update','rollback']) {
		ensure();
		if(action!='check'){
			lock=open(ROOT+'/update.lock','a');
			if(!lock || !lock.lock('xn'))die('已有核心更新或回退任务运行，请稍后重试');
			lockHeld=true;
			prune();
		}
		work=mkdtemp('/tmp/bettbox-core.XXXXXX');if(!work)die('无法创建下载目录');
		if(action=='check') {release(work,arch());print(sprintf('%J',info()));}
		else if(action=='rollback'){
			let target=pointer('previous','none');
			if(target=='none'||target==pointer('current','package'))die('没有可回退的上一核心');
			command('/etc/init.d/bettbox core_switch '+q(target),true);prune();print('已回退上一核心\n');
		} else {
			let platform=arch(), latest=release(work,platform), current=info();
			if(!newer(latest.version,current.current))print('当前核心已是最新稳定版\n');
			else {
				space('/tmp',latest.size+16777216);
				let archive=work+'/core.gz';fetch(latest.url,archive,67108864);
				if(stat(archive).size!=latest.size || sha256(archive)!=latest.sha256)die('核心下载 SHA-256 校验失败，旧核心未切换');
				let fd=open(archive,'r');if(!fd || !fd.seek(-4,2))die('无效 gzip 核心文件');
				let tail=fd.read(4);fd.close();
				let size=length(tail)==4?ord(tail,0)+ord(tail,1)*256+ord(tail,2)*65536+ord(tail,3)*16777216:0;
				if(size<=0||size>MAX_BINARY)die('解压后的核心大小无效');
				space(ROOT,size+16777216);
				stage=mkdtemp(ROOT+'/stage.XXXXXX');if(!stage)die('无法暂存新核心');
				command('(ulimit -f 524288; gzip -dc '+q(archive)+' > '+q(stage+'/mihomo')+')',true);
				if(stat(stage+'/mihomo')?.size!=size || !chmod(stage+'/mihomo',0o755))die('核心解压不完整或权限设置失败');
				elf(stage+'/mihomo',platform);
				if(version(stage+'/mihomo')!=latest.version)die('核心版本验证失败');
				latest.binary_sha256=sha256(stage+'/mihomo');
				if(writefile(stage+'/release.json',sprintf('%J',latest))==null)die('无法保存核心校验记录');
				let target='releases/'+latest.version+'-'+platform.name+'-'+latest.sha256;
				if(access(ROOT+'/'+target)){validate(target);}
				else {if(!rename(stage,ROOT+'/'+target))die('无法保存新核心');stage=null;}
				command('/etc/init.d/bettbox core_switch '+q(target),true);prune();print('核心已更新至 '+latest.version+'\n');
			}
		}
	} else die('usage: bettbox core status|check|update|rollback');
} catch(e) { failure=e; }
// ucode supports try/catch, not JavaScript finally.
if(stage){unlink(stage+'/mihomo');unlink(stage+'/release.json');rmdir(stage);}
if(work){for(let name in ['release.json','cache.json','core.gz'])unlink(work+'/'+name);rmdir(work);}
if(lockHeld){try {prune();} catch(e) {}}
if(lock)lock.close();
if(failure)die(failure.message??(''+failure));
