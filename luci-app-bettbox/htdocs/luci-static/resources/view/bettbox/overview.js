'use strict';
'require view';
'require rpc';
'require poll';
'require uci';
'require ui';
'require bettbox.core as Core';
'require bettbox.ui as UI';

var callStatus=rpc.declare({object:'bettbox',method:'get_status'});
var callNetwork=rpc.declare({object:'bettbox',method:'get_network'});
var callService=rpc.declare({object:'bettbox',method:'service_action',params:['action']});
var commit=rpc.declare({object:'uci',method:'commit',params:['config']});
function svg(tag,attrs){var el=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.keys(attrs||{}).forEach(function(k){el.setAttribute(k,attrs[k]);});return el;}
function traffic(upload,download,available){
	var total=upload+download,up=total?upload/total*100:0,down=total?100-up:0,ring=svg('svg',{viewBox:'0 0 128 128',role:'img','aria-label':available?(total?'上传 '+up.toFixed(1)+'%，下载 '+down.toFixed(1)+'%':'暂无累计流量'):'核心未运行'});
	ring.appendChild(svg('circle',{'class':'traffic-track',cx:64,cy:64,r:51}));
	if(total&&available){var g=svg('g',{transform:'rotate(-90 64 64)'});g.appendChild(svg('circle',{'class':'download-arc',cx:64,cy:64,r:51,pathLength:100,'stroke-dasharray':down+' '+up,'stroke-dashoffset':-up}));g.appendChild(svg('circle',{'class':'upload-arc',cx:64,cy:64,r:51,pathLength:100,'stroke-dasharray':up+' '+down}));ring.appendChild(g);}
	var sum=available?UI.bytes(total).split(' '):['—',''];return E('div',{'class':'traffic-body'},[E('div',{'class':'traffic-donut'},[ring,E('div',{'class':'traffic-total'},[E('small',{},'累计总量'),E('strong',{},sum[0]),E('span',{},sum[1]||'')])]),E('div',{'class':'traffic-legend'},[['up','上传',upload,up,'upload'],['down','下载',download,down,'download']].map(function(row){var value=available?UI.bytes(row[2]).split(' '):['—',''];return E('div',{'class':'traffic-entry '+row[4]},[E('div',{'class':'traffic-entry-label'},[E('i'),document.createTextNode(row[1]),E('span',{},total&&available?row[3].toFixed(1)+'%':'—')]),E('div',{'class':'traffic-value'},[UI.icon(row[0]),E('strong',{},value[0]),E('small',{},value[1]||'')])]);}))]);
}
return view.extend({
	load:function(){return Promise.all([callStatus(),callNetwork(),uci.load('bettbox')]);},
	render:function(data){
		var st=data[0]||{},net=data[1]||{},last=null,busy=false,lastStatus=0,lastProxy=0,servicePending='',serviceGeneration=0,refreshSequence=0;
		var note=E('div',{'class':'bb-update-note','role':'status',hidden:true}),stateTag=UI.tag(st.running?'运行中':'已停止',st.running?'':'neutral'),serviceTitle=E('span',{},st.running?'Bettbox 正在运行':'Bettbox 已停止');
		function setNote(text){note.textContent=text;note.hidden=!text;}
		var meta=E('div',{'class':'service-meta'},'Mihomo · '+(st.transparent_mode||'tun').toUpperCase()+' / '+(net.stack||'mips'));
		var serviceSwitch=E('button',{type:'button','class':'switch'+((st.enabled||st.running)?'':' off'),role:'switch','aria-checked':String(!!(st.enabled||st.running)),'aria-label':'启动服务'});
		serviceSwitch.addEventListener('click',function(){
			if(servicePending)return;
			var on=!(st.enabled||st.running);
			serviceGeneration++;refreshSequence++;busy=false;last=null;proxyGeneration++;
			serviceSwitch.disabled=true;servicePending=on?'正在启动…':'正在停止…';setNote('');paintService();
			callService(on?'start':'stop').then(UI.operation).then(function(){return waitForService(on);}).catch(function(err){
				UI.error(err);return refreshStatus().catch(UI.error);
			}).finally(function(){
				servicePending='';paintService();serviceSwitch.disabled=false;refresh();
				if(st.running){proxyGeneration++;checkExit('proxy');}
			});
		});
		var modes=E('div',{'class':'segmented','aria-label':'运行模式'});
		[['rule','规则'],['global','全局'],['direct','直连']].forEach(function(m){var b=E('button',{type:'button','class':st.mode===m[0]?'active':'','aria-pressed':String(st.mode===m[0])},m[1]);b.addEventListener('click',function(){var old=st.mode;Array.from(modes.children).forEach(function(x){x.disabled=true;});(st.running?Core.patch('/configs',{mode:m[0]}):Promise.resolve()).then(function(){uci.set('bettbox','config','mode',m[0]);return uci.save();}).then(function(){return commit('bettbox');}).then(refreshStatus).catch(function(err){uci.set('bettbox','config','mode',old);if(st.running)Core.patch('/configs',{mode:old}).catch(function(){});UI.error(err);}).finally(function(){Array.from(modes.children).forEach(function(x){x.disabled=false;});});});b.dataset.mode=m[0];modes.appendChild(b);});
		var stats={},metrics=E('section',{'class':'panel metric-grid overview-metrics'},[['down','下行速度','实时下载'],['up','上行速度','实时上传'],['link','活动连接','当前核心会话数'],['chip','内核内存','Mihomo 进程占用']].map(function(m){var value=E('div',{'class':'stat'},'—');stats[m[0]]=value;return E('div',{'class':'metric'},[E('div',{'class':'label'},[UI.icon(m[0]),document.createTextNode(m[1])]),value]);}));
		var trafficSlot=E('div',{},traffic(0,0,false));
		var trafficPanel=E('section',{'class':'panel traffic-card'},[E('div',{'class':'panel-head'},E('h2',{},[UI.icon('traffic'),document.createTextNode('流量统计')])),trafficSlot]);
		var exitParts={},exitJobs={},proxyGeneration=0,exitBodies=E('div',{'class':'exit-grid'});
		['direct','proxy'].forEach(function(via){var ip=E('span',{'class':'ip-address network-unknown'},'未检测'),country=E('div',{'class':'country'},'—'),org=E('div',{'class':'asn'},'—'),node=E('span',{},via==='direct'?'直连 DIRECT':'当前代理出口'),status=E('span',{'class':'muted'},'未检测');exitParts[via]={ip:ip,country:country,org:org,node:node,status:status};exitBodies.appendChild(E('div',{'class':'exit-block'},[E('div',{'class':'exit-kind'},[E('i',{'class':'dot'}),document.createTextNode(via==='direct'?'直连出口':'代理出口')]),E('div',{'class':'ip-row'},[ip,UI.button('复制',function(){if(ip.dataset.ip)return UI.copy(ip.dataset.ip);},'text small','copy')]),country,org,E('div',{'class':'exit-node'},[node,status])]));});
		function stopProxyExit(){
			proxyGeneration++;
			var p=exitParts.proxy;
			p.ip.textContent='未启用';p.ip.classList.add('network-unknown');delete p.ip.dataset.ip;
			p.country.textContent='—';p.org.textContent='—';p.status.textContent='代理未运行';p.status.title='';
		}
		function checkExit(via){
			if(via==='proxy'&&servicePending)return Promise.resolve();
			if(via==='proxy'&&!st.running){stopProxyExit();return Promise.resolve();}
			if(exitJobs[via])return exitJobs[via];
			var p=exitParts[via],generation=proxyGeneration;
			function current(){return via!=='proxy'||(st.running&&!servicePending&&generation===proxyGeneration);}
			p.status.textContent='检测中…';p.status.title='';if(!p.ip.dataset.ip)p.ip.textContent='检测中…';
			var task=Promise.resolve().then(function(){return UI.job('exit',[via]);}).then(function(res){
				if(!current())return;
				var info=JSON.parse(res.text);if(!info.ip)throw new Error('未返回出口 IP');
				p.ip.textContent=info.ip;p.ip.classList.remove('network-unknown');p.ip.dataset.ip=info.ip;
				p.country.textContent=[info.country||info.country_code,info.region,info.city].filter(Boolean).join(' · ')||'地区未知';
				p.org.textContent=info.organization_name||info.organization||'运营商未知';p.status.textContent='更新于 '+new Date().toLocaleTimeString();
			}).catch(function(err){
				if(!current())return;
				p.status.textContent='检测失败';if(!p.ip.dataset.ip)p.ip.textContent='查询失败';p.status.title=err.message;
			}).finally(function(){
				delete exitJobs[via];
				// A stop/start during an in-flight query needs a fresh result.
				if(via==='proxy'&&!servicePending&&st.running&&generation!==proxyGeneration)return checkExit('proxy');
			});exitJobs[via]=task;return task;
		}
		function checkExits(){return Promise.all([checkExit('direct'),checkExit('proxy')]);}
		var networkPanel=E('section',{'class':'panel network-card'},[E('div',{'class':'panel-head'},[E('div',{},[E('h2',{},[UI.icon('globe'),document.createTextNode('网络检查')])]),UI.button('检测',checkExits,'small','refresh')]),exitBodies]);
		var lan=net.lan||{},lanAddr=lan.address||'—';function row(k,v){return E('div',{'class':'definition-row'},[E('dt',{},k),E('dd',{'class':'right mono'},String(v||'—'))]);}
		var lanPanel=UI.panel('内网 IP','lan',[E('div',{'class':'lan-primary'},[E('div',{},[E('div',{'class':'ip-address'},lanAddr),E('div',{'class':'tiny muted'},(lan.device||'LAN')+' / '+(lan.prefix||24))]),UI.button('复制',function(){return UI.copy(lanAddr);},'text small','copy')]),E('dl',{'class':'definition-list'},[row('局域网代理',net.mixed_port?lanAddr+':'+net.mixed_port:'未开启'),row('LAN DNS',lanAddr),row('WAN 接口',net.wan&&net.wan.device)])]);lanPanel.classList.add('lan-card');
		var sites=[['baidu','百','百度','baidu.com'],['google','G','Google','gstatic.com'],['youtube','▷','YouTube','youtube.com'],['github','gh','GitHub','github.com'],['netflix','N','Netflix','netflix.com'],['openai','◎','OpenAI','openai.com']],resultNodes={};
		var siteGrid=E('div',{'class':'test-grid'},sites.map(function(s){var result=E('div',{'class':'test-result'},'未检测');resultNodes[s[0]]=result;return E('div',{'class':'test-row'},[E('div',{'class':'test-left'},[E('span',{'class':'site-icon'},s[1]),E('div',{},[E('div',{'class':'site-name'},s[2]),E('div',{'class':'site-domain'},s[3])])]),result]);}));
		function checkSites(){Object.keys(resultNodes).forEach(function(id){resultNodes[id].textContent='检测中…';});return UI.job('connectivity',[]).then(function(res){var result=JSON.parse(res.text);(result.results||[]).forEach(function(s){var el=resultNodes[s.id];if(!el)return;var good=s.code===0&&s.http>=200&&s.http<400;el.className='test-result'+(good?'':' warn');el.replaceChildren(E('span',{},good?'可达':s.code===28?'超时':s.code===6?'解析失败':s.http?'HTTP '+s.http:'连接失败'),E('b',{},s.latency_ms>0?Math.round(s.latency_ms)+' ms':'—'));});}).catch(function(err){Object.keys(resultNodes).forEach(function(id){resultNodes[id].textContent='检测失败';});throw err;});}
		var connectivity=E('section',{'class':'panel section-gap'},[E('div',{'class':'panel-head'},[E('div',{},[E('h2',{},[UI.icon('link'),document.createTextNode('连通性测试')])]),UI.button('开始检测',checkSites,'primary small','refresh')]),siteGrid]);
		function paintService(){
			stateTag.textContent=servicePending||(st.running?'运行中':'已停止');stateTag.className='tag '+(st.running?'':'neutral');
			serviceTitle.textContent=st.running?'Bettbox 正在运行':'Bettbox 已停止';
			serviceSwitch.classList.toggle('off',!(st.enabled||st.running));serviceSwitch.setAttribute('aria-checked',String(!!(st.enabled||st.running)));
			Array.from(modes.children).forEach(function(b){b.classList.toggle('active',b.dataset.mode===st.mode);b.setAttribute('aria-pressed',String(b.dataset.mode===st.mode));});
		}
		function refreshStatus(){
			var generation=serviceGeneration;
			return callStatus().then(function(s){
				if(generation!==serviceGeneration)return st;
				var wasRunning=st.running,oldMode=st.mode;st=s;lastStatus=Date.now();paintService();
				if(!s.running&&wasRunning)stopProxyExit();
				else if(!servicePending&&s.running&&(!wasRunning||oldMode!==s.mode)){proxyGeneration++;checkExit('proxy');}
				return s;
			});
		}
		function waitForService(on){
			var until=Date.now()+15000;
			function check(){return refreshStatus().then(function(s){
				if(s.service_known!==false&&(on?s.enabled&&s.running:!s.enabled&&!s.running))return s;
				if(Date.now()>=until)throw new Error('服务状态尚未稳定，请刷新确认');
				return new Promise(function(resolve){window.setTimeout(resolve,200);}).then(check);
			});}return check();
		}
		function stoppedMetrics(){last=null;Object.keys(stats).forEach(function(k){stats[k].textContent='—';});trafficSlot.replaceChildren(traffic(0,0,false));setNote('');}
		function refresh(){
			if(servicePending||busy)return Promise.resolve();busy=true;
			var generation=serviceGeneration,sequence=++refreshSequence;
			function current(){return generation===serviceGeneration&&sequence===refreshSequence&&!servicePending;}
			return (Date.now()-lastStatus>10000?refreshStatus():Promise.resolve(st)).then(function(s){
				if(!current())return;
				if(!s.running){stoppedMetrics();return;}
				return Core.get('/connections').then(function(res){
					if(!current())return;
					var c=res.data||{},now=Date.now(),up=+c.uploadTotal||0,down=+c.downloadTotal||0;
					if(last&&now>last.time&&up>=last.up&&down>=last.down){stats.up.textContent=UI.speed((up-last.up)*1000/(now-last.time));stats.down.textContent=UI.speed((down-last.down)*1000/(now-last.time));}
					else{stats.up.textContent='采样中…';stats.down.textContent='采样中…';}
					last={up:up,down:down,time:now};stats.link.textContent=String((c.connections||[]).length);stats.chip.textContent=UI.bytes(st.memory_rss);trafficSlot.replaceChildren(traffic(up,down,true));setNote('');
					if(now-lastProxy>30000){lastProxy=now;Core.get('/proxies').then(function(p){if(!current())return;var ps=p.data&&p.data.proxies||{},g=ps['默认代理']||ps.PROXY||ps.Proxy;if(g&&g.now)exitParts.proxy.node.textContent=g.now;}).catch(function(){});}
				});
			}).catch(function(err){
				if(!current())return;
				return refreshStatus().then(function(s){if(!current())return;if(!s.running)stoppedMetrics();else setNote('暂时无法更新统计，保留上次结果：'+err.message);},function(){if(current())setNote('暂时无法更新统计，保留上次结果：'+err.message);});
			}).finally(function(){if(sequence===refreshSequence)busy=false;});
		}
		var service=E('section',{'class':'panel service'},[E('div',{'class':'service-main'},[E('div',{'class':'service-icon'},UI.icon('power')),E('div',{},[E('div',{'class':'service-title'},[serviceTitle,stateTag]),meta])]),E('div',{'class':'service-actions'},[modes,E('div',{'class':'service-toggle'},[document.createTextNode('启动服务'),serviceSwitch])])]);
		var root=UI.page('overview','概览',[UI.button('刷新',refresh,'','refresh')],[service,metrics,note,E('div',{'class':'net-grid overview-network'},[trafficPanel,networkPanel,lanPanel]),connectivity]);poll.add(refresh,2);checkExits();refresh();return root;
	},handleSaveApply:null,handleSave:null,handleReset:null
});
