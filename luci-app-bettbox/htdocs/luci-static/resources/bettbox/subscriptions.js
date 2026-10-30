'use strict';
'require baseclass';
'require rpc';
'require uci';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';
'require bettbox.subscription-editor as Editor';
'require bettbox.script-manager as Scripts';

var profilesRPC = rpc.declare({ object: 'bettbox', method: 'get_profiles' });
var scriptsRPC = rpc.declare({ object: 'bettbox', method: 'get_scripts' });
var updateRPC = rpc.declare({ object: 'bettbox', method: 'update_profile', params: ['sid','all'] });
var addRPC = rpc.declare({ object: 'bettbox', method: 'add_profile', params: ['url','label'] });
var importRPC = rpc.declare({ object: 'bettbox', method: 'import_profile', params: ['content','label'] });
var commitRPC = rpc.declare({ object: 'uci', method: 'commit', params: ['config'] });
var applyRPC = rpc.declare({ object: 'bettbox', method: 'apply' });

function load(fresh) {
	if (fresh && uci.unload) uci.unload('bettbox');
	return Promise.all([profilesRPC(), scriptsRPC(), uci.load('bettbox')]).then(function(data) {
		if (!data[0] || data[0].error || !Array.isArray(data[0].profiles)) throw new Error((data[0] && data[0].error) || '无法读取订阅');
		if (!data[1] || data[1].error || !Array.isArray(data[1].scripts)) throw new Error((data[1] && data[1].error) || '无法读取脚本');
		return data;
	});
}
function mount() {
	[['bettbox-subscriptions-css','subscriptions.css'],['bettbox-scripts-css','scripts.css']].forEach(function(item) {
		if (!document.getElementById(item[0])) document.head.appendChild(E('link', { id: item[0], rel: 'stylesheet', href: L.resource('bettbox/' + item[1]) + '?v=20261030-2' }));
	});
}

