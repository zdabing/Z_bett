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
var updateRPC = rpc.declare({ object: 'bettbox', method: 'update_profile', params: ['sid','all','background'] });
var addRPC = rpc.declare({ object: 'bettbox', method: 'add_profile', params: ['url','label'] });
var importRPC = rpc.declare({ object: 'bettbox', method: 'import_profile', params: ['content','label'] });
var mergeRPC = rpc.declare({ object: 'bettbox', method: 'merge_profile', params: ['action','sid','label','members'] });
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
	[['bettbox-subscriptions-css','subscriptions.css','20261118-4'],['bettbox-scripts-css','scripts.css','20261114-3']].forEach(function(item) {
		if (!document.getElementById(item[0])) document.head.appendChild(E('link', { id: item[0], rel: 'stylesheet', href: L.resource('bettbox/' + item[1]) + '?v=' + item[2] }));
	});
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function formatDate(ts) {
	if (!ts || ts <= 0) return '';
	var d = new Date(ts * 1000);
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function formatRelative(ts) {
	if (!ts || ts <= 0) return '未更新';
	var diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
	if (diff < 60) return '刚刚';
	if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
	if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
	if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
	return formatDate(ts);
}
function formatInterval(mins) {
	var m = +mins || 1440;
	return m >= 60 && m % 60 === 0 ? '每 ' + (m / 60) + ' 小时' : '每 ' + m + ' 分钟';
}
function ringSvg(percent, hasTotal) {
	var r = 15, circ = 2 * Math.PI * r;
	var clamped = hasTotal ? Math.max(0, Math.min(100, percent)) : 0;
	var offset = circ * (1 - clamped / 100);
	var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 40 40');
	svg.setAttribute('aria-hidden', 'true');
	svg.innerHTML = '<circle class="track" cx="20" cy="20" r="15"/><circle class="fill" cx="20" cy="20" r="15" stroke-dasharray="' + circ.toFixed(2) + '" stroke-dashoffset="' + offset.toFixed(2) + '"/>';
	return E('div', { 'class': 'hub-ring' + (hasTotal ? '' : ' empty') }, [svg, E('span', {}, hasTotal ? Math.round(clamped) + '%' : '—')]);
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
			return updateRPC(id, all ? '1' : '0', '1').then(UI.operation).then(function(result) {
				return refresh().then(function() {
					var report;
					try { report = JSON.parse(result.text); } catch (err) {}
					notice.textContent = report && report.failed ? '合并完成，跳过 ' + report.failed + ' 个无法处理的成员' : '订阅已更新';
				});
			}).catch(function(err) { notice.textContent = '更新失败：' + err.message; }).finally(function() { busy = false; draw(); });
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
		function card(p, byId) {
			var current = p.id === active, memberIds = p.merge_members || [], merged = memberIds.length > 0;
			var local = !merged && /^file:\/\//.test(p.url || '');
			var members = merged ? memberIds.map(function(id) { return byId[id] || { id: id, label: id, missing: true }; }) : [];
			var expiryTs = merged ? members.reduce(function(min, m) {
				var t = +m.sub_expire || 0;
				return t > 0 && (!min || t < min) ? t : min;
			}, 0) : (+p.sub_expire || 0);
			var expiryText = expiryTs > 0 ? formatDate(expiryTs) : (local ? '本地文件' : '');
			var updatedLabel = formatRelative(p.last_update);
			var updatedTitle = p.last_update > 0 ? new Date(p.last_update * 1000).toLocaleString() : '';

			var bodyNode;
			var sublineText;
			if (merged) {
				bodyNode = E('div', { 'class': 'hub-merge-grid' }, members.map(function(m) {
					var mUsed = (+m.sub_upload || 0) + (+m.sub_download || 0), mTotal = +m.sub_total || 0;
					var mPct = mTotal > 0 ? Math.max(0, Math.min(100, mUsed / mTotal * 100)) : 0;
					var mText = m.missing ? '成员已删除或缺失'
						: mTotal > 0 ? UI.bytes(mUsed) + ' / ' + UI.bytes(mTotal)
						: mUsed > 0 ? UI.bytes(mUsed) + ' / Unlimited'
						: '无用量统计';
					return E('div', { 'class': 'hub-merge-tile', title: (m.label || m.id) + ' · ' + mText }, [
						ringSvg(mPct, !m.missing && mTotal > 0),
						E('div', { 'class': 'hub-merge-tile-info' }, [
							E('strong', {}, m.label || m.id),
							E('span', {}, mText)
						])
					]);
				}));
				var parts = ['合并 ' + members.length + ' 个配置'];
				if (+p.merge_proxies > 0) parts.push(p.merge_proxies + ' 个节点');
				parts.push(updatedLabel);
				sublineText = parts.join(' · ');
			} else {
				var used = (+p.sub_upload || 0) + (+p.sub_download || 0), total = +p.sub_total || 0;
				var percent = total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;
				var hasTraffic = used > 0 || total > 0;
				bodyNode = hasTraffic
					? E('div', { 'class': 'hub-usage-row' }, [
						E('div', { 'class': 'progress' }, E('i', { style: 'width:' + percent + '%' })),
						E('div', { 'class': 'hub-usage-meta' }, [
							E('span', {}, UI.bytes(used) + ' / ' + (total > 0 ? UI.bytes(total) : 'Unlimited')),
							total > 0 ? E('strong', {}, percent.toFixed(1) + '%') : ''
						])
					])
					: E('div', { 'class': 'hub-usage-empty' }, '无用量统计');
				var modeText = local ? '本地导入' : (p.auto_update ? '自动更新 · ' + formatInterval(p.update_interval) : '手动更新');
				sublineText = modeText + ' · ' + updatedLabel;
			}

			var overrideLabel = p.use_managed ? '托管分流' : (p.use_script ? ('脚本: ' + (p.script || '未选择')) : '覆写: 未启用');
			var scriptPill = E('button', {
				type: 'button',
				'class': 'hub-script-pill' + (p.use_managed || p.use_script ? ' active' : ''),
				'aria-label': '配置' + (p.label || p.id) + '的覆写脚本或托管分流'
			}, [UI.icon('code'), E('span', {}, overrideLabel)]);
			scriptPill.addEventListener('click', function() { if (p.use_managed) edit(p); else scriptSettings(p); });

			var btns = [];
			if (!current) {
				var chooseBtn = UI.button('选用', function() { return choose(p); }, 'soft');
				chooseBtn.disabled = busy;
				btns.push(chooseBtn);
			}
			var updateButton = UI.button(merged ? '重新合并' : '更新', function() { return update(p.id, false); }, '', 'refresh');
			updateButton.disabled = busy;
			btns.push(updateButton);
			if (merged) {
				var membersBtn = UI.button('成员', function() { return mergeProfiles(p); }, '', 'layers');
				membersBtn.disabled = busy;
				btns.push(membersBtn);
			}
			var editBtn = UI.button('编辑', function() { edit(p); }, '', 'edit');
			editBtn.disabled = busy;
			btns.push(editBtn);

			return E('article', { 'class': 'panel hub-profile' + (current ? ' current' : ''), 'data-profile-id': p.id }, [
				E('div', { 'class': 'hub-card-top' }, [
					E('div', { 'class': 'hub-name' }, [
						E('span', { 'class': 'hub-icon bb-icon-badge ' + (merged ? 'bb-tint-purple' : local ? 'bb-tint-teal' : 'bb-tint-blue') }, UI.icon(merged ? 'layers' : 'file')),
						E('div', { 'class': 'hub-name-text' }, [
							E('h2', {}, p.label || p.id),
							expiryText ? E('span', { 'class': 'hub-expiry' }, '· ' + expiryText) : ''
						])
					]),
					current ? E('div', { 'class': 'hub-card-top-right' }, [E('span', { 'class': 'tag hub-active-tag' }, [UI.icon('check'), E('span', {}, '已选用')])]) : ''
				]),
				bodyNode,
				E('div', { 'class': 'hub-subline', title: updatedTitle }, sublineText),
				E('div', { 'class': 'hub-card-actions' }, [
					scriptPill,
					E('div', { 'class': 'hub-card-btns' }, btns)
				])
			]);
		}
		function mergeProfiles(profile) {
			var eligible = profiles.filter(function(p) { return p.file && !(p.merge_members || []).some(Boolean); });
			var label = E('input', { 'class': 'field', placeholder: '合并订阅', 'aria-label': '合并订阅名称' });
			if (profile) label.value = profile.label || '';
			var list = E('div', { 'class': 'hub-merge-list' }), status = E('p', { 'class': 'hub-merge-preview', role: 'status' }), countHint = E('span', { 'class': 'hub-merge-count' }), rows = [], box;
			var addButton = UI.button('添加成员', function() { addMember(); }, '', 'plus');
			function syncRows() {
				rows.forEach(function(item, idx) {
					item.badge.textContent = idx === 0 ? '#1 主规则' : '#' + (idx + 1);
					item.select.setAttribute('aria-label', '成员 ' + (idx + 1));
					item.up.disabled = idx === 0;
					item.down.disabled = idx === rows.length - 1;
					item.del.disabled = rows.length <= 2;
				});
				var maxMembers = Math.min(8, eligible.length);
				addButton.disabled = rows.length >= maxMembers;
				countHint.textContent = '已选 ' + rows.length + ' / ' + maxMembers + ' 个成员（至少 2 个）';
			}
			function moveRow(item, delta) {
				var idx = rows.indexOf(item), next = idx + delta;
				if (idx < 0 || next < 0 || next >= rows.length) return;
				rows.splice(idx, 1);
				rows.splice(next, 0, item);
				rows.forEach(function(r) { list.appendChild(r.row); });
				status.textContent = '';
				syncRows();
			}
			function addMember(id) {
				var usedIds = rows.map(function(r) { return r.select.value; });
				var chosenId = id !== undefined ? id : ((eligible.find(function(p) { return usedIds.indexOf(p.id) < 0; }) || {}).id || '');
				var badge = E('span', { 'class': 'hub-merge-badge' });
				var select = E('select', { 'class': 'field' }, [E('option', { value: '' }, '请选择订阅')].concat(eligible.map(function(p) {
					return E('option', { value: p.id }, p.label || p.id);
				})));
				select.value = chosenId || '';
				var item = { badge: badge, select: select };
				item.up = UI.button('上移', function() { moveRow(item, -1); }, 'bb-icon-only', 'up');
				item.down = UI.button('下移', function() { moveRow(item, 1); }, 'bb-icon-only', 'down');
				item.del = UI.button('移除', function() {
					if (rows.length <= 2) return;
					rows = rows.filter(function(r) { return r !== item; });
					item.row.remove();
					status.textContent = '';
					syncRows();
				}, 'bb-icon-only', 'close');
				item.row = E('div', { 'class': 'hub-merge-row' }, [badge, select, E('div', { 'class': 'hub-merge-row-actions' }, [item.up, item.down, item.del])]);
				rows.push(item);
				list.appendChild(item.row);
				select.addEventListener('change', function() { status.textContent = ''; });
				syncRows();
			}
			function submit(action) {
				var ids = rows.map(function(item) { return item.select.value; });
				if (ids.some(function(id) { return !id; }) || new Set(ids).size !== ids.length) {
					status.textContent = '请为每个位置选择不同的订阅';
					return;
				}
				box.setBusy(true);
				status.textContent = action === 'preview' ? '正在生成预览…' : '正在校验并保存…';
				return mergeRPC(action, profile ? profile.id : '', label.value.trim(), JSON.stringify(ids)).then(UI.operation).then(UI.checked).then(function(job) {
					if (action !== 'preview') return refresh().then(function() { box.setBusy(false); return box.close(true); });
					var result = JSON.parse(job.text);
					status.textContent = '节点 ' + result.proxies + ' 个，策略组 ' + result.groups + ' 个';
					if (result.duplicates) status.textContent += '，已去重 ' + result.duplicates + ' 个节点';
					if (result.conflicts) status.textContent += '，' + result.conflicts + ' 项 DNS 或 hosts 冲突沿用靠前成员';
					if (result.failed) status.textContent += '，跳过 ' + result.failed + ' 个无法处理的成员';
				}).catch(function(err) { status.textContent = err.message; }).finally(function() { box.setBusy(false); });
			}
			(profile ? profile.merge_members : ['', '']).forEach(addMember);
			box = H.dialog('合并订阅', [
				E('p', { 'class': 'hub-merge-intro' }, '按顺序选择成员：#1 主规则提供路由规则与 DNS，其余成员补充节点和策略组。'),
				H.field('名称', label),
				list,
				E('div', { 'class': 'hub-merge-add-bar' }, [addButton, countHint]),
				status
			], [
				UI.button('取消', function() { return box.close(); }),
				UI.button('预览', function() { return submit('preview'); }),
				UI.button('保存合并订阅', function() { return submit(profile ? 'edit' : 'create'); }, 'primary', 'save')
			]);
		}
		function draw() {
			if (!root) return;
			Object.keys(buttons).forEach(function(key) { var b = buttons[key]; b.querySelector('span').textContent = key === 'profiles' ? '订阅管理' : '脚本管理'; b.querySelector('em').textContent = String(key === 'profiles' ? profiles.length : scripts.length); b.classList.toggle('active', section === key); b.setAttribute('aria-selected', String(section === key)); });
			var selected = profiles.find(function(p) { return p.id === active; }); summary.textContent = section === 'profiles' ? '当前使用 · ' + (selected ? selected.label || selected.id : '未选用') : '按订阅配置开关';
			panel.setAttribute('aria-labelledby', buttons[section].id);
			if (section === 'scripts') {
				panel.replaceChildren(manager.element); actions.replaceChildren(UI.button('导入脚本', function() { manager.add(); }, 'primary', 'plus')); manager.activate();
				if (!root.isConnected) window.requestAnimationFrame(function() { if (root.isConnected && section === 'scripts') manager.activate(); });
			}
			else {
				var byId = Object.create(null);
				profiles.forEach(function(item) { byId[item.id] = item; });
				var updateAll = UI.button('更新全部', function() { return update('', true); }, '', 'refresh'); updateAll.disabled = busy || !profiles.length;
				var merge = UI.button('合并订阅', function() { return mergeProfiles(); }, '', 'layers');
				merge.disabled = busy || profiles.filter(function(p) { return p.file && !(p.merge_members || []).some(Boolean); }).length < 2;
				actions.replaceChildren(updateAll, merge, UI.button('添加订阅', add, 'primary', 'plus'));
				panel.replaceChildren(profiles.length ? E('div', { 'class': 'hub-grid' }, profiles.map(function(p) { return card(p, byId); })) : E('section', { 'class': 'panel hub-empty' }, [E('span', { 'class': 'hub-icon' }, UI.icon('file')), E('h2', {}, '还没有订阅'), UI.button('添加订阅', add, 'primary', 'plus')]));
			}
		}
		[['profiles','订阅管理'],['scripts','脚本管理']].forEach(function(item) {
			var b = E('button', { type: 'button', role: 'tab', id: 'bettbox-sub-tab-' + item[0], 'aria-controls': panel.id }, [E('span', {}, item[1]), E('em', {}, '0')]); buttons[item[0]] = b;
			b.addEventListener('click', function() { section = item[0]; var url = new URL(window.location.href); url.searchParams.set('section', section); window.history.replaceState({}, '', url.href); draw(); }); tabs.appendChild(b);
		});
		createManager();
		actions = E('div', { 'class': 'button-row hub-section-actions' });
		root = UI.page('profiles', '订阅', [], [E('div', { 'class': 'subscription-hub' }, [E('div', { 'class': 'hub-section-bar' }, [E('div', { 'class': 'hub-section-left' }, [tabs, summary]), actions]), notice, panel])]);
		draw(); return root;
	}
});
