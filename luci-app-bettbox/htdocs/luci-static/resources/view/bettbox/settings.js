'use strict';
'require view';
'require rpc';
'require uci';
'require bettbox.ui as UI';
var callApply=rpc.declare({object:'bettbox',method:'apply'}),callProfiles=rpc.declare({object:'bettbox',method:'get_profiles'}),commit=rpc.declare({object:'uci',method:'commit',params:['config']});
var SCHEMA = [
	{ section: 'config', title: _('常规'), opts: [
		{ opt: 'enabled', kind: 'flag', icon: 'power', label: _('启动服务') },
		{ opt: 'profile', kind: 'value', icon: 'list', label: _('当前订阅') },
		{ opt: 'mode', kind: 'list', icon: 'tune', label: _('运行模式'), list: [ ['rule', '规则 (Rule)'], ['global', '全局 (Global)'], ['direct', '直连 (Direct)'] ] },
		{ opt: 'log_level', kind: 'list', icon: 'doc', label: _('日志级别'), list: [ ['silent'], ['error'], ['warning'], ['info'], ['debug'] ] },
		{ opt: 'ipv6', kind: 'flag', icon: 'globe', label: _('IPv6') }
	] },
	{ section: 'config', title: _('网络与端口'), opts: [
		{ opt: 'mixed_port', kind: 'value', icon: 'port', label: _('Mixed 端口 (HTTP+SOCKS)') },
		{ opt: 'tproxy_port', kind: 'value', icon: 'port', label: _('TPROXY 端口') },
		{ opt: 'redir_port', kind: 'value', icon: 'port', label: _('REDIR 端口 (0=关)') },
		{ opt: 'socks_port', kind: 'value', icon: 'port', label: _('SOCKS 端口 (0=关)') },
		{ opt: 'port', kind: 'value', icon: 'port', label: _('HTTP 端口 (0=关)') },
		{ opt: 'allow_lan', kind: 'flag', icon: 'lan', label: _('允许局域网') },
		{ opt: 'transparent_mode', kind: 'list', icon: 'shield', label: _('透明代理'), sub: _('TUN 内核自管路由；TPROXY/REDIR 走 nftables'), list: [ ['tun', 'TUN (推荐)'], ['tproxy', 'TPROXY (TCP+UDP)'], ['redir', 'REDIR (仅 TCP)'], ['off', '关闭'] ] },
		{ opt: 'hijack_dnsmasq', kind: 'flag', icon: 'shield', label: _('dnsmasq 转发内核 DNS'), sub: _('LAN 客户端 DNS 经 dnsmasq 进入分流') }
	] },
	{ section: 'config', title: _('控制面板'), opts: [
		{ opt: 'external_controller', kind: 'value', icon: 'term', label: _('控制 API 监听'), ph: '127.0.0.1:9097' },
		{ opt: 'secret', kind: 'value', icon: 'lock', label: _('控制 API 密钥'), pass: true },
		{ opt: 'external_ui', kind: 'flag', icon: 'cloud', label: _('内置面板 (zashboard)'), sub: _('在「资源」页安装') },
		{ opt: 'test_url', kind: 'value', icon: 'gauge', label: _('测延迟 URL'), ph: 'https://www.gstatic.com/generate_204' }
	] },
	{ section: 'tun', title: _('TUN 虚拟网卡'), opts: [
		{ opt: 'stack', kind: 'list', icon: 'tunnel', label: 'TUN 栈', sub: _('上游默认 mips'), list: [ ['mips'], ['mixed'], ['gvisor'], ['system'] ] },
		{ opt: 'device', kind: 'value', icon: 'tunnel', label: _('设备名'), ph: 'bettbox' },
		{ opt: 'auto_route', kind: 'flag', icon: 'map', label: 'auto-route' },
		{ opt: 'auto_redirect', kind: 'flag', icon: 'map', label: 'auto-redirect' },
		{ opt: 'strict_route', kind: 'flag', icon: 'shield', label: 'strict-route' },
		{ opt: 'mtu', kind: 'value', icon: 'tune', label: 'MTU', ph: '9000' },
		{ opt: 'dns_hijack', kind: 'value', icon: 'server', label: 'dns-hijack', ph: 'any:53' }
	] },
	{ section: 'dns', title: _('DNS'), opts: [
		{ opt: 'override', kind: 'flag', icon: 'shield', label: _('覆写 DNS'), sub: _('关闭则使用订阅/脚本自带 DNS') },
		{ opt: 'listen', kind: 'value', icon: 'server', label: _('监听地址'), ph: '0.0.0.0:1053' },
		{ opt: 'enhanced_mode', kind: 'list', icon: 'tune', label: _('增强模式'), list: [ ['fake-ip'], ['redir-host'] ] },
		{ opt: 'fake_ip_range', kind: 'value', icon: 'globe', label: 'fake-ip-range', ph: '198.18.0.1/16' },
		{ opt: 'respect_rules', kind: 'flag', icon: 'map', label: 'respect-rules', sub: _('DNS 连接跟随规则') },
		{ opt: 'ipv6', kind: 'flag', icon: 'globe', label: _('IPv6 解析') },
		{ opt: 'nameserver', kind: 'list-multi', icon: 'server', label: 'nameserver', wide: true },
		{ opt: 'default_nameserver', kind: 'list-multi', icon: 'server', label: 'default-nameserver', wide: true },
		{ opt: 'fallback', kind: 'list-multi', icon: 'server', label: 'fallback', wide: true },
		{ opt: 'proxy_server_nameserver', kind: 'list-multi', icon: 'server', label: 'proxy-server-nameserver', sub: _('解析节点域名专用（国内可达）'), wide: true }
	] },
	{ section: 'quic', title: _('QUIC'), opts: [
		{ opt: 'block', kind: 'flag', icon: 'bolt', label: _('禁用 QUIC'), sub: _('注入 UDP:443 REJECT 前置规则') },
		{ opt: 'exclude_china', kind: 'flag', icon: 'globe', label: _('国内站点不拦截') }
	] },
	{ section: 'sniffer', title: _('嗅探 Sniffer'), opts: [
		{ opt: 'enabled', kind: 'flag', icon: 'eye', label: _('启用流量嗅探') },
		{ opt: 'override_destination', kind: 'flag', icon: 'eye', label: 'override-destination', sub: _('用嗅探结果覆盖目标地址') }
	] },
	{ section: 'config', title: _('Geo 资源'), opts: [
		{ opt: 'geo_auto_update', kind: 'flag', icon: 'map', label: _('自动更新 Geo') },
		{ opt: 'geo_update_interval', kind: 'value', icon: 'clock', label: _('更新间隔 (小时)') },
		{ opt: 'geodata_mode', kind: 'flag', icon: 'map', label: 'geodata-mode', sub: _('用 dat 而非 mmdb') },
		{ opt: 'geox_mmdb', kind: 'value', icon: 'globe', label: 'geox-url · mmdb', ph: 'https://…/country.mmdb', wide: true },
		{ opt: 'geox_geosite', kind: 'value', icon: 'globe', label: 'geox-url · geosite', ph: 'https://…/geosite.dat', wide: true },
		{ opt: 'geox_asn', kind: 'value', icon: 'globe', label: 'geox-url · asn', ph: 'https://…/GeoLite2-ASN.mmdb', wide: true }
	] },
	{ section: 'config', title: _('守护'), opts: [
		{ opt: 'watchdog', kind: 'flag', icon: 'pulse', label: _('看门狗'), sub: _('健康检查失败自动重启内核') },
		{ opt: 'watchdog_interval', kind: 'value', icon: 'clock', label: _('检查间隔 (秒)') },
		{ opt: 'age_identity', kind: 'value', icon: 'key', label: _('age 身份密钥 (全局)'), sub: _('加密订阅解密密钥'), pass: true, ph: 'AGE-SECRET-KEY-…', wide: true }
	] },
	{ section: 'backup', title: _('备份 WebDAV'), opts: [
		{ opt: 'url', kind: 'value', icon: 'cloud', label: _('WebDAV 地址'), ph: 'https://dav.example.com/dav/bettbox/', wide: true },
		{ opt: 'username', kind: 'value', icon: 'key', label: _('用户名') },
		{ opt: 'password', kind: 'value', icon: 'lock', label: _('密码'), pass: true },
		{ opt: 'filename', kind: 'value', icon: 'doc', label: _('远程文件名'), ph: 'bettbox-backup.tar' }
	] },
	{ section: 'experimental', title: _('实验选项'), opts: [
		{ opt: 'quic_gso', kind: 'flag', icon: 'bolt', label: 'quic-go-disable-gso' },
		{ opt: 'quic_ecn', kind: 'flag', icon: 'bolt', label: 'quic-go-disable-ecn' }
	] }
];

