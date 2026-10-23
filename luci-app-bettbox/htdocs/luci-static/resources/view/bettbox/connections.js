'use strict';
'require view';
'require rpc';
'require poll';

var callApi = rpc.declare({ object: 'bettbox', method: 'api_proxy', params: [ 'method', 'path', 'body' ] });

function fmtBytes(n) {
	if (n == null) return '-';
	var u = [ 'B', 'KB', 'MB', 'GB', 'TB' ], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return n.toFixed(i ? 2 : 0) + ' ' + u[i];
}

return view.extend({
	render: function () {
		var self = this;
		var sortMode = 'traffic';
		var table = E('table', { 'class': 'table' });
		var info = E('p', { 'class': 'monospace' });

		function row(c) {
			var meta = c.metadata || {};
			var speed = ((c.download - (c._d || 0)) + (c.upload - (c._u || 0))) / 2;
			c._d = c.download; c._u = c.upload;
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, [ meta.host || meta.destinationIP || '-', E('br', {}), E('small', {}, (meta.network || '') + ' ' + (meta.destinationPort || '')) ]),
				E('td', { 'class': 'td left' }, [ (c.chains || []).join(' / '), E('br', {}), E('small', {}, c.rule || '') ]),
				E('td', { 'class': 'td left monospace' }, fmtBytes(c.upload) + ' ↑ / ' + fmtBytes(c.download) + ' ↓'),
				E('td', { 'class': 'td left monospace' }, fmtBytes(speed) + '/s'),
				E('td', { 'class': 'td left' }, [
					E('button', {
						'class': 'btn cbi-button-remove',
						click: function () {
							callApi('DELETE', '/connections/' + encodeURIComponent(c.id), null).then(self.refresh);
						}
					}, '✕')
				])
			]);
		}

		self.refresh = function () {
			callApi('GET', '/connections', null).then(function (res) {
				if (!res || !res.data) return;
				var conns = res.data.connections || [];
				conns.sort(function (a, b) {
					if (sortMode === 'traffic') return (b.download + b.upload) - (a.download + a.upload);
					return (b.start || '').localeCompare(a.start || '');
				});
				info.textContent = _('共 %d 个连接，总流量 ↓%s ↑%s').format(
					conns.length,
					fmtBytes(res.data.downloadTotal), fmtBytes(res.data.uploadTotal));
				table.innerHTML = '';
				table.appendChild(E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th left' }, _('目标')),
					E('th', { 'class': 'th left' }, _('链路 / 规则')),
					E('th', { 'class': 'th left' }, _('流量')),
					E('th', { 'class': 'th left' }, _('速率')),
					E('th', { 'class': 'th left' }, _('操作'))
				]));
				conns.slice(0, 300).forEach(function (c) { table.appendChild(row(c)); });
			});
		};

		poll.add(self.refresh, 2);
		self.refresh();

		return E([
			E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('连接')),
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-section-descr' }, [
						info, ' ',
						E('button', { 'class': 'btn cbi-button-negative', click: function () { callApi('DELETE', '/connections', null).then(self.refresh); } }, _('关闭全部')),
						' ',
						E('button', { 'class': 'btn', click: function () { sortMode = (sortMode === 'traffic') ? 'time' : 'traffic'; self.refresh(); } }, _('排序: %s').format(sortMode === 'traffic' ? '流量' : '时间'))
					]),
					table
				])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
