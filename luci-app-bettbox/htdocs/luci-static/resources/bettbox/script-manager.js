'use strict';
'require baseclass';
'require rpc';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';

var getScript = rpc.declare({ object: 'bettbox', method: 'get_script', params: ['name'] });
var saveScript = rpc.declare({ object: 'bettbox', method: 'save_script', params: ['name', 'content', 'create_only'] });
var delScript = rpc.declare({ object: 'bettbox', method: 'del_script', params: ['name'] });
var scriptOptions = rpc.declare({ object: 'bettbox', method: 'script_options', params: ['name'] });
var importURL = rpc.declare({ object: 'bettbox', method: 'import_script_url', params: ['url', 'name'] });
var setSource = rpc.declare({ object: 'bettbox', method: 'set_script_source', params: ['name', 'url'] });
var checkScript = rpc.declare({ object: 'bettbox', method: 'script_check', params: ['name'] });
var updateScript = rpc.declare({ object: 'bettbox', method: 'script_update', params: ['name', 'token'] });
var TEMPLATE = '// const Compatible_With_Bettbox = { ruleOptionsEnable: true };\nfunction main(config) {\n  return config;\n}\n';

function normalizeName(name) { return name.trim().replace(/\.js$/i, '').normalize('NFC'); }
function validName(name) {
	return !!name && name === name.trim() && name.charAt(0) !== '.' && new TextEncoder().encode(name).length <= 192 && /^[A-Za-z0-9_.\-\u0080-\uFFFF ]+$/.test(name);
}
function address(value) {
	var url; try { url = new URL(value.trim()); } catch (e) { throw new Error('请输入有效的 http(s) 链接'); }
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('请输入有效的 http(s) 链接');
	return url.href;
}
function jobResult(promise) {
	return promise.then(UI.operation).then(function(result) {
		if (result.text != null) { try { return UI.checked(JSON.parse(result.text)); } catch (e) { throw new Error('脚本任务返回无效结果'); } }
		return UI.checked(result);
	});
}
function ago(value) {
	var elapsed = Math.max(0, Date.now() - new Date(value).getTime());
	if (!isFinite(elapsed)) return '更新时间未知';
	if (elapsed < 60000) return '刚刚';
	if (elapsed < 3600000) return Math.floor(elapsed / 60000) + ' 分钟前';
	if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + ' 小时前';
	return Math.floor(elapsed / 86400000) + ' 天前';
}
function versionCard(source, size) {
	var stamp = source.committed_at || source.last_modified;
	return E('section', { 'class': 'bb-script-version', 'aria-label': '脚本版本' }, [
		E('div', { 'class': 'bb-script-version-head' }, [E('strong', { 'class': 'mono bb-script-version-id', title: source.commit ? 'Git 提交' : 'SHA-256' }, source.commit || source.sha256 || '版本信息未提供'),
			E('span', { 'class': 'muted', title: stamp ? new Date(stamp).toLocaleString() : '' }, stamp ? '上游更新 ' + ago(stamp) : '上游更新时间未提供')]),
		E('p', { 'class': 'bb-script-version-message' }, source.message ? String(source.message).split('\n')[0] : '上游未提供提交说明'),
		E('div', { 'class': 'bb-script-version-facts' }, [E('span', {}, ['脚本：', E('strong', { 'class': 'mono' }, UI.bytes(size == null ? source.size : size))]),
			E('span', {}, ['脚本开关：', E('strong', {}, source.options_count == null ? '未提取' : source.options_count + ' 项')]), source.modified ? UI.tag('本地已修改', 'neutral') : null])]);
}

