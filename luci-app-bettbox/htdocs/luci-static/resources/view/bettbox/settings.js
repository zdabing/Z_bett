'use strict';
'require view';
'require rpc';
'require uci';
'require bettbox.ui as UI';
'require bettbox.device-picker as DevicePicker';
'require bettbox.resources-panel as ResourcesPanel';
var callApply=rpc.declare({object:'bettbox',method:'apply'}),commit=rpc.declare({object:'uci',method:'commit',params:['config']});
var callProxyGroups=rpc.declare({object:'bettbox',method:'api_proxy',params:['method','path','body']});
var SCHEMA = [
	{ category: 'general', section: 'config', icon: 'settings', title: _('基础与守护'), opts: [
		{ opt: 'log_level', kind: 'list', label: _('日志级别'), list: [ ['silent'], ['error'], ['warning'], ['info'], ['debug'] ] },
		{ opt: 'watchdog_interval', kind: 'value', label: _('看门狗间隔 (秒)') },
		{ opt: 'health_interval', kind: 'value', label: _('网络检测间隔 (秒)'), ph: '300；0 关闭定期检测' },
		{ opt: 'traffic_retention', kind: 'list', label: _('流量记录保留'), list: [ ['7', _('7 天')], ['14', _('14 天')], ['30', _('30 天')] ], ph: '7' },
		{ opt: 'ipv6', kind: 'flag', label: _('IPv6') },
		{ opt: 'watchdog', kind: 'flag', label: _('看门狗'), sub: _('健康检查失败自动重启内核') },
		{ opt: 'traffic_history', kind: 'flag', label: _('记录历史流量') }
	] },
	{ category: 'network', section: 'config', icon: 'shield', title: _('透明代理与端口'), opts: [
		{ opt: 'transparent_mode', kind: 'list', label: _('透明代理'), sub: _('TUN 内核自管路由；TPROXY/REDIR 走 nftables'), list: [ ['tun', 'TUN (推荐)'], ['tproxy', 'TPROXY (TCP+UDP)'], ['redir', 'REDIR (仅 TCP)'], ['off', '关闭'] ] },
		{ opt: 'mixed_port', kind: 'value', label: _('Mixed 端口'), sub: _('HTTP + SOCKS 混合端口') },
		{ opt: 'tproxy_port', kind: 'value', label: _('TPROXY 端口') },
		{ opt: 'redir_port', kind: 'value', label: _('REDIR 端口 (0=关)') },
		{ opt: 'allow_lan', kind: 'flag', label: _('允许局域网') },
		{ opt: 'hijack_dnsmasq', kind: 'flag', label: _('dnsmasq 转发内核 DNS'), sub: _('LAN 客户端 DNS 经 dnsmasq 进入分流') }
	] },
	{ category: 'network', section: 'dns', icon: 'globe', title: _('DNS 与分流增强'), opts: [
		{ opt: 'listen', section: 'dns', kind: 'value', label: _('DNS 监听地址'), ph: '0.0.0.0:1053' },
		{ opt: 'block', section: 'quic', kind: 'flag', label: _('禁用 QUIC'), sub: _('非托管订阅下注入 UDP:443 REJECT 前置规则') },
		{ opt: 'enabled', section: 'sniffer', kind: 'flag', label: _('启用流量嗅探') },
		{ opt: 'override_destination', section: 'sniffer', kind: 'flag', label: 'override-destination', sub: _('用嗅探结果覆盖目标地址') },
		{ opt: 'real_ip_domains', section: 'dns', kind: 'list-multi', label: _('真实 IP 域名（每行一个）'), ph: 'nas.example.com\n+.example.com', wide: true }
	] },
	{ category: 'network', section: 'tun', icon: 'route', tunOnly: true, title: _('TUN 虚拟网卡'), opts: [
		{ opt: 'stack', kind: 'list', label: 'TUN 栈', sub: _('上游默认 mips'), list: [ ['mips'], ['mixed'], ['gvisor'], ['system'] ] },
		{ opt: 'device', kind: 'value', label: _('设备名'), ph: 'bettbox' },
		{ opt: 'mtu', kind: 'value', label: 'MTU', ph: '9000' },
		{ opt: 'dns_hijack', kind: 'value', label: 'dns-hijack', ph: 'any:53' },
		{ opt: 'auto_route', kind: 'flag', label: 'auto-route' },
		{ opt: 'auto_redirect', kind: 'flag', label: 'auto-redirect' },
		{ opt: 'strict_route', kind: 'flag', label: 'strict-route' },
		{ opt: 'endpoint_independent_nat', kind: 'flag', label: 'endpoint-independent-nat', sub: _('改善 UDP / 游戏联机 NAT 类型') }
	] },
	{ category: 'network', section: 'config', icon: 'grid', fold: true, title: _('高级与接口参数'), opts: [
		{ opt: 'external_controller', kind: 'value', label: _('控制 API 监听'), ph: '127.0.0.1:9097' },
		{ opt: 'secret', kind: 'value', label: _('控制 API 密钥'), pass: true },
		{ opt: 'test_url', kind: 'value', label: _('测延迟 URL'), ph: 'https://www.gstatic.com/generate_204' },
		{ opt: 'geo_update_interval', kind: 'value', label: _('Geo 更新间隔 (小时)') },
		{ opt: 'external_ui', kind: 'flag', label: _('内置面板 (zashboard)'), sub: _('在「设置 → 资源与维护」中安装') },
		{ opt: 'geo_auto_update', kind: 'flag', label: _('自动更新 Geo'), sub: _('直连 GitHub 较慢或小内存路由建议关闭，改在「设置 → 资源与维护」手动更新') },
		{ opt: 'quic_gso', section: 'experimental', kind: 'flag', label: 'quic-go-disable-gso' },
		{ opt: 'quic_ecn', section: 'experimental', kind: 'flag', label: 'quic-go-disable-ecn' },
		{ opt: 'geox_mmdb', kind: 'value', label: 'geox-url · mmdb', ph: 'https://…/geoip.metadb', wide: true },
		{ opt: 'geox_geosite', kind: 'value', label: 'geox-url · geosite', ph: 'https://…/geosite.dat', wide: true },
		{ opt: 'geox_asn', kind: 'value', label: 'geox-url · asn', ph: 'https://…/GeoLite2-ASN.mmdb', wide: true }
	] },
	{ category: 'devices', section: 'config', icon: 'lan', title: _('设备 MAC 控制'), opts: [
		{ opt: 'device_mode', kind: 'list', label: _('设备控制模式'), list: [ ['off',_('关闭')], ['include',_('白名单')], ['exclude',_('黑名单')] ] },
		{ opt: 'device_macs', kind: 'list-multi', label: _('设备名单') }
	] }
];

