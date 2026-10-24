'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require bettbox.core as Core';

/* LuCI 25.12 removed ui.createHandlerBtn; shim it on top of createHandlerFn. */
if (!ui.createHandlerBtn)
	ui.createHandlerBtn = function(label, fn) {
		return E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, fn) }, label);
	};

var callApi = function (method, path, body) { return Core.api(method, path, body); };

var TEST_URL = 'https://www.gstatic.com/generate_204';

var GROUP_ICONS = {
	Selector: '👉', URLTest: '⚡', Fallback: '🔁', LoadBalance: '⚖️', Relay: '🔗'
};

var PAGE_CSS = `
.bb-group { background:var(--background-color-high,#fff); border:1px solid var(--border-color,#ddd); border-radius:12px; margin-bottom:.8em; box-shadow:0 1px 3px rgba(0,0,0,.06); overflow:hidden; }
.bb-group-head { display:flex; align-items:center; gap:.55em; padding:.8em 1em; cursor:pointer; user-select:none; }
.bb-group-head:hover { background:var(--background-color-low,#f7f7f7); }
.bb-group-title { font-weight:600; display:flex; align-items:center; gap:.4em; }
.bb-group-now { color:var(--sub-color,#888); font-size:.85em; margin-left:auto; display:flex; align-items:center; gap:1em; max-width:45%; }
.bb-group-now .bb-now-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bb-chev { transition:transform .15s; display:inline-block; }
.bb-group-collapsed .bb-chev { transform:rotate(-90deg); }
.bb-group-collapsed .bb-group-body { display:none; }
.bb-group-body { padding:0 1em 1em; }
.bb-nodes { display:flex; flex-wrap:wrap; }
.bb-node { border:1px solid var(--border-color,#ddd); border-radius:10px; padding:.45em .7em; margin:.2em; cursor:pointer; min-width:7em; text-align:center; background:var(--background-color-low,#fafafa); }
.bb-node:hover { border-color:var(--primary,#2f7fd6); }
.bb-node.bb-active { border-color:var(--primary,#2f7fd6); box-shadow:0 0 0 1px var(--primary,#2f7fd6); background:var(--primary,#2f7fd614); }
.bb-node .bb-node-name { max-width:13em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.85em; }
.bb-node .bb-node-delay { font-size:.75em; margin-top:.15em; }
`;

function delayBadge(h) {
	if (!h || !h.length) return E('span', { 'class': 'label' }, '未测');
	var last = h[h.length - 1];
	if (last.delay == null) return E('span', { 'class': 'label' }, '超时');
	return E('span', { 'class': 'label ' + (last.delay < 200 ? 'label-success' : last.delay < 500 ? 'label-warning' : 'label-important') }, last.delay + 'ms');
}

function iconImg(src, size, cls) {
	return E('img', {
		src: src, width: size, height: size, loading: 'lazy',
		style: 'vertical-align:-3px; object-fit:contain; border-radius:4px;' + (cls ? 'margin-right:.35em;' : ''),
		onerror: 'this.style.display="none"'
	});
}

function nodeChip(group, node, now) {
	var nameRow = E('div', { 'class': 'bb-node-name', title: node.name });
	if (node.icon)
		nameRow.appendChild(iconImg(node.icon, 15, true));
	nameRow.appendChild(document.createTextNode(node.name));
	var el = E('div', { 'class': 'bb-node' + (node.name === now ? ' bb-active' : '') }, [
		nameRow,
		E('div', { 'class': 'bb-node-delay' }, delayBadge(node.history))
	]);
	el.addEventListener('click', function () {
		if (node.name === now) return;
		ui.showModal(_('切换到 %s ?').format(node.name), [
			E('div', { 'class': 'btn-row' }, [
				ui.createHandlerBtn(_('确定'), function () {
					return callApi('PUT', '/proxies/' + encodeURIComponent(group.name), JSON.stringify({ name: node.name }))
						.then(function () { ui.hideModal(); refresh(); });
				}),
				E('button', { 'class': 'btn', click: ui.createHandlerFn(null, ui.hideModal) }, _('取消'))
			])
		]);
	});
	return el;
}

var refresh;