return baseclass.extend({
	load: function() { return load(false); },
	render: function(data) {
		mount();
		var profiles = data[0].profiles, scripts = data[1].scripts, active = uci.get('bettbox','config','profile') || '';
		var section = new URLSearchParams(window.location.search).get('section') === 'scripts' ? 'scripts' : 'profiles';
		var panel = E('div', { id: 'bettbox-subscription-panel', role: 'tabpanel' }), tabs = E('div', { 'class': 'hub-tabs', role: 'tablist', 'aria-label': '订阅管理分区' });
		var summary = E('span', { 'class': 'hub-section-summary' }), notice = E('div', { 'class': 'hub-live-note', role: 'status' });
		var buttons = {}, manager = null, refreshing = null, busy = false, root, actions;
		function edit(p, script) { return Editor.open({ profile: p, scripts: scripts, active: p.id === active, tab: script ? 'script' : 'basic', script: script, onSaved: refresh }); }
		function scriptSettings(p) { return Editor.open({ profile: p, scripts: scripts, active: p.id === active, tab: 'script', onSaved: refresh }); }
		function createManager() {
			if (manager) manager.dispose();
			manager = Scripts.create({ scripts: scripts, profiles: profiles, notice: notice, onChanged: refresh, onConfigure: function(p, script) { if (script) edit(p, script); else scriptSettings(p); } });
		}
		function refresh() {
			if (refreshing) return refreshing;
			refreshing = load(true).then(function(next) {
				profiles = next[0].profiles; scripts = next[1].scripts; active = uci.get('bettbox','config','profile') || '';
				createManager(); draw();
			}).catch(function(err) { notice.textContent = '无法刷新，保留已有数据：' + err.message; throw err; }).finally(function() { refreshing = null; });
			return refreshing;
		}
		function update(id, all) {
			if (busy) return; busy = true; notice.textContent = '正在更新订阅…'; draw();
			return updateRPC(id, all ? '1' : '0').then(UI.checked).then(refresh).then(function() { notice.textContent = '订阅已更新'; }).catch(function(err) { notice.textContent = '更新失败：' + err.message; }).finally(function() { busy = false; draw(); });
		}
		function choose(p) {
			if (busy || p.id === active) return; busy = true; notice.textContent = '正在选用订阅…'; draw();
			uci.set('bettbox','config','profile',p.id);
			return uci.save().then(function() { return commitRPC('bettbox'); }).then(function(res) {
				if (res && res.error) throw new Error('配置提交失败'); return applyRPC().then(UI.operation);
			}).then(refresh).then(function() { notice.textContent = '已选用“' + (p.label || p.id) + '”'; }).catch(function(err) { notice.textContent = '选用失败，请刷新确认当前状态：' + err.message; }).finally(function() { busy = false; draw(); });
		}
		function add() {
			var name = E('input', { 'class': 'field', placeholder: '订阅名称（可选）', 'aria-label': '订阅名称' });
			var url = E('input', { 'class': 'field', type: 'url', placeholder: 'https://…', 'aria-label': '订阅链接' });
			var method = E('select', { 'class': 'field', 'aria-label': '添加方式' }, [E('option', { value: 'url' }, '订阅链接'), E('option', { value: 'content' }, '粘贴导入')]);
			var content = E('textarea', { 'class': 'field mono', rows: '7', 'aria-label': '导入内容', placeholder: '粘贴 Clash YAML、分享链接或 Base64 内容', spellcheck: 'false' });
			var urlField = H.field('订阅链接', url), contentField = H.field('导入内容', content); contentField.hidden = true;
			var error = E('div', { 'class': 'hub-error', role: 'alert' }), box;
			method.addEventListener('change', function() { urlField.hidden = method.value === 'content'; contentField.hidden = method.value !== 'content'; error.textContent = ''; });
			box = H.dialog('添加订阅', [H.field('名称', name), H.field('添加方式', method), urlField, contentField, error], [UI.button('取消', function() { return box.close(); }), UI.button('添加订阅', function() {
				var pasted = method.value === 'content', value = pasted ? content.value.trim() : url.value.trim();
				if (pasted ? !value : !/^(https?|file):\/\//.test(value)) { error.textContent = pasted ? '请粘贴要导入的内容' : '请输入有效的订阅链接'; return; }
				if (pasted && new Blob([value]).size > 1048576) { error.textContent = '导入内容超过 1 MiB 上限'; return; }
				box.setBusy(true); error.textContent = '';
				return (pasted ? importRPC(value, name.value.trim()) : addRPC(value, name.value.trim())).then(UI.checked).then(refresh).then(function() { box.setBusy(false); return box.close(true); }).catch(function(err) { error.textContent = '添加失败：' + err.message; }).finally(function() { box.setBusy(false); });
			}, 'primary', 'plus')]);
		}
		function card(p) {
			var current = p.id === active, used = (+p.sub_upload || 0) + (+p.sub_download || 0), total = +p.sub_total || 0;
			var percent = total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;
			var formatted = UI.bytes(used).split(' '), expiry = p.sub_expire > 0 ? new Date(p.sub_expire * 1000).toLocaleDateString() : '未提供';
			function fact(label, value, mono) { return E('div', {}, [E('span', {}, label), E('strong', { 'class': mono ? 'mono' : '' }, value)]); }
			var select = current ? E('span', { 'class': 'hub-current-label' }, [UI.icon('check'), document.createTextNode('当前使用')]) : UI.button('选用', function() { return choose(p); }, 'soft');
			if (!current) select.disabled = busy;
			var updateButton = UI.button('更新', function() { return update(p.id, false); }, '', 'refresh'); updateButton.disabled = busy;
			var scriptLink = E('button', { type: 'button', 'class': 'hub-script-link', 'aria-label': '配置' + (p.label || p.id) + '的覆写脚本' }, [E('span', {}, [UI.icon('code'), E('span', {}, '覆写脚本')]), E('strong', {}, p.use_script ? p.script || '未选择脚本' : '未启用'), UI.icon('chevron')]);
			scriptLink.addEventListener('click', function() { scriptSettings(p); });
			return E('article', { 'class': 'panel hub-profile' + (current ? ' current' : ''), 'data-profile-id': p.id }, [
				E('div', { 'class': 'hub-card-top' }, [E('div', { 'class': 'hub-name' }, [E('span', { 'class': 'hub-icon' }, UI.icon('file')), E('h2', {}, p.label || p.id)]), UI.tag(current ? '当前使用' : '未选用', current ? '' : 'neutral')]),
				E('div', { 'class': 'hub-usage' }, [E('div', {}, [E('span', { 'class': 'label' }, '已用流量'), E('div', { 'class': 'hub-number' }, total > 0 ? [document.createTextNode(formatted[0]), E('small', {}, [document.createTextNode(formatted[1]), E('span', {}, ' / ' + UI.bytes(total))])] : E('span', { 'class': 'hub-no-usage' }, '未提供用量'))]), total > 0 ? E('span', { 'class': 'hub-usage-percent mono' }, percent.toFixed(1) + '%') : '']),
				E('div', { 'class': 'progress' }, E('i', { style: 'width:' + percent + '%' })),
				E('div', { 'class': 'hub-profile-facts' }, [fact('下载 / 上传', UI.bytes(p.sub_download || 0) + ' / ' + UI.bytes(p.sub_upload || 0), true), fact('到期时间', expiry), fact('自动更新', p.auto_update ? '每 ' + p.update_interval + ' 分钟' : '手动更新'), fact('上次更新', p.last_update > 0 ? new Date(p.last_update * 1000).toLocaleString() : '未更新')]), scriptLink,
				E('div', { 'class': 'hub-card-actions' }, [E('div', {}, select), E('div', {}, [updateButton, UI.button('编辑订阅', function() { edit(p); }, '', 'edit')])])]);
		}
		function draw() {
			if (!root) return;
			Object.keys(buttons).forEach(function(key) { var b = buttons[key]; b.querySelector('span').textContent = key === 'profiles' ? '订阅管理' : '脚本管理'; b.querySelector('em').textContent = String(key === 'profiles' ? profiles.length : scripts.length); b.classList.toggle('active', section === key); b.setAttribute('aria-selected', String(section === key)); });
			var selected = profiles.find(function(p) { return p.id === active; }); summary.textContent = section === 'profiles' ? '当前使用 · ' + (selected ? selected.label || selected.id : '未选用') : '按订阅配置开关';
			panel.setAttribute('aria-labelledby', buttons[section].id);
			if (section === 'scripts') {
				panel.replaceChildren(manager.element); actions.replaceChildren(UI.button('导入脚本', manager.add, 'primary', 'plus')); manager.activate();
				if (!root.isConnected) window.requestAnimationFrame(function() { if (root.isConnected && section === 'scripts') manager.activate(); });
			}
			else {
				var updateAll = UI.button('更新全部', function() { return update('', true); }, '', 'refresh'); updateAll.disabled = busy || !profiles.length;
				actions.replaceChildren(updateAll, UI.button('添加订阅', add, 'primary', 'plus'));
				panel.replaceChildren(profiles.length ? E('div', { 'class': 'hub-grid' }, profiles.map(card)) : E('section', { 'class': 'panel hub-empty' }, [E('span', { 'class': 'hub-icon' }, UI.icon('file')), E('h2', {}, '还没有订阅'), UI.button('添加订阅', add, 'primary', 'plus')]));
			}
		}
		[['profiles','订阅管理'],['scripts','脚本管理']].forEach(function(item) {
			var b = E('button', { type: 'button', role: 'tab', id: 'bettbox-sub-tab-' + item[0], 'aria-controls': panel.id }, [E('span', {}, item[1]), E('em', {}, '0')]); buttons[item[0]] = b;
			b.addEventListener('click', function() { section = item[0]; var url = new URL(window.location.href); url.searchParams.set('section', section); window.history.replaceState({}, '', url.href); draw(); }); tabs.appendChild(b);
		});
		createManager(); root = UI.page('profiles', '订阅', [], [E('div', { 'class': 'subscription-hub' }, [E('div', { 'class': 'hub-section-bar' }, [tabs, summary]), notice, panel])]);
		actions = root.querySelector('.heading-actions'); draw(); return root;
	}
});
