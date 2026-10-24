'use strict';
'require view';
'require rpc';
'require uci';
'require ui';

var callApply = rpc.declare({ object: 'bettbox', method: 'apply' });

/* LuCI 25.12 removed ui.createHandlerBtn; shim it on top of createHandlerFn. */
if (!ui.createHandlerBtn)
	ui.createHandlerBtn = function(label, fn) {
		return E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, fn) }, label);
	};

/* 行内矢量图标（Material 风格、描边跟随主题色） */
var ICONS = {
	power: '<path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
	tune: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
	list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
	doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h6M9 16h6"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
	port: '<rect x="4" y="8" width="16" height="9" rx="1.5"/><path d="M8 17v3M12 17v3M16 17v3M8 11h.01M12 11h.01M16 11h.01"/>',
	lan: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/>',
	shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
	server: '<rect x="4" y="4" width="16" height="6" rx="1"/><rect x="4" y="14" width="16" height="6" rx="1"/><path d="M8 7h.01M8 17h.01"/>',
	tunnel: '<path d="M3 20v-6a9 9 0 0 1 18 0v6"/><path d="M8 20v-6a4 4 0 0 1 8 0v6"/>',
	bolt: '<path d="M13 2L5 13h6l-2 9 8-11h-6z"/>',
	eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
	map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
	pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
	key: '<circle cx="8" cy="15" r="4"/><path d="M11 12L20 3M16 7l3 3"/>',
	cloud: '<path d="M7 18a4.5 4.5 0 1 1 .8-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-1 7z"/>',
	gauge: '<path d="M4 17a9 9 0 0 1 16 0"/><path d="M12 17l4.5-6"/><circle cx="12" cy="17" r="1.4"/>',
	term: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
	lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
};

function ico(name) {
	var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	s.setAttribute('viewBox', '0 0 24 24');
	s.setAttribute('width', '21'); s.setAttribute('height', '21');
	s.setAttribute('fill', 'none');
	s.setAttribute('stroke', 'currentColor');
	s.setAttribute('stroke-width', '1.7');
	s.setAttribute('stroke-linecap', 'round');
	s.setAttribute('stroke-linejoin', 'round');
	s.innerHTML = ICONS[name] || ICONS.list;
	var w = document.createElement('span');
	w.className = 'set-ico';
	w.appendChild(s);
	return w;
}

var PAGE_CSS = `
.set-sec { background:var(--background-color-high,#fff); border:1px solid var(--border-color,#ddd); border-radius:12px; margin-bottom:1em; box-shadow:0 1px 3px rgba(0,0,0,.05); }
.set-sec > h3 { margin:0; padding:.8em 1em .3em; font-size:.92em; color:var(--sub-color,#777); font-weight:600; }
.set-row { display:flex; align-items:center; gap:.75em; padding:.6em 1em; border-top:1px solid var(--border-color-low,#eee); }
.set-row:first-of-type { border-top:none; }
.set-main { flex:1; min-width:0; }
.set-title { font-size:.95em; }
.set-sub { font-size:.75em; color:var(--sub-color,#999); }
.set-ico { color:var(--primary,#2f7fd6); display:inline-flex; flex:none; }
.set-ctl { flex:none; display:flex; align-items:center; gap:.4em; }
.set-ctl .cbi-input-text { width:11em; }
.set-ctl-wide { flex-direction:column; align-items:stretch; width:100%; }
.set-ctl-wide .cbi-input-text, .set-ctl-wide textarea { width:100%; }
.bb-switch { position:relative; display:inline-block; width:56px; height:32px; flex:none; }
.bb-switch input { opacity:0; width:0; height:0; position:absolute; }
.bb-switch .bb-slider { position:absolute; inset:0; background:#b0b3b8; border-radius:32px; transition:background .2s; cursor:pointer; }
.bb-switch .bb-slider::before { content:''; position:absolute; width:26px; height:26px; left:3px; top:3px; background:#fff; border-radius:50%; transition:transform .2s; box-shadow:0 1px 4px rgba(0,0,0,.35); }
.bb-switch input:checked + .bb-slider { background:var(--primary,#2f7fd6); }
.bb-switch input:checked + .bb-slider::before { transform:translateX(24px); }
`;

