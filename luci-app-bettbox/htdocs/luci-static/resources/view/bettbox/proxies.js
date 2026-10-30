'use strict';
'require view';
'require poll';
'require rpc';
'require uci';
'require ui';
'require bettbox.core as Core';
'require bettbox.ui as UI';

var getStatus = rpc.declare({ object: 'bettbox', method: 'get_status' });
var serviceAction = rpc.declare({ object: 'bettbox', method: 'service_action', params: ['action'] });

function encode(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, function(c) {
		return '%' + c.charCodeAt(0).toString(16).toUpperCase();
	});
}
function stored(key, fallback) {
	try { return localStorage.getItem('bettbox-' + key) || fallback; }
	catch(e) { return fallback; }
}
function persist(key, value) {
	try { localStorage.setItem('bettbox-' + key, value); } catch(e) {}
}
function iconFor(proxy) {
	proxy = proxy || {};
	var fallback = Array.isArray(proxy.all) ? 'route' : 'globe';
	var value = typeof proxy.icon === 'string' ? proxy.icon.trim() : '';
	var valid = /^(https?:\/\/|\/\/|data:image\/|\.?\.?\/)/i.test(value) ||
		(!/^[a-z][a-z0-9+.-]*:/i.test(value) && /^[A-Za-z0-9_-]+\//.test(value));
	if (!value || !valid) return UI.icon(fallback);
	var image = E('img', {
		'class': 'bb-proxy-image', src: value, alt: '', width: 24, height: 24,
		loading: 'lazy', decoding: 'async'
	});
	image.addEventListener('error', function() { image.replaceWith(UI.icon(fallback)); }, { once: true });
	return image;
}

return view.extend({
	load: function() { return uci.load('bettbox'); },
	render: function() {
		var proxies = new Map(), groups = [], expanded = new Set(), columns = new Map();
		var results = new Map(), requests = new Map(), queue = [], active = 0, enqueueDepth = 0;
		var testBatch = 0, disposed = false, runtimeKey = '', visibleCounts = new Map(), gridObserver = null;
		var reuseSeconds = Number(stored('proxy-test-reuse', '60'));
		if ([0,30,60,300].indexOf(reuseSeconds) < 0) reuseSeconds = 60;
		var cacheKey = 'bettbox-proxy-results-v1', cacheLoaded = false;
		var groupTests = new Map(), selecting = new Set(), allTesting = false;
		var filter = '', snapshot = false, offline = false, refreshPromise = null;
		var serviceState = 'checking', serviceInfo = null, startError = '', dataGeneration = 0;
		var lastAttempt = 0, lastSuccess = 0, layoutKey = '', expansionLoaded = false;
		var profileKey = 'proxy-expanded-v4:' + (uci.get('bettbox', 'config', 'profile') || 'default');
		var viewMode = stored('proxy-view', 'cards'), sortMode = stored('proxy-sort', 'default');
		if (['cards', 'list'].indexOf(viewMode) < 0) viewMode = 'cards';
		if (['default', 'delay', 'name'].indexOf(sortMode) < 0) sortMode = 'default';
		var testURL = stored('test-url', uci.get('bettbox', 'config', 'test_url') || 'https://www.gstatic.com/generate_204');
		if (!document.getElementById('bettbox-proxy-state-css'))
			document.head.appendChild(E('link', { id: 'bettbox-proxy-state-css', rel: 'stylesheet', href: L.resource('bettbox/proxy-state.css') + '?v=20261030-1' }));
		var host = E('div', { 'class': 'v4-groups', 'aria-live': 'off' });
		var banner = E('div', { 'class': 'v4-connection-state', role: 'status', hidden: true });
		var count = E('span', { 'class': 'v4-group-count' }, '—');
		var refreshButton = UI.button('刷新', refresh, '', 'refresh');
		var allButton = UI.button('全部测速', function() { testAll(); }, 'primary', 'activity');
		var cancelButton = UI.button('取消测速', cancelTests, '', 'close'); cancelButton.hidden = true;
		var viewButton = UI.button('切换视图', function() {
			viewMode = viewMode === 'cards' ? 'list' : 'cards';
			persist('proxy-view', viewMode); draw();
		}, 'bb-icon-only v4-view-button', viewMode === 'cards' ? 'list' : 'grid');
		viewButton.setAttribute('aria-label', '切换节点卡片/列表视图');
		var collapseButton = UI.button('全部收起', toggleAll, 'bb-icon-only', 'layers');
		var settingsButton = UI.button('测试设置', settings, 'bb-icon-only', 'settings');
		settingsButton.setAttribute('aria-label', '测试设置');
		var search = UI.search('搜索策略组或节点', function(value) { filter = value.trim().toLowerCase(); visibleCounts.clear(); draw(); });
		var sort = E('select', { 'class': 'field', 'aria-label': '节点排序' }, [
			E('option', { value: 'default' }, '默认排序'),
			E('option', { value: 'delay' }, '延迟优先'),
			E('option', { value: 'name' }, '名称排序')
		]);
		sort.value = sortMode;
		sort.addEventListener('change', function() { sortMode = sort.value; persist('proxy-sort', sortMode); visibleCounts.clear(); draw(); });

		function get(name) { return proxies.get(name) || { name: name || '—', type: 'Unknown' }; }
		function children(group) { return (group.all || []).map(get); }
		function chain(proxy) {
			var list = [], seen = new Set(), current = proxy;
			while (current) {
				if (seen.has(current.name)) return null;
				seen.add(current.name); list.push(current);
				if (!current.now) return list;
				current = get(current.now);
			}
			return list;
		}
		function target(proxy) { var list = chain(proxy); return list && list[list.length - 1]; }
		function testable(proxy) {
			var last = target(proxy);
			return last && !/^(REJECT|REJECT-DROP|PASS)$/i.test(last.name) &&
				!/^(Reject|RejectDrop|Pass|Rematch)$/i.test(last.type || '');
		}
		function requestKey(proxy, url) { return JSON.stringify([runtimeKey, url || testURL, proxy.name]); }
		function saveResults() {
			var entries = Array.from(results.entries()).filter(function(item) { return item[1].status === 'success' && Date.now() - item[1].time <= 300000; }).slice(-512);
			try { sessionStorage.setItem(cacheKey, JSON.stringify(entries)); } catch(e) {}
		}
		function loadResults() {
			if (cacheLoaded) return; cacheLoaded = true;
			try { var data = JSON.parse(sessionStorage.getItem(cacheKey) || '[]');
				if (Array.isArray(data)) data.slice(-512).forEach(function(item) {
					if (Array.isArray(item) && typeof item[0] === 'string' && item[1] && item[1].status === 'success' && item[1].delay > 0 && item[1].time <= Date.now() && Date.now() - item[1].time <= 300000) results.set(item[0], item[1]);
				});
			} catch(e) {}
		}
		function stateFor(proxy) {
			var last = target(proxy);
			if (!last) return { status: 'error', error: '策略组出口形成循环' };
			var key = requestKey(last), pending = requests.get(key);
			if (pending && pending.aliases.has(proxy.name)) return { status: pending.running ? 'testing' : 'queued' };
			if (results.has(key)) return results.get(key);
			var history = last.history || [], item = history[history.length - 1];
			return !item ? { status: 'idle' } : item.delay > 0 ?
				{ status: 'success', delay: item.delay } : { status: 'timeout' };
		}
		function saveExpanded() { persist(profileKey, JSON.stringify(Array.from(expanded))); }
		function initializeLayout() {
			if (!expansionLoaded) {
				expansionLoaded = true;
				var saved = null;
				try { saved = JSON.parse(stored(profileKey, 'null')); } catch(e) {}
				if (Array.isArray(saved)) saved.forEach(function(name) { if (typeof name === 'string') expanded.add(name); });
				else groups.slice(0, 2).forEach(function(group) { expanded.add(group.name); });
			}
			var key = JSON.stringify(groups.map(function(group) { return group.name; }));
			if (key === layoutKey) return;
			layoutKey = key; columns.clear();
			var weights = [0, 0];
			groups.forEach(function(group) {
				var column = weights[0] <= weights[1] ? 0 : 1;
				columns.set(group.name, column);
				weights[column] += expanded.has(group.name) ?
					96 + Math.ceil(group.all.length / (group.all.length === 4 ? 4 : 3)) * 94 : 90;
			});
		}
		function filteredNodes(group) {
			var matchesGroup = group.name.toLowerCase().indexOf(filter) >= 0;
			var list = children(group).filter(function(proxy) {
				return !filter || matchesGroup || (proxy.name + ' ' + proxy.type).toLowerCase().indexOf(filter) >= 0;
			});
			if (sortMode === 'delay') list.sort(function(a, b) {
				var x = stateFor(a), y = stateFor(b);
				return (x.status === 'success' ? x.delay : Infinity) - (y.status === 'success' ? y.delay : Infinity);
			});
			if (sortMode === 'name') list.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }); });
			return list;
		}
		function latency(proxy) {
			if (!testable(proxy)) return E('span', { 'class': 'v4-untestable', title: '此出口不支持连通性测试' }, '—');
			var state = stateFor(proxy);
			var label = state.status === 'testing' ? '检测中' : state.status === 'queued' ? '排队中' :
				state.status === 'success' ? state.delay + ' ms' : state.status === 'timeout' ? '超时' :
				state.status === 'error' ? '失败' : '测试';
			var button = E('button', {
				type: 'button', 'class': 'proxy-latency v4-latency ' + state.status,
				'data-test-node': proxy.name, 'aria-label': '单独测试 ' + proxy.name + ' 的连通性',
				title: state.error || '单独测试此出口'
			}, [UI.icon(state.status === 'testing' || state.status === 'queued' || state.status === 'timeout' ? 'refresh' : 'bolt'), E('span', {}, label)]);
			button.disabled = offline || state.status === 'testing' || state.status === 'queued';
			button.addEventListener('click', function(event) { event.stopPropagation(); testOne(proxy); });
			return button;
		}
		function nodeCard(group, proxy) {
			var selected = group.now === proxy.name;
			var choose = E('button', {
				type: 'button', 'class': 'node-select v4-node-select', 'data-node': proxy.name,
				'data-select-group': group.name, 'aria-pressed': String(selected), title: proxy.name
			}, [E('span', { 'class': 'v4-node-icon' }, iconFor(proxy)), E('span', { 'class': 'v4-node-name' }, proxy.name)]);
			if (selected) choose.appendChild(E('span', { 'class': 'v4-selected-mark' }, UI.icon('check')));
			choose.disabled = offline || selecting.has(group.name);
			choose.addEventListener('click', function() { selectNode(group, proxy); });
			var card = E('article', { 'class': 'v4-node' + (selected ? ' selected' : ''), 'data-proxy-name': proxy.name }, [
				choose, E('div', { 'class': 'v4-node-footer' }, [E('span', { 'class': 'v4-protocol' }, proxy.type || '—'), latency(proxy)])
			]);
			card.addEventListener('contextmenu', function(event) { event.preventDefault(); if (!offline) testOne(proxy); });
			return card;
		}
		function nodeGrid(group, list) {
			var limit = Math.min(list.length, visibleCounts.get(group.name) || 48);
			var grid = E('div', {
				'class': 'proxy-node-grid v4-node-grid' + (viewMode === 'list' ? ' list-view' : ''), 'data-count': String(list.length)
			}, list.length ? list.slice(0, limit).map(function(proxy) { return nodeCard(group, proxy); }) : [E('div', { 'class': 'v4-no-nodes' }, '暂无节点')]);
			if (limit < list.length) {
				var more = E('button', { type: 'button', 'class': 'btn v4-load-more', 'aria-label': '加载更多 ' + group.name + ' 节点' }, '加载更多 · ' + limit + '/' + list.length);
				function append() {
					if (!grid.isConnected || disposed) return;
					var end = Math.min(list.length, limit + 48), fragment = document.createDocumentFragment();
					list.slice(limit, end).forEach(function(proxy) { fragment.appendChild(nodeCard(group, proxy)); });
					grid.insertBefore(fragment, more); limit = end; visibleCounts.set(group.name, limit);
					if (limit === list.length) { if (gridObserver) gridObserver.unobserve(more); more.remove(); }
					else more.textContent = '加载更多 · ' + limit + '/' + list.length;
				}
				more.addEventListener('click', append); more.loadNodes = append; grid.appendChild(more);
				if (gridObserver) gridObserver.observe(more);
			}
			return grid;
		}
		function currentChain(group) {
			var list = chain(group), selected = group.now ? get(group.now) : null;
			var row = E('span', { 'class': 'v4-current', title: list ? list.slice(1).map(function(p) { return p.name; }).join(' → ') : '策略组出口形成循环' }, UI.icon('arrow'));
			if (!selected) { row.appendChild(E('span', {}, '—')); return row; }
			function item(proxy, final) {
				return E('span', { 'class': 'v4-current-item' + (final ? ' final' : '') }, [
					E('span', { 'class': 'v4-current-icon' }, iconFor(proxy)), E('span', { 'class': 'v4-current-name' }, proxy.name)
				]);
			}
			row.appendChild(item(selected, false));
			var last = list && list[list.length - 1];
			if (last && last.name !== selected.name) { row.appendChild(E('span', { 'class': 'v4-chain-arrow' }, '›')); row.appendChild(item(last, true)); }
			return row;
		}
		function groupCard(group, list, index) {
			var open = !!filter || expanded.has(group.name);
			var toggle = E('button', {
				type: 'button', 'class': 'v4-group-toggle', 'data-expand-group': group.name,
				'aria-expanded': String(open), 'aria-label': group.name
			}, [E('span', { 'class': 'v4-disclosure' }, UI.icon('chevron')),
				E('span', { 'class': 'v4-group-icon' }, iconFor(group)), E('span', { 'class': 'v4-group-copy' }, [
					E('span', { 'class': 'v4-group-title-row' }, [E('strong', { 'class': 'v4-group-title' }, group.name),
						E('span', { 'class': 'v4-group-type' }, group.type || ''),
						E('span', { 'class': 'v4-node-count' }, String(list.length === group.all.length ? list.length : list.length + '/' + group.all.length))]), currentChain(group)
				])]);
			toggle.addEventListener('click', function() {
				if (expanded.has(group.name)) expanded.delete(group.name); else expanded.add(group.name);
				saveExpanded(); draw();
			});
			var test = UI.button('测试 ' + group.name + ' 组', function() { testGroup(group); }, 'bb-icon-only v4-group-test', 'bolt');
			test.setAttribute('data-test-group', group.name); test.setAttribute('aria-label', '测试 ' + group.name + ' 组');
			test.disabled = offline || groupTests.has(group.name) || !children(group).some(testable);
			test.classList.toggle('testing', groupTests.has(group.name));
			return E('section', {
				'class': 'panel v4-group' + (open ? ' open' : ''), 'data-group-name': group.name, style: '--group-order:' + index
			}, [E('div', { 'class': 'v4-group-head' }, [toggle, test]), open ? nodeGrid(group, list) : document.createTextNode('')]);
		}
		function inactive() { return serviceState === 'stopped' || serviceState === 'idle' || serviceState === 'starting'; }
		function inactiveCard() {
			var starting = serviceState === 'starting';
			var id = serviceInfo && serviceInfo.profile || uci.get('bettbox', 'config', 'profile') || '';
			var name = id ? uci.get('bettbox', id, 'label') || '已选择订阅' : '未选择订阅';
			var primary = id ? UI.button(starting ? '正在启动…' : startError ? '重试启动' : '启动服务', startService, 'primary', starting ? 'refresh' : 'power') :
				E('a', { 'class': 'btn primary', href: L.url('admin', 'services', 'bettbox', 'profiles') }, '添加订阅');
			primary.disabled = starting;
			return E('section', { 'class': 'panel v4-state-card' + (starting ? ' starting' : ''), 'aria-labelledby': 'bettbox-proxy-state-title' }, [
				E('div', { 'class': 'v4-state-symbol' }, UI.icon(starting ? 'refresh' : 'power')),
				E('h2', { id: 'bettbox-proxy-state-title' }, starting ? '正在启动服务' : serviceState === 'idle' ? '服务未运行' : '服务未启动'),
				E('div', { 'class': 'v4-state-profile' }, id ? [E('span', {}, '当前订阅'), E('strong', {}, name)] : E('span', {}, name)),
				startError ? E('p', { 'class': 'v4-state-error', role: 'alert' }, startError) : document.createTextNode(''),
				E('div', { 'class': 'v4-state-actions' }, [primary, id ? E('a', { 'class': 'btn text', href: L.url('admin', 'services', 'bettbox', 'profiles') }, '管理订阅') : document.createTextNode('')])
			]);
		}
		function stopped(status) {
			if (snapshot || groups.length || requests.size) {
				dataGeneration++; cancelTests(); results.clear(); saveResults();
				proxies.clear(); groups = []; snapshot = false; layoutKey = '';
			}
			serviceInfo = status; serviceState = status.enabled ? 'idle' : 'stopped'; offline = true; banner.hidden = true; draw();
		}
		function startService() {
			if (serviceState === 'starting') return Promise.resolve();
			dataGeneration++; startError = ''; serviceState = 'starting'; draw();
			return serviceAction('start').then(UI.operation).then(function() {
				return Promise.resolve(refreshPromise).then(function() { serviceState = 'checking'; return refresh(); });
			}).catch(function(error) {
				startError = error.message || String(error);
				return getStatus().then(function(status) {
					if (status && status.service_known !== false && status.running === false) { stopped(status); return; }
					serviceState = 'unknown'; offline = true; connectionError(error, '启动服务失败'); draw();
				}, function() { serviceState = 'unknown'; offline = true; connectionError(error, '启动服务失败'); draw(); });
			});
		}
		function draw() {
			if (disposed) return;
			if (gridObserver) gridObserver.disconnect();
			var quiet = inactive() || serviceState === 'checking';
			controls.hidden = quiet; refreshButton.hidden = quiet; allButton.hidden = quiet; count.hidden = !snapshot || quiet;
			cancelButton.hidden = quiet || !requests.size;
			host.classList.toggle('v4-inactive', inactive());
			if (inactive()) { banner.hidden = true; host.classList.remove('stale'); host.replaceChildren(inactiveCard()); return; }
			count.textContent = snapshot ? String(groups.length) : '—';
			allButton.disabled = !groups.length || offline || allTesting;
			collapseButton.disabled = !groups.length || !!filter;
			var closed = groups.every(function(group) { return !expanded.has(group.name); });
			collapseButton.setAttribute('aria-label', closed ? '全部展开' : '全部收起');
			collapseButton.setAttribute('title', closed ? '全部展开' : '全部收起');
			viewButton.replaceChildren(UI.icon(viewMode === 'cards' ? 'list' : 'grid'), E('span', {}, '切换视图'));
			if (!snapshot) return;
			if (!groups.length) {
				host.replaceChildren(E('div', { 'class': 'v4-no-data' }, [UI.icon('info'), E('strong', {}, '暂无策略组'),
					E('a', { 'class': 'btn', href: L.url('admin', 'services', 'bettbox', 'profiles') }, '管理订阅')])); return;
			}
			var cols = [E('div', { 'class': 'v4-group-column' }), E('div', { 'class': 'v4-group-column' })], matches = 0;
			groups.forEach(function(group, index) {
				var list = filteredNodes(group);
				if (filter && !list.length && group.name.toLowerCase().indexOf(filter) < 0) return;
				cols[columns.get(group.name) || 0].appendChild(groupCard(group, list, index)); matches++;
			});
			host.replaceChildren.apply(host, matches ? cols : [E('div', { 'class': 'v4-no-data' }, '没有匹配的策略组或节点')]);
		}
		function toggleAll() {
			var open = groups.every(function(group) { return !expanded.has(group.name); });
			groups.forEach(function(group) { if (open) expanded.add(group.name); else expanded.delete(group.name); });
			saveExpanded(); draw();
		}
		function updateTests() {
			if (disposed) return;
			Array.from(host.querySelectorAll('[data-proxy-name]')).forEach(function(card) {
				var proxy = get(card.dataset.proxyName), footer = card.querySelector('.v4-node-footer');
				footer.replaceChildren(E('span', { 'class': 'v4-protocol' }, proxy.type || '—'), latency(proxy));
			});
			Array.from(host.querySelectorAll('[data-test-group]')).forEach(function(button) {
				var group = get(button.dataset.testGroup), testing = groupTests.has(group.name);
				button.disabled = offline || testing || !children(group).some(testable); button.classList.toggle('testing', testing);
			});
			allButton.disabled = !groups.length || offline || allTesting;
			cancelButton.hidden = !requests.size || inactive();
		}
		function cancelTests() {
			testBatch++;
			requests.forEach(function(entry) { entry.cancelled = true; entry.resolve(); });
			requests.clear(); queue = []; groupTests.clear(); allTesting = false;
			allButton.querySelector('span').textContent = '全部测速'; updateTests();
		}
		function pump() {
			if (offline || disposed) return;
			while (active < 2 && queue.length) run(queue.shift());
		}
		function run(entry) {
			var generation = dataGeneration;
			active++; entry.running = true; updateTests();
			Promise.resolve().then(function() {
				if (!disposed && !entry.cancelled && generation === dataGeneration) return UI.job('delay', [encode(entry.target.name), encode(entry.url)]);
			}).then(function(response) {
				if (disposed || entry.cancelled || generation !== dataGeneration) return;
				var data = JSON.parse(response.text); if (!(data.delay > 0)) throw new Error('未获得有效延迟');
				results.delete(entry.key); results.set(entry.key, { status: 'success', delay: data.delay, time: Date.now() });
				while (results.size > 512) results.delete(results.keys().next().value);
				saveResults();
			}).catch(function(error) {
				if (disposed || entry.cancelled || generation !== dataGeneration) return;
				results.set(entry.key, { status: /504|timeout|timed out|超时/i.test(error.message) ? 'timeout' : 'error', error: String(error.message || error).slice(0,300) });
				while (results.size > 512) results.delete(results.keys().next().value);
			}).finally(function() {
				active--; if (requests.get(entry.key) === entry) requests.delete(entry.key); entry.resolve(); pump();
				if (sortMode === 'delay') draw(); else updateTests();
			});
		}
		function testOne(proxy, reuse) {
			if (offline || disposed || !testable(proxy)) return Promise.resolve();
			var last = target(proxy), key = requestKey(last), entry = requests.get(key);
			if (entry) { entry.aliases.add(proxy.name); if (!enqueueDepth) updateTests(); return entry.promise; }
			var cached = results.get(key);
			if (reuse === true && reuseSeconds > 0 && cached && cached.status === 'success' && cached.time <= Date.now() && Date.now() - cached.time < reuseSeconds * 1000) return Promise.resolve();
			entry = { key: key, target: last, url: testURL, aliases: new Set([proxy.name]), running: false };
			entry.promise = new Promise(function(resolve) { entry.resolve = resolve; });
			requests.set(key, entry); queue.push(entry);
			if (!enqueueDepth) { updateTests(); pump(); }
			return entry.promise;
		}
		function testGroup(group) {
			if (offline) return Promise.resolve();
			if (groupTests.has(group.name)) return groupTests.get(group.name);
			var tasks;
			enqueueDepth++;
			try { tasks = children(group).map(function(proxy) { return testOne(proxy, true); }); }
			finally { enqueueDepth--; }
			var pending = Promise.all(tasks).finally(function() {
				if (groupTests.get(group.name) === pending) groupTests.delete(group.name); updateTests();
			});
			groupTests.set(group.name, pending); updateTests(); pump(); return pending;
		}
		function testAll() {
			if (offline || allTesting) return Promise.resolve();
			var batch = testBatch;
			allTesting = true; allButton.querySelector('span').textContent = '检测中…';
			return Promise.all(groups.map(testGroup)).finally(function() {
				if (batch !== testBatch) return;
				allTesting = false; allButton.querySelector('span').textContent = '全部测速'; updateTests();
			});
		}
		function selectNode(group, proxy) {
			if (offline || selecting.has(group.name) || group.now === proxy.name) return;
			var generation = dataGeneration;
			selecting.add(group.name);
			Array.from(host.querySelectorAll('[data-select-group]')).forEach(function(button) {
				if (button.dataset.selectGroup === group.name) button.disabled = true;
			});
			Core.put('/proxies/' + encode(group.name), { name: proxy.name }).then(function() {
				// Keep the confirmed selection even if the subsequent snapshot fails.
				return Promise.resolve(refreshPromise).then(function() {
					if (generation !== dataGeneration) return;
					get(group.name).now = proxy.name; draw(); return refresh();
				});
			}).catch(function(error) { if (generation === dataGeneration) UI.error(error); }).finally(function() { selecting.delete(group.name); draw(); });
		}
		function settings() {
			var input = E('input', { 'class': 'field', type: 'url', value: testURL, 'aria-label': '测试地址' });
			var reuse = E('select', { 'class': 'field', 'aria-label': '批量结果复用' }, [0,30,60,300].map(function(n) { return E('option', { value: String(n) }, n ? n + ' 秒' : '每次重新检测'); })); reuse.value = String(reuseSeconds);
			UI.modal('测试设置', [UI.field('测试地址', input), UI.field('批量结果复用', reuse)], [UI.button('保存', function() {
				var address = input.value.trim();
				try { if (!/^https?:$/.test(new URL(address).protocol)) throw new Error(); }
				catch(e) { throw new Error('请输入有效的 http(s) 测试地址'); }
				if (address !== testURL) cancelTests();
				testURL = address; reuseSeconds = Number(reuse.value); persist('proxy-test-reuse', String(reuseSeconds)); persist('test-url', address); ui.hideModal(); draw();
			}, 'primary', 'save'), UI.button('取消', ui.hideModal)]);
		}
		function connectionError(error, message) {
			var code = error && error.httpStatus;
			var title = message || (code === 401 || code === 403 ? '控制器认证失败' : code === 408 || code === 504 ? '控制器连接超时' : serviceState === 'unknown' ? '暂时无法确认服务状态' : '控制器连接中断');
			banner.hidden = false; banner.title = error.message || String(error);
			banner.replaceChildren(UI.icon('info'), E('div', {}, [E('strong', {}, title),
				snapshot ? E('time', {}, '上次数据 · ' + new Date(lastSuccess).toLocaleTimeString()) : document.createTextNode('')]),
				UI.button('重试', refresh, 'small', 'refresh'));
			if (!snapshot) host.replaceChildren(E('div', { 'class': 'v4-no-data' },
				E('a', { 'class': 'btn', href: L.url('admin', 'services', 'bettbox', 'overview') }, '查看概览')));
		}
		function refresh() {
			if (disposed) return Promise.resolve();
			if (serviceState === 'starting') return Promise.resolve();
			if (refreshPromise) return refreshPromise;
			var generation = dataGeneration;
			lastAttempt = Date.now();
			refreshPromise = getStatus().catch(function() { return { service_known: false }; }).then(function(status) {
				if (generation !== dataGeneration) return null;
				serviceInfo = status;
				var nextProfileKey = 'proxy-expanded-v4:' + (status && status.profile || 'default');
				if (nextProfileKey !== profileKey) { profileKey = nextProfileKey; expansionLoaded = false; expanded.clear(); layoutKey = ''; }
				var nextKey = JSON.stringify([status && status.profile || '', status && status.controller || '', status && status.pid || 0, status && status.config_stamp || 0]);
				if (runtimeKey && runtimeKey !== nextKey) { cancelTests(); results.clear(); visibleCounts.clear(); dataGeneration++; generation = dataGeneration; }
				runtimeKey = nextKey; loadResults();
				if (status && status.service_known !== false && status.running === false && typeof status.enabled === 'boolean') { stopped(status); return null; }
				serviceState = status && status.running === true ? 'live' : 'unknown';
				return Core.get('/proxies');
			}).then(function(response) {
				if (!response || generation !== dataGeneration) return;
				var data = response.data && response.data.proxies;
				if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('控制器未返回节点数据');
				var next = new Map();
				Object.keys(data).forEach(function(name) {
					if (data[name] && typeof data[name] === 'object') next.set(name, Object.assign({}, data[name], { name: name }));
				});
				var global = next.get('GLOBAL'), order = global && Array.isArray(global.all) ? global.all.slice() : [];
				var seen = new Set(); order = order.concat(Array.from(next.keys()));
				groups = order.filter(function(name) { if (seen.has(name)) return false; seen.add(name); return true; }).map(function(name) { return next.get(name); }).filter(function(proxy) {
					return proxy && proxy.name !== 'GLOBAL' && !proxy.hidden && Array.isArray(proxy.all);
				});
				serviceState = 'live'; startError = ''; proxies = next; snapshot = true; offline = false; lastSuccess = Date.now(); banner.hidden = true;
				initializeLayout(); host.classList.remove('stale'); draw(); pump();
			}).catch(function(error) {
				if (generation !== dataGeneration) return;
				offline = true; connectionError(error);
				if (snapshot) host.classList.add('stale');
				draw();
			}).finally(function() { refreshPromise = null; });
			return refreshPromise;
		}

		var controls = E('div', { 'class': 'v4-controls' }, [search, E('div', { 'class': 'v4-control-actions' }, [sort, viewButton, collapseButton, settingsButton])]);
		if (typeof IntersectionObserver !== 'undefined') gridObserver = new IntersectionObserver(function(entries) { entries.forEach(function(entry) { if (entry.isIntersecting && entry.target.loadNodes) entry.target.loadNodes(); }); }, { rootMargin: '480px' });
		var root = UI.page('proxies', '代理', [refreshButton, cancelButton, allButton], [controls, banner, host]);
		function dispose() { if (disposed) return; disposed = true; dataGeneration++; cancelTests(); if (gridObserver) gridObserver.disconnect(); lifecycle.disconnect(); window.removeEventListener('pagehide', dispose); }
		var lifecycle = new MutationObserver(function() { if (!root.isConnected) dispose(); }); lifecycle.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('pagehide', dispose);
		root.classList.add('v4-proxies'); root.querySelector('h1').appendChild(count);
		host.appendChild(E('div', { 'class': 'v4-loading', role: 'status' }, [UI.icon('refresh'), document.createTextNode('正在读取服务状态…')]));
		poll.add(function() {
			if (disposed || !root.isConnected) return Promise.resolve();
			if (Date.now() - lastAttempt < (inactive() ? 5000 : 15000)) return Promise.resolve();
			return refresh();
		}, 5);
		draw(); refresh(); return root;
	},
	handleSaveApply: null, handleSave: null, handleReset: null
});
