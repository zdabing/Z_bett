'use strict';
'require baseclass';
'require rpc';
'require uci';
'require bettbox.core as Core';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';

var optionsRPC = rpc.declare({ object: 'bettbox', method: 'script_options', params: ['name'] });
var commitRPC = rpc.declare({ object: 'uci', method: 'commit', params: ['config'] });
var applyRPC = rpc.declare({ object: 'bettbox', method: 'apply' });
var deleteRPC = rpc.declare({ object: 'bettbox', method: 'del_profile', params: ['sid'] });

return baseclass.extend({
	open: function(config) {
		var p = config.profile, scripts = config.scripts, original = H.object(p.custom_options);
		var name = p.label || p.id, auto = !!p.auto_update, useScript = !!p.use_script;
		var selected = config.script || p.script || (scripts[0] && scripts[0].name) || '';
		if (config.script) useScript = true;
		var tab = config.tab || 'basic', dirty = !!config.script && (config.script !== p.script || !p.use_script), committed = false, ruleTouched = false;
		var cache = Object.create(null), category = 'all', search = '', box, busy = false;
		var error = E('div', { 'class': 'hub-error', role: 'alert' }), status = E('span', { 'class': 'hub-save-state', role: 'status' });
		var content = E('div', { 'class': 'hub-editor-content' }), optionsHost = E('div'), tabs = E('div', { 'class': 'hub-editor-tabs', role: 'tablist', 'aria-label': '订阅设置分区' });
		function changed() { dirty = true; status.textContent = '有未保存的修改'; }
		function input(value, type, attributes) {
			var el = E('input', Object.assign({ 'class': 'field', type: type || 'text' }, attributes || {})); el.value = value || '';
			el.addEventListener('input', changed); return el;
		}
		var label = input(name), url = input(p.url, 'password', { autocomplete: 'off' });
		var age = input(p.age_identity, 'password', { placeholder: '使用全局密钥', autocomplete: 'off' });
		var interval = input(String(p.update_interval || 1440), 'number', { min: '1', max: '10080', step: '1' });
		var period = E('select', { 'class': 'field', 'aria-label': '更新周期' }, [60, 360, 720, 1440].map(function(v) { return E('option', { value: String(v) }, '每 ' + (v / 60) + ' 小时'); }).concat([E('option', { value: 'custom' }, '自定义')]));
		function syncPeriod() { period.value = [60,360,720,1440].indexOf(+interval.value) >= 0 ? interval.value : 'custom'; }
		syncPeriod(); interval.addEventListener('input', syncPeriod);
		period.addEventListener('change', function() { if (period.value !== 'custom') interval.value = period.value; changed(); });
		var scriptSelect = E('select', { 'class': 'field', 'aria-label': '选择脚本' }, [E('option', { value: '' }, '选择脚本')].concat(scripts.map(function(s) { return E('option', { value: s.name }, s.name); })));
		if (selected && !scripts.some(function(s) { return s.name === selected; })) scriptSelect.appendChild(E('option', { value: selected }, selected + '（文件不存在）'));
		scriptSelect.value = selected;
		var oldRules = H.object(p.override_rules), rules = E('textarea', { 'class': 'field hub-rules mono', rows: '7', placeholder: 'DOMAIN-SUFFIX,example.com,DIRECT', 'aria-label': '规则内容' });
		rules.value = Array.isArray(oldRules.rules) ? oldRules.rules.join('\n') : '';
		var ruleMode = E('select', { 'class': 'field', 'aria-label': '规则处理方式' }, [E('option', { value: 'prepend' }, '追加在订阅规则之前'), E('option', { value: 'replace' }, '替换订阅规则')]); ruleMode.value = oldRules.mode === 'replace' ? 'replace' : 'prepend';
		[rules, ruleMode].forEach(function(el) { el.addEventListener('input', function() { ruleTouched = true; changed(); }); el.addEventListener('change', function() { ruleTouched = true; changed(); }); });

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
			if (!box || !box.element.isConnected || tab !== 'script' || busy) return;
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
		function renderTab() {
			Array.from(tabs.children).forEach(function(b) { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
			error.textContent = '';
			if (tab === 'basic') {
				var reveal = UI.button('显示', function() { url.type = url.type === 'password' ? 'text' : 'password'; reveal.querySelector('span').textContent = url.type === 'password' ? '显示' : '隐藏'; }, 'text', 'eye');
				var autoToggle = H.toggle(auto, '自动更新', function(value) { auto = value; interval.disabled = period.disabled = !value; changed(); }); interval.disabled = period.disabled = !auto;
				content.replaceChildren(section('订阅信息', [E('div', { 'class': 'hub-form-grid' }, [H.field('名称', label, true), H.field('订阅链接', E('div', { 'class': 'hub-input-action' }, [url, reveal]), true)])]),
					E('section', { 'class': 'hub-form-section' }, [E('div', { 'class': 'hub-setting-line' }, [E('h3', {}, '自动更新'), autoToggle]), E('div', { 'class': 'hub-form-grid' }, [H.field('更新周期', period), H.field('间隔（分钟）', interval)])]), error);
			} else if (tab === 'script') {
				scriptSelect.disabled = !useScript;
				content.replaceChildren(E('section', { 'class': 'hub-form-section' }, [E('div', { 'class': 'hub-setting-line' }, [E('h3', {}, '覆写脚本'), H.toggle(useScript, '启用覆写脚本', function(value) { useScript = value; scriptSelect.disabled = !value; changed(); if (value) loadOptions(selected); else drawOptions(); })]), H.field('选择脚本', scriptSelect)]), optionsHost, error); drawOptions();
			} else {
				var fetchRules = UI.button('读取当前规则', function() {
					return Core.get('/rules').then(function(res) {
						if (!res.data || !Array.isArray(res.data.rules)) throw new Error('核心未返回有效规则');
						rules.value = res.data.rules.map(function(r) { return [r.type, r.payload, r.proxy].filter(function(v) { return v != null && v !== ''; }).join(','); }).join('\n'); ruleMode.value = 'replace'; ruleTouched = true; changed();
					}).catch(function(err) { error.textContent = '读取失败：' + err.message; });
				}, 'text', 'download');
				var remove = UI.button('删除订阅', function() {
					return H.confirm('删除订阅', '确定删除“' + (label.value || p.id) + '”？', '删除订阅', true).then(function(yes) {
						if (!yes) return; busy = true; box.setBusy(true);
						return deleteRPC(p.id).then(UI.checked).then(config.onSaved).then(function() { busy = false; box.setBusy(false); return box.close(true); }).catch(function(err) { error.textContent = err.message; }).finally(function() { busy = false; box.setBusy(false); });
					});
				}, 'danger', 'close'); remove.disabled = config.active; if (config.active) remove.title = '请先选用其他订阅';
				content.replaceChildren(section('订阅加密', [H.field('age 密钥', age)]), E('section', { 'class': 'hub-form-section' }, [E('div', { 'class': 'hub-options-heading' }, [E('h3', {}, '自定义规则'), fetchRules]), H.field('规则处理方式', ruleMode), H.field('规则内容', rules)]), E('section', { 'class': 'hub-form-section hub-delete-section' }, [E('h3', {}, '删除订阅'), remove]), error);
			}
			box.body.scrollTop = 0;
		}
		scriptSelect.addEventListener('change', function() { selected = scriptSelect.value; category = 'all'; search = ''; changed(); loadOptions(selected); });
		[['basic','基本信息'],['script','脚本开关'],['advanced','高级']].forEach(function(item) {
			var b = E('button', { type: 'button', role: 'tab', 'data-tab': item[0] }, item[1]); b.addEventListener('click', function() { tab = item[0]; renderTab(); }); tabs.appendChild(b);
		});
		function save() {
			error.textContent = '';
			var intervalValue = Number(interval.value), options = selected ? entry(selected) : null;
			if (!label.value.trim()) { error.textContent = '请输入订阅名称'; return; }
			if (!/^(https?|file):\/\//.test(url.value.trim())) { error.textContent = '请输入有效的订阅链接'; return; }
			if (!Number.isInteger(intervalValue) || intervalValue < 1 || intervalValue > 10080) { error.textContent = '更新间隔应为 1 至 10080 分钟'; return; }
			if (useScript && (!selected || !scripts.some(function(s) { return s.name === selected; }))) { error.textContent = '请选择存在的覆写脚本'; return; }
			if (useScript && !options.loaded && selected !== p.script) { error.textContent = '脚本开关尚未成功提取，请重试'; return; }
			busy = true; box.setBusy(true); status.textContent = '正在保存…';
			uci.set('bettbox', p.id, 'label', label.value.trim()); uci.set('bettbox', p.id, 'url', url.value.trim());
			uci.set('bettbox', p.id, 'auto_update', auto ? '1' : '0'); uci.set('bettbox', p.id, 'update_interval', String(intervalValue));
			uci.set('bettbox', p.id, 'use_script', useScript ? '1' : '0'); uci.set('bettbox', p.id, 'script', selected);
			uci.set('bettbox', p.id, 'custom_options', JSON.stringify(options ? options.values : original));
			if (age.value.trim()) uci.set('bettbox', p.id, 'age_identity', age.value.trim()); else uci.unset('bettbox', p.id, 'age_identity');
			if (ruleTouched) {
				var list = rules.value.split('\n').map(function(v) { return v.trim(); }).filter(Boolean);
				if (list.length) uci.set('bettbox', p.id, 'override_rules', JSON.stringify({ mode: ruleMode.value, rules: list })); else uci.unset('bettbox', p.id, 'override_rules');
			}
			return uci.save().then(function() { return commitRPC('bettbox'); }).then(function(res) {
				if (res && res.error) throw new Error('配置提交失败'); committed = true;
				if (config.active) { status.textContent = '正在应用配置…'; return applyRPC().then(UI.operation); }
			}).then(config.onSaved).then(function() { busy = false; box.setBusy(false); dirty = false; return box.close(true); }).catch(function(err) {
				error.textContent = (committed ? '配置已保存，应用或刷新失败：' : '保存失败：') + err.message; status.textContent = '请检查后重试';
			}).finally(function() { busy = false; box.setBusy(false); if (box.element.isConnected) drawOptions(); });
		}
		var saveButton = UI.button(config.active ? '保存并应用' : '保存', save, 'primary', 'save');
		box = H.dialog('编辑订阅', [E('div', { 'class': 'hub-editor-context' }, [UI.icon('file'), E('strong', {}, name), config.active ? UI.tag('当前使用') : null]), tabs, content], [status, E('div', {}, [UI.button('取消', function() { return box.close(); }), saveButton])], {
			drawer: true, beforeClose: function() { if (busy) return false; return !dirty || H.confirm('放弃修改', '订阅有未保存的修改，确定放弃？', '放弃修改', true); }
		});
		renderTab(); if (dirty) changed(); if (useScript) loadOptions(selected); return box;
	}
});