function fieldFor(cfg,o,profiles){
	var value=cfg[o.opt],control;
	if(o.kind==='flag'){control=E('button',{type:'button','class':'switch'+(value==='1'?'':' off'),role:'switch','aria-checked':String(value==='1'),'aria-label':o.label});control.checked=value==='1';control.addEventListener('click',function(){control.checked=!control.checked;control.classList.toggle('off',!control.checked);control.setAttribute('aria-checked',String(control.checked));control.dispatchEvent(new Event('change',{bubbles:true}));});return control;}
	if(o.opt==='profile'){control=E('select',{'class':'field','aria-label':o.label},profiles.map(function(p){return E('option',{value:p.id},p.label||p.id);}));if(value&&!profiles.some(function(p){return p.id===value;}))control.appendChild(E('option',{value:value},value));control.value=value||'';return control;}
	if(o.kind==='list'){control=E('select',{'class':'field','aria-label':o.label},(o.list||[]).map(function(item){return E('option',{value:item[0]},item[1]||item[0]);}));control.value=value||o.list[0][0];return control;}
	if(o.kind==='list-multi'){control=E('textarea',{'class':'field',rows:3,'aria-label':o.label});control.value=Array.isArray(value)?value.join('\n'):value||'';return control;}
	var numeric=/(?:port$|interval$|mtu$)/.test(o.opt);control=E('input',{'class':'field',type:o.pass?'password':numeric?'number':'text','aria-label':o.label});control.value=value==null?'':value;if(o.ph)control.placeholder=o.ph;if(numeric)control.min='0';return control;
}
function readField(control,o){if(o.kind==='flag')return control.checked?'1':'0';if(o.kind==='list-multi')return control.value.split('\n').map(function(s){return s.trim();}).filter(Boolean);return control.value;}
function category(sec){if(sec.section==='tun')return 'tun';if(sec.section==='dns')return 'dns';if(sec.section==='backup')return 'backup';if(sec.opts.some(function(o){return o.opt==='mixed_port';}))return 'network';if(sec.opts.some(function(o){return o.opt==='enabled'||o.opt==='watchdog';}))return 'general';return 'other';}
return view.extend({
	load:function(){return Promise.all([uci.load('bettbox'),callProfiles()]);},
	render:function(data){var profiles=data[1]&&data[1].profiles||[],inputs=[],selected='general',content=E('div',{'class':'settings-content'}),sections=[],categories=[['general','常规','settings'],['network','网络','lan'],['tun','TUN','route'],['dns','DNS','globe'],['backup','备份','layers'],['other','其他','grid']];
		var state=E('strong',{},'当前配置');
		function changed(){var count=inputs.filter(function(it){return JSON.stringify(readField(it.control,it.option))!==it.original;}).length;state.textContent=count?'有 '+count+' 项修改':'当前配置';}
		SCHEMA.forEach(function(sec){var cfg=uci.get('bettbox',sec.section)||{},form=E('div',{'class':'settings-form'});sec.opts.forEach(function(o){var control=fieldFor(cfg,o,profiles),original=JSON.stringify(readField(control,o));inputs.push({section:sec.section,option:o,control:control,original:original});control.addEventListener('change',changed);control.addEventListener('input',changed);form.appendChild(E('div',{'class':'setting-row'+(o.kind==='flag'?' flag':'')},[E('div',{},[E('label',{'class':'setting-label'},o.opt==='profile'?'当前订阅':o.label)]),E('div',{'class':'setting-control'},control)]));});var panel=E('section',{'class':'panel settings-panel'},[E('div',{'class':'panel-head'},E('div',{},[E('h2',{},[UI.icon(category(sec)==='general'?'settings':category(sec)==='network'?'lan':category(sec)==='tun'?'route':category(sec)==='dns'?'globe':'grid'),document.createTextNode(sec.title)]) ])),form]);var cat=category(sec);panel.hidden=cat!==selected;sections.push({panel:panel,category:cat});content.appendChild(panel);});
		var nav=E('aside',{'class':'panel settings-categories','aria-label':'设置类别'},categories.map(function(c){var b=E('button',{type:'button','class':'category-button'+(selected===c[0]?' active':''),'aria-pressed':String(selected===c[0])},[UI.icon(c[2]),E('span',{},c[1])]);b.addEventListener('click',function(){selected=c[0];Array.from(nav.children).forEach(function(x){x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});sections.forEach(function(s){s.panel.hidden=s.category!==selected;});});return b;}));
		function save(){inputs.forEach(function(it){var value=readField(it.control,it.option);if(it.control.type==='number'&&value!==''&&!it.control.checkValidity())throw new Error('请检查 '+it.option.label);if(/port$/.test(it.option.opt)&&value!==''&&(+value<0||+value>65535))throw new Error('端口需要在 0–65535 之间');if(JSON.stringify(value)!==it.original)uci.set('bettbox',it.section,it.option.opt,value);});inputs.forEach(function(it){it.control.disabled=true;});state.textContent='正在保存并应用…';return uci.save().then(function(){return commit('bettbox');}).then(callApply).then(UI.operation).then(function(){inputs.forEach(function(it){it.original=JSON.stringify(readField(it.control,it.option));});state.textContent='设置已保存并应用';}).catch(function(err){state.textContent='应用失败';throw new Error('配置可能已保存：'+err.message);}).finally(function(){inputs.forEach(function(it){it.control.disabled=false;});});}
		var bar=E('div',{'class':'save-bar'},[E('div',{},[state]),E('div',{'class':'button-row'},[UI.button('撤销',function(){window.location.reload();}),UI.button('保存并应用',save,'primary','save')])]);
		return UI.page('settings','设置',[],[E('div',{'class':'settings-layout'},[nav,content]),bar]);
	},handleSaveApply:null,handleSave:null,handleReset:null
});
