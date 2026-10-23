'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callTool = rpc.declare({ object: 'bettbox', method: 'toolbox_call', params: [ 'tool', 'args_json' ] });

function out(el) {
	return function (res) {
		el.textContent = res && res.text ? res.text : (res && res.error ? '错误: ' + res.error : '（无输出）');
	};
}

return view.extend({
	render: function () {
		var self = this;

		/* ---------- DNS 查询 ---------- */
		var dnsName = E('input', { 'class': 'cbi-input-text', value: 'www.google.com', style: 'width:16em' });
		var dnsType = E('select', { 'class': 'cbi-input-select' }, ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map(function (t) { return E('option', { value: t }, t); }));
		var dnsMode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'follow' }, '跟随内核 (分流路由)'),
			E('option', { value: 'system' }, '系统 DNS'),
			E('option', { value: 'custom' }, '自定义上游')
		]);
		var dnsServer = E('input', { 'class': 'cbi-input-text', value: '8.8.8.8', style: 'width:10em' });
		var dnsOut = E('pre', { style: 'min-height:6em; font-size:.85em' }, '—');

		/* ---------- IP 查询 ---------- */
		var ipAddr = E('input', { 'class': 'cbi-input-text', style: 'width:14em', placeholder: _('留空查询本机') });
		var ipOut = E('pre', { style: 'min-height:6em; font-size:.85em' }, '—');

		/* ---------- Ping ---------- */
		var pingHost = E('input', { 'class': 'cbi-input-text', value: '1.1.1.1', style: 'width:14em' });
		var pingCount = E('input', { 'class': 'cbi-input-text', type: 'number', value: '4', style: 'width:5em' });
		var pingPort = E('input', { 'class': 'cbi-input-text', type: 'number', value: '0', style: 'width:6em' });
		var pingOut = E('pre', { style: 'min-height:6em; font-size:.85em' }, '—');

		/* ---------- 测速 ---------- */
		var speedOut = E('pre', { style: 'min-height:4em; font-size:.85em' }, '—');

		/* ---------- 流媒体 ---------- */
		var mediaOut = E('pre', { style: 'min-height:6em; font-size:.85em' }, '—');

		function tab(title, body) {
			return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, title), body ]);
		}

		var container = E([
			E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('工具箱')),
				tab(_('DNS 查询'), [
					E('div', {}, [ dnsName, ' ', dnsType, ' ', dnsMode, ' ', dnsServer, ' ',
						ui.createHandlerBtn(_('查询'), function () {
							dnsOut.textContent = '…';
							return callTool('dns', JSON.stringify([dnsName.value.trim(), dnsType.value, dnsMode.value, dnsServer.value.trim()])).then(out(dnsOut));
						}) ]),
					dnsOut
				]),
				tab(_('IP 查询'), [
					E('div', {}, [ ipAddr, ' ',
						ui.createHandlerBtn(_('直连查询'), function () {
							ipOut.textContent = '…';
							return callTool('ip', JSON.stringify(['direct', ipAddr.value.trim()])).then(out(ipOut));
						}), ' ',
						ui.createHandlerBtn(_('经代理查询'), function () {
							ipOut.textContent = '…';
							return callTool('ip', JSON.stringify(['proxy', ipAddr.value.trim()])).then(out(ipOut));
						}) ]),
					ipOut
				]),
				tab(_('本地 Ping'), [
					E('div', {}, [ pingHost, ' ', _('次数'), ' ', pingCount, ' ', _('TCP端口(0=ICMP)'), ' ', pingPort, ' ',
						ui.createHandlerBtn(_('Ping'), function () {
							pingOut.textContent = '…';
							return callTool('ping', JSON.stringify([pingHost.value.trim(), pingCount.value, '1', pingPort.value])).then(out(pingOut));
						}) ]),
					pingOut
				]),
				tab(_('测速 (Cloudflare，走 mixed 端口)'), [
					ui.createHandlerBtn(_('开始测速'), function () {
						speedOut.textContent = '…';
						return callTool('speedtest', JSON.stringify([])).then(out(speedOut));
					}),
					speedOut
				]),
				tab(_('流媒体解锁'), [
					ui.createHandlerBtn(_('检测'), function () {
						mediaOut.textContent = '…';
						return callTool('media', JSON.stringify([])).then(out(mediaOut));
					}),
					mediaOut
				])
			])
		]);

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
