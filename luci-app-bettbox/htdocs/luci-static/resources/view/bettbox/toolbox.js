'use strict';
'require view';
'require rpc';
'require ui';

var callTool = rpc.declare({ object: 'bettbox', method: 'toolbox_call', params: [ 'tool', 'args_json' ] });

/* LuCI 25.12 removed ui.createHandlerBtn; shim it on top of createHandlerFn. */
if (!ui.createHandlerBtn)
	ui.createHandlerBtn = function(label, fn) {
		return E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, fn) }, label);
	};

function out(el) {
	return function (res) {
		el.textContent = res && res.text ? res.text : (res && res.error ? '错误: ' + res.error : '（无输出）');
	};
}

/* Tool set mirrors upstream Bettbox lib/views/toolbox.dart (official zh labels):
   网速测试 / 路由追踪 / IP 全能查 / MRS 速查 / DNS 查询 / NAT 检测 /
   本地 Ping / iPerf3 工具 / Age 加解密 / 连通性测试 */

return view.extend({
	render: function () {
		var self = this;

		/* ---------- 网速测试 ---------- */
		var speedOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- 路由追踪 (rule-match) ---------- */
		var traceHost = E('input', { 'class': 'cbi-input-text', value: 'www.youtube.com', style: 'width:16em' });
		var traceOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- IP 全能查 ---------- */
		var ipAddr = E('input', { 'class': 'cbi-input-text', style: 'width:14em', placeholder: _('留空查询本机') });
		var ipOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- MRS 速查 ---------- */
		var mrsDomain = E('input', { 'class': 'cbi-input-text', value: 'www.baidu.com', style: 'width:16em' });
		var mrsOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- DNS 查询 ---------- */
		var dnsName = E('input', { 'class': 'cbi-input-text', value: 'www.baidu.com', style: 'width:16em' });
		var dnsType = E('select', { 'class': 'cbi-input-select' }, ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map(function (t) { return E('option', { value: t }, t); }));
		var dnsMode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'follow' }, '跟随内核 (分流路由)'),
			E('option', { value: 'system' }, '系统 DNS'),
			E('option', { value: 'custom' }, '自定义上游')
		]);
		var dnsServer = E('input', { 'class': 'cbi-input-text', value: '223.5.5.5', style: 'width:10em' });
		var dnsOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- NAT 检测 ---------- */
		var natOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- 本地 Ping ---------- */
		var pingHost = E('input', { 'class': 'cbi-input-text', value: '223.5.5.5', style: 'width:14em' });
		var pingCount = E('input', { 'class': 'cbi-input-text', type: 'number', value: '4', style: 'width:5em' });
		var pingPort = E('input', { 'class': 'cbi-input-text', type: 'number', value: '0', style: 'width:6em' });
		var pingOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- iPerf3 工具 ---------- */
		var iperfHost = E('input', { 'class': 'cbi-input-text', style: 'width:14em', placeholder: 'iperf3 服务器地址' });
		var iperfSecs = E('input', { 'class': 'cbi-input-text', type: 'number', value: '10', style: 'width:5em' });
		var iperfOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- Age 加解密 ---------- */
		var ageMode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'encrypt' }, '加密 (需要接收方公钥 age1…)'),
			E('option', { value: 'decrypt' }, '解密 (需要身份密钥 AGE-SECRET-KEY-…)')
		]);
		var ageKey = E('input', { 'class': 'cbi-input-text', style: 'width:100%; font-family:monospace', placeholder: 'age1… / AGE-SECRET-KEY-…' });
		var ageData = E('textarea', { 'class': 'cbi-input-textarea', rows: 4, style: 'width:100%; font-family:monospace', placeholder: _('输入要加密/解密的文本') });
		var ageOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		/* ---------- 连通性测试 ---------- */
		var mediaOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '—');

		function tab(title, body) {
			return E('div', { 'class': 'cbi-section' }, [ E('h3', {}, title) ].concat(body));
		}

		var container = E([
			E('div', { 'class': 'cbi-map' }, [
				tab(_('网速测试 (Cloudflare)'), [
					ui.createHandlerBtn(_('开始测速'), function () {
						speedOut.textContent = '…';
						return callTool('speedtest', '[]').then(out(speedOut));
					}),
					speedOut
				]),
				tab(_('路由追踪'), [
					E('div', {}, [ traceHost, ' ',
						ui.createHandlerBtn(_('追踪'), function () {
							traceOut.textContent = '…';
							return callTool('trace', JSON.stringify([traceHost.value.trim()])).then(out(traceOut));
						}) ]),
					traceOut
				]),
				tab(_('IP 全能查'), [
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
				tab(_('MRS 速查'), [
					E('div', {}, [ mrsDomain, ' ',
						ui.createHandlerBtn(_('查询'), function () {
							mrsOut.textContent = '…';
							return callTool('mrs', JSON.stringify([mrsDomain.value.trim()])).then(out(mrsOut));
						}) ]),
					mrsOut
				]),
				tab(_('DNS 查询'), [
					E('div', {}, [ dnsName, ' ', dnsType, ' ', dnsMode, ' ', dnsServer, ' ',
						ui.createHandlerBtn(_('查询'), function () {
							dnsOut.textContent = '…';
							return callTool('dns', JSON.stringify([dnsName.value.trim(), dnsType.value, dnsMode.value, dnsServer.value.trim()])).then(out(dnsOut));
						}) ]),
					dnsOut
				]),
				tab(_('NAT 检测'), [
					ui.createHandlerBtn(_('开始检测'), function () {
						natOut.textContent = '…';
						return callTool('nat', '[]').then(out(natOut));
					}),
					natOut
				]),
				tab(_('本地 Ping'), [
					E('div', {}, [ pingHost, ' ', _('次数'), ' ', pingCount, ' ', _('TCP端口(0=ICMP)'), ' ', pingPort, ' ',
						ui.createHandlerBtn(_('Ping'), function () {
							pingOut.textContent = '…';
							return callTool('ping', JSON.stringify([pingHost.value.trim(), pingCount.value, '1', pingPort.value])).then(out(pingOut));
						}) ]),
					pingOut
				]),
				tab(_('iPerf3 工具'), [
					E('div', {}, [ iperfHost, ' ', _('时长(秒)'), ' ', iperfSecs, ' ',
						ui.createHandlerBtn(_('开始'), function () {
							iperfOut.textContent = '…';
							return callTool('iperf', JSON.stringify([iperfHost.value.trim(), iperfSecs.value])).then(out(iperfOut));
						}) ]),
					iperfOut
				]),
				tab(_('Age 加解密'), [
					ageMode, ' ',
					E('div', { style: 'margin:.3em 0' }, ageKey),
					ageData, ' ',
					ui.createHandlerBtn(_('执行'), function () {
						ageOut.textContent = '…';
						return callTool('age', JSON.stringify([ageMode.value, ageKey.value.trim(), ageData.value])).then(out(ageOut));
					}),
					ageOut
				]),
				tab(_('连通性测试'), [
					ui.createHandlerBtn(_('检测'), function () {
						mediaOut.textContent = '…';
						return callTool('media', '[]').then(out(mediaOut));
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
