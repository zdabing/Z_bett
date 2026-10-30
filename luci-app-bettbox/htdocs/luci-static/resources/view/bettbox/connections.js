'use strict';
'require view';
'require poll';
'require rpc';
'require ui';
'require bettbox.core as Core';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';

var getStatus = rpc.declare({ object: 'bettbox', method: 'get_status' });

return view.extend({
	render: function() {
		var active = [], closed = [], previous = {}, lastTime = 0, session = null;
		var paused = false, inFlight = null, supported = null, state = 'loading';
		var filter = '', protocol = '', scope = 'active', sort = 'traffic', pageNo = 0, pageSize = 30;
		var totals = {}, detailRecord = null, detailBody = null, detailActions = null;
		var list = E('div'), summary = E('div', { 'class': 'toolbar connection-summary' });
		var notice = E('div', { 'class': 'bb-update-note', role: 'status' }), pager = E('div', { 'class': 'button-row' });
		var tabs = E('div', { 'class': 'chips bb-connection-tabs', 'aria-label': '连接状态' }), tabButtons = {};

		if (!document.getElementById('bettbox-connections-css'))
			document.head.appendChild(E('link', { id: 'bettbox-connections-css', rel: 'stylesheet', href: L.resource('bettbox/connections.css') + '?v=20261029-1' }));

		function target(c) { var m = c.metadata || {}; return m.host || m.destinationIP || '—'; }
		function date(value) { return value ? new Date(value).toLocaleString() : '—'; }
		function isClosed(c) { return !!c.closed; }
		function find(items, id) { return items.find(function(c) { return c.id === id; }); }
		function updatedAfterAction() { return Promise.resolve(inFlight).then(function() { return refresh(true); }); }
		function closeDetail() { detailRecord = detailBody = detailActions = null; ui.hideModal(); }
		function updateDetail() {
			if (!detailRecord || !document.body.contains(detailBody)) return;
			var current = find(active, detailRecord.id), old = find(closed, detailRecord.id);
			if (!current && !old) { closeDetail(); return; }
			var c = current || old || detailRecord, m = c.metadata || {};
			var rows = [['状态', current ? '活动' : isClosed(c) ? '已关闭' : '已结束'], ['目标', target(c)],
				['目的地址', (m.destinationIP || '—') + ':' + (m.destinationPort || '—')], ['来源', (m.sourceIP || '—') + ':' + (m.sourcePort || '—')],
				['协议', (m.network || '').toUpperCase() + ' · ' + (m.type || '')], ['链路', (c.chains || []).join(' → ')],
				['规则', (c.rule || '') + ' ' + (c.rulePayload || '')], ['上传', UI.bytes(c.upload)], ['下载', UI.bytes(c.download)], ['开始时间', date(c.start)]];
			if (isClosed(c)) rows.push(['关闭时间', date(c.closed)]);
			else if (current) rows.push(['速率', UI.speed(c._speed)]);
			detailRecord = c;
			detailBody.replaceChildren(E('dl', { 'class': 'definition-list' }, rows.map(function(r) {
				return E('div', { 'class': 'definition-row' }, [E('dt', {}, r[0]), E('dd', {}, String(r[1]))]);
			})));
			var actions = [];
			if (current) actions.push(UI.button('关闭此连接', function() {
				return Core.del('/connections/' + encodeURIComponent(c.id)).then(function() { closeDetail(); return updatedAfterAction(); });
			}, 'danger', 'close'));
			actions.push(UI.button('返回', closeDetail)); detailActions.replaceChildren.apply(detailActions, actions);
		}
		function detail(c) {
			detailRecord = c; detailBody = E('div'); detailActions = E('div', { 'class': 'button-row' });
			UI.modal('连接详情', detailBody, [detailActions]); updateDetail();
		}
		function detailButton(c) {
			var b = UI.button('详情', function() { detail(c); }, 'bb-icon-only', 'chevron');
			b.setAttribute('aria-label', '查看 ' + target(c) + ' 的详情'); return b;
		}
		function status(c) { return UI.tag(isClosed(c) ? '已关闭' : '活动', isClosed(c) ? 'neutral' : ''); }
		function rate(c) { return isClosed(c) ? E('time', { datetime: c.closed, title: date(c.closed) }, date(c.closed)) : UI.speed(c._speed); }
		function row(c) {
			var m = c.metadata || {};
			return E('tr', { 'class': isClosed(c) ? 'bb-connection-closed' : '' }, [
				E('td', {}, [E('div', { 'class': 'cell-title' }, target(c)), E('div', { 'class': 'cell-meta' }, (m.network || '').toUpperCase() + ' · ' + (m.destinationPort || ''))]),
				E('td', { 'class': 'mono' }, m.sourceIP || '—'),
				E('td', {}, [E('div', {}, (c.chains || []).join(' → ') || '—'), E('div', { 'class': 'cell-meta' }, c.rule || '')]),
				E('td', { 'class': 'mono' }, '↓ ' + UI.bytes(c.download) + ' / ↑ ' + UI.bytes(c.upload)),
				E('td', {}, [status(c), E('div', { 'class': 'cell-meta' }, rate(c))]), E('td', {}, detailButton(c))]);
		}
		function card(c) {
			var m = c.metadata || {};
			return E('article', { 'class': 'connection-card' + (isClosed(c) ? ' bb-connection-closed' : '') }, [
				E('div', { 'class': 'connection-top' }, [E('div', {}, [E('div', { 'class': 'cell-title' }, target(c)),
					E('div', { 'class': 'cell-meta' }, (m.network || '').toUpperCase() + ' · ' + (m.destinationPort || '') + ' · 来自 ' + (m.sourceIP || '—'))]), detailButton(c)]),
				E('div', { 'class': 'connection-chain' }, (c.chains || []).join(' → ') || '—'),
				E('div', { 'class': 'connection-bottom' }, [UI.tag(c.rule || '—', 'neutral'), status(c)]),
				E('div', { 'class': 'bb-connection-traffic mono' }, [E('span', {}, '↓ ' + UI.bytes(c.download)), E('span', {}, '↑ ' + UI.bytes(c.upload))]),
				E('div', { 'class': 'cell-meta' }, rate(c))]);
		}
		function draw() {
			var counts = { active: active.length, closed: closed.length, all: active.length + closed.length };
			Object.keys(tabButtons).forEach(function(key) {
				var b = tabButtons[key]; b.textContent = ({ active: '活动', closed: '已关闭', all: '全部' })[key] + ' ' + counts[key];
				b.classList.toggle('active', scope === key); b.setAttribute('aria-pressed', String(scope === key)); b.disabled = key === 'closed' && supported === false;
			});
			clearHistory.disabled = supported !== true || closed.length === 0; closeAll.disabled = active.length === 0;
			summary.replaceChildren(E('span', {}, '↓ ' + UI.bytes(totals.downloadTotal)), E('span', {}, '↑ ' + UI.bytes(totals.uploadTotal)));
			var data = scope === 'active' ? active : scope === 'closed' ? closed : active.concat(closed);
			var filtered = data.filter(function(c) {
				var m = c.metadata || {};
				return (!protocol || String(m.network).toLowerCase() === protocol) && (!filter ||
					[target(c), m.destinationIP, m.sourceIP, c.rule, c.rulePayload, (c.chains || []).join(' ')].join(' ').toLowerCase().indexOf(filter) >= 0);
			});
			filtered.sort(function(a, b) {
				return sort === 'time' ? String(b.closed || b.start).localeCompare(String(a.closed || a.start)) : ((b.upload || 0) + (b.download || 0)) - ((a.upload || 0) + (a.download || 0));
			});
			var pages = Math.max(1, Math.ceil(filtered.length / pageSize)); pageNo = Math.max(0, Math.min(pageNo, pages - 1));
			var slice = filtered.slice(pageNo * pageSize, (pageNo + 1) * pageSize);
			if (!slice.length) {
				var title = state === 'loading' ? '正在读取连接…' : state === 'stopped' ? '代理服务已关闭' : state === 'unknown' && !data.length ? '暂时无法读取连接' :
					filter || protocol ? '暂无符合条件的连接' : scope === 'closed' ? '暂无已关闭连接' : scope === 'all' ? '暂无连接' : '暂无活动连接';
				list.replaceChildren(UI.empty(title));
			} else list.replaceChildren(E('section', { 'class': 'panel connection-table' }, E('table', { 'class': 'data-table' }, [
				E('thead', {}, E('tr', {}, ['目标 / 协议', '来源设备', '链路 / 规则', '流量', '状态 / 速率或关闭时间', ''].map(function(h) { return E('th', {}, h); }))),
				E('tbody', {}, slice.map(row))])), E('section', { 'class': 'panel connection-cards' }, slice.map(card)));
			var prev = UI.button('上一页', function() { pageNo--; draw(); }), next = UI.button('下一页', function() { pageNo++; draw(); });
			prev.disabled = pageNo === 0; next.disabled = pageNo + 1 >= pages;
			pager.replaceChildren(prev, E('span', { 'class': 'small muted' }, '第 ' + (pageNo + 1) + ' / ' + pages + ' 页 · ' + filtered.length + ' 条'), next);
			pager.hidden = filtered.length <= pageSize; updateDetail();
		}
		function stopped() {
			active = []; closed = []; previous = {}; totals = {}; lastTime = 0; session = null; state = 'stopped';
			notice.textContent = ''; if (detailRecord) closeDetail(); draw();
		}
		function checkStopped(err) {
			return getStatus().then(function(st) {
				// A failed service-list query is unknown, not a confirmed stop.
				if (st && st.service_known === true && st.running === false) { stopped(); return; }
				if (err) { state = 'unknown'; notice.textContent = '无法更新连接：' + err.message; draw(); }
			}).catch(function() { if (err) { state = 'unknown'; notice.textContent = '无法更新连接：' + err.message; draw(); } });
		}
		function refresh(force) {
			if (inFlight) return inFlight;
			var request = paused && force !== true ? checkStopped() : Core.get('/connections?history=true').then(function(res) {
				var snapshot = res.data;
				if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, 'connections') ||
					(snapshot.connections != null && !Array.isArray(snapshot.connections)) ||
					('closed' in snapshot && !Array.isArray(snapshot.closed))) throw new Error('连接数据无效');
				var now = Date.now(), next = {};
				if (snapshot.session !== session) {
					previous = {}; lastTime = 0;
					if (session != null && detailRecord) closeDetail();
				}
				session = snapshot.session; supported = Array.isArray(snapshot.closed); closed = supported ? snapshot.closed.slice(0, 512) : [];
				active = (snapshot.connections || []).map(function(item) {
					var count = (item.upload || 0) + (item.download || 0), old = previous[item.id];
					item._speed = old != null && now > lastTime ? Math.max(0, count - old) * 1000 / (now - lastTime) : 0; next[item.id] = count; return item;
				});
				previous = next; lastTime = now; totals = snapshot; state = 'running'; notice.textContent = supported ? '' : '当前核心不支持已关闭记录';
				if (!supported && scope === 'closed') scope = 'active'; draw();
			}).catch(checkStopped);
			inFlight = request.finally(function() { inFlight = null; }); return inFlight;
		}
		var pause = UI.button('暂停', function() {
			paused = !paused; pause.querySelector('span').textContent = paused ? '继续' : '暂停'; pause.setAttribute('aria-pressed', String(paused));
			if (!paused) return updatedAfterAction();
		}, '', 'pause');
		var closeAll = UI.button('关闭全部连接', function() {
			return H.confirm('关闭全部连接', '关闭当前全部活动连接？', '确认关闭', true).then(function(yes) {
				if (yes) return Core.del('/connections').then(updatedAfterAction);
			});
		}, 'danger', 'close');
		var clearHistory = UI.button('清空历史', function() {
			return H.confirm('清空历史', '清空全部已关闭记录？', '确认清空', true).then(function(yes) {
				if (yes) return Core.del('/connections/closed').then(updatedAfterAction);
			});
		}, '', 'close');
		['active', 'closed', 'all'].forEach(function(key) {
			var b = E('button', { type: 'button', 'class': 'chip', 'aria-pressed': 'false' });
			b.addEventListener('click', function() { scope = key; pageNo = 0; draw(); }); tabButtons[key] = b; tabs.appendChild(b);
		});
		var sortSelect = E('select', { 'class': 'field', 'aria-label': '连接排序' }, [E('option', { value: 'traffic' }, '按流量排序'), E('option', { value: 'time' }, '按时间排序')]);
		sortSelect.addEventListener('change', function() { sort = sortSelect.value; pageNo = 0; draw(); });
		var chips = E('div', { 'class': 'chips', 'aria-label': '连接协议' });
		[['', '全部协议'], ['tcp', 'TCP'], ['udp', 'UDP']].forEach(function(p) {
			var b = E('button', { type: 'button', 'class': 'chip' + (!p[0] ? ' active' : ''), 'aria-pressed': String(!p[0]) }, p[1]);
			b.addEventListener('click', function() {
				protocol = p[0]; Array.from(chips.children).forEach(function(x) { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); }); pageNo = 0; draw();
			}); chips.appendChild(b);
		});
		var root = UI.page('connections', '连接', [pause, clearHistory, closeAll], [
			E('div', { 'class': 'toolbar bb-connection-filters' }, [UI.search('搜索目标、来源 IP 或规则…', function(value) { filter = value.toLowerCase(); pageNo = 0; draw(); }), sortSelect, chips]),
			E('div', { 'class': 'toolbar bb-connection-state' }, [tabs, summary]), notice, list, pager]);
		draw(); poll.add(refresh, 4); refresh(); return root;
	},
	handleSaveApply: null, handleSave: null, handleReset: null
});
