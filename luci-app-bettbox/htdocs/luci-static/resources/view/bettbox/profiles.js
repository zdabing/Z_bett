'use strict';
'require view';
'require rpc';
'require uci';
'require ui';

/* LuCI 25.12 removed ui.createHandlerBtn; shim it on top of createHandlerFn. */
if (!ui.createHandlerBtn)
	ui.createHandlerBtn = function(label, fn) {
		return E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, fn) }, label);
	};

var callProfiles = rpc.declare({ object: 'bettbox', method: 'get_profiles' });
var callUpdate = rpc.declare({ object: 'bettbox', method: 'update_profile', params: [ 'sid', 'all' ] });
var callDel = rpc.declare({ object: 'bettbox', method: 'del_profile', params: [ 'sid' ] });
var callAdd = rpc.declare({ object: 'bettbox', method: 'add_profile', params: [ 'url', 'label' ] });
var callScripts = rpc.declare({ object: 'bettbox', method: 'get_scripts' });
var callScriptOpts = rpc.declare({ object: 'bettbox', method: 'script_options', params: [ 'name' ] });
var callApi = rpc.declare({ object: 'bettbox', method: 'api_proxy', params: [ 'method', 'path', 'body' ] });

function fmtBytes(n) {
	if (n == null || n <= 0) return '-';
	var u = [ 'B', 'KB', 'MB', 'GB', 'TB' ], i = 0;
	while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
	return n.toFixed(i ? 2 : 0) + ' ' + u[i];
}

function fmtExpire(ts) {
	if (!ts || ts <= 0) return '-';
	var d = new Date(ts * 1000);
	return d.toISOString().slice(0, 10);
}

