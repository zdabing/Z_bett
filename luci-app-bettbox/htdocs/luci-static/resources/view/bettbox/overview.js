'use strict';
'require view';
'require rpc';
'require poll';
'require uci';
'require ui';

var callStatus = rpc.declare({ object: 'bettbox', method: 'get_status' });
var callApi = rpc.declare({ object: 'bettbox', method: 'api_proxy', params: [ 'method', 'path', 'body' ] });
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

function sparkline(samples) {
	if (!samples || samples.length < 2) return null;
	var w = 220, h = 36, max = Math.max.apply(null, samples) || 1;
	var pts = samples.map(function (v, i) {
		return (i * w / (samples.length - 1)).toFixed(1) + ',' + (h - v / max * h).toFixed(1);
	}).join(' ');
	return E('svg', { width: w, height: h, style: 'vertical-align:middle' }, [
		E('polyline', { points: pts, fill: 'none', stroke: 'var(--primary, #2f7fd6)', 'stroke-width': '1.5' })
	]);
}

return view.extend({
	upHist: [], downHist: [], totalUp: 0, totalDown: 0,

	load: function () {
		return Promise.all([ callStatus(), uci.load('bettbox') ]);
	},

	render: function (data) {
		var self = this;
		var st = data[0] || {};

		var statusChip = E('span', { 'class': 'label', id: 'bb-state' }, '-');
		var speedUp = E('span', { id: 'bb-up', 'class': 'monospace' }, '-');
		var speedDown = E('span', { id: 'bb-down', 'class': 'monospace' }, '-');
		var chartUp = E('span', { id: 'bb-chart-up' });
		var chartDown = E('span', { id: 'bb-chart-down' });
		var connCount = E('span', { id: 'bb-conn', 'class': 'monospace' }, '-');
		var memInfo = E('span', { id: 'bb-mem', 'class': 'monospace' }, '-');
		var totalInfo = E('span', { id: 'bb-total', 'class': 'monospace' }, '-');
		var modeSel = E('select', { id: 'bb-mode', 'class': 'cbi-input-select', style: 'min-width:8em' }, [
			E('option', { value: 'rule' }, '规则'),
			E('option', { value: 'global' }, '全局'),
			E('option', { value: 'direct' }, '直连')
		]);

		modeSel.value = st.mode || 'rule';
		modeSel.addEventListener('change', function () {
			var m = modeSel.value;
			Promise.all([
				callApi('PUT', '/configs', JSON.stringify({ mode: m })),
				uci.set('bettbox', 'config', 'mode', m), uci.save()
			]);
		});

		var startBtn = ui.createHandlerBtn(_('启动'), function () { return callService('start').then(function () { window.setTimeout(pollStatus, 500); }); });
		var stopBtn = ui.createHandlerBtn(_('停止'), function () { return callService('stop').then(function () { window.setTimeout(pollStatus, 500); }); });
		var applyBtn = ui.createHandlerBtn(_('应用配置'), function () {
			return ui.showModal(_('正在渲染并热更新配置…'), E('p', {}, _('请稍候'))),
				callApply().then(function (res) {
					ui.hideModal();
					if (!res || res.ok !== true)
						ui.addNotification(null, E('p', {}, _('应用失败：') + (res ? res.text : '')), 'error');
					else
						ui.addNotification(null, E('p', {}, _('配置已应用')), 'info');
					window.setTimeout(pollStatus, 800);
				});
		});
		var dashBtn = st.external_ui ?
			E('a', { 'class': 'btn', href: 'http://' + (window.location.hostname || '') + ':' + (st.controller || '127.0.0.1:9097').split(':')[1] + '/ui/', target: '_blank', rel: 'noopener' }, _('控制面板')) : null;

		function pollStatus() {
			callStatus().then(function (s) {
				statusChip.textContent = s.running ? _('运行中') : _('已停止');
				statusChip.className = 'label ' + (s.running ? 'label-success' : 'label-important');
				modeSel.value = s.mode || 'rule';
			});
			Promise.all([
				callApi('GET', '/traffic', null),
				callApi('GET', '/connections', null),
				callApi('GET', '/memory', null)
			]).then(function (r) {
				var t = r[0] && r[0].data;
				if (t) {
					speedUp.textContent = fmtSpeed(t.up);
					speedDown.textContent = fmtSpeed(t.down);
					self.totalUp = Math.max(self.totalUp, 0) + (t.up || 0);
					self.totalDown += (t.down || 0);
					totalInfo.textContent = _('本页累计 ↓%s ↑%s').format(fmtBytes(self.totalDown), fmtBytes(self.totalUp));
					self.upHist.push(t.up || 0); if (self.upHist.length > 40) self.upHist.shift();
					self.downHist.push(t.down || 0); if (self.downHist.length > 40) self.downHist.shift();
					var cu = document.getElementById('bb-chart-up'), cd = document.getElementById('bb-chart-down');
					if (cu) { cu.innerHTML = ''; var s1 = sparkline(self.upHist); if (s1) cu.appendChild(s1); }
					if (cd) { cd.innerHTML = ''; var s2 = sparkline(self.downHist); if (s2) cd.appendChild(s2); }
				}
				var c = r[1] && r[1].data;
				if (c) connCount.textContent = (c.connections ? c.connections.length : 0) + ' (' + fmtBytes(c.downloadTotal || 0) + ' ↓ / ' + fmtBytes(c.uploadTotal || 0) + ' ↑)';
				var m = r[2] && r[2].data;
				if (m) memInfo.textContent = fmtBytes(m.inuse) + ' / ' + fmtBytes(m.oslimit || 0);
			});
		}

		var body = E([
			E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('Bettbox — 网络工具箱')),
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-section-descr' },
						_('内核：mihomo · 运行状态：'), statusChip,
						E('span', { style: 'margin-left:1em' }, _('模式：')), modeSel),
					E('table', { 'class': 'table' }, [
						E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td left', width: '33%' }, [ _('↑ 上行'), E('div', {}, [speedUp, chartUp]) ]),
							E('td', { 'class': 'td left', width: '33%' }, [ _('↓ 下行'), E('div', {}, [speedDown, chartDown]) ]),
							E('td', { 'class': 'td left' }, [ _('连接 / 总流量'), E('div', {}, connCount) ])
						]),
						E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td left' }, [ _('内存占用'), E('div', {}, memInfo) ]),
							E('td', { 'class': 'td left' }, [ _('会话流量'), E('div', {}, totalInfo) ]),
							E('td', { 'class': 'td left' }, [ _('透明代理模式：'), (st.transparent_mode || 'tun') ])
						])
					])
				])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [ startBtn, stopBtn, applyBtn, dashBtn ])
		]);

		poll.add(pollStatus, 2);
		return body;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
