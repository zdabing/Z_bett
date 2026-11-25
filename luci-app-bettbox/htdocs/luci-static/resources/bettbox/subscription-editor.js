'use strict';
'require baseclass';
'require rpc';
'require uci';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';

var optionsRPC = rpc.declare({ object: 'bettbox', method: 'script_options', params: ['name'] });
var commitRPC = rpc.declare({ object: 'uci', method: 'commit', params: ['config'] });
var applyRPC = rpc.declare({ object: 'bettbox', method: 'apply' });
var deleteRPC = rpc.declare({ object: 'bettbox', method: 'del_profile', params: ['sid'] });
var catalogRPC = rpc.declare({ object: 'bettbox', method: 'managed_catalog' });
var refreshMergeRPC = rpc.declare({ object: 'bettbox', method: 'update_profile', params: ['sid','all','background','regenerate'] });

return baseclass.extend({
	open: function(config) {
		var p = config.profile, scripts = config.scripts, original = H.object(p.custom_options);
		var merged = (p.merge_members || []).length > 0;
		var name = p.label || p.id, auto = !!p.auto_update, useScript = !!p.use_script;
		var useManaged = merged ? !useScript : (!!p.use_managed && !config.script);
		var managed = H.object(p.managed_routing);
		var managedOptions = H.object(p.managed_options), managedDefaults = {};
		var catalog, catalogPending, catalogError = '', originalManaged = p.managed_routing || '{}', originalManagedOptions = p.managed_options || '{}';
		if (!Array.isArray(managed.routes)) managed.routes = [];
		if (!Array.isArray(managed.customRegions)) managed.customRegions = [];
		var selected = config.script || p.script || (scripts[0] && scripts[0].name) || '';
		if (config.script) { useScript = true; useManaged = false; }
		else if (merged && !useScript) { useManaged = true; }
		var mode = useScript ? 'script' : (useManaged ? 'managed' : 'none');
		if (merged && mode === 'none') { mode = 'managed'; useManaged = true; }
		var rawTab = config.tab || (config.script ? 'routing' : 'basic');
		var tab = (rawTab === 'script' || rawTab === 'managed' || rawTab === 'routing') ? 'routing' : rawTab;
		var dirty = !!config.script && (config.script !== p.script || !p.use_script), committed = false, ruleTouched = false, sharedRuleTouched = false;
		var cache = Object.create(null), category = 'all', search = '', serviceSearch = '', managedSearch = '', managedFoldOpen = false, expandedRoute = null, highlightRoute = null, routeFeedback = '', box, busy = false;
		var error = E('div', { 'class': 'hub-error', role: 'alert' }), status = E('span', { 'class': 'hub-save-state', role: 'status' });
		var content = E('div', { 'class': 'hub-editor-content' }), optionsHost = E('div'), tabs = E('div', { 'class': 'hub-editor-tabs', role: 'tablist', 'aria-label': '订阅设置分区' });
		function changed() { dirty = true; status.textContent = '有未保存的修改'; }
		function input(value, type, attributes) {
			var el = E('input', Object.assign({ 'class': 'field', type: type || 'text' }, attributes || {})); el.value = value || '';
			el.addEventListener('input', changed); return el;
		}
		var label = input(name), url = input(p.url, 'password', { autocomplete: 'off' });
		var mergePrefix = input(p.merge_prefix, 'text', { maxlength: 32, placeholder: '可选，合并时区分同名节点' });
		var dlModeValue = ['auto', 'direct', 'proxy'].indexOf(p.download_mode) >= 0 ? p.download_mode : 'auto';
		var downloadMode = E('select', { 'class': 'field', 'aria-label': '下载方式' }, [
			E('option', { value: 'auto' }, '自动回退（直连失败时走本地代理）'),
			E('option', { value: 'direct' }, '仅直连下载'),
			E('option', { value: 'proxy' }, '强制走本地代理下载')
		]);
		downloadMode.value = dlModeValue;
		downloadMode.addEventListener('change', changed);
		var skipCertVerify = !!p.skip_cert_verify;
		var userAgent = input(p.user_agent, 'text', { maxlength: '160', placeholder: '留空使用全局 User-Agent' });
		var interval = input(String(p.update_interval || 1440), 'number', { min: '1', max: '10080', step: '1' });
		var period = E('select', { 'class': 'field', 'aria-label': '更新周期' }, [60, 360, 720, 1440].map(function(v) { return E('option', { value: String(v) }, '每 ' + (v / 60) + ' 小时'); }).concat([E('option', { value: 'custom' }, '自定义')]));
		function syncPeriod() { period.value = [60,360,720,1440].indexOf(+interval.value) >= 0 ? interval.value : 'custom'; }
		syncPeriod(); interval.addEventListener('input', syncPeriod);
		period.addEventListener('change', function() { if (period.value !== 'custom') interval.value = period.value; changed(); });
		var scriptSelect = E('select', { 'class': 'field', 'aria-label': '选择脚本' }, [E('option', { value: '' }, '选择脚本')].concat(scripts.map(function(s) { return E('option', { value: s.name }, s.name); })));
		if (selected && !scripts.some(function(s) { return s.name === selected; })) scriptSelect.appendChild(E('option', { value: selected }, selected + '（文件不存在）'));
		scriptSelect.value = selected;
		var oldRules = H.object(p.override_rules), rules = E('textarea', { 'class': 'field hub-rules mono', rows: '7', placeholder: 'DOMAIN-SUFFIX,example.com,DIRECT', 'aria-label': '规则内容' });
		var oldShared = H.object(uci.get('bettbox', 'config', 'shared_managed_rules')), sharedRules = E('textarea', { 'class': 'field hub-rules mono', rows: '6', placeholder: 'DOMAIN-SUFFIX,openai.com,默认代理', 'aria-label': '全局托管共享规则内容' });
		var presets = H.object(uci.get('bettbox', 'config', 'rule_presets'));
		var savedPreset = uci.get('bettbox', p.id, 'rule_preset') || '';
		var preset = E('select', { 'class': 'field', 'aria-label': '分流预设' }, [E('option', { value: '' }, '无')].concat(
			Object.keys(presets).map(function(name) { return E('option', { value: name }, name); })));
		if (savedPreset && !Object.prototype.hasOwnProperty.call(presets, savedPreset))
			preset.appendChild(E('option', { value: savedPreset }, savedPreset + '（已删除）'));
		preset.value = savedPreset;
		preset.addEventListener('change', changed);
		var presetName = input('', 'text', { maxlength: '64', placeholder: '输入名称可将下方规则保存为预设' });
		rules.value = Array.isArray(oldRules.rules) ? oldRules.rules.join('\n') : '';
		rules.addEventListener('input', function() { ruleTouched = true; changed(); });
		sharedRules.value = Array.isArray(oldShared.rules) ? oldShared.rules.join('\n') : '';
		sharedRules.addEventListener('input', function() { sharedRuleTouched = true; changed(); });

		function entry(script) {
			if (!cache[script]) cache[script] = { values: Object.assign(Object.create(null), script === p.script ? original : {}), defaults: {}, groups: [], loaded: false, promise: null, error: '' };
			return cache[script];
		}
		function loadOptions(script, retry) {
			if (!script) { drawOptions(); return Promise.resolve(); }
			var data = entry(script); if (data.promise) return data.promise;
			if (data.loaded && !retry) { drawOptions(); return Promise.resolve(); }
			data.error = '';
			data.promise = optionsRPC(script).then(UI.checked).then(function(res) {
				var opts = res.options || {}; data.defaults = H.object(opts.options); data.groups = Array.isArray(opts.policyGroupOptions) ? opts.policyGroupOptions : [];
				data.values = Object.assign(Object.create(null), data.defaults, data.values); data.loaded = true;
			}).catch(function(err) { data.error = err.message; }).finally(function() { data.promise = null; if (box.element.isConnected && selected === script) drawOptions(); });
			drawOptions(); return data.promise;
		}
		function drawOptions() {
			if (!box || !box.element.isConnected || tab !== 'routing' || mode !== 'script' || busy) return;
			if (!useScript) { optionsHost.replaceChildren(E('section', { 'class': 'hub-form-section hub-disabled' }, '未启用覆写脚本')); return; }
			if (!selected) { optionsHost.replaceChildren(E('section', { 'class': 'hub-form-section hub-disabled' }, '请选择覆写脚本')); return; }
			var data = entry(selected);
			if (data.promise) { optionsHost.replaceChildren(E('section', { 'class': 'hub-form-section', role: 'status' }, '正在提取脚本开关…')); return; }
			if (data.error) { optionsHost.replaceChildren(E('section', { 'class': 'hub-form-section' }, [E('p', { 'class': 'hub-error', role: 'alert' }, '无法提取脚本开关：' + data.error), UI.button('重试提取', function() { return loadOptions(selected, true); }, '', 'refresh')])); return; }
			if (!data.loaded) return;
			var keys = Object.keys(data.defaults), count = E('span', { 'class': 'hub-option-count' }), grid = E('div', { 'class': 'hub-option-grid' });
			var empty = E('div', { 'class': 'hub-option-empty', hidden: true }, '没有符合条件的开关'), controls = Object.create(null);
			function update() {
				var visible = 0, on = 0;
				keys.forEach(function(key) {
					var group = data.groups.indexOf(key) >= 0; if (data.values[key]) on++;
					var row = controls[key].row; row.hidden = (category === 'groups' && !group) || (category === 'other' && group) || key.toLowerCase().indexOf(search.toLowerCase()) < 0;
					if (!row.hidden) visible++;
				}); count.textContent = on + ' / ' + keys.length + ' 已开启'; empty.hidden = visible > 0;
			}
			keys.forEach(function(key) {
				var toggle = H.toggle(!!data.values[key], key, function(value) { data.values[key] = value; changed(); update(); });
				var row = E('div', { 'class': 'hub-option' }, [E('span', {}, [UI.icon(data.groups.indexOf(key) >= 0 ? 'layers' : 'settings'), E('strong', {}, key)]), toggle]);
				controls[key] = { row: row, toggle: toggle }; grid.appendChild(row);
			});
			var query = E('input', { 'class': 'field', type: 'search', 'aria-label': '搜索脚本开关', placeholder: '搜索开关…' }); query.value = search;
			query.addEventListener('input', function() { search = query.value; update(); });
			var categories = E('div', { 'class': 'chips', 'aria-label': '开关分类' });
			[['all','全部'],['groups','策略组'],['other','其他设置']].forEach(function(item) {
				var b = E('button', { type: 'button', 'class': 'chip' + (category === item[0] ? ' active' : ''), 'aria-pressed': String(category === item[0]) }, item[1]);
				b.addEventListener('click', function() { category = item[0]; Array.from(categories.children).forEach(function(node) { node.classList.toggle('active', node === b); node.setAttribute('aria-pressed', String(node === b)); }); update(); }); categories.appendChild(b);
			});
			function bulk(defaults) { keys.forEach(function(key) { data.values[key] = defaults ? !!data.defaults[key] : true; controls[key].toggle.setValue(data.values[key]); }); changed(); update(); }
			optionsHost.replaceChildren(E('section', { 'class': 'hub-form-section hub-options-section' }, [
				E('div', { 'class': 'hub-options-heading' }, [E('h3', {}, (label.value || p.id) + '的开关'), count]),
				E('label', { 'class': 'search hub-option-search' }, [UI.icon('search'), query]),
				E('div', { 'class': 'hub-option-toolbar' }, [categories, E('div', { 'class': 'button-row' }, [UI.button('全部开启', function() { bulk(false); }, 'text'), UI.button('恢复默认', function() { bulk(true); }, 'text')])]),
				keys.length ? grid : E('p', { 'class': 'muted' }, '此脚本未声明可视化开关。'), empty])); update();
		}
		function section(title, children) { return E('section', { 'class': 'hub-form-section' }, [E('h3', {}, title)].concat(children)); }
		function formatSetChip(raw) {
			var s = String(raw || '').trim();
			var m = s.match(/^(domain|ipcidr):(https?:\/\/\S+)$/i);
			if (!m) return s;
			var clean = m[2].split('?')[0].split('#')[0];
			var file = clean.split('/').pop() || clean;
			return m[1].toLowerCase() + ':' + file;
		}
		function managedControls() {
			var blocks = [];
			if (!catalog && !catalogError && !catalogPending) {
				catalogPending = catalogRPC().then(UI.checked).then(function(result) {
					catalog = result.catalog;
					managedDefaults = H.object(result.options);
				}).catch(function(err) { catalogError = err.message; }).finally(function() {
					catalogPending = null;
					if (tab === 'routing' && mode === 'managed' && box.element.isConnected) renderTab(false);
				});
			}
			if (!catalog) {
				return [E('section', { 'class': 'hub-form-section' }, [
					E('p', { 'class': 'small muted', style: 'margin:0' }, catalogError || '正在读取内置目录…')
				])];
			}

			var regionDefaults = catalog.regions.filter(function(item) { return item.default; }).map(function(item) { return item.name; });
			var activeRegions = Array.isArray(managed.regions) ? managed.regions.slice() : regionDefaults.slice();
			var regionCount = E('span', { 'class': 'hub-option-count' }, activeRegions.length + ' / ' + catalog.regions.length + ' 个地区已开启');
			var regionGrid = E('div', { 'class': 'hub-option-grid' }, catalog.regions.map(function(region) {
				return E('div', { 'class': 'hub-option' }, [
					E('span', {}, [UI.icon('globe'), E('strong', {}, region.name)]),
					H.toggle(activeRegions.indexOf(region.name) >= 0, region.name, function(value) {
						activeRegions = activeRegions.filter(function(name) { return name !== region.name; });
						if (value) activeRegions.push(region.name);
						managed.regions = activeRegions.slice();
						regionCount.textContent = activeRegions.length + ' / ' + catalog.regions.length + ' 个地区已开启';
						changed();
					})
				]);
			}));
			var customRegionNodes = managed.customRegions.map(function(region, index) {
				var name = input(region.name, 'text', { placeholder: '地区名（如 英国）', 'aria-label': '自定义地区名称' });
				var pattern = input(region.regex, 'text', { placeholder: '节点正则（如 UK|London|英国）', 'aria-label': '节点名称正则' });
				name.addEventListener('input', function() { region.name = name.value.trim(); });
				pattern.addEventListener('input', function() { region.regex = pattern.value.trim(); });
				var del = UI.button('删除地区', function() { managed.customRegions.splice(index, 1); changed(); renderTab(false); }, 'bb-icon-only danger', 'close');
				return E('div', { 'class': 'hub-custom-region-row' }, [name, pattern, del]);
			});
			var regionCard = E('section', { 'class': 'hub-form-section' }, [
				E('div', { 'class': 'hub-options-heading' }, [E('h3', {}, '地区分组'), regionCount]),
				regionGrid
			].concat(customRegionNodes.length ? [E('div', { 'class': 'hub-custom-region-list' }, customRegionNodes)] : []).concat([
				E('div', { 'class': 'hub-inline-footer' }, [
					UI.button('添加自定义地区', function() { managed.customRegions.push({ name: '', regex: '' }); changed(); renderTab(false); }, 'small', 'plus')
				])
			]));
			blocks.push(regionCard);

			var filterInput = E('input', { 'class': 'field', type: 'search', placeholder: '搜索 ' + catalog.services.length + ' 项内置服务（如 ChatGPT、B站）…', 'aria-label': '搜索目录服务' });
			filterInput.value = serviceSearch;
			var service = E('select', { 'class': 'field', 'aria-label': '目录服务' });
			var addServiceBtn = UI.button('添加服务', function() {
				var idx = Number(service.value);
				if (Number.isInteger(idx) && catalog.services[idx]) addRoute(catalog.services[idx], false);
			}, 'soft', 'plus');
			function syncServices() {
				var q = serviceSearch.trim().toLowerCase(), matches = [];
				catalog.services.forEach(function(item, index) {
					var hay = [item.name].concat(item.keywords || []).join(' ').toLowerCase();
					if (!q || hay.indexOf(q) >= 0) matches.push({ item: item, index: index });
				});
				service.replaceChildren.apply(service, matches.length
					? matches.map(function(m) { return E('option', { value: String(m.index) }, m.item.name); })
					: [E('option', { value: '' }, '无匹配服务')]);
				service.disabled = !matches.length;
				addServiceBtn.disabled = !matches.length;
			}
			syncServices();
			filterInput.addEventListener('input', function() { serviceSearch = filterInput.value; syncServices(); });
			function addRoute(item, isCustom) {
				if (!isCustom && item.name) {
					var existing = managed.routes.find(function(r) { return r && r.name === item.name; });
					if (existing) {
						expandedRoute = existing;
						highlightRoute = existing;
						routeFeedback = '该服务已存在，已为你定位到下方条目';
						renderTab(false);
						return;
					}
				}
				var created = { name: item.name || '', icon: item.icon, sets: (item.sets || []).slice(), enabled: true };
				managed.routes.push(created);
				expandedRoute = isCustom ? created : null;
				highlightRoute = created;
				routeFeedback = isCustom ? '' : ('已添加「' + created.name + '」，点击条目可调整出口或规则集');
				changed(); renderTab(false);
			}
			var highlightEl = null;
			var routeNodes = managed.routes.map(function(route, index) {
				var isOpen = expandedRoute === route;
				var isHighlight = highlightRoute === route;
				var titleNode = E('strong', { 'class': 'hub-route-title' }, route.name || ('自定义分流 ' + (index + 1)));
				var targetTag = UI.tag(route.target || '独立策略组', route.target ? 'neutral' : '');
				var setsSummary = E('div', { 'class': 'hub-route-sets' });
				function syncSetsSummary() {
					var list = Array.isArray(route.sets) ? route.sets : [];
					if (!list.length) {
						setsSummary.replaceChildren(E('span', { 'class': 'small muted' }, '未配置规则集'));
						return;
					}
					var chips = list.slice(0, 4).map(function(s) {
						return E('span', { 'class': 'hub-route-set-chip', title: s }, formatSetChip(s));
					});
					if (list.length > 4)
						chips.push(E('span', { 'class': 'hub-route-set-chip', title: list.slice(4).join('\n') }, '+' + (list.length - 4)));
					setsSummary.replaceChildren.apply(setsSummary, chips);
				}
				syncSetsSummary();
				function toggleOpen() {
					expandedRoute = isOpen ? null : route;
					routeFeedback = '';
					renderTab(false);
				}
				var trigger = E('button', { type: 'button', 'class': 'hub-route-trigger', 'aria-expanded': String(isOpen) }, [
					UI.badge('layers', 'bb-small-icon', 'orange'),
					E('div', { 'class': 'hub-route-copy' }, [
						E('div', { 'class': 'hub-route-title-row' }, [titleNode, targetTag]),
						setsSummary
					])
				]);
				trigger.addEventListener('click', toggleOpen);
				var editBtn = UI.button(isOpen ? '收起' : '编辑', toggleOpen, 'bb-icon-only', 'edit');
				editBtn.title = isOpen ? '收起详情' : '展开编辑';
				var upBtn = UI.button('上移', function() {
					if (!index) return;
					managed.routes.splice(index, 1);
					managed.routes.splice(index - 1, 0, route);
					routeFeedback = '';
					changed(); renderTab(false);
				}, 'bb-icon-only', 'up');
				upBtn.disabled = index === 0;
				var downBtn = UI.button('下移', function() {
					if (index >= managed.routes.length - 1) return;
					managed.routes.splice(index, 1);
					managed.routes.splice(index + 1, 0, route);
					routeFeedback = '';
					changed(); renderTab(false);
				}, 'bb-icon-only', 'down');
				downBtn.disabled = index >= managed.routes.length - 1;
				var delBtn = UI.button('删除分流', function() {
					managed.routes.splice(index, 1);
					if (expandedRoute === route) expandedRoute = null;
					routeFeedback = '';
					changed(); renderTab(false);
				}, 'bb-icon-only danger', 'close');

				var cardNode = E('div', {
					'class': 'hub-route-card' + (!route.enabled ? ' is-disabled' : '') + (isOpen ? ' is-expanded' : '') + (isHighlight ? ' is-highlight' : '')
				}, [
					E('div', { 'class': 'hub-route-head' }, [
						trigger,
						H.toggle(!!route.enabled, '启用分流 ' + (index + 1), function(value) {
							route.enabled = value;
							cardNode.classList.toggle('is-disabled', !value);
							changed();
						}),
						E('div', { 'class': 'hub-route-actions' }, [editBtn, upBtn, downBtn, delBtn])
					])
				]);

				if (isOpen) {
					var name = input(route.name, 'text', { placeholder: '分流组名称' });
					var sets = E('textarea', { 'class': 'field mono', rows: '2', placeholder: 'geosite:openai\ndomain:https://example.com/rules.mrs' });
					var target = E('select', { 'class': 'field' }, [E('option', { value: '' }, '建立独立策略组')].concat(catalog.targets.map(function(value) { return E('option', { value: value }, value); })));
					target.value = route.target || '';
					sets.value = (route.sets || []).join('\n');
					name.addEventListener('input', function() { route.name = name.value.trim(); titleNode.textContent = route.name || ('自定义分流 ' + (index + 1)); });
					sets.addEventListener('input', function() { route.sets = sets.value.split('\n').map(function(value) { return value.trim(); }).filter(Boolean); syncSetsSummary(); changed(); });
					target.addEventListener('change', function() {
						route.target = target.value;
						targetTag.textContent = route.target || '独立策略组';
						targetTag.className = 'tag' + (route.target ? ' neutral' : '');
						changed();
					});
					cardNode.appendChild(E('div', { 'class': 'hub-route-body' }, [
						E('div', { 'class': 'hub-form-grid' }, [
							H.field('名称', name), H.field('出口', target), H.field('规则集（每行一条）', sets, true)
						])
					]));
				}
				if (isHighlight) highlightEl = cardNode;
				return cardNode;
			});
			var feedbackEl = E('p', { 'class': 'hub-route-feedback', role: 'status' }, routeFeedback || '');
			var routeCard = E('section', { 'class': 'hub-form-section' }, [
				E('div', { 'class': 'hub-options-heading' }, [
					E('h3', {}, '分流服务与规则'),
					E('span', { 'class': 'hub-option-count' }, managed.routes.length ? '已添加 ' + managed.routes.length + ' 项' : '可按需添加')
				]),
				E('div', { 'class': 'hub-managed-picker' }, [
					E('label', { 'class': 'search hub-option-search' }, [UI.icon('search'), filterInput]),
					E('div', { 'class': 'hub-input-action' }, [service, addServiceBtn, UI.button('自定义', function() { addRoute({ name: '' }, true); }, '', 'plus')])
				]),
				feedbackEl
			].concat(routeNodes.length
				? [E('div', { 'class': 'hub-route-list' }, routeNodes)]
				: [E('p', { 'class': 'small muted', style: 'margin:12px 0 0' }, '未额外添加服务时，将沿用内置默认分流规则。')]));
			if (highlightEl) {
				highlightRoute = null;
				window.requestAnimationFrame(function() {
					if (highlightEl.isConnected) highlightEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				});
			}
			blocks.push(routeCard);

			var optionKeys = Object.keys(managedDefaults);
			var enabledOptCount = optionKeys.filter(function(key) {
				return Object.prototype.hasOwnProperty.call(managedOptions, key) ? !!managedOptions[key] : !!managedDefaults[key];
			}).length;
			var optSummaryText = E('span', { 'class': 'hub-option-count' });
			function syncOptSummary() {
				optSummaryText.textContent = (optionKeys.length ? enabledOptCount + ' / ' + optionKeys.length + ' 项开启 · ' : '') + (managedFoldOpen ? '收起' : '展开调整');
			}
			syncOptSummary();
			var optSearchInput = E('input', { 'class': 'field', type: 'search', placeholder: '筛选内置开关…', 'aria-label': '筛选内置开关' });
			optSearchInput.value = managedSearch;
			var optRows = Object.create(null);
			var optGrid = E('div', { 'class': 'hub-option-grid' }, optionKeys.map(function(key) {
				var value = Object.prototype.hasOwnProperty.call(managedOptions, key) ? !!managedOptions[key] : !!managedDefaults[key];
				var row = E('div', { 'class': 'hub-option' }, [
					E('span', {}, [UI.icon('settings'), E('strong', {}, key)]),
					H.toggle(value, key, function(next) {
						var prev = Object.prototype.hasOwnProperty.call(managedOptions, key) ? !!managedOptions[key] : !!managedDefaults[key];
						managedOptions[key] = next;
						if (next !== prev) enabledOptCount += next ? 1 : -1;
						syncOptSummary();
						changed();
					})
				]);
				optRows[key] = row;
				return row;
			}));
			function filterManagedOpts() {
				var q = managedSearch.trim().toLowerCase();
				optionKeys.forEach(function(key) { optRows[key].hidden = q && key.toLowerCase().indexOf(q) < 0; });
			}
			filterManagedOpts();
			optSearchInput.addEventListener('input', function() { managedSearch = optSearchInput.value; filterManagedOpts(); });
			var order = E('textarea', { 'class': 'field', rows: '2', placeholder: '每行一个策略组名称（留空按默认顺序）' });
			order.value = Array.isArray(managed.order) ? managed.order.join('\n') : '';
			order.addEventListener('input', function() {
				managed.order = Array.from(new Set(order.value.split('\n').map(function(value) { return value.trim(); }).filter(Boolean)));
				changed();
			});
			var fold = E('details', { 'class': 'hub-form-section hub-fold' });
			if (managedFoldOpen) fold.open = true;
			fold.addEventListener('toggle', function() { managedFoldOpen = fold.open; syncOptSummary(); });
			fold.append(
				E('summary', { 'class': 'hub-fold-summary' }, [
					E('span', { 'class': 'hub-fold-title' }, [E('strong', {}, '内置开关与策略组排序'), UI.icon('chevron')]),
					optSummaryText
				]),
				E('div', { 'class': 'hub-fold-body' }, (optionKeys.length ? [
					E('label', { 'class': 'search hub-option-search', style: 'margin-bottom:12px' }, [UI.icon('search'), optSearchInput]),
					optGrid
				] : []).concat([E('div', { style: 'margin-top:14px' }, [H.field('策略组顺序', order)])]))
			);
			blocks.push(fold);
			return blocks;
		}
		function routingControls() {
			var modeChoices = merged
				? [['managed', '托管分流'], ['script', '外部脚本']]
				: [['none', '不覆写'], ['managed', '托管分流'], ['script', '外部脚本']];
			var modeDescs = {
				none: '直接使用订阅原生的节点、策略组与规则，仅应用路由器通用设置与「高级 → 附加规则」。',
				managed: merged
					? '使用内置可视化托管引擎统一分流，修改地区或服务后保存将自动重新合并。'
					: '免写 JS 的可视化分流，按地区分组与服务目录自动生成策略组和规则。',
				script: merged
					? '合并订阅仅保留各成员节点与 DNS，并交由所选外部 JS 脚本生成策略组与规则。'
					: '从「脚本管理」选用第三方或自定义 JS 覆写脚本，并在此调整脚本开关。'
			};
			var switcher = E('div', { 'class': 'segmented hub-routing-mode', role: 'radiogroup', 'aria-label': '分流与覆写方式' }, modeChoices.map(function(item) {
				var activeMode = mode === item[0];
				var btn = E('button', { type: 'button', role: 'radio', 'aria-checked': String(activeMode), 'class': activeMode ? 'active' : '' }, item[1]);
				btn.addEventListener('click', function() {
					if (mode === item[0]) return;
					mode = item[0];
					useManaged = mode === 'managed';
					useScript = mode === 'script';
					if (mode === 'script' && !selected && scripts[0]) {
						selected = scripts[0].name;
						scriptSelect.value = selected;
					}
					changed();
					renderTab(false);
					if (mode === 'script') loadOptions(selected);
				});
				return btn;
			}));
			var headerCard = E('section', { 'class': 'hub-form-section' }, [
				E('div', { 'class': 'hub-options-heading' }, [E('h3', {}, '分流与覆写方式')]),
				switcher,
				E('p', { 'class': 'small muted hub-routing-desc' }, modeDescs[mode] || '')
			]);
			var out = [headerCard];
			if (mode === 'managed') {
				return out.concat(managedControls());
			}
			if (mode === 'script') {
				scriptSelect.disabled = false;
				var scriptFields = [H.field('选择脚本', scriptSelect)];
				if (!scripts.length) {
					scriptFields.push(E('p', { 'class': 'small muted', style: 'margin:10px 0 0' }, '暂未导入外部脚本，可前往「订阅 → 脚本管理」导入或新建 JS 覆写脚本。'));
				}
				out.push(E('section', { 'class': 'hub-form-section' }, scriptFields));
				out.push(optionsHost);
				return out;
			}
			out.push(E('section', { 'class': 'hub-form-section hub-disabled' }, '当前不启用额外分流脚本。如需临时补充少量规则，可在「高级 → 附加规则」中置顶添加。'));
			return out;
		}
		function renderTab(resetScroll) {
			Array.from(tabs.children).forEach(function(b) { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
			error.textContent = '';
			if (tab === 'basic') {
				var reveal = UI.button('显示', function() { url.type = url.type === 'password' ? 'text' : 'password'; reveal.querySelector('span').textContent = url.type === 'password' ? '显示' : '隐藏'; }, '', 'eye');
				var autoToggle = H.toggle(auto, '自动更新', function(value) { auto = value; interval.disabled = period.disabled = !value; changed(); }); interval.disabled = period.disabled = !auto;
				var infoFields = merged
					? [H.field('名称', label, true), E('p', { 'class': 'wide small muted', style: 'margin:0' }, '合并配置随成员订阅自动重建。')]
					: [H.field('名称', label), H.field('合并时的节点前缀', mergePrefix), H.field('订阅链接', E('div', { 'class': 'hub-input-action' }, [url, reveal]), true)];
				content.replaceChildren(section('订阅信息', [E('div', { 'class': 'hub-form-grid' }, infoFields)]),
					...(merged ? [] : [E('section', { 'class': 'hub-form-section' }, [E('div', { 'class': 'hub-setting-line' }, [E('h3', {}, '自动更新'), autoToggle]), E('div', { 'class': 'hub-form-grid' }, [H.field('更新周期', period), H.field('间隔（分钟）', interval)])])]), error);
			} else if (tab === 'routing') {
				content.replaceChildren.apply(content, routingControls().concat([error]));
				if (mode === 'script') drawOptions();
			} else {
				var remove = UI.button('删除订阅', function() {
					return H.confirm('删除订阅', '确定删除“' + (label.value || p.id) + '”？', '删除订阅', true).then(function(yes) {
						if (!yes) return; busy = true; box.setBusy(true);
						return deleteRPC(p.id).then(UI.checked).then(config.onSaved).then(function() { busy = false; box.setBusy(false); return box.close(true); }).catch(function(err) { error.textContent = err.message; }).finally(function() { busy = false; box.setBusy(false); });
					});
				}, 'danger', 'close'); remove.disabled = config.active; if (config.active) remove.title = '请先选用其他订阅';
				var advBlocks = [
					section('附加规则', [E('div', { 'class': 'hub-form-grid' }, [H.field('分流预设', preset), H.field('另存为分流预设', presetName), H.field('规则内容', rules, true)])]),
					section('全局托管共享规则', [
						E('p', { 'class': 'small muted', style: 'margin:0 0 10px' }, '对所有启用「内置托管脚本」或「合并订阅」的配置统一置顶追加规则；若目标策略组在某订阅中不存在，将自动回退到“默认代理”。'),
						H.field('共享规则（全局，每行一条）', sharedRules, true)
					])
				];
				if (!merged) {
					var skipToggle = H.toggle(skipCertVerify, '跳过 TLS 证书验证', function(value) { skipCertVerify = value; changed(); });
					advBlocks.push(section('下载设置', [
						E('div', { 'class': 'hub-setting-line' }, [
							E('div', { 'class': 'hub-setting-copy' }, [
								E('h4', { style: 'margin:0;font-size:14px' }, '跳过 TLS 证书验证'),
								E('p', { 'class': 'small muted', style: 'margin:2px 0 0' }, '仅用于自签证书或 TLS 握手异常的机场链接。')
							]),
							skipToggle
						]),
						E('div', { 'class': 'hub-form-grid' }, [
							H.field('下载方式', downloadMode),
							H.field('自定义 User-Agent', userAgent)
						])
					]));
				}
				advBlocks.push(E('section', { 'class': 'hub-form-section hub-delete-section' }, [E('h3', {}, '删除订阅'), remove]), error);
				content.replaceChildren.apply(content, advBlocks);
			}
			if (resetScroll === true) box.body.scrollTop = 0;
		}
		scriptSelect.addEventListener('change', function() { selected = scriptSelect.value; category = 'all'; search = ''; changed(); loadOptions(selected); });
		[['basic','基本信息'],['routing','分流与脚本'],['advanced','高级']].forEach(function(item) {
			var b = E('button', { type: 'button', role: 'tab', 'data-tab': item[0] }, item[1]); b.addEventListener('click', function() { tab = item[0]; renderTab(true); }); tabs.appendChild(b);
		});
		function save() {
			error.textContent = '';
			var intervalValue = Number(interval.value), options = selected ? entry(selected) : null;
			if (!label.value.trim()) { tab = 'basic'; renderTab(true); error.textContent = '请输入订阅名称'; return; }
			if (!merged && !/^(https?|file):\/\//.test(url.value.trim())) { tab = 'basic'; renderTab(true); error.textContent = '请输入有效的订阅链接'; return; }
			if (!merged && (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 10080)) { tab = 'basic'; renderTab(true); error.textContent = '更新间隔应为 1 至 10080 分钟'; return; }
			if (useScript && (!selected || !scripts.some(function(s) { return s.name === selected; }))) { tab = 'routing'; mode = 'script'; renderTab(false); error.textContent = '请选择存在的覆写脚本'; return; }
			if (useScript && !options.loaded && selected !== p.script) { tab = 'routing'; mode = 'script'; renderTab(false); error.textContent = '脚本开关尚未成功提取，请重试'; return; }
			if (useManaged) {
				var enabled = managed.routes.filter(function(route) { return route.enabled; });
				var regionNames = managed.customRegions.map(function(region) { return region.name; });
				if (new Set(regionNames).size !== regionNames.length || managed.customRegions.some(function(region) {
					if (!region.name || !region.regex || catalog && catalog.regions.some(function(item) { return item.name === region.name; })) return true;
					try { new RegExp(region.regex); return false; } catch (err) { return true; }
				})) {
					tab = 'routing'; mode = 'managed'; renderTab(false);
					error.textContent = '请检查自定义地区名称和正则';
					return;
				}
				var seenNames = Object.create(null);
				var badRoute = enabled.find(function(route) {
					var dup = !route.name || seenNames[route.name];
					if (route.name) seenNames[route.name] = true;
					return dup || !route.sets.length || (catalog && catalog.reserved.includes(route.name)) ||
						route.sets.some(function(set) { return !/^(?:(?:geosite|geoip):[A-Za-z0-9_@.!-]+|(?:domain|ipcidr):https?:\/\/\S+)$/.test(set); });
				});
				if (badRoute) {
					expandedRoute = badRoute;
					highlightRoute = badRoute;
					tab = 'routing';
					mode = 'managed';
					renderTab(false);
					error.textContent = '请检查分流名称和规则集';
					return;
				}
			}
			var list = rules.value.split('\n').map(function(v) { return v.trim(); }).filter(Boolean);
			var sharedList = sharedRules.value.split('\n').map(function(v) { return v.trim(); }).filter(Boolean);
			if (sharedList.length > 512) {
				error.textContent = '全局共享规则最多保存 512 条';
				return;
			}
			var newPreset = presetName.value.trim();
			if (newPreset && (!list.length || list.length > 512 || newPreset.length > 64 || /[\r\n]/.test(newPreset) ||
			    Object.prototype.hasOwnProperty.call(presets, newPreset) || Object.keys(presets).length >= 32)) {
				error.textContent = '预设需要唯一名称和 1 至 512 条规则，最多保存 32 个预设';
				return;
			}
			busy = true; box.setBusy(true); status.textContent = '正在保存…';
			uci.set('bettbox', p.id, 'label', label.value.trim());
			if (!merged) {
				uci.set('bettbox', p.id, 'url', url.value.trim());
				uci.set('bettbox', p.id, 'auto_update', auto ? '1' : '0');
				uci.set('bettbox', p.id, 'update_interval', String(intervalValue));
				if (mergePrefix.value.trim()) uci.set('bettbox', p.id, 'merge_prefix', mergePrefix.value.trim());
				else if (p.merge_prefix) uci.unset('bettbox', p.id, 'merge_prefix');
				if (downloadMode.value !== 'auto') uci.set('bettbox', p.id, 'download_mode', downloadMode.value);
				else uci.unset('bettbox', p.id, 'download_mode');
				if (skipCertVerify) uci.set('bettbox', p.id, 'skip_cert_verify', '1');
				else uci.unset('bettbox', p.id, 'skip_cert_verify');
				if (userAgent.value.trim()) uci.set('bettbox', p.id, 'user_agent', userAgent.value.trim());
				else uci.unset('bettbox', p.id, 'user_agent');
			}
			uci.set('bettbox', p.id, 'use_script', useScript ? '1' : '0'); uci.set('bettbox', p.id, 'script', selected);
			var routing = JSON.stringify(managed), routingOptions = JSON.stringify(managedOptions);
			var scriptModeChanged = merged && (useScript !== !!p.use_script);
			var regenerate = merged && (scriptModeChanged || (useManaged && (routing !== originalManaged || routingOptions !== originalManagedOptions)));
			if (useManaged !== !!p.use_managed || useManaged || regenerate) {
				uci.set('bettbox', p.id, 'use_managed', useManaged ? '1' : '0');
				uci.set('bettbox', p.id, 'managed_routing', routing);
				uci.set('bettbox', p.id, 'managed_options', routingOptions);
			}
			uci.set('bettbox', p.id, 'custom_options', JSON.stringify(options ? options.values : original));
			if (newPreset) {
				var currentPresets = Object.assign(Object.create(null), presets);
				currentPresets[newPreset] = list;
				uci.set('bettbox', 'config', 'rule_presets', JSON.stringify(currentPresets));
			}
			if (preset.value !== savedPreset) {
				if (preset.value) uci.set('bettbox', p.id, 'rule_preset', preset.value);
				else uci.unset('bettbox', p.id, 'rule_preset');
			}
			if (ruleTouched) {
				if (list.length) uci.set('bettbox', p.id, 'override_rules', JSON.stringify({ rules: list })); else uci.unset('bettbox', p.id, 'override_rules');
			}
			if (sharedRuleTouched) {
				if (sharedList.length) uci.set('bettbox', 'config', 'shared_managed_rules', JSON.stringify({ rules: sharedList })); else uci.unset('bettbox', 'config', 'shared_managed_rules');
			}
			return uci.save().then(function() { return commitRPC('bettbox'); }).then(function(res) {
				if (res && res.error) throw new Error('配置提交失败'); committed = true;
				if (regenerate) { status.textContent = '正在重新合并…'; return refreshMergeRPC(p.id, '0', '1', '1').then(UI.operation); }
				if (config.active) { status.textContent = '正在应用配置…'; return applyRPC().then(UI.operation); }
			}).then(config.onSaved).then(function() { busy = false; box.setBusy(false); dirty = false; return box.close(true); }).catch(function(err) {
				error.textContent = (committed ? '配置已保存，应用或刷新失败：' : '保存失败：') + err.message; status.textContent = '请检查后重试';
			}).finally(function() { busy = false; box.setBusy(false); if (box.element.isConnected) drawOptions(); });
		}
		var saveButton = UI.button(config.active ? '保存并应用' : '保存', save, 'primary', 'save');
		box = H.dialog('编辑订阅', [E('div', { 'class': 'hub-editor-context' }, [UI.badge(merged ? 'layers' : 'file', 'bb-small-icon', merged ? 'purple' : 'blue'), E('strong', {}, name), config.active ? UI.tag('当前使用') : '']), tabs, content], [status, E('div', {}, [UI.button('取消', function() { return box.close(); }), saveButton])], {
			drawer: true, beforeClose: function() { if (busy) return false; return !dirty || H.confirm('放弃修改', '订阅有未保存的修改，确定放弃？', '放弃修改', true); }
		});
		renderTab(true);
		if (tab === 'advanced' && (config.focus === 'shared' || config.focus === 'rules')) {
			var focusTarget = config.focus === 'shared' ? sharedRules : rules;
			window.requestAnimationFrame(function() {
				if (focusTarget.isConnected) {
					focusTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
					focusTarget.focus();
				}
			});
		}
		if (dirty) changed(); if (useScript) loadOptions(selected); return box;
	}
});