return view.extend({
	load: function () {
		return Promise.all([ callProfiles(), callScripts(), uci.load('bettbox') ]);
	},

	/* Edit modal — mirrors upstream Bettbox edit_profile + override page:
	   基本信息 / JS 覆写（脚本 + 自定义规则开关）/ 规则覆写（覆盖或附加原始规则，可获取原始规则） */
	editProfile: function (sid, profiles, scripts, ev) {
		var self = this;
		var p = profiles.filter(function (x) { return x.id === sid; })[0] || {};
		var body = E('div', {});

		var fLabel = E('input', { 'class': 'cbi-input-text', value: p.label || '', style: 'width:100%' });
		var fUrl = E('input', { 'class': 'cbi-input-text', value: p.url || '', style: 'width:100%', placeholder: 'https://…' });
		var fAuto = E('input', { type: 'checkbox' }); fAuto.checked = !!p.auto_update;
		var fIntv = E('input', { 'class': 'cbi-input-text', type: 'number', value: p.update_interval || 1440, style: 'width:8em' });

		var scriptOpts = [ E('option', { value: '' }, '— 无 —') ];
		scripts.forEach(function (s) {
			scriptOpts.push(E('option', { value: s.name }, s.name));
		});
		var fScript = E('select', { 'class': 'cbi-input-select', style: 'width:100%' }, scriptOpts);
		fScript.value = p.script || '';
		var fUseScript = E('input', { type: 'checkbox' }); fUseScript.checked = !!p.use_script;

		var fAge = E('input', { 'class': 'cbi-input-text', value: p.age_identity || '', style: 'width:100%; font-family:monospace', placeholder: _('留空则使用全局密钥 (AGE-SECRET-KEY-…)') });

		var fOverride = E('textarea', { 'class': 'cbi-input-textarea', rows: 8, style: 'width:100%; font-family:monospace', placeholder: 'DOMAIN,example.com,DIRECT\nGEOIP,CN,DIRECT' });
		try {
			var ov0 = JSON.parse(p.override_rules || 'null');
			fOverride.value = ov0 ? (ov0.rules || []).join('\n') : '';
		} catch (e) { fOverride.value = ''; }
		var fOverrideMode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'prepend' }, '附加到原始规则前'),
			E('option', { value: 'replace' }, '覆盖原始规则')
		]);
		try { fOverrideMode.value = (JSON.parse(p.override_rules || '{}') || {}).mode || 'prepend'; }
		catch (e) { fOverrideMode.value = 'prepend'; }

		var optBox = E('div', {});

		function loadOptions() {
			optBox.innerHTML = '';
			if (!fUseScript.checked || !fScript.value) return;
			callScriptOpts(fScript.value).then(function (res) {
				if (!res || !res.ok || !res.options) {
					optBox.appendChild(E('p', { style: 'color:var(--danger-color,#c44)' },
						_('无法提取脚本开关') + (res && res.error ? '：' + res.error : '')));
					return;
				}
				var groups = res.options.policyGroupOptions || [];
				var opts = res.options.options || {};
				var custom = {};
				try { custom = JSON.parse(p.custom_options || '{}') || {}; } catch (e) {}
				custom = Object.assign({}, opts, custom);
				var keys = Object.keys(custom);
				var groupKeys = keys.filter(function (k) { return groups.indexOf(k) >= 0; });
				var otherKeys = keys.filter(function (k) { return groups.indexOf(k) < 0; });
				function section(title, list) {
					if (!list.length) return;
					optBox.appendChild(E('h4', {}, title));
					list.forEach(function (k) {
						var cb = E('input', { type: 'checkbox', 'data-opt': k }); cb.checked = !!custom[k];
						optBox.appendChild(E('label', { style: 'display:block; margin:.15em 0' }, [ cb, ' ', k ]));
					});
				}
				section('⚙️ 自定义规则开关（策略组）', groupKeys);
				section('⚙️ 其他设置', otherKeys);
				if (!keys.length)
					optBox.appendChild(E('p', {}, _('该脚本未声明 ruleOptionsEnable 开关')));
			});
		}
		fUseScript.addEventListener('change', loadOptions);
		fScript.addEventListener('change', loadOptions);
		loadOptions();

		var fetchBtn = ui.createHandlerBtn(_('获取原始规则'), function () {
			fOverride.placeholder = _('正在获取…');
			return callApi('GET', '/rules', '').then(function (res) {
				var d = res && res.data;
				if (d && d.rules) {
					fOverride.value = d.rules.map(function (r) {
						return r.type + (r.payload ? ',' + r.payload : '') + ',' + r.proxy;
					}).join('\n');
					fOverrideMode.value = 'replace';
					fOverride.placeholder = '';
				} else {
					fOverride.placeholder = _('获取失败');
				}
			});
		});

		function save() {
			var ov = { mode: fOverrideMode.value, rules: fOverride.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) };
			var custom = {};
			optBox.querySelectorAll('input[data-opt]').forEach(function (cb) { custom[cb.getAttribute('data-opt')] = cb.checked; });
			uci.set('bettbox', sid, 'label', fLabel.value || sid);
			uci.set('bettbox', sid, 'url', fUrl.value);
			uci.set('bettbox', sid, 'auto_update', fAuto.checked ? '1' : '0');
			uci.set('bettbox', sid, 'update_interval', String(parseInt(fIntv.value, 10) || 1440));
			uci.set('bettbox', sid, 'use_script', fUseScript.checked ? '1' : '0');
			uci.set('bettbox', sid, 'script', fScript.value);
			uci.set('bettbox', sid, 'custom_options', JSON.stringify(custom));
			if (fAge.value.trim()) uci.set('bettbox', sid, 'age_identity', fAge.value.trim());
			else uci.unset('bettbox', sid, 'age_identity');
			if (ov.rules.length) uci.set('bettbox', sid, 'override_rules', JSON.stringify(ov));
			else uci.unset('bettbox', sid, 'override_rules');
			uci.save().then(function () {
				return rpc.declare({ object: 'uci', method: 'commit', params: ['config'] })('bettbox');
			}).then(function () { ui.hideModal(); window.location.reload(); })
			.catch(function () { ui.hideModal(); window.location.reload(); });
		}

		body.appendChild(E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left', style: 'width:9em' }, _('名称')), E('td', { 'class': 'td' }, fLabel) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('订阅链接')), E('td', { 'class': 'td' }, fUrl) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('自动更新')), E('td', { 'class': 'td' }, [ fAuto, ' ', _('间隔(分钟)'), ' ', fIntv ]) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('JS 覆写')), E('td', { 'class': 'td' }, [ fUseScript, ' ', fScript ]) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, _('age 密钥')), E('td', { 'class': 'td' }, fAge) ]),
			E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td left' }, ''), E('td', { 'class': 'td' }, optBox) ]),
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left' }, _('规则覆写')),
				E('td', { 'class': 'td' }, [ fOverrideMode, ' ', fetchBtn, fOverride ])
			])
		]));

		ui.showModal(sid ? _('编辑订阅') : _('添加订阅'), [
			body,
			E('div', { 'class': 'right' }, [
				ui.createHandlerBtn(_('保存'), save),
				' ',
				E('button', { 'class': 'btn', click: ui.createHandlerFn(null, ui.hideModal) }, _('取消'))
			])
		]);
	},

	render: function (data) {
		var self = this;
		var profiles = (data[0] && data[0].profiles) || [];
		var scripts = (data[1] && data[1].scripts) || [];
		var active = uci.get('bettbox', 'config', 'profile') || '';

		var wrap = E('div', { 'class': 'cbi-map' }, [
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-descr' }, [
					ui.createHandlerBtn(_('添加订阅'), function () {
						var url = prompt(_('订阅链接 (Clash YAML / age 加密)：'));
						if (!url || !url.trim()) return Promise.resolve();
						ui.showModal(_('正在下载订阅…'), E('p', {}, _('请稍候')));
						return callAdd(url.trim(), '').then(function (res) {
							ui.hideModal();
							if (res && res.ok) window.location.reload();
							else ui.addNotification(null, E('p', {}, _('添加失败：') + ((res && (res.error || res.text)) || '')), 'error');
						});
					}), ' ',
					ui.createHandlerBtn(_('全部更新'), function () {
						return callUpdate('', '1').then(function () { window.location.reload(); });
					})
				])
			])
		]);

		profiles.forEach(function (p) {
			var used = (p.sub_upload || 0) + (p.sub_download || 0);
			var total = p.sub_total || 0;
			var usage = total > 0 ? _(' 已用 %s / %s').format(fmtBytes(used), fmtBytes(total)) : '';
			var ovInfo = '';
			try {
				var ov = JSON.parse(p.override_rules || 'null');
				if (ov && ov.rules && ov.rules.length)
					ovInfo = ' · 规则覆写: ' + (ov.mode == 'replace' ? '覆盖' : '附加') + ' ' + ov.rules.length + ' 条';
			} catch (e) {}
			wrap.appendChild(E('div', { 'class': 'cbi-section', style: p.id === active ? 'border-left:4px solid var(--primary,#2f7fd6)' : '' }, [
				E('h3', {}, [ (p.id === active ? '✓ ' : '') + (p.label || p.id), ' ', E('small', {}, '[' + p.id + ']') ]),
				E('div', { 'class': 'cbi-section-descr' },
					_('流量：') + fmtBytes(p.sub_download) + ' ↓ / ' + fmtBytes(p.sub_upload) + ' ↑' + usage +
					' · ' + _('到期：') + fmtExpire(p.sub_expire) +
					' · ' + _('更新于：') + (p.last_update > 0 ? new Date(p.last_update * 1000).toLocaleString() : '-') +
					(p.use_script ? ' · JS 覆写: ' + p.script : '') + ovInfo),
				E('div', {}, [
					ui.createHandlerBtn(p.id === active ? _('当前使用') : _('设为当前'), function () {
						uci.set('bettbox', 'config', 'profile', p.id);
						uci.save().then(function () { return rpc.declare({ object: 'uci', method: 'commit', params: ['config'] })('bettbox'); }).then(function () { window.location.reload(); });
					}), ' ',
					ui.createHandlerBtn(_('更新'), function () {
						ui.showModal(_('正在更新…'));
						return callUpdate(p.id, '0').then(function (res) { ui.hideModal(); ui.addNotification(null, E('pre', {}, res.text || ''), 'info'); window.location.reload(); });
					}), ' ',
					ui.createHandlerBtn(_('编辑'), self.editProfile.bind(self, p.id, profiles, scripts)), ' ',
					E('button', { 'class': 'btn cbi-button-negative', click: ui.createHandlerFn(null, function () {
						if (!confirm(_('删除订阅 %s？').format(p.label))) return;
						callDel(p.id).then(function () { window.location.reload(); });
					}) }, _('删除'))
				])
			]));
		});

		if (!profiles.length)
			wrap.appendChild(E('p', {}, _('还没有订阅。点击"添加订阅"，粘贴机场的 Clash 订阅链接。')));

		return wrap;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
