'use strict';
'require view';
'require rpc';
'require poll';

var callLogs = rpc.declare({ object: 'bettbox', method: 'get_logs' });

return view.extend({
	filter: '',
	autoscroll: true,

	render: function () {
		var self = this;
		var pre = E('pre', {
			style: 'max-height:32em; overflow:auto; font-size:.8em; background:var(--background-color-high,#f5f5f5); padding:.6em; white-space:pre-wrap'
		}, _('加载中…'));
		var search = E('input', { 'class': 'cbi-input-text', placeholder: _('过滤关键字…'), style: 'width:16em' });
		var level = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: '' }, _('全部级别')),
			E('option', { value: 'info' }, 'info'),
			E('option', { value: 'warning' }, 'warning'),
			E('option', { value: 'error' }, 'error')
		]);

		search.addEventListener('input', function () { self.filter = search.value; });
		level.addEventListener('change', function () { self.level = level.value; });
		pre.addEventListener('scroll', function () {
			self.autoscroll = (pre.scrollTop + pre.clientHeight) >= (pre.scrollHeight - 20);
		});

		var refresh = function () {
			callLogs().then(function (res) {
				var text = (res && res.text) || '';
				var lines = text.split('\n').filter(function (l) {
					if (self.level && l.toLowerCase().indexOf(self.level) < 0) return false;
					if (self.filter && l.toLowerCase().indexOf(self.filter.toLowerCase()) < 0) return false;
					return true;
				});
				pre.textContent = lines.join('\n') || _('（无日志）');
				if (self.autoscroll) pre.scrollTop = pre.scrollHeight;
			});
		};

		poll.add(refresh, 3);
		refresh();

		return E([
			E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('日志')),
				E('div', { 'class': 'cbi-section' }, [
					E('div', { 'class': 'cbi-section-descr' }, [ search, ' ', level, ' ',
						E('button', { 'class': 'btn', click: function () {
							var blob = new Blob([ pre.textContent ], { type: 'text/plain' });
							var a = E('a', { href: URL.createObjectURL(blob), download: 'bettbox.log' });
							document.body.appendChild(a); a.click(); a.remove();
						} }, _('导出')) ]),
					pre
				])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
