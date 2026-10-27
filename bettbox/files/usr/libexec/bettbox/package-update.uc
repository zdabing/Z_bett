#!/usr/bin/ucode
// Fixed-repository APK updates. All downloads/preflight finish before install.
import { access, mkdtemp, open, popen, readfile, rename, rmdir, stat, unlink, writefile } from 'fs';

const REPO='https://github.com/zdabing/Z_bett';
const API='https://api.github.com/repos/zdabing/Z_bett/releases/latest';
const STATE='/etc/bettbox/state';
const CACHE=STATE+'/package-release.json';
const RESULT=STATE+'/package-update-result.json';
const BACKUP=STATE+'/before-package-update.tar';
const LOCK='/var/lock/bettbox-package-update.lock';
const NAMES=['bettbox','luci-app-bettbox'];
function q(value){return sprintf("'%s'",replace(''+value,/'/g,"'\\''"));}
function cmd(value,required){
	let fd=popen(value+' 2>&1','r');if(!fd)die('无法启动更新命令');
	let output='',part,large=false;
	while((part=fd.read(4096))!=null && length(part)){output+=part;if(length(output)>262144){output=substr(output,length(output)-262144);large=true;}}
	let code=fd.close();if(part==null||large)die('更新命令输出不完整，请手动检查');
	if(required && code!=0)die(trim(output)||'更新命令执行失败');
	return {code:code,text:trim(output)};
}
function object(path){try {let value=json(readfile(path));return type(value)=='object'?value:null;}catch(e){return null;}}
function hash(value){return type(value)=='string' && length(value)==64 && match(value,/^[a-f0-9]+$/);}
function version(value){return type(value)=='string' && length(value)<64 && match(value,/^[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+$/);}
function tag(value){return type(value)=='string' && length(value)<64 && match(value,/^v[0-9]+\.[0-9]+\.[0-9]+(-r[0-9]+)?$/);}
function compare(a,b){let value=cmd('timeout 5 apk version -t '+q(a)+' '+q(b),true).text;if(!(value in ['<','=','>']))die('APK 版本比较失败');return value;}
function save(path,value){
	cmd('mkdir -p '+q(STATE),true);
	let temporary=mkdtemp(STATE+'/update-state.XXXXXX');if(!temporary)die('无法保存更新状态');
	let file=temporary+'/value';let ok=writefile(file,sprintf('%J',value))!=null && rename(file,path);
	unlink(file);rmdir(temporary);if(!ok)die('无法保存更新状态');
}
function platform(){
	let machine=cmd('timeout 5 uname -m',true).text,accepted=split(readfile('/etc/apk/arch')??'','\n'),arch=null;
	for(let item in accepted){item=trim(item);if(item=='x86_64' && machine=='x86_64'){arch=item;break;}
		if(item=='aarch64_generic' && (machine=='aarch64'||machine=='arm64')){arch=item;break;}}
	let release=null;
	for(let line in split(readfile('/etc/openwrt_release')??'','\n')){
		let m=match(line,/^DISTRIB_RELEASE=['"]([^'"]+)['"]$/);if(m)release=m[1];
	}
	let compatible=type(release)=='string' && (release=='25.12'||substr(release,0,6)=='25.12.'||substr(release,0,6)=='25.12-');
	return {architecture:arch??machine,supported:arch!=null && compatible && access('/usr/bin/apk','x'),openwrt:release,
		error:!arch?'没有匹配当前 APK 架构的软件包':!compatible?'仅支持 OpenWrt 25.12 系列':!access('/usr/bin/apk','x')?'系统未安装 APK 包管理器':null};
}
function installed(){
	let value=json(cmd('timeout 10 apk query --from installed --installed --match name --format json --fields name,version,arch,status bettbox luci-app-bettbox',true).text);
	if(type(value)!='array')die('无法读取已安装的 APK 版本');
	let result={};
	for(let item in value)if(item.name in NAMES){
		if(!version(item.version)||result[item.name])die('已安装的软件包版本无效');
		result[item.name]=item;
	}
	for(let name in NAMES)if(!result[name])die('未找到已安装的 '+name);
	return result;
}
function assessment(current,latest){
	let available=false,blocked=false;
	if(latest)for(let item in latest.packages){let diff=compare(current[item.name].version,item.version);if(diff=='<')available=true;if(diff=='>')blocked=true;}
	return {available:available&&!blocked,blocked:blocked};
}
function info(){
	let system=platform(),current=installed(),latest=object(CACHE);
	if(latest?.architecture!=system.architecture || !tag(latest?.tag)||type(latest?.packages)!='array'||length(latest.packages)!=2)latest=null;
	let state=assessment(current,latest);
	let probe=open(LOCK,'a'),updating=false;if(probe){updating=!probe.lock('xn');probe.close();}
	return {ok:true,architecture:system.architecture,openwrt:system.openwrt,supported:system.supported,error:system.error,
		current:current,latest:latest,available:state.available,blocked:state.blocked,last:object(RESULT),backup:access(BACKUP),updating:updating};
}
function sha(path){let value=substr(cmd('sha256sum '+q(path),true).text,0,64);if(!hash(value))die('无法计算下载校验值');return value;}
function fetch(url,path,maximum){
	cmd('curl -fLsS --proto '+q('=https')+' --proto-redir '+q('=https')+' --connect-timeout 10 --max-time '+(maximum<=1048576?35:120)+
		' --retry 1 --retry-delay 1 --max-filesize '+maximum+' -H '+q('User-Agent: Bettbox-OpenWrt')+' -o '+q(path)+' '+q(url),true);
	let size=stat(path)?.size;if(!size||size>maximum)die('更新文件大小无效');
}
function asset(release,name){
	let found=null;
	for(let item in release.assets)if(item.name==name){if(found)die('发布资源名称重复');found=item;}
	let digest=found?.digest;
	if(!found||found.browser_download_url!=REPO+'/releases/download/'+release.tag_name+'/'+name||type(digest)!='string'||substr(digest,0,7)!='sha256:'||!hash(substr(digest,7))||type(found.size)!='int'||found.size<=0)die('发布文件缺少可信校验值或下载地址');
	return {filename:name,url:found.browser_download_url,sha256:substr(digest,7),size:found.size};
}
function checked_download(item,path,maximum){
	if(item.size>maximum)die('发布文件超过大小限制');
	fetch(item.url,path,maximum);
	if(stat(path)?.size!=item.size||sha(path)!=item.sha256)die('更新文件 SHA-256 校验失败，未安装 APK');
}
function latest(folder,system){
	if(!system.supported)die(system.error);
	try {fetch(API,folder+'/release.json',1048576);}catch(e){
		let error=e.message??(''+e);
		if(match(error,/404/))die('尚未发布可用于一键更新的稳定版 APK');
		die(error);
	}
	let release=object(folder+'/release.json');
	if(!release||type(release.draft)!='bool'||release.draft||type(release.prerelease)!='bool'||release.prerelease||!tag(release.tag_name)||type(release.assets)!='array'||release.html_url!=REPO+'/releases/tag/'+release.tag_name)die('未找到有效的稳定发布版本');
	let manifestAsset=asset(release,'bettbox-update.json');
	checked_download(manifestAsset,folder+'/manifest.json',1048576);
	let manifest=object(folder+'/manifest.json'),target=manifest?.targets?.[system.architecture];
	if(manifest?.schema!=1||manifest.tag!=release.tag_name||manifest.openwrt!='25.12'||type(target?.packages)!='array'||length(target.packages)!=2)die('发布清单不兼容或没有当前架构');
	let packages=[];
	for(let i=0;i<2;i++){
		let entry=target.packages[i],name=NAMES[i],arch=i==0?system.architecture:'noarch';
		if(entry.name!=name||!version(entry.version)||entry.arch!=arch||entry.filename!=name+'-'+entry.version+'-'+system.architecture+'.apk'||!hash(entry.sha256)||type(entry.size)!='int'||entry.size<=0||entry.size>134217728||type(entry.installed_size)!='int'||entry.installed_size<=0||entry.installed_size>536870912)die('发布清单中的 APK 信息无效');
		let file=asset(release,entry.filename);
		if(file.sha256!=entry.sha256||file.size!=entry.size)die('发布清单与 GitHub 文件校验值不一致');
		file.name=name;file.version=entry.version;file.arch=arch;file.installed_size=entry.installed_size;push(packages,file);
	}
	let result={tag:release.tag_name,url:release.html_url,architecture:system.architecture,packages:packages,checked:time()};
	save(CACHE,result);return result;
}
function free_space(path,needed){
	let available=cmd('df -Pk '+q(path)+' | tail -n 1 | awk '+q('{print $4}'),true).text;
	if(!match(available,/^[0-9]+$/)||int(available)*1024<needed)die('空间不足，未安装 APK');
}
function running(){
	let value=json(cmd('ubus -t 3 call service list '+q('{"name":"bettbox"}'),true).text);
	return value?.bettbox?.instances?.core?.running==true;
}
function inspect(item,path,folder,index){
	cmd('timeout 60 apk --allow-untrusted verify '+q(path),true);
	let output=folder+'/metadata-'+index+'.json';
	cmd('(ulimit -f 8192; timeout 60 apk adbdump --format json '+q(path)+' > '+q(output)+')',true);
	if((stat(output)?.size??0)>4194304)die('APK 元数据过大');
	let root=json(readfile(output));if(type(root)=='array' && length(root)==1)root=root[0];
	let data=root?.info;
	if(data?.name!=item.name||data?.version!=item.version||data?.arch!=item.arch||data?.['installed-size']!=item.installed_size)die('APK 内部名称、版本、架构或大小与发布清单不一致');
	if(item.name=='bettbox'){
		let provides=false,replaces=false;
		for(let value in (data.provides??[]))if(value=='bettbox-forge='+item.version)provides=true;
		for(let value in (data.replaces??[]))if(value=='bettbox-forge')replaces=true;
		if(!provides||!replaces)die('APK 缺少脚本引擎合包迁移信息');
	}
}
function review(plan){
	let own=0;
	for(let line in split(plan,'\n')){
		if(substr(line,0,1)!='(')continue;
		let m=match(line,/^\([ ]*[0-9]+\/[0-9]+\) (Installing|Purging|Removing|Upgrading|Downgrading|Reinstalling|Replacing|Updating pinning) ([A-Za-z0-9_.+-]+)/);
		if(!m)die('无法识别 APK 事务计划，请手动更新');
		let action=m[1],name=m[2],ownPackage=name in NAMES;
		if(action=='Downgrading'||(name=='bettbox-forge'&&action!='Purging'&&action!='Removing')||((action=='Purging'||action=='Removing') && name!='bettbox-forge')||(!ownPackage&&action!='Installing'&&name!='bettbox-forge'))die('APK 事务会更改其他已安装软件，请手动处理依赖');
		if(ownPackage)own++;
	}
	if(!own)die('APK 预检查未确认本项目更新');
}

let action=ARGV[0]??'status',folder=null,lock=null,coreLock=null,failure=null,started=false;
try {
	if(action=='status')print(sprintf('%J',info()));
	else if(action in ['check','update']){
		let system=platform();if(!system.supported)die(system.error);
		if(action=='update'){
			cmd('mkdir -p /var/lock /etc/bettbox/core',true);
			lock=open(LOCK,'a');if(!lock||!lock.lock('xn'))die('已有 APK 更新任务运行');
			coreLock=open('/etc/bettbox/core/update.lock','a');if(!coreLock||!coreLock.lock('xn'))die('核心正在更新，请稍后重试');
		}
		folder=mkdtemp('/tmp/bettbox-package.XXXXXX');if(!folder)die('无法创建 APK 下载目录');
		let release=latest(folder,system),current=installed(),state=assessment(current,release);
		if(action=='check')print(sprintf('%J',info()));
		else if(state.blocked)die('发布包包含较旧版本，拒绝降级');
		else if(!state.available)print(sprintf('%J',{ok:true,changed:false,text:'当前 APK 已是最新版本'}));
		else {
			let compressed=0,expanded=0,files=[];
			for(let item in release.packages){compressed+=item.size;expanded+=item.installed_size;}
			free_space('/tmp',compressed+16777216);free_space('/etc/bettbox',expanded+16777216);
			for(let i=0;i<2;i++){
				let item=release.packages[i],path=folder+'/'+i+'.apk';
				checked_download(item,path,134217728);inspect(item,path,folder,i);push(files,path);
			}
			let installArgs=q(files[0])+' '+q(files[1])+' bettbox-forge';
			let plan=cmd('timeout 120 apk --no-interactive --no-progress --allow-untrusted --simulate add '+installArgs,true).text;review(plan);
			let after=installed();for(let name in NAMES)if(after[name].version!=current[name].version)die('安装版本已被其他任务更改，请重新检查');
			let active=running();
			if(active && cmd('uci -q get bettbox.config.enabled',true).text!='1')die('核心仍在运行但配置已关闭，请先完成停止');
			cmd('timeout 120 /usr/bin/bettbox backup create '+q(folder+'/backup.tar'),true);
			if(!rename(folder+'/backup.tar',BACKUP))die('无法保存更新前备份');
			save(RESULT,{ok:false,phase:'installing',tag:release.tag,backup:BACKUP,time:time()});started=true;
			// APK sanitizes hook environments: explicitly pass only PATH and our flag.
			cmd('env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin BETTBOX_SELF_UPDATE=1 timeout 600 apk --preserve-env --no-interactive --no-progress --allow-untrusted add '+installArgs,true);
			let actual=installed();
			for(let item in release.packages){
				if(actual[item.name].version!=item.version)die('APK 安装后的版本核对失败');
				for(let status in (actual[item.name].status??[]))if(status!='installed')die('APK 报告文件或安装脚本异常');
			}
			if(active)cmd('timeout 600 /etc/init.d/bettbox restart',true);
			else if(running())cmd('timeout 60 /etc/init.d/bettbox stop',true);
			if(running()!=active)die('安装完成但服务状态恢复失败，请检查服务');
			save(RESULT,{ok:true,phase:'complete',tag:release.tag,backup:BACKUP,time:time()});
			// The procd-owned job survives restarting rpcd and changing LuCI files.
			cmd('timeout 30 /etc/init.d/rpcd restart',true);
			print(sprintf('%J',{ok:true,changed:true,text:'APK 已更新，请刷新页面',backup:BACKUP}));
		}
	} else die('usage: bettbox package status|check|update');
} catch(e){failure=e;}
if(failure && started){try {save(RESULT,{ok:false,phase:'failed',tag:object(CACHE)?.tag,backup:BACKUP,time:time(),error:failure.message??(''+failure)});}catch(e){}}
if(folder){for(let file in ['release.json','manifest.json','metadata-0.json','metadata-1.json','0.apk','1.apk','backup.tar'])unlink(folder+'/'+file);rmdir(folder);}
if(coreLock)coreLock.close();if(lock)lock.close();
if(failure)die((started?'安装可能已部分完成，请检查版本和服务；配置备份：'+BACKUP+'。':'')+(failure.message??(''+failure)));