return baseclass.extend({
	create: function(config) {
		var scripts = config.scripts, profiles = config.profiles, host = E('div', { 'class': 'hub-grid' });
		var busy = Object.create(null), counts = Object.create(null), countNodes = Object.create(null), queueStarted = false, disposed = false;
		var notice = config.notice;
		function related(name) { return profiles.filter(function(p) { return p.use_script && p.script === name; }); }
		function report(text) { notice.textContent = text; }
		function refresh() { return config.onChanged(); }
		function complete(box) { box.setBusy(false); return box.close(true); }
		function sourceDialog(item, thenCheck) {
			var url = E('input', { 'class': 'field', type: 'url', placeholder: 'https://…/script.js', 'aria-label': '更新来源' }); url.value = item.source ? item.source.url : '';
			var error = E('div', { 'class': 'hub-error', role: 'alert' }), box;
			box = H.dialog('脚本更新来源', [H.field('来源链接', url), error], [UI.button('取消', function() { return box.close(); }), UI.button('保存来源', function() {
				var value; try { value = address(url.value); } catch (e) { error.textContent = e.message; return; }
				box.setBusy(true); error.textContent = '';
				return setSource(item.name, value).then(UI.checked).then(function(result) { return refresh().then(function() { return complete(box).then(function() { if (thenCheck) return check(result.script); }); }); }).catch(function(err) { error.textContent = err.message; }).finally(function() { box.setBusy(false); });
			}, 'primary', 'save')]);
		}
		function check(item) {
			if (!item.source) { sourceDialog(item, true); return; }
			if (busy[item.name]) return;
			busy[item.name] = true; report('正在检查“' + item.name + '”…'); draw();
			return jobResult(checkScript(item.name)).then(function(result) {
				report(result.available ? '发现脚本更新' : '脚本内容已是最新');
				var error = E('div', { 'class': 'hub-error', role: 'alert' }), box;
				var children = [E('p', {}, result.available ? '发现可用更新' : '当前已是最新内容'), versionCard(result.latest, result.latest.size)];
				if (result.local_modified && result.available) children.push(E('p', { 'class': 'hub-error' }, '本地脚本有修改，更新会替换本地内容。'));
				children.push(error);
				var actions = [UI.button('关闭', function() { return box.close(); })];
				if (result.available) actions.push(UI.button('更新脚本', function() {
					box.setBusy(true); error.textContent = '';
					return jobResult(updateScript(item.name, result.token)).then(refresh).then(function() { report('脚本已更新'); return complete(box); }).catch(function(err) { error.textContent = err.message; }).finally(function() { box.setBusy(false); });
				}, 'primary', 'refresh'));
				box = H.dialog('脚本更新', children, actions);
			}).catch(function(err) { report('检查失败：' + err.message); }).finally(function() { busy[item.name] = false; if (!disposed) draw(); });
		}
		function editCode(item, initialName) {
			var original = null, dirty = false, saving = false, box;
			var name = E('input', { 'class': 'field', 'aria-label': '脚本名称' }); name.value = item ? item.name : initialName || ''; name.readOnly = !!item;
			var code = E('textarea', { 'class': 'field hub-code mono', rows: '16', spellcheck: 'false', 'aria-label': '脚本代码' }); code.value = item ? '' : TEMPLATE; code.disabled = !!item;
			var error = E('div', { 'class': 'hub-error', role: 'alert' }), loading = E('div', { 'class': 'hub-save-state', role: 'status' }, item ? '正在读取脚本…' : '');
			[name, code].forEach(function(el) { el.addEventListener('input', function() { dirty = true; }); });
			var save = UI.button('保存脚本', function() {
				var value = normalizeName(name.value);
				if (!validName(value)) { error.textContent = '请输入有效的脚本名称'; return; }
				if (!item && scripts.some(function(s) { return s.name === value; })) { error.textContent = '已存在同名脚本'; return; }
				if (new TextEncoder().encode(code.value).length > 524288) { error.textContent = '脚本不能超过 512 KB'; return; }
				saving = true; box.setBusy(true); error.textContent = '';
				return saveScript(value, code.value, item ? '0' : '1').then(UI.checked).then(refresh).then(function() { dirty = false; report('脚本已保存'); return complete(box); }).catch(function(err) { error.textContent = err.message; }).finally(function() { saving = false; box.setBusy(false); });
			}, 'primary', 'save'); save.disabled = !!item;
			box = H.dialog(item ? '编辑代码' : '新建代码', [H.field('脚本名称', name), loading, H.field('JavaScript', code), error], [UI.button('取消', function() { return box.close(); }), save], {
				beforeClose: function() { return !saving && (!dirty || H.confirm('放弃修改', '代码有未保存的修改，确定放弃？', '放弃修改', true)); }
			});
			if (item) getScript(item.name).then(function(result) {
				if (result.error || typeof result.content !== 'string') throw new Error(result.error || '脚本内容无效');
				original = result.content; if (!box.element.isConnected) return;
				code.value = original; code.disabled = false; save.disabled = false; loading.textContent = '';
			}).catch(function(err) { if (box.element.isConnected) { loading.textContent = ''; error.textContent = '读取失败：' + err.message; } });
		}
		function remove(item) {
			if (related(item.name).length) { report('脚本仍被订阅使用，请先修改关联'); return; }
			return H.confirm('删除脚本', '确定删除“' + item.name + '”？', '删除脚本', true).then(function(yes) {
				if (!yes) return; return delScript(item.name).then(UI.checked).then(refresh).then(function() { report('脚本已删除'); }).catch(function(err) { report('删除失败：' + err.message); });
			});
		}
		function configure(item) {
			var used = related(item.name), candidates = used.length ? used : profiles;
			if (used.length === 1) { config.onConfigure(used[0], item.name); return; }
			if (!candidates.length) { report('请先添加订阅，再关联脚本'); return; }
			var box, picker = E('div', { 'class': 'hub-profile-picker' });
			candidates.forEach(function(p) {
				var b = E('button', { type: 'button' }, [E('span', { 'class': 'hub-icon' }, UI.icon('file')), E('span', {}, [E('strong', {}, p.label || p.id), E('small', {}, used.length ? '已关联此脚本' : '选择后配置脚本开关')]), UI.icon('chevron')]);
				b.addEventListener('click', function() { box.close(true).then(function() { config.onConfigure(p, item.name); }); }); picker.appendChild(b);
			});
			box = H.dialog(used.length ? '选择要配置的订阅' : '关联订阅', picker, [UI.button('取消', function() { return box.close(); })]);
		}
		function more(item) {
			var details = E('details', { 'class': 'hub-more' }), summary = E('summary', { 'aria-label': item.name + '的更多操作' }, '•••');
			function action(label, fn, kind, icon) { return UI.button(label, function() { details.open = false; return fn(); }, kind || 'text', icon); }
			var version = action('版本信息', function() {
				var box, data = Object.assign({}, item.source || {}, { options_count: count(item) });
				box = H.dialog('脚本版本', versionCard(data, item.size), [UI.button('关闭', function() { return box.close(); })]);
			}, 'text', 'info');
			var removeButton = action('删除脚本', function() { return remove(item); }, 'text bb-delete', 'close'); removeButton.disabled = related(item.name).length > 0;
			if (removeButton.disabled) removeButton.title = '请先解除订阅关联';
			details.append(summary, E('div', {}, [version, action('更新来源', function() { sourceDialog(item, false); }, 'text', 'link'), action('编辑代码', function() { editCode(item); }, 'text', 'code'), removeButton]));
			details.addEventListener('toggle', function() { if (details.open) host.querySelectorAll('details[open]').forEach(function(other) { if (other !== details) other.open = false; }); }); return details;
		}
		function count(item) { return Object.prototype.hasOwnProperty.call(counts, item.name) ? counts[item.name] : item.source && item.source.options_count != null ? item.source.options_count : null; }
		function draw() {
			if (disposed) return; countNodes = Object.create(null);
			if (!scripts.length) { host.replaceChildren(E('section', { 'class': 'panel hub-empty' }, [E('span', { 'class': 'hub-icon' }, UI.icon('code')), E('h2', {}, '还没有覆写脚本'), UI.button('导入脚本', add, 'primary', 'plus')])); return; }
			host.replaceChildren.apply(host, scripts.map(function(s) {
				var used = related(s.name), number = E('strong', {}, count(s) == null ? '—' : String(count(s)) + ' 项'); countNodes[s.name] = number;
				function stat(label, value) { return E('div', {}, [E('span', {}, label), value]); }
				var references = E('div'); used.forEach(function(p) { var b = UI.button(p.label || p.id, function() { config.onConfigure(p); }, '', 'chevron'); references.appendChild(b); });
				if (!used.length) references.appendChild(E('span', { 'class': 'muted' }, '尚未关联订阅'));
				var update = UI.button(s.source ? '检查更新' : '设置来源', function() { return check(s); }, '', 'refresh'); update.disabled = !!busy[s.name];
				var configureButton = UI.button(used.length ? '设置开关' : '关联订阅', function() { configure(s); }, 'soft', 'settings');
				return E('article', { 'class': 'panel hub-script-card', 'data-script-name': s.name }, [
					E('div', { 'class': 'hub-card-top' }, [E('div', { 'class': 'hub-name' }, [E('span', { 'class': 'hub-icon' }, UI.icon('code')), E('div', {}, [E('h2', {}, s.name), E('span', { 'class': 'small muted' }, s.name + '.js')])]), UI.tag(s.source ? '链接导入' : '本地脚本', 'neutral')]),
					E('div', { 'class': 'hub-script-stats' }, [stat('脚本大小', E('strong', { 'class': 'mono' }, UI.bytes(s.size))), stat('脚本开关', number), stat('关联订阅', E('strong', {}, used.length + ' 个'))]),
					E('div', { 'class': 'hub-associated' }, [E('span', { 'class': 'label' }, '应用于'), references]),
					E('div', { 'class': 'hub-script-stamp' }, [E('span', {}, s.source && s.source.updated_at ? '最近同步 · ' + new Date(s.source.updated_at * 1000).toLocaleString() : '本地保存'), s.source && s.source.modified ? UI.tag('本地已修改', 'neutral') : null]),
					E('div', { 'class': 'hub-card-actions' }, [E('div', {}, configureButton), E('div', {}, [update, more(s)])])]);
			}));
		}
		function add() {
			var mode = 'url', name = E('input', { 'class': 'field', placeholder: '我的分流脚本', 'aria-label': '文件名' });
			var url = E('input', { 'class': 'field', type: 'url', placeholder: 'https://…/script.js', 'aria-label': '脚本链接' });
			var file = E('input', { 'class': 'field', type: 'file', accept: '.js,text/javascript', 'aria-label': '脚本文件' });
			var tabs = E('div', { 'class': 'hub-add-tabs', role: 'tablist', 'aria-label': '添加脚本方式' }), form = E('div'), error = E('div', { 'class': 'hub-error', role: 'alert' }), box;
			var confirm = UI.button('导入脚本', function() {
				error.textContent = ''; var n = normalizeName(name.value), addressValue, f = file.files && file.files[0];
				try {
					if (mode === 'url') { addressValue = address(url.value); if (!n) n = normalizeName(decodeURIComponent(new URL(addressValue).pathname.split('/').pop())); }
					if (mode === 'file') { if (!f) throw new Error('请选择脚本文件'); if (f.size > 524288) throw new Error('文件不能超过 512 KB'); n = n || normalizeName(f.name); }
					if (!validName(n)) throw new Error('名称不能以点开头或包含路径、特殊字符，最长 192 字节');
					if (scripts.some(function(s) { return s.name === n; })) throw new Error('已存在同名脚本');
				} catch (err) { error.textContent = err.message; return; }
				if (mode === 'new') return box.close(true).then(function() { editCode(null, n); });
				box.setBusy(true);
				var operation = mode === 'file' ? f.text().then(function(text) { return saveScript(n, text, '1'); }).then(UI.checked) : jobResult(importURL(addressValue, n));
				return operation.then(refresh).then(function() { report('脚本已导入'); return complete(box); }).catch(function(err) { error.textContent = err.message; }).finally(function() { box.setBusy(false); });
			}, 'primary', 'plus');
			function sourceForm() {
				Array.from(tabs.children).forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); b.setAttribute('aria-selected', String(b.dataset.mode === mode)); });
				form.replaceChildren.apply(form, (mode === 'url' ? [H.field('脚本链接', url)] : mode === 'file' ? [H.field('脚本文件', file)] : []).concat([H.field(mode === 'new' ? '文件名' : '文件名（可选）', name)]));
				confirm.querySelector('span').textContent = mode === 'new' ? '创建并编辑' : '导入脚本'; error.textContent = '';
			}
			[['url','链接导入'],['file','文件导入'],['new','新建代码']].forEach(function(item) { var b = E('button', { type: 'button', role: 'tab', 'data-mode': item[0] }, item[1]); b.addEventListener('click', function() { mode = item[0]; sourceForm(); }); tabs.appendChild(b); });
			sourceForm(); box = H.dialog('添加脚本', [tabs, form, error], [UI.button('取消', function() { return box.close(); }), confirm]);
		}
		function activate() {
			if (queueStarted) return; queueStarted = true;
			var pending = scripts.filter(function(s) { return count(s) == null; });
			function next() {
				if (disposed || !pending.length || !host.isConnected) { queueStarted = false; return; }
				var item = pending.shift();
				scriptOptions(item.name).then(UI.checked).then(function(res) { counts[item.name] = Object.keys(H.object(res.options && res.options.options)).length; if (countNodes[item.name]) countNodes[item.name].textContent = counts[item.name] + ' 项'; }).catch(function() { if (countNodes[item.name]) countNodes[item.name].title = '脚本开关提取失败'; }).finally(next);
			} next();
		}
		draw(); return { element: host, add: add, activate: activate, dispose: function() { disposed = true; } };
	}
});