return view.extend({
	render: function () {
		var container = E('div', { 'class': 'cbi-map' }, [
			E('style', {}, PAGE_CSS),
			E('div', { id: 'bb-groups' }, E('p', {}, _('加载中…')))
		]);

		refresh = function () {
			callApi('GET', '/proxies', '').then(function (res) {
				var wrap = document.getElementById('bb-groups');
				if (!wrap) return;
				var expanded = {};
				wrap.querySelectorAll('.bb-group').forEach(function (g) {
					if (!g.classList.contains('bb-group-collapsed'))
						expanded[g.getAttribute('data-group')] = true;
				});
				wrap.innerHTML = '';
				if (!res || res.status !== 200 || !res.data || !res.data.proxies) {
					wrap.appendChild(E('p', {}, _('内核未运行或 API 不可用')));
					return;
				}
				var proxies = res.data.proxies;
				/* /proxies is a Go map -> JSON sorts keys alphabetically; the
				   subscription's own order lives in GLOBAL.all (config order) */
				var order = (proxies['GLOBAL'] && proxies['GLOBAL'].all) ? proxies['GLOBAL'].all : Object.keys(proxies);
				var groups = order.map(function (n) { return proxies[n]; }).filter(function (p) {
					/* hidden groups (脚本标记的 自动选择/负载均衡/区域自动组) stay
					   selectable as chips inside their parents, not top-level cards */
					return p && !p.hidden && /^(Selector|URLTest|Fallback|LoadBalance|Relay)$/.test(p.type) && p.name !== 'GLOBAL';
				});
				if (!groups.length) {
					wrap.appendChild(E('p', {}, _('没有策略组，请先选择订阅')));
					return;
				}
				var first = true;
				groups.forEach(function (g) {
					var nodes = (g.all || []).map(function (n) { return proxies[n]; }).filter(function (n) { return n; });
					var bodyEl = E('div', { 'class': 'bb-nodes' });
					nodes.forEach(function (n) { bodyEl.appendChild(nodeChip(g, n, g.now)); });

					var head = E('div', { 'class': 'bb-group-head' }, [
						E('span', { 'class': 'bb-chev' }, '▾'),
						E('span', { 'class': 'bb-group-title', title: g.name }, [
							/* icon comes from the subscription YAML (mihomo passes it
							   through the /proxies API); type glyph is the fallback */
							g.icon ? iconImg(g.icon, 19, true) : document.createTextNode(GROUP_ICONS[g.type] || '👥'),
							document.createTextNode(g.name)
						]),
						E('span', { 'class': 'bb-sub', style: 'font-size:.78em' }, '[' + g.type + ']'),
						E('span', { 'class': 'bb-group-now' }, [
							/* 当前选中节点：带出它的图标与名称（icon 来自订阅 YAML） */
							(function () {
								var sel = g.now ? proxies[g.now] : null;
								var row = E('span', { 'class': 'bb-now-name', style: 'display:inline-flex; align-items:center; gap:.3em', title: g.now || '-' });
								if (sel && sel.icon)
									row.appendChild(iconImg(sel.icon, 17, false));
								row.appendChild(document.createTextNode(g.now || '-'));
								return row;
							})(),
							ui.createHandlerBtn(_('测全组'), function () {
								ui.showModal(_('正在测试…'));
								return callApi('GET', '/group/' + encodeURIComponent(g.name) + '/delay?url=' + encodeURIComponent(TEST_URL) + '&timeout=5000', '')
									.then(function () { ui.hideModal(); refresh(); });
							})
						])
					]);

					var card = E('div', { 'class': 'bb-group' + ((expanded[g.name] || (first && Object.keys(expanded).length === 0)) ? '' : ' bb-group-collapsed'), 'data-group': g.name }, [
						head,
						E('div', { 'class': 'bb-group-body' }, [ bodyEl ])
					]);
					head.addEventListener('click', function (ev) {
						if (ev.target.closest('button')) return;
						card.classList.toggle('bb-group-collapsed');
					});
					wrap.appendChild(card);
					first = false;
				});
			});
		};

		poll.add(refresh, 15);
		if (!poll.running) poll.start();
		refresh();
		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
