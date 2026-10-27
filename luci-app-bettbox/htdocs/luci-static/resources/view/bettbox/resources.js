'use strict';
'require view';
'require rpc';
'require ui';
'require bettbox.ui as UI';
var getResources=rpc.declare({object:'bettbox',method:'get_resources'}),geoUpdate=rpc.declare({object:'bettbox',method:'geo_update'}),dashboard=rpc.declare({object:'bettbox',method:'dashboard',params:['action']}),backup=rpc.declare({object:'bettbox',method:'backup_call',params:['action','file']}),backupFile=rpc.declare({object:'bettbox',method:'backup_file',params:['action','file']}),getStatus=rpc.declare({object:'bettbox',method:'get_status'});
var getCore=rpc.declare({object:'bettbox',method:'core_info'}),checkCore=rpc.declare({object:'bettbox',method:'core_check'}),changeCore=rpc.declare({object:'bettbox',method:'core_update',params:['action']});
var getPackage=rpc.declare({object:'bettbox',method:'package_info'}),checkPackage=rpc.declare({object:'bettbox',method:'package_check'}),updatePackage=rpc.declare({object:'bettbox',method:'package_update'});
function download(blob,name){var url=URL.createObjectURL(blob),a=E('a',{href:url,download:name});document.body.appendChild(a);a.click();a.remove();window.setTimeout(function(){URL.revokeObjectURL(url);},5000);}
return view.extend({
	load:function(){return Promise.all([getResources(),getStatus(),getCore().catch(function(err){return {ok:false,error:err.message};}),getPackage().catch(function(err){return {ok:false,error:err.message};})]);},
	render:function(data){var resources=data[0]||{},status=data[1]||{},core=data[2]||{},packages=data[3]||{},coreBusy=false,packageBusy=false,list=E('div'),message=E('div',{'class':'bb-operation-state','role':'status'});
		var coreValues=E('dl',{'class':'definition-list bb-core-details'}),coreState=E('div',{'class':'bb-operation-state','role':'status'});
		var checkButton=UI.button('检查更新',function(){coreAction('check');},'','refresh');
		var updateButton=UI.button('更新核心',function(){coreAction('update');},'primary','download');
		var rollbackButton=UI.button('回退上一版',function(){coreAction('rollback');},'','refresh');
		function coreDraw(){
			function row(label,value){return E('div',{'class':'definition-row'},[E('dt',{},label),E('dd',{},value)]);}
			coreValues.replaceChildren(row('当前版本',[E('span',{'class':'mono'},core.current||'未知'),core.source?UI.tag(core.source==='managed'?'独立更新':'随包核心','neutral'):document.createTextNode('')]),
				row('最新稳定版',[E('span',{'class':'mono'},core.latest||'未检查'),core.latest?UI.tag(core.available?'有新版本':core.latest===core.current?'已是最新':'无需更新',core.available?'':'neutral'):document.createTextNode('')]),
				row('设备架构',core.architecture||'未知'),row('可回退版本',core.rollback?(core.previous||'上一版'):'无'));
			updateButton.querySelector('span').textContent=status.running?'更新并重启':'更新核心';
			rollbackButton.querySelector('span').textContent=core.previous_source==='package'?(status.running?'恢复随包并重启':'恢复随包核心'):(status.running?'回退并重启':'回退上一版');
			checkButton.disabled=coreBusy||packageBusy||packages.updating||core.supported===false;
			updateButton.disabled=coreBusy||packageBusy||packages.updating||!core.supported||!!(core.latest&&!core.available);
			rollbackButton.disabled=coreBusy||packageBusy||packages.updating||!core.rollback;
			if(!coreBusy && !coreState.textContent && core.ok===false)coreState.textContent=core.error||core.text||'无法读取核心信息';
			if(!coreBusy && !coreState.textContent && core.supported===false)coreState.textContent='当前架构暂不支持一键更新';
			coreState.hidden=!coreState.textContent;
		}
		function refreshCore(){return Promise.all([getCore(),getStatus()]).then(function(result){core=UI.checked(result[0]);status=result[1];coreDraw();});}
		function coreAction(action){
			if(coreBusy||packageBusy)return;coreBusy=true;coreDraw();packageDraw();
			coreState.textContent=action==='check'?'正在检查稳定版…':action==='rollback'?'正在回退核心…':'正在下载、校验并更新核心…';
			coreState.hidden=false;
			(action==='check'?checkCore():changeCore(action)).then(UI.operation).then(function(result){
				if(action==='check'){core=UI.checked(JSON.parse(result.text));coreState.textContent=core.available?'发现新版本 '+core.latest:'检查完成';coreDraw();}
				else {coreState.textContent=action==='rollback'?'核心已回退':'核心更新完成';return refreshCore();}
			}).catch(function(err){return refreshCore().catch(function(){}).then(function(){coreState.textContent=(action==='check'?'检查失败：':'操作失败：')+err.message;UI.error(err);});})
			.finally(function(){coreBusy=false;coreDraw();packageDraw();});
		}
		var corePanel=UI.panel('Mihomo 核心','chip',[coreValues,E('div',{'class':'button-row'},[checkButton,updateButton,rollbackButton]),coreState]);coreDraw();
		var packageValues=E('dl',{'class':'definition-list bb-core-details'}),packageState=E('div',{'class':'bb-operation-state',role:'status'});
		var packageCheck=UI.button('检查更新',function(){packageAction('check');},'','refresh');
		var packageUpdate=UI.button('更新 APK',function(){packageAction('update');},'primary','download');
		var packageReload=UI.button('刷新页面',function(){window.location.reload();},'','refresh');packageReload.hidden=true;
		function packageDraw(){
			function row(label,value){return E('div',{'class':'definition-row'},[E('dt',{},label),E('dd',{},value)]);}
			function versions(name){var current=packages.current&&packages.current[name],next=(packages.latest&&packages.latest.packages||[]).filter(function(p){return p.name===name;})[0];return E('span',{'class':'mono'},(current&&current.version||'未知')+(next&&next.version!==(current&&current.version)?' → '+next.version:''));}
			packageValues.replaceChildren(row('Bettbox',versions('bettbox')),row('LuCI',versions('luci-app-bettbox')),row('设备架构',packages.architecture||'未知'),row('最新发布',packages.latest?packages.latest.tag:'未检查'));
			packageUpdate.querySelector('span').textContent=status.running?'更新并重启服务':'更新 APK';
			packageCheck.disabled=coreBusy||packageBusy||packages.updating||packages.supported===false;
			packageUpdate.disabled=coreBusy||packageBusy||packages.updating||!packages.supported||packages.blocked===true||!!(packages.latest&&!packages.available);
			if(!packageState.textContent && packages.updating){packageState.textContent='APK 更新正在运行，请稍后刷新';packageReload.hidden=false;}
			if(!packageState.textContent && packages.last&&packages.last.phase==='failed')packageState.textContent='上次 APK 更新未完成：'+(packages.last.error||'请检查版本和服务');
			if(!packageState.textContent && packages.last&&packages.last.phase==='installing'&&!packages.updating)packageState.textContent='上次 APK 更新中断，请检查版本和服务后重试';
			if(!packageState.textContent && packages.blocked)packageState.textContent='发布包包含较旧版本，无法自动更新';
			if(!packageState.textContent && (packages.ok===false||packages.supported===false))packageState.textContent=packages.error||packages.text||'无法读取 APK 更新信息';
			packageState.hidden=!packageState.textContent;
		}
		function packageAction(action){
			if(packageBusy||coreBusy)return;packageBusy=true;packageDraw();coreDraw();
			packageState.textContent=action==='check'?'正在检查 APK 更新…':'正在更新 APK，后台重连时可能需要重新登录…';packageState.hidden=false;
			(action==='check'?checkPackage():updatePackage()).then(UI.operation).then(function(result){
				if(action==='check'){packages=UI.checked(JSON.parse(result.text));packageState.textContent=packages.available?'发现 APK 更新':packages.blocked?'发布版本需要手动处理':'当前 APK 已是最新版本';}
				else {var outcome=UI.checked(JSON.parse(result.text));packageState.textContent=outcome.text||'APK 更新完成，请刷新页面';packageReload.hidden=false;return getPackage().then(UI.checked).then(function(value){packages=value;}).catch(function(){});}
			}).catch(function(err){packageState.textContent=err.unconfirmed?err.message:(action==='check'?'检查失败：':'APK 更新失败：')+err.message;if(action==='update')packageReload.hidden=false;UI.error(err);return getPackage().then(UI.checked).then(function(value){packages=value;}).catch(function(){});})
			.finally(function(){packageBusy=false;packageDraw();coreDraw();});
		}
		var packagePanel=UI.panel('Bettbox 更新','download',[packageValues,E('div',{'class':'button-row'},[packageCheck,packageUpdate,packageReload]),packageState]);packageDraw();
		function draw(){list.replaceChildren.apply(list,(resources.files||[]).map(function(r){var info=r.info||{};return E('div',{'class':'resource-row'},[E('div',{'class':'resource-file'},[E('div',{'class':'file-icon'},UI.icon('file')),E('div',{},[E('strong',{},r.name),E('small',{},r.file)])]),E('div',{'class':'resource-meta'},[UI.tag(r.installed?'已安装':'未下载',r.installed?'':'neutral'),info.modified?E('small',{},new Date(info.modified*1000).toLocaleString()):document.createTextNode('')]),E('div',{'class':'resource-meta mono'},r.installed?UI.bytes(info.size):'—')]);}));}
		function refresh(){return getResources().then(function(result){resources=result;draw();});}
		function update(){message.textContent='正在请求核心更新 Geo 数据…';return geoUpdate().then(UI.checked).then(function(){message.textContent='Geo 数据已更新';return refresh();}).catch(function(err){message.textContent='更新失败，保留现有资源：'+err.message;throw err;});}
		function exportBackup(){var file;message.textContent='正在创建备份…';return backupFile('prepare','').then(UI.checked).then(function(res){file=res.file;return backup('create',file);}).then(UI.checked).then(function(){return fetch(L.env.cgi_base+'/cgi-download',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'sessionid='+encodeURIComponent(L.env.sessionid)+'&path='+encodeURIComponent(file)});}).then(function(res){if(!res.ok)throw new Error('备份下载失败：HTTP '+res.status);if((res.headers.get('content-type')||'').indexOf('json')>=0)throw new Error('下载接口拒绝了备份文件');return res.blob();}).then(function(blob){download(blob,'bettbox-backup-'+new Date().toISOString().slice(0,10)+'.tar');message.textContent='备份已创建并下载';}).finally(function(){if(file)return backupFile('remove',file);});}
		function restoreDialog(){var file=E('input',{'class':'field',type:'file',accept:'.tar,application/x-tar'}),result=E('p',{'class':'small muted'},'');UI.modal('恢复备份',[E('p',{},'恢复将替换 Bettbox 配置和归档中的订阅、脚本、规则，并按配置启停服务。建议先导出当前备份。'),UI.field('本地备份文件',file,'tar 格式，最大 64MB。'),result],[UI.button('上传并恢复',function(){var f=file.files&&file.files[0],remote;if(!f)throw new Error('请选择备份文件');if(f.size>64*1024*1024)throw new Error('备份不能超过 64MB');result.textContent='正在上传…';return backupFile('prepare','').then(UI.checked).then(function(res){remote=res.file;var form=new FormData();form.append('sessionid',L.env.sessionid);form.append('filename',remote);form.append('filedata',f);return fetch(L.env.cgi_base+'/cgi-upload',{method:'POST',credentials:'same-origin',body:form});}).then(function(res){if(!res.ok)throw new Error('上传失败：HTTP '+res.status);return res.json();}).then(function(reply){if(reply.failure)throw new Error(reply.message||reply.failure);result.textContent='归档已上传，正在校验并应用…';return backup('restore',remote);}).then(UI.checked).then(function(){ui.hideModal();window.location.reload();}).catch(function(err){result.textContent='恢复失败：'+err.message+'。若失败发生在应用阶段，配置可能已经写入，请检查服务状态。';throw err;}).finally(function(){if(remote)return backupFile('remove',remote);});},'danger','refresh'),UI.button('取消',ui.hideModal)]);}
		function panelInstall(){message.textContent='正在安装 / 更新面板…';return dashboard('install').then(UI.checked).then(function(){window.location.reload();}).catch(function(err){message.textContent='面板安装失败：'+err.message;throw err;});}
		var open=UI.button('打开面板',function(){var ctl=status.controller||'',port=ctl.substring(ctl.lastIndexOf(':')+1)||'9097',host=window.location.hostname;if(host.indexOf(':')>=0&&host.charAt(0)!=='[')host='['+host+']';window.open('http://'+host+':'+port+'/ui/','_blank','noopener');},'','arrow');open.disabled=!resources.dashboard;
		var geo=E('section',{'class':'panel'},[E('div',{'class':'panel-head'},E('div',{},[E('h2',{},[UI.icon('globe'),document.createTextNode('Geo 数据')])])),list]);draw();
		return UI.page('resources','资源',[UI.button('更新 Geo 数据',update,'primary','refresh')],[message,E('div',{'class':'stack'},[packagePanel,corePanel,geo,E('div',{'class':'grid-two'},[UI.panel('控制面板','grid',[E('p',{'class':'small muted'},resources.dashboard?'已安装':'未安装'),E('div',{'class':'button-row'},[open,UI.button('安装 / 更新',panelInstall,'','refresh')])]),UI.panel('配置备份','layers',[E('div',{'class':'button-row'},[UI.button('导出备份',exportBackup,'','download'),UI.button('恢复备份',restoreDialog,'','refresh')])])])])]);
	},handleSaveApply:null,handleSave:null,handleReset:null
});