function fieldFor(cfg,o){
	var value=cfg[o.opt],control;
	if(o.opt==='device_macs')return DevicePicker.create(value,validateMacs,true,cfg.device_ips||[]);
	if(o.kind==='flag'){control=E('button',{type:'button','class':'switch'+(value==='1'?'':' off'),role:'switch','aria-checked':String(value==='1'),'aria-label':o.label});control.checked=value==='1';control.addEventListener('click',function(){control.checked=!control.checked;control.classList.toggle('off',!control.checked);control.setAttribute('aria-checked',String(control.checked));control.dispatchEvent(new Event('change',{bubbles:true}));});return control;}
	if(o.kind==='list'){control=E('select',{'class':'field','aria-label':o.label},(o.list||[]).map(function(item){return E('option',{value:item[0]},item[1]||item[0]);}));control.value=value||o.list[0][0];return control;}
	if(o.kind==='list-multi'){control=E('textarea',{'class':'field',rows:2,'aria-label':o.label,autocomplete:'off'});control.value=Array.isArray(value)?value.join('\n'):value||'';if(o.ph)control.placeholder=o.ph;return control;}
	var numeric=/(?:port$|interval$|mtu$)/.test(o.opt);control=E('input',{'class':'field',type:o.pass?'password':numeric?'number':'text','aria-label':o.label,autocomplete:o.pass?'new-password':'off'});control.value=value==null?'':value;if(o.ph)control.placeholder=o.ph;if(numeric)control.min='0';return control;
}
function readField(control,o){if(o.kind==='flag')return control.checked?'1':'0';if(o.kind==='list-multi')return control.value.split('\n').map(function(s){return s.trim();}).filter(Boolean);return control.value;}
function watchField(control,o,changed){
	if(!control.matches('input, textarea')){
		control.addEventListener('change',changed);
		control.addEventListener('input',changed);
		return function(){return readField(control,o);};
	}

	// Keep a separate draft because browser autofill can write to the DOM
	// even when autocomplete is disabled or the field is on another tab.
	var draft=control.value;
	function autofilled(){return control.matches(':is(:autofill, :-webkit-autofill)');}
	function restore(){
		if(control.value===draft&&autofilled())control.value='';
		if(control.value!==draft)control.value=draft;
	}
	control.addEventListener('focus',restore);
	control.addEventListener('beforeinput',restore);
	control.addEventListener('input',function(event){
		if(!event.isTrusted||document.activeElement!==control||autofilled()){
			restore();
			return;
		}
		draft=control.value;
		changed();
	});
	return function(){restore();return readField(control,o);};
}
function validateMacs(values){
	if(values.length>256)throw new Error('设备 MAC 列表最多 256 项');
	values.forEach(function(text){
		if(!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(text))throw new Error('设备 MAC 地址无效：'+text);
	});
}
function validateDevices(values){
	if(values.length>256)throw new Error('设备 IP 列表最多 256 项');
	values.forEach(function(text){
		var parts=text.split('/'),address=parts[0],ipv6=address.indexOf(':')>=0,valid=parts.length<=2;
		if(ipv6){try{if(!/^[0-9a-f:.]+$/i.test(address))throw new Error();new URL('http://['+address+']/');}catch(e){valid=false;}}
		else valid=valid&&/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address)&&address.split('.').every(function(n){return +n<=255;});
		if(parts.length===2)valid=valid&&/^(0|[1-9]\d{0,2})$/.test(parts[1])&&+parts[1]<=(ipv6?128:32);
		if(!valid)throw new Error('设备 IP 或网段无效：'+text);
	});
}
return view.extend({
	load:function(){return Promise.all([uci.load('bettbox'),callProxyGroups('GET','/proxies','').catch(function(){return null;})]);},
	render:function(data){var inputs=[],selected='general',content=E('div',{'class':'settings-content','role':'region','aria-label':'常规设置'}),sections=[],categories=[['general','常规','settings'],['network','网络与代理','lan'],['devices','设备控制','lan'],['resources','资源与维护','layers']],tunPanel=null;
		if(!document.getElementById('bettbox-settings-css'))document.head.appendChild(E('link',{id:'bettbox-settings-css',rel:'stylesheet',href:L.resource('bettbox/settings.css')+'?v=20261125-8'}));
		var rawCat=new URLSearchParams(window.location.search).get('category'),openFold=rawCat==='other';
		var requested=(rawCat==='tun'||rawCat==='dns'||rawCat==='other')?'network':rawCat;
		if(categories.some(function(c){return c[0]===requested;}))selected=requested;
		content.setAttribute('aria-label',categories.find(function(c){return c[0]===selected;})[1]+'设置');
		var state=E('strong',{},'当前配置');
		var modeHelp=E('p',{'class':'device-setting-help',id:'bettbox-device-mode-help'});
		var tunRoutingHelp=E('p',{'class':'device-setting-help settings-form-help',id:'bettbox-tun-routing-help'},
			_('设备控制已接管 TUN 路由，auto-route、auto-redirect 和 strict-route 已锁定。要编辑这些开关，请在「设备控制」中将模式设为「关闭」。'));
		var modeDescriptions={
			off:_('全部设备进入分流。'),
			include:_('仅名单中的设备进入分流。'),
			exclude:_('名单中的设备直连，其余设备进入分流。')
		};
		function syncDeviceControls(){
			var mode=inputs.find(function(it){return it.option.opt==='device_mode';}),transport=inputs.find(function(it){return it.option.opt==='transparent_mode';});
			if(!mode||!transport)return;
			var tmode=transport.control.value;
			if(tunPanel)tunPanel.hidden=selected!=='network'||tmode!=='tun';
			inputs.forEach(function(it){
				if(it.rowEl&&(it.option.opt==='tproxy_port'||it.option.opt==='redir_port'))
					it.rowEl.hidden=it.option.opt==='tproxy_port'?tmode!=='tproxy':tmode!=='redir';
			});
			modeHelp.textContent=modeDescriptions[mode.control.value]||'';
			var devicesEnabled=mode.control.value!=='off'&&tmode!=='off';
			var tunManaged=devicesEnabled&&tmode==='tun';
			tunRoutingHelp.hidden=!tunManaged;
			inputs.forEach(function(it){
				var dnsManagedOption=it.option.opt==='hijack_dnsmasq';
				var tunManagedOption=it.section==='tun'&&['auto_route','auto_redirect','strict_route'].indexOf(it.option.opt)>=0;
				if(!dnsManagedOption&&!tunManagedOption)return;
				var locked=dnsManagedOption?devicesEnabled:tunManaged;
				it.control.disabled=locked;
				it.control.classList.toggle('is-managed',locked);
				if(dnsManagedOption)it.control.title=locked?_('设备控制启用时，由插件按名单接管 DNS 和路由'):'';
				else if(locked)it.control.setAttribute('aria-describedby',tunRoutingHelp.id);
				else it.control.removeAttribute('aria-describedby');
			});
		}
		var fallbackRows=[],savedFallbacks=[],fallbackError='';
		try {
			savedFallbacks=JSON.parse(uci.get('bettbox','config','device_fallbacks')||'[]');
			if(!Array.isArray(savedFallbacks)||savedFallbacks.length>64||savedFallbacks.some(function(row){
				return !row||!Array.isArray(row.addresses)||row.addresses.some(function(ip){return typeof ip!=='string';})||typeof row.target!=='string';
			}))throw new Error();
		}
		catch(e){savedFallbacks=[];fallbackError='已保存的设备兜底配置格式无效，请重新设置。';}
		var originalFallbacks=fallbackError?'invalid':JSON.stringify(savedFallbacks);
		function fallbackValues(){return fallbackRows.map(function(row){return {addresses:row.picker.value.split('\n').filter(Boolean),target:row.target.value};});}
		function changed(){var count=inputs.filter(function(it){return JSON.stringify(it.read())!==it.original;}).length;
			if(JSON.stringify(fallbackValues())!==originalFallbacks)count++;
			state.textContent=count?'有 '+count+' 项修改':'当前配置';syncDeviceControls();}
		var devicePicker;
		SCHEMA.forEach(function(sec,index){
			var cat=sec.category,headingId='bettbox-settings-section-'+index;
			var form=E('div',{'class':cat==='devices'?'device-settings-form':'settings-form'});
			if(sec.tunOnly)form.appendChild(tunRoutingHelp);
			sec.opts.forEach(function(o){
				var secName=o.section||sec.section,cfg=uci.get('bettbox',secName)||{};
				var control=fieldFor(cfg,o),read=watchField(control,o,changed),id='bettbox-setting-'+secName+'-'+o.opt;
				control.id=id;
				if(control.input)control.input.id=id+'-input';
				var label=E('label',{'class':'setting-label',for:control.input?id+'-input':id},o.label);
				var field=E('div',{'class':'setting-control'},control);
				if(cat==='devices'){
					inputs.push({section:secName,option:o,control:control,read:read,original:JSON.stringify(read())});
					var children=[label,field];
					if(o.opt==='device_mode'){
						control.setAttribute('aria-describedby',modeHelp.id);
						children.push(modeHelp);
					} else {
						devicePicker=control;
						var helpId=id+'-help';
						control.input.setAttribute('aria-describedby',helpId);
						children.push(E('p',{'class':'device-setting-help',id:helpId},_('按名称或 IP 选择设备，保存时按 MAC 匹配。')));
						inputs.push({section:secName,option:{opt:'device_ips',kind:'list-multi'},control:control,
							read:control.legacyAddresses,original:JSON.stringify(control.legacyAddresses())});
					}
					form.appendChild(E('div',{'class':'device-setting'},children));
					return;
				}
				var rowEl=E('div',{'class':'setting-row'+(o.kind==='flag'?' flag':'')+(o.wide?' wide':'')+(o.kind==='list-multi'?' multiline':'')},[label,field]);
				inputs.push({section:secName,option:o,control:control,read:read,original:JSON.stringify(read()),rowEl:rowEl});
				form.appendChild(rowEl);
			});
			var heading=E('h2',{id:headingId},[UI.badge(sec.icon||'settings','bb-section-icon'),document.createTextNode(sec.title)]);
			var panel=sec.fold
				? E('details',{'class':'panel settings-panel settings-fold',open:openFold,'aria-labelledby':headingId},[
					E('summary',{'class':'panel-head'},[heading,E('span',{'class':'settings-fold-hint'},[E('span',{},_('展开 / 收起')),UI.icon('chevron')])]),
					form
				])
				: E('section',{'class':'panel settings-panel'+(cat==='devices'?' device-settings':''),'aria-labelledby':headingId},[
					E('div',{'class':'panel-head'},heading),form
				]);
			if(sec.tunOnly)tunPanel=panel;
			panel.hidden=cat!==selected;sections.push({panel:panel,category:cat});content.appendChild(panel);
		});
		var fallbackList=E('div',{'class':'device-fallback-list'});
		var groupData=data[1]&&data[1].data&&data[1].data.proxies||{};
		var groupNames=Object.keys(groupData).filter(function(name){return name!=='GLOBAL'&&Array.isArray(groupData[name].all);}).sort();
		function addFallback(value){
			var picker=DevicePicker.create(value.addresses||[],validateDevices);
			picker.setAttribute('aria-label','兜底策略设备');
			var target=E('select',{'class':'field','aria-label':'未命中规则时的出口'});
			var choices=[['inherit','跟随全局'],['DIRECT','直连'],['REJECT','拒绝连接']].concat(groupNames.map(function(name){return [name,name];}));
			if(value.target&&!choices.some(function(item){return item[0]===value.target;}))choices.push([value.target,value.target+'（已保存）']);
			choices.forEach(function(item){target.appendChild(E('option',{value:item[0]},item[1]));});
			target.value=value.target||'inherit';
			var row={picker:picker,target:target};
			var remove=UI.button('移除',function(){fallbackRows=fallbackRows.filter(function(item){return item!==row;});element.remove();changed();},'small','close');
			var element=E('div',{'class':'device-fallback-row'},[
				E('div',{},[E('div',{'class':'input-label'},'设备 IP / 网段'),picker]),
				E('label',{},[E('span',{'class':'input-label'},'未命中规则时'),target]),remove
			]);
			picker.addEventListener('change',changed);target.addEventListener('change',changed);
			fallbackRows.push(row);fallbackList.appendChild(element);
		}
		savedFallbacks.forEach(addFallback);
		var fallbackControls=E('fieldset',{'class':'device-fallback-controls'},[
			E('p',{'class':'setting-help'},'先匹配订阅中的业务规则，再使用设备兜底；未单独设置的设备跟随全局。仅对进入规则分流的设备生效，订阅更新后保留。'),
			fallbackList,UI.button('添加设备策略',function(){if(fallbackRows.length>=64)throw new Error('设备兜底策略最多 64 项');addFallback({});changed();},'small','plus')
		]);
		if(fallbackError)fallbackControls.prepend(E('p',{'class':'bb-update-note'},fallbackError));
		var fallbackPanel=UI.panel('设备兜底策略','route',[fallbackControls]);
		fallbackPanel.classList.add('settings-panel','device-fallback-panel');fallbackPanel.hidden=selected!=='devices';
		sections.push({panel:fallbackPanel,category:'devices'});content.appendChild(fallbackPanel);
		var appearancePanel=UI.panel('外观风格','palette',[UI.appearanceControls(false)]);
		appearancePanel.classList.add('settings-panel','bb-appearance-panel');appearancePanel.hidden=selected!=='general';
		var generalIndex=sections.findIndex(function(s){return s.category==='general';});
		if(generalIndex>=0){
			sections.splice(generalIndex+1,0,{panel:appearancePanel,category:'general'});
			sections[generalIndex].panel.after(appearancePanel);
		}else{
			sections.push({panel:appearancePanel,category:'general'});content.appendChild(appearancePanel);
		}
		var resourcesPanel=ResourcesPanel.create();
		resourcesPanel.element.hidden=selected!=='resources';
		sections.push({panel:resourcesPanel.element,category:'resources'});content.appendChild(resourcesPanel.element);
		if(selected==='devices')devicePicker.loadDevices();
		if(selected==='resources')resourcesPanel.activate();
		syncDeviceControls();
		var nav=E('nav',{'class':'settings-categories','aria-label':'设置类别'},categories.map(function(c){
			var b=E('button',{type:'button','class':'category-button'+(selected===c[0]?' active':''),'aria-pressed':String(selected===c[0])},[UI.badge(c[2],'bb-nav-icon'),E('span',{},c[1])]);
			b.addEventListener('click',function(){
				selected=c[0];Array.from(nav.children).forEach(function(x){x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});
				sections.forEach(function(s){s.panel.hidden=s.category!==selected;});content.setAttribute('aria-label',c[1]+'设置');
				bar.hidden=selected==='resources';
				if(selected==='devices')devicePicker.loadDevices();
				if(selected==='resources')resourcesPanel.activate();
				syncDeviceControls();
				inputs.forEach(function(it){it.read();});
				var url=new URL(window.location.href);url.searchParams.set('category',selected);window.history.replaceState({},'',url.href);
			});return b;
		}));
		function save(){
			var saved=false;
			devicePicker.validate();
			fallbackRows.forEach(function(row){row.picker.validate();if(!row.picker.value)throw new Error('请为兜底策略选择设备或输入 IP / 网段');});
			var fallbacks=fallbackValues();
			validateDevices([].concat.apply([],fallbacks.map(function(row){return row.addresses;})));
			var fallbackChanged=JSON.stringify(fallbacks)!==originalFallbacks;
			var values=inputs.map(function(it){
				var value=it.read();
				if(it.control.type==='number'&&!it.control.validity.valid)throw new Error('请检查 '+it.option.label);
				if(/port$/.test(it.option.opt)&&value!==''&&(+value<0||+value>65535))throw new Error('端口需要在 0–65535 之间');
				return value;
			});
			inputs.forEach(function(it,index){
				var value=values[index];
				if(JSON.stringify(value)===it.original)return;
				if(it.option.kind==='list-multi'&&value.length===0)uci.unset('bettbox',it.section,it.option.opt);
				else uci.set('bettbox',it.section,it.option.opt,value);
			});
			if(fallbackChanged){
				if(fallbacks.length)uci.set('bettbox','config','device_fallbacks',JSON.stringify(fallbacks));
				else uci.unset('bettbox','config','device_fallbacks');
			}
			fallbackControls.disabled=true;
			inputs.forEach(function(it){it.control.disabled=true;});state.textContent='正在保存并应用…';
			return uci.save().then(function(){return commit('bettbox');}).then(function(){saved=true;return callApply();}).then(UI.operation).then(function(){
				originalFallbacks=JSON.stringify(fallbacks);
				inputs.forEach(function(it){it.original=JSON.stringify(it.read());});state.textContent='设置已保存并应用';
			}).catch(function(err){
				state.textContent=saved?'应用失败':'保存失败';
				throw new Error((saved?'配置已保存，但应用失败：':'配置保存未完成：')+err.message);
			}).finally(function(){fallbackControls.disabled=false;inputs.forEach(function(it){it.control.disabled=false;});syncDeviceControls();});
		}
		var bar=E('div',{'class':'save-bar settings-save-bar'},[E('div',{'role':'status','aria-live':'polite'},[state]),E('div',{'class':'button-row'},[UI.button('撤销',function(){window.location.reload();}),UI.button('保存并应用',save,'primary','save')])]);
		bar.hidden=selected==='resources';
		var root=UI.page('settings','设置',[],[E('div',{'class':'settings-layout'},[nav,content]),bar]);root.classList.add('bb-settings');return root;
	},handleSaveApply:null,handleSave:null,handleReset:null
});
