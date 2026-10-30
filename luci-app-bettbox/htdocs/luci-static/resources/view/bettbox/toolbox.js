'use strict';
'require view';
'require bettbox.ui as UI';

var TOOLS=[['dns','DNS 查询','globe','解析域名，检查分流 DNS'],['ping','本地 Ping','activity','检测路由器到目标的连通性'],['trace','路由追踪','route','查看目标命中的规则与策略链'],['ip','IP 全能查','globe','查询直连或代理出口信息'],['speedtest','网速测试','bolt','经当前代理策略测试上下行'],['mrs','MRS 速查','search','查询域名所属的 GeoSite 类别'],['nat','NAT 检测','lan','检测公网地址与 STUN 映射'],['iperf','iPerf3 工具','link','测试到指定服务器的吞吐量'],['age','Age 加解密','shield','使用接收方公钥或身份密钥'],['media','连通性测试','grid','查看常用服务的 HTTP 响应']];
function input(value,placeholder,type){return E('input',{'class':'field',value:value||'',placeholder:placeholder||'',type:type||'text'});}
function select(values){return E('select',{'class':'field'},values.map(function(v){return E('option',{value:v[0]},v[1]||v[0]);}));}
function bounded(c,min,max){var n=Number(c.value);if(!Number.isInteger(n)||n<min||n>max)throw new Error('请输入 '+min+'–'+max+' 之间的整数');return String(n);}
function host(c){var s=c.value.trim();if(!/^[A-Za-z0-9_:.\-]+$/.test(s)||s.charAt(0)==='-')throw new Error('请输入有效的域名或 IP 地址');return s;}
TOOLS.unshift(['health','网络健康','activity','分层检测 DNS 和访问链路']);
function healthResult(report){
	var labels={process:'核心进程',controller:'控制接口',core_dns:'核心 DNS',dnsmasq:'dnsmasq',upstream:'上游 DNS（本机路径）',explicit:'显式代理访问',router_access:'路由器本机访问'};
	var statuses={ok:'通过',fail:'失败',unknown:'未确认',skipped:'未检测',stopped:'已停止'};
	var reasons={missing_nslookup:'缺少 nslookup',unsupported_nslookup:'查询工具不支持该方式',invalid_dns_endpoint:'DNS 地址无法检测',unsupported_dns_transport:'该 DNS 协议不适用于 UDP 查询',not_owned:'未接管 dnsmasq',not_configured:'未配置可检测的上游',mixed_disabled:'Mixed 端口未开启',invalid_controller_endpoint:'控制接口地址无法检测',api_failed:'控制接口未正常响应',no_address:'未获得有效的 A 记录',proxy_authentication:'代理认证失败',connection_failed:'请求失败',runtime_missing:'没有运行配置'};
	var rows=Object.keys(labels).map(function(key){var item=report.layers&&report.layers[key]||{status:'unknown'};return E('div',{'class':'bb-health-layer'},[E('strong',{},labels[key]),UI.tag(statuses[item.status]||'未确认',item.status==='ok'?'':item.status==='fail'?'danger':'neutral'),E('span',{'class':'small muted'},item.reason?reasons[item.reason]||'检测未完成':item.http_status?'HTTP '+item.http_status+' · '+Math.round(item.latency_ms||0)+' ms':'')]);});
	var summary=report.summary||{},memory=report.memory||{};
	return E('div',{'class':'bb-health-report'},[E('p',{'class':'bb-health-summary'},summary.message||'检测未完成'),E('div',{'class':'bb-health-grid'},rows),E('p',{'class':'small muted'},'局域网设备链路：待终端验证'),E('dl',{'class':'bb-health-memory'},[['核心 RSS',memory.VmRSS],['核心 PSS',memory.Pss],['历史峰值',memory.VmHWM],['系统可用',memory.system_available]].map(function(pair){return E('div',{},[E('dt',{},pair[0]),E('dd',{'class':'mono'},UI.bytes(pair[1]))]);}))]);
}
return view.extend({render:function(){
	var requested=new URLSearchParams(window.location.search).get('tool');
	var active=TOOLS.some(function(t){return t[0]===requested;})?requested:'dns',states={},workspace=E('div',{'class':'tool-workspace'}),tiles=[];
	if(!document.getElementById('bettbox-health-css'))document.head.appendChild(E('link',{id:'bettbox-health-css',rel:'stylesheet',href:L.resource('bettbox/health.css')+'?v=20261030-1'}));
	function draw(){var item=TOOLS.filter(function(t){return t[0]===active;})[0],id=active,state=states[id]||(states[id]={}),fields=[],args,form=E('div',{'class':'bb-tool-fields'});
		function field(label,c,help){if(state.values&&Object.prototype.hasOwnProperty.call(state.values,label))c.value=state.values[label];c.setAttribute('aria-label',label);fields.push([label,c]);function remember(){if(!state.values)state.values={};state.values[label]=c.value;}c.addEventListener('input',remember);c.addEventListener('change',remember);form.appendChild(UI.field(label,c,help));return c;}
		if(id==='health'){var healthDomain=field('测试域名',input('www.baidu.com'));args=function(){var value=host(healthDomain);if(value.length>253||! /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*)$/.test(value))throw new Error('请输入有效的测试域名');return[value];};}
		else if(id==='dns'){var dn=field('域名',input('www.baidu.com')),dt=field('记录类型',select([['A'],['AAAA'],['CNAME'],['MX'],['TXT'],['NS']])),dm=field('查询方式',select([['follow','跟随核心'],['system','系统 DNS'],['custom','指定 DNS 服务器']])),ds=field('DNS 服务器',input('223.5.5.5'),'仅在指定 DNS 服务器时使用');args=function(){return[host(dn),dt.value,dm.value,dm.value==='custom'?host(ds):''];};}
		else if(id==='ping'){var ph=field('目标地址',input('223.5.5.5')),pc=field('次数',input('4','','number')),pp=field('TCP 端口',input('0','','number'),'0 使用 ICMP；TCP 探测需要系统 nc 支持');args=function(){return[host(ph),bounded(pc,1,20),'1',bounded(pp,0,65535)];};}
		else if(id==='trace'||id==='mrs'){var th=field('域名 / IP 地址',input(id==='trace'?'www.youtube.com':'www.baidu.com'));args=function(){return[host(th)];};}
		else if(id==='ip'){var iv=field('访问方式',select([['direct','直连查询'],['proxy','经代理查询']])),ih=field('查询 IP',input('','留空查询当前出口'));args=function(){return[iv.value,ih.value.trim()?host(ih):''];};}
		else if(id==='iperf'){var ihost=field('iPerf3 服务器',input('','例如 10.0.0.194')),isec=field('测试时长（秒）',input('10','','number'));args=function(){return[host(ihost),bounded(isec,1,60)];};}
		else if(id==='age'){var am=field('操作',select([['encrypt','加密'],['decrypt','解密']])),ak=field('公钥 / 身份密钥',input('','age1… / AGE-SECRET-KEY-…','password')),ad=field('输入文本',E('textarea',{'class':'field',rows:5}));args=function(){if(!ak.value.trim()||!ad.value)throw new Error('请填写密钥和文本');return[am.value,ak.value.trim(),ad.value];};}
		else {args=function(){return[];};}
		var out=E(id==='health'?'div':'pre',{'class':id==='health'?'bb-health-output':'tool-result',role:'status'},state.report?healthResult(state.report):state.output||'—'),status=E('span',{'class':'small muted'},state.running?'诊断正在后台运行…':state.finished?'上次运行 '+state.finished:'尚未运行');
		function execute(){if(state.running)return;var argv=args();state.values={};fields.forEach(function(f){state.values[f[0]]=f[1].value;});state.running=true;state.report=null;status.textContent='诊断正在后台运行…';out.textContent='任务已提交，正在等待结果…';return UI.job(id==='health'?'health':'toolbox',id==='health'?argv:[id].concat(argv),function(res){if(res.text&&id!=='health')out.textContent=res.text;}).then(function(res){if(id==='health'){var report=JSON.parse(res.text);if(!report.layers||!report.summary)throw new Error('未获得有效的分层检测结果');state.report=report;}state.output=res.text||'任务完成，无输出。';status.textContent='诊断完成';}).catch(function(err){state.output='诊断失败：'+err.message;status.textContent='诊断失败';}).finally(function(){state.running=false;state.finished=new Date().toLocaleTimeString();if(state.report)out.replaceChildren(healthResult(state.report));else out.textContent=state.output;if(active===id)draw();});}
		var run=UI.button(state.running?'检测中…':'开始运行',execute,'primary','activity');run.disabled=!!state.running;
		workspace.replaceChildren(UI.panel(item[1],item[2],[form,E('div',{'class':'button-row'},[run,status]),out]));tiles.forEach(function(t){t.classList.toggle('active',t.dataset.tool===active);t.setAttribute('aria-pressed',String(t.dataset.tool===active));});
	}
	var grid=E('div',{'class':'tool-grid'},TOOLS.map(function(t){var b=E('button',{type:'button','class':'tool-card','data-tool':t[0]},[UI.icon(t[2]),E('div',{},[E('strong',{},t[1])])]);b.addEventListener('click',function(){active=t[0];draw();});tiles.push(b);return b;}));draw();
	return UI.page('toolbox','工具箱',[],[grid,workspace]);
},handleSaveApply:null,handleSave:null,handleReset:null});
