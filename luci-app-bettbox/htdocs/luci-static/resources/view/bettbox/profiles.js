'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require bettbox.ui as UI';

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
var callApply = rpc.declare({ object: 'bettbox', method: 'apply' });

function checked(res) {
	if (!res || !res.ok) throw new Error((res && (res.error || res.text)) || _('操作失败'));
	return res;
}

function failed(err) {
	ui.hideModal();
	ui.addNotification(null, E('p', {}, String(err.message || err)), 'error');
}

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

		var fAge = E('input', { type: 'password', 'class': 'cbi-input-text', value: p.age_identity || '', style: 'width:100%; font-family:monospace', placeholder: _('留空则使用全局密钥 (AGE-SECRET-KEY-…)') });

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
			return uci.save().then(function () {
				return rpc.declare({ object: 'uci', method: 'commit', params: ['config'] })('bettbox');
			}).then(function () {
				return uci.get('bettbox', 'config', 'profile') === sid ? callApply() : { ok: true };
			}).then(checked).then(function () { ui.hideModal(); window.location.reload(); }).catch(failed);
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

		UI.modal(sid ? _('编辑订阅') : _('添加订阅'), [body], [UI.button('保存',save,'primary','save'),UI.button('取消',ui.hideModal)]);
	},

	render: function (data) {
		var self=this,profiles=(data[0]&&data[0].profiles)||[],scripts=(data[1]&&data[1].scripts)||[],active=uci.get('bettbox','config','profile')||'';
		function add(){var name=E('input',{'class':'field',placeholder:'订阅名称（可选）'}),url=E('input',{'class':'field',type:'url',placeholder:'https://…'});UI.modal('添加订阅',[UI.field('名称',name),UI.field('订阅链接',url,'支持 Clash YAML 与 age 加密订阅。')],[UI.button('添加',function(){if(!/^(https?|file):\/\//.test(url.value.trim()))throw new Error('请输入有效的订阅链接');return callAdd(url.value.trim(),name.value.trim()).then(checked).then(function(){ui.hideModal();window.location.reload();});},'primary','plus'),UI.button('取消',ui.hideModal)]);}
		var cards=E('div',{'class':'profile-grid'});
		profiles.forEach(function(p){var used=(p.sub_upload||0)+(p.sub_download||0),total=p.sub_total||0,current=p.id===active;
			var choose=UI.button(current?'当前使用':'选用',function(){uci.set('bettbox','config','profile',p.id);return uci.save().then(function(){return rpc.declare({object:'uci',method:'commit',params:['config']})('bettbox');}).then(callApply).then(checked).then(function(){window.location.reload();});},current?'soft':'');choose.disabled=current;
			var remove=UI.button('删除',function(){UI.modal('删除订阅',[E('p',{},'确定删除“'+(p.label||p.id)+'”？此操作将移除该订阅配置。')],[UI.button('删除',function(){return callDel(p.id).then(checked).then(function(){window.location.reload();});},'danger'),UI.button('取消',ui.hideModal)]);},'text bb-delete','close');remove.disabled=current;
			function info(label,value){return E('div',{},[E('span',{'class':'label'},label),E('span',{},value)]);}
			cards.appendChild(E('article',{'class':'panel profile'+(current?' current':'')},[E('div',{'class':'profile-top'},[E('div',{},[E('h2',{'class':'profile-name',title:p.id},p.label||p.id)]),UI.tag(current?'当前使用':'未选用',current?'':'neutral')]),E('div',{'class':'usage-main'},[E('strong',{'class':total?'':'usage-empty'},total?UI.bytes(used):'未提供用量'),total?E('small',{},' / '+UI.bytes(total)):document.createTextNode('')]),E('div',{'class':'progress'},E('i',{style:'width:'+(total?Math.min(100,used/total*100):0)+'%'})),E('div',{'class':'profile-rows'},[info('下载 / 上传',UI.bytes(p.sub_download||0)+' / '+UI.bytes(p.sub_upload||0)),info('到期时间',p.sub_expire>0?fmtExpire(p.sub_expire):'未提供'),info('更新策略',p.auto_update?'每 '+p.update_interval+' 分钟':'手动更新'),info('覆写脚本',p.use_script?p.script||'—':'未启用'),info('上次更新',p.last_update>0?new Date(p.last_update*1000).toLocaleString():'未更新')]),E('div',{'class':'profile-actions'},[choose,UI.button('更新',function(){return callUpdate(p.id,'0').then(checked).then(function(){window.location.reload();});},'','refresh'),UI.button('编辑',self.editProfile.bind(self,p.id,profiles,scripts),'','edit'),remove])]));
		});
		return UI.page('profiles','订阅',[UI.button('更新全部',function(){return callUpdate('','1').then(checked).then(function(){window.location.reload();});},'','refresh'),UI.button('添加订阅',add,'primary','plus')],[profiles.length?cards:UI.empty('还没有订阅','添加订阅链接，或导入本地配置。',UI.button('添加订阅',add,'primary','plus'))]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
