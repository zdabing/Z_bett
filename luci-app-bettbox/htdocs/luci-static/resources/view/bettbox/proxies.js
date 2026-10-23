'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callApi = rpc.declare({ object: 'bettbox', method: 'api_proxy', params: [ 'method', 'path', 'body' ] });

var TEST_URL = 'https://www.gstatic.com/generate_204';

function delayBadge(h) {
	if (!h || !h.length) return null;
	var last = h[h.length - 1];
	if (last.delay == null) return E('span', { 'class': 'label' }, '超时');
	return E('span', { 'class': 'label ' + (last.delay < 200 ? 'label-success' : last.delay < 500 ? 'label-warning' : 'label-important') }, last.delay + 'ms');
}

function nodeCard(group, node, now) {
	var card = E('div', {
		'class': 'cbi-button cbi-button-neutral',
		style: 'margin:.2em; padding:.4em .8em; ' + (node.name === now ? 'border-color:var(--primary,#2f7fd6); box-shadow:0 0 0 1px var(--primary,#2f7fd6)' : ''),
		'data-node': node.name
	}, [
		E('div', { style: 'max-width:16em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap' }, node.name),
		E('div', {}, delayBadge(node.history))
	]);
	card.addEventListener('click', function () {
		ui.showModal(_('切换到 %s ?').format(node.name), [
			E('div', { 'class': 'btn-row' }, [
				ui.createHandlerBtn(_('确定'), function () {
					return callApi('PUT', '/proxies/' + encodeURIComponent(group.name), JSON.stringify({ name: node.name }))
						.then(function () { ui.hideModal(); window.location.reload(); });
				}),
				E('button', { 'class': 'btn', click: ui.hideModal }, _('取消'))
			])
		]);
	});
	return card;
}

return view.extend({
	render: function () {
		var container = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('代理')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-descr' }, _('点击节点切换策略组出口，URL-Test 由内核自动调度。')),
				E('div', { id: 'bb-groups' }, E('p', {}, _('加载中…')))
			])
		]);

		function refresh() {
			callApi('GET', '/proxies', null).then(function (res) {
				var wrap = document.getElementById('bb-groups');
				if (!wrap) return;
				wrap.innerHTML = '';
				if (!res || res.status !== 200 || !res.data || !res.data.proxies) {
					wrap.appendChild(E('p', {}, _('内核未运行或 API 不可用')));
					return;
				}
				var proxies = res.data.proxies;
				var groups = Object.keys(proxies).map(function (k) { return proxies[k]; }).filter(function (p) {
					return p && /^(Selector|URLTest|Fallback|LoadBalance|Relay)$/.test(p.type) && p.name !== 'GLOBAL';
				});
				if (!groups.length) {
					wrap.appendChild(E('p', {}, _('没有策略组，请先选择订阅')));
					return;
				}
				groups.forEach(function (g) {
					var nodes = (g.all || []).map(function (n) { return proxies[n]; }).filter(function (n) { return n; });
					var body = E('div', { style: 'display:flex; flex-wrap:wrap' });
					nodes.forEach(function (n) { body.appendChild(nodeCard(g, n, g.now)); });
					wrap.appendChild(E('div', { 'class': 'cbi-section', style: 'margin-bottom:1em' }, [
						E('h3', {}, [ g.name + ' ', E('small', {}, '[' + g.type + ' → ' + (g.now || '-') + '] ') ]),
						E('div', { style: 'margin-bottom:.4em' }, [
							ui.createHandlerBtn(_('测当前'), function () {
								return callApi('GET', '/proxies/' + encodeURIComponent(g.now) + '/delay?url=' + encodeURIComponent(TEST_URL) + '&timeout=5000', null)
									.then(function (r) {
										ui.addNotification(null, E('p', {}, g.now + ' → ' + (r && r.data && r.data.delay ? r.data.delay + 'ms' : _('超时'))), 'info');
										window.setTimeout(refresh, 300);
									});
							}),
							' ',
							ui.createHandlerBtn(_('测全组'), function () {
								ui.showModal(_('正在测试…'));
								return callApi('GET', '/group/' + encodeURIComponent(g.name) + '/delay?url=' + encodeURIComponent(TEST_URL) + '&timeout=5000', null)
									.then(function () { ui.hideModal(); window.setTimeout(refresh, 300); });
							})
						]),
						body
					]));
				});
			});
		}

		poll.add(refresh, 15);
		refresh();
		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
