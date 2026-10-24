'use strict';
'require view';
'require rpc';
'require poll';
'require uci';
'require ui';
'require bettbox.core as Core';

/* LuCI 25.12 removed ui.createHandlerBtn; shim it on top of createHandlerFn. */
if (!ui.createHandlerBtn)
	ui.createHandlerBtn = function(label, fn) {
		return E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, fn) }, label);
	};

var callStatus = rpc.declare({ object: 'bettbox', method: 'get_status' });
var callService = rpc.declare({ object: 'bettbox', method: 'service_action', params: [ 'action' ] });
var callApply = rpc.declare({ object: 'bettbox', method: 'apply' });

function fmtSpeed(bps) {
	if (bps == null) return '-';
	var u = [ 'B/s', 'KB/s', 'MB/s', 'GB/s' ], i = 0;
	while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
	return bps.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtBytes(n) {
	if (n == null) return '-';
	var u = [ 'B', 'KB', 'MB', 'GB', 'TB' ], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return n.toFixed(i ? 2 : 0) + ' ' + u[i];
}

function sparkline(samples, color) {
	if (!samples || samples.length < 2) return null;
	var w = 200, h = 34, max = Math.max.apply(null, samples) || 1;
	var pts = samples.map(function (v, i) {
		return (i * w / (samples.length - 1)).toFixed(1) + ',' + (h - v / max * h).toFixed(1);
	}).join(' ');
	return E('svg', { width: w, height: h, style: 'vertical-align:middle' }, [
		E('polyline', { points: pts, fill: 'none', stroke: color || 'var(--primary, #2f7fd6)', 'stroke-width': '1.5' })
	]);
}

/* card grid styles (Bettbox home look, drawn with LuCI theme variables) */
var CARD_CSS = `
.bb-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:1em; margin-top:1em; }
.bb-card { background:var(--background-color-high,#fff); border:1px solid var(--border-color,#ddd); border-radius:12px; padding:1em 1.1em; box-shadow:0 1px 3px rgba(0,0,0,.06); }
.bb-card h3 { display:flex; align-items:center; gap:.45em; margin:0 0 .6em; font-size:.95em; color:var(--main-color,#404040); }
.bb-card .bb-big { font-size:1.55em; font-weight:700; line-height:1.25; font-variant-numeric:tabular-nums; }
.bb-card .bb-sub { font-size:.8em; color:var(--sub-color,#888); }
.bb-row { display:flex; justify-content:space-between; align-items:center; margin:.35em 0; }
.bb-tools { display:grid; grid-template-columns:repeat(3,1fr); gap:.6em; }
.bb-tool { display:flex; flex-direction:column; align-items:center; gap:.3em; padding:.7em .2em; border-radius:10px; background:var(--background-color-low,#f5f5f5); color:inherit; text-decoration:none; text-align:center; font-size:.78em; border:1px solid transparent; }
.bb-tool:hover { border-color:var(--primary,#2f7fd6); }
.bb-tool .bb-ico { font-size:1.5em; }
.bb-chev { transition:transform .15s; display:inline-block; }
.bb-group-collapsed .bb-chev { transform:rotate(-90deg); }
.bb-group-collapsed .bb-group-body { display:none; }
/* 滑动开关（与设置页同款尺寸） */
.bb-switch { position:relative; display:inline-block; width:44px; height:25px; flex:none; }
.bb-switch input { opacity:0; width:0; height:0; position:absolute; }
.bb-switch .bb-slider { position:absolute; inset:0; background:#b0b3b8; border-radius:25px; transition:background .2s; cursor:pointer; }
.bb-switch .bb-slider::before { content:''; position:absolute; width:19px; height:19px; left:3px; top:3px; background:#fff; border-radius:50%; transition:transform .2s; box-shadow:0 1px 3px rgba(0,0,0,.35); }
.bb-switch input:checked + .bb-slider { background:var(--primary,#2f7fd6); }
.bb-switch input:checked + .bb-slider::before { transform:translateX(19px); }
.bb-switch input:disabled + .bb-slider { opacity:.55; cursor:wait; }
.bb-main-row { display:flex; align-items:center; gap:.8em; padding:.2em 0 .6em; }
.bb-main-row .bb-main-label { font-size:1.05em; font-weight:600; }
`;

var TOOL_LINKS = [
	[ '🚀', '网速测试', 'toolbox' ],
	[ '🧭', '路由追踪', 'toolbox' ],
	[ '🌍', 'IP 全能查', 'toolbox' ],
	[ '🔍', 'MRS 速查', 'toolbox' ],
	[ '📘', 'DNS 查询', 'toolbox' ],
	[ '🛰️', 'NAT 检测', 'toolbox' ],
	[ '📶', '本地 Ping', 'toolbox' ],
	[ '📐', 'iPerf3', 'toolbox' ],
	[ '🔐', 'Age 加解密', 'toolbox' ],
	[ '🎬', '连通性测试', 'toolbox' ],
	[ '📝', 'JS 脚本', 'scripts' ],
	[ '📡', '订阅', 'profiles' ]
];

return view.extend({
	upHist: [], downHist: [],

	load: function () {
		return Promise.all([ callStatus(), uci.load('bettbox') ]);
	},

	render: function (data) {
		var self = this;
		var st = data[0] || {};

		var style = E('style', {}, CARD_CSS);

		var enabledCb = E('input', { type: 'checkbox' });
		enabledCb.checked = (uci.get('bettbox', 'config', 'enabled') == '1');
		enabledCb.addEventListener('change', function () {
			var on = enabledCb.checked;
			enabledCb.disabled = true;
			ui.showModal(on ? _('正在启动服务…') : _('正在停止服务…'), E('p', {}, _('请稍候')));
			uci.set('bettbox', 'config', 'enabled', on ? '1' : '0');
			uci.save().then(function () {
				return rpc.declare({ object: 'uci', method: 'commit', params: ['config'] })('bettbox');
			}).then(function () {
				return callService(on ? 'start' : 'stop');
			}).then(function () {
				return new Promise(function (res) { window.setTimeout(res, 2500); });
			}).then(function () { ui.hideModal(); window.location.reload(); })
			.catch(function () { ui.hideModal(); window.location.reload(); });
		});

		var statusChip = E('span', { 'class': 'label ' + (st.running ? 'label-success' : 'label-important'), id: 'bb-state' },
			st.running ? _('运行中') : _('已停止'));

		var modeSel = E('select', { 'class': 'cbi-input-select', style: 'min-width:7em' }, [
			E('option', { value: 'rule' }, '规则'),
			E('option', { value: 'global' }, '全局'),
			E('option', { value: 'direct' }, '直连')
		]);
		modeSel.value = st.mode || 'rule';
		modeSel.addEventListener('change', function () {
			var m = modeSel.value;
			Promise.all([
				Core.put('/configs', { mode: m }),
				uci.set('bettbox', 'config', 'mode', m), uci.save()
			]);
		});

		var speedUp = E('span', { 'class': 'bb-big' }, '-');
		var speedDown = E('span', { 'class': 'bb-big' }, '-');
		var chartUp = E('div', { id: 'bb-chart-up' });
		var chartDown = E('div', { id: 'bb-chart-down' });

		var connBig = E('div', { 'class': 'bb-big' }, '-');
		var memBig = E('div', { 'class': 'bb-big' }, '-');
		var totalBig = E('div', { 'class': 'bb-big' }, '-');
		var exitBig = E('div', { 'class': 'bb-big', style: 'font-size:1.05em' }, '—');

		function refreshStatus() {
			callStatus().then(function (s) {
				statusChip.textContent = s.running ? _('运行中') : _('已停止');
				statusChip.className = 'label ' + (s.running ? 'label-success' : 'label-important');
				modeSel.value = s.mode || 'rule';
			}).catch(function () { });
		}

		Core.stream('/traffic', function (t) {
			if (t == null) return;
			speedUp.textContent = fmtSpeed(t.up);
			speedDown.textContent = fmtSpeed(t.down);
			self.upHist.push(t.up || 0); if (self.upHist.length > 40) self.upHist.shift();
			self.downHist.push(t.down || 0); if (self.downHist.length > 40) self.downHist.shift();
			var cu = document.getElementById('bb-chart-up'), cd = document.getElementById('bb-chart-down');
			if (cu) { cu.innerHTML = ''; var s1 = sparkline(self.upHist); if (s1) cu.appendChild(s1); }
			if (cd) { cd.innerHTML = ''; var s2 = sparkline(self.downHist, '#2e9e5b'); if (s2) cd.appendChild(s2); }
		});
		Core.stream('/memory', function (m) {
			if (m != null) memBig.textContent = fmtBytes(m.inuse);
		});

		var lastDl = null, lastUl = null;
		function pollConn() {
			Core.get('/connections').then(function (res) {
				var c = res && res.data;
				if (!c) return;
				var dl = c.downloadTotal || 0, ul = c.uploadTotal || 0;
				connBig.textContent = String(c.connections ? c.connections.length : 0);
				totalBig.textContent = fmtBytes(dl) + ' ↓ / ' + fmtBytes(ul) + ' ↑';
				lastDl = dl; lastUl = ul;
			}).catch(function () { });
		}
		poll.add(pollConn, 2);
		pollConn();
		if (!poll.running) poll.start();

		/* current exit node (默认代理 group chain), icon from the profile YAML */
		Core.get('/proxies').then(function (res) {
			var ps = res && res.data && res.data.proxies;
			if (!ps) return;
			var g = ps['默认代理'] || ps['PROXY'] || ps['Proxy'];
			if (g && g.now) {
				var cur = g.now, hops = [cur], seen = {};
				while (ps[cur] && ps[cur].now && !seen[cur] && hops.length < 5) {
					seen[cur] = true;
					cur = ps[cur].now;
					hops.push(cur);
				}
				exitBig.textContent = '';
				if (g.icon)
					exitBig.appendChild(E('img', { src: g.icon, width: 22, height: 22, style: 'vertical-align:-4px; object-fit:contain; margin-right:.3em', onerror: 'this.style.display="none"' }));
				exitBig.appendChild(document.createTextNode(hops.join(' → ')));
				exitBig.title = hops.join(' → ');
			}
		}).catch(function () { });

		var applyBtn = ui.createHandlerBtn(_('应用配置'), function () {
			return ui.showModal(_('正在渲染并热更新配置…'), E('p', {}, _('请稍候'))),
				callApply().then(function (res) {
					ui.hideModal();
					ui.addNotification(null, E('p', {}, (res && res.ok) ? _('配置已应用') : _('应用失败：') + (res ? res.text : '')),
						(res && res.ok) ? 'info' : 'error');
					refreshStatus();
				});
		});
		var dashBtn = st.external_ui ?
			E('a', { 'class': 'btn', href: 'http://' + (window.location.hostname || '') + ':' + (st.controller || '127.0.0.1:9097').split(':')[1] + '/ui/', target: '_blank', rel: 'noopener' }, _('控制面板')) : null;

		var toolsGrid = E('div', { 'class': 'bb-tools' });
		TOOL_LINKS.forEach(function (t) {
			toolsGrid.appendChild(E('a', { 'class': 'bb-tool', href: L.url('admin', 'services', 'bettbox', t[2]) }, [
				E('span', { 'class': 'bb-ico' }, t[0]),
				E('span', {}, t[1])
			]));
		});

		var body = E([
			style,
			E('div', { 'class': 'cbi-map' }, [
				E('div', { 'class': 'bb-grid' }, [
					E('div', { 'class': 'bb-card' }, [
						E('h3', {}, [ '⚡ ', _('启动') ]),
						E('div', { 'class': 'bb-main-row' }, [
							E('span', { 'class': 'bb-main-label' }, _('启动服务')),
							statusChip,
							E('label', { 'class': 'bb-switch', style: 'margin-left:auto' }, [ enabledCb, E('span', { 'class': 'bb-slider' }) ])
						]),
						E('div', { 'class': 'bb-row' }, [ _('运行模式'), modeSel ]),
						E('div', { 'class': 'bb-sub', style: 'margin-top:.5em' },
							_('透明代理：') + (st.transparent_mode || 'tun') + ' · mihomo')
					]),
					E('div', { 'class': 'bb-card' }, [
						E('h3', {}, [ '🚀 ', _('网速 (实时)') ]),
						E('div', { 'class': 'bb-row' }, [ E('span', {}, _('↑ 上行')), speedUp ]),
						chartUp,
						E('div', { 'class': 'bb-row' }, [ E('span', {}, _('↓ 下行')), speedDown ]),
						chartDown
					]),
					E('div', { 'class': 'bb-card' }, [
						E('h3', {}, [ '🔀 ', _('当前出口') ]),
						exitBig,
						E('div', { 'class': 'bb-sub', style: 'margin-top:.4em' }, ' ')
					]),
					E('div', { 'class': 'bb-card' }, [
						E('h3', {}, [ '🔌 ', _('活动连接') ]),
						connBig,
						E('div', { 'class': 'bb-sub' }, _('实时会话数'))
					]),
					E('div', { 'class': 'bb-card' }, [
						E('h3', {}, [ '🧠 ', _('内核内存') ]),
						memBig,
						E('div', { 'class': 'bb-sub' }, _('mihomo 进程占用'))
					]),
					E('div', { 'class': 'bb-card' }, [
						E('h3', {}, [ '📊 ', _('本次累计流量') ]),
						totalBig,
						E('div', { 'class': 'bb-sub' }, _('内核启动以来的代理流量'))
					])
				]),
				E('div', { 'class': 'bb-card', style: 'margin-top:1em' }, [
					E('h3', {}, [ '🧰 ', _('工具') ]),
					toolsGrid
				]),
				E('div', { 'class': 'cbi-page-actions' }, [ applyBtn ].concat(dashBtn ? [ dashBtn ] : []))
			])
		]);

		return body;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
