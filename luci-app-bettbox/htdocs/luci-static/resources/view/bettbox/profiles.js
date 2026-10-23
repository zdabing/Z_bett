'use strict';
'require view';
'require rpc';
'require uci';
'require ui';

var callProfiles = rpc.declare({ object: 'bettbox', method: 'get_profiles' });
var callUpdate = rpc.declare({ object: 'bettbox', method: 'update_profile', params: [ 'sid', 'all' ] });
var callDel = rpc.declare({ object: 'bettbox', method: 'del_profile', params: [ 'sid' ] });
var callScripts = rpc.declare({ object: 'bettbox', method: 'get_scripts' });
var callScriptOpts = rpc.declare({ object: 'bettbox', method: 'script_options', params: [ 'name' ] });

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

	editProfile: function (sid, profiles, scripts, ev) {
		var self = this;
		var p = profiles.filter(function (x) { return x.id === sid; })[0] || {};
		var body = E('div', {});

		var fLabel = E('input', { 'class': 'cbi-input-text', value: p.label || '', style: 'width:100%' });
		var fUrl = E('input', { 'class': 'cbi-input-text', value: p.url || '', style: 'width:100%', placeholder: 'https://… / clash://install-config?url=…' });
		var fAuto = E('input', { type: 'checkbox' }); fAuto.checked = !!p.auto_update;
		var fIntv = E('input', { 'class': 'cbi-input-text', type: 'number', value: p.update_interval || 1440, style: 'width:8em' });
		var fScript = E('select', { 'class': 'cbi-input-select', style: 'width:100%' }, [
			E('option', { value: '' }, '— 无 —')
		].concat(scripts.map(function (s) {
			var o = E('option', { value: s.name }, s.name); return o;
		})));
		fScript.value = p.script || '';
		var fUseScript = E('input', { type: 'checkbox' }); fUseScript.checked = !!p.use_script;
		var fOverride = E('textarea', { 'class': 'cbi-input-textarea', rows: 6, style: 'width:100%; font-family:monospace' });
		try {
			var ov = JSON.parse(p.override_rules || 'null');
			fOverride.value = ov ? (ov.rules || []).join('\n') : '';
		} catch (e) { fOverride.value = ''; }
		var fOverrideMode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'prepend' }, '前置到现有规则前'),
			E('option', { value: 'replace' }, '替换全部规则')
		]);
		fOverrideMode.value = (JSON.parse(p.override_rules || '{}') || {}).mode || 'prepend';
		var optBox = E('div', {});

		function loadOptions() {
			optBox.innerHTML = '';
			if (!fUseScript.checked || !fScript.value) return;
			callScriptOpts(fScript.value).then(function (res) {
				if (!res || !res.ok || !res.options) {
					optBox.appendChild(E('p', {}, _('无法提取脚本开关') + (res && res.error ? '：' + res.error : '')));
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
				section('⚙️ 策略组开关', groupKeys);
				section('⚙️ 其他设置', otherKeys);
			});
		}
		fUseScript.addEventListener('change', loadOptions);
		fScript.addEventListener('change', loadOptions);
		loadOptions();

		function save() {
			var ov = { mode: fOverrideMode.value, rules: fOverride.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s; }) };
			var custom = {};
			optBox.querySelectorAll('input[data-opt]').forEach(function (cb) { custom[cb.getAttribute('data-opt')] = cb.checked; });
			if (sid) {
				uci.set('bettbox', sid, 'label', fLabel.value || sid);
				uci.set('bettbox', sid, 'url', fUrl.value);
				uci.set('bettbox', sid, 'auto_update', fAuto.checked ? '1' : '0');
				uci.set('bettbox', sid, 'update_interval', String(parseInt(fIntv.value, 10) || 1440));
				uci.set('bettbox', sid, 'use_script', fUseScript.checked ? '1' : '0');
				uci.set('bettbox', sid, 'script', fScript.value);
				uci.set('bettbox', sid, 'custom_options', JSON.stringify(custom));
				if (ov.rules.length) uci.set('bettbox', sid, 'override_rules', JSON.stringify(ov));
				else uci.unset('bettbox', sid, 'override_rules');
			}
			uci.save().then(function () {
				return uci.apply();
			}).then(function () {
				ui.hideModal();
				window.location.reload();
			}).catch(function () { ui.hideModal(); window.location.reload(); });
		}

		body.appendChild(E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr' }, E('td', { 'class': 'td left', style: 'width:9em' }, _('名称')), E('td', { 'class': 'td' }, fLabel)),
			E('tr', { 'class': 'tr' }, E('td', { 'class': 'td left' }, _('订阅链接')), E('td', { 'class': 'td' }, fUrl)),
			E('tr', { 'class': 'tr' }, E('td', { 'class': 'td left' }, _('自动更新')), E('td', { 'class': 'td' }, [ fAuto, ' ', _('间隔(分钟)'), ' ', fIntv ])),
			E('tr', { 'class': 'tr' }, E('td', { 'class': 'td left' }, _('JS 覆写')), E('td', { 'class': 'td' }, [ fUseScript, ' ', fScript ])),
			E('tr', { 'class': 'tr' }, E('td', { 'class': 'td left' }), E('td', { 'class': 'td' }, optBox)),
			E('tr', { 'class': 'tr' }, E('td', { 'class': 'td left' }, _('规则覆写')), E('td', { 'class': 'td' }, [ fOverrideMode, fOverride ]))
		]));

		ui.showModal(sid ? _('编辑订阅') : _('添加订阅'), [
			body,
			E('div', { 'class': 'right' }, [
				ui.createHandlerBtn(_('保存'), save),
				' ',
				E('button', { 'class': 'btn', click: ui.hideModal }, _('取消'))
			])
		]);
	},

	render: function (data) {
		var self = this;
		var profiles = (data[0] && data[0].profiles) || [];
		var scripts = (data[1] && data[1].scripts) || [];
		var active = uci.get('bettbox', 'config', 'profile') || '';

		var wrap = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('订阅')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-descr' }, [
					ui.createHandlerBtn(_('添加订阅'), this.editProfile.bind(this, null, profiles, scripts)),
					' ',
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
			wrap.appendChild(E('div', { 'class': 'cbi-section', style: p.id === active ? 'border-left:4px solid var(--primary,#2f7fd6)' : '' }, [
				E('h3', {}, [ (p.id === active ? '✓ ' : '') + (p.label || p.id), ' ',
					E('small', {}, '[' + p.id + ']') ]),
				E('div', { 'class': 'cbi-section-descr' },
					_('流量：') + fmtBytes(p.sub_download) + ' ↓ / ' + fmtBytes(p.sub_upload) + ' ↑' + usage +
					' · ' + _('到期：') + fmtExpire(p.sub_expire) +
					' · ' + _('更新于：') + (p.last_update > 0 ? new Date(p.last_update * 1000).toLocaleString() : '-') +
					(p.use_script ? ' · JS 覆写: ' + p.script : '')),
				E('div', {}, [
					ui.createHandlerBtn(p.id === active ? _('当前使用') : _('设为当前'), function () {
						uci.set('bettbox', 'config', 'profile', p.id);
						uci.save().then(function () { return uci.apply(); }).then(function () { window.location.reload(); });
					}),
					' ',
					ui.createHandlerBtn(_('更新'), function () {
						ui.showModal(_('正在更新…'));
						return callUpdate(p.id, '0').then(function (res) { ui.hideModal(); ui.addNotification(null, E('pre', {}, res.text || ''), 'info'); window.location.reload(); });
					}),
					' ',
					ui.createHandlerBtn(_('编辑'), self.editProfile.bind(self, p.id, profiles, scripts)),
					' ',
					E('button', { 'class': 'btn cbi-button-negative', click: function () {
						if (!confirm(_('删除订阅 %s？').format(p.label))) return;
						callDel(p.id).then(function () { window.location.reload(); });
					} }, _('删除'))
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