/* 层级与上游 config/ 页对齐：常规/网络端口/控制面板/TUN/DNS/QUIC/嗅探/NTP/Geo/守护/Age/WebDAV/实验 */
var SCHEMA = [
	{ section: 'config', title: _('常规'), opts: [
		{ opt: 'enabled', kind: 'flag', icon: 'power', label: _('启动服务') },
		{ opt: 'profile', kind: 'value', icon: 'list', label: _('当前订阅 (sid)') },
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
		{ opt: 'stack', kind: 'list', icon: 'tunnel', label: 'TUN 栈', list: [ ['mixed'], ['gvisor'], ['system'] ] },
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
	{ section: 'ntp', title: _('NTP'), opts: [
		{ opt: 'enabled', kind: 'flag', icon: 'clock', label: _('启用 NTP 校时') },
		{ opt: 'server', kind: 'value', icon: 'clock', label: _('服务器'), ph: 'time.apple.com' },
		{ opt: 'port', kind: 'value', icon: 'port', label: _('端口'), ph: '123' },
		{ opt: 'interval', kind: 'value', icon: 'clock', label: _('间隔 (分钟)') }
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

function fieldFor(cfg, o) {
	var val = cfg[o.opt];
	if (o.kind === 'flag') {
		var cb = E('input', { type: 'checkbox' });
		cb.checked = (val == '1');
		var sw = E('label', { 'class': 'bb-switch' }, [ cb, E('span', { 'class': 'bb-slider' }) ]);
		return { el: sw, input: cb };
	}
	if (o.kind === 'list') {
		var sel = E('select', { 'class': 'cbi-input-select' });
		(o.list || []).forEach(function (item) {
			sel.appendChild(E('option', { value: item[0] }, item[1] || item[0]));
		});
		sel.value = val || (o.list && o.list[0] && o.list[0][0]);
		return { el: sel, input: sel };
	}
	if (o.kind === 'list-multi') {
		var ta = E('textarea', { 'class': 'cbi-input-textarea', rows: 3, style: 'font-family:monospace' });
		ta.value = Array.isArray(val) ? val.join('\n') : (val || '');
		return { el: ta, input: ta };
	}
	var inp = E('input', { 'class': 'cbi-input-text' });
	if (o.ph) inp.placeholder = o.ph;
	if (o.pass) inp.type = 'password';
	inp.value = (val == null) ? '' : val;
	return { el: inp, input: inp };
}

function readField(el, o) {
	if (o.kind === 'flag')
		return el.checked ? '1' : '0';
	if (o.kind === 'list-multi')
		return el.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
	return el.value;
}

return view.extend({
	load: function () {
		return uci.load('bettbox');
	},

	render: function () {
		var self = this;
		var inputs = [];

		var saveBtn = E('button', { 'class': 'btn cbi-button-important', style: 'padding:.5em 1.6em' }, _('保存并应用'));
		saveBtn.addEventListener('click', function () {
			ui.showModal(_('正在保存…'), E('p', {}, _('请稍候')));
			try {
				inputs.forEach(function (it) {
					var v = readField(it.input, it);
					if (Array.isArray(v))
						uci.set('bettbox', it.sec, it.opt, v.length ? v : []);
					else
						uci.set('bettbox', it.sec, it.opt, v);
				});
			} catch (e) {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('保存失败：') + String(e.message || e)), 'error');
				return;
			}
			uci.save().then(function () {
				return rpc.declare({ object: 'uci', method: 'commit', params: ['config'] })('bettbox');
			}).then(function () {
				if (uci.get('bettbox', 'config', 'enabled') == '1')
					return callApply();
			}).then(function () {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('配置已保存并应用')), 'info');
			}).catch(function (e) {
				ui.hideModal();
				ui.addNotification(null, E('p', {}, _('应用失败：') + String(e && e.message ? e.message : e)), 'error');
			});
		});

		var sections = SCHEMA.map(function (sec) {
			var cfg = uci.get('bettbox', sec.section) || {};
			var rows = sec.opts.map(function (o) {
				var f = fieldFor(cfg, o);
				inputs.push({ sec: sec.section, opt: o.opt, kind: o.kind, input: f.input });
				var main = E('div', { 'class': 'set-main' }, [
					E('div', { 'class': 'set-title' }, o.label)
				].concat(o.sub ? [ E('div', { 'class': 'set-sub' }, o.sub) ] : []));
				var ctl = E('div', { 'class': 'set-ctl' + (o.wide ? ' set-ctl-wide' : '') }, [ f.el ]);
				return E('div', { 'class': 'set-row' }, [ ico(o.icon || 'list'), main, ctl ]);
			});
			return E('div', { 'class': 'set-sec' }, [ E('h3', {}, sec.title) ].concat(rows));
		});

		return E([
			E('style', {}, PAGE_CSS),
			E('div', { 'class': 'cbi-map' }, sections.concat([
				E('div', { 'class': 'cbi-page-actions' }, [ saveBtn ])
			]))
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
