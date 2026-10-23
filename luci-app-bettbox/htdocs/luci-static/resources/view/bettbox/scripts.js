'use strict';
'require view';
'require rpc';
'require ui';

var callList = rpc.declare({ object: 'bettbox', method: 'get_scripts' });
var callGet = rpc.declare({ object: 'bettbox', method: 'get_script', params: [ 'name' ] });
var callSave = rpc.declare({ object: 'bettbox', method: 'save_script', params: [ 'name', 'content' ] });
var callDel = rpc.declare({ object: 'bettbox', method: 'del_script', params: [ 'name' ] });
var callOpts = rpc.declare({ object: 'bettbox', method: 'script_options', params: [ 'name' ] });

var TEMPLATE =
	'// const Compatible_With_Bettbox = { ruleOptionsEnable: true, policyGroupOptions: [\'🚀 节点选择\'] };\n' +
	'// const ruleOptionsEnable = { \'🚀 节点选择\': true };\n' +
	'function main(config) {\n' +
	'  // config.rules = [\'DOMAIN,example.com,DIRECT\', ...(config.rules || [])];\n' +
	'  return config;\n' +
	'}\n';

return view.extend({
	load: function () { return callList(); },

	editor: function (name, scripts, ev) {
		var self = this;
		var fetching = !name ? Promise.resolve({ name: '', content: TEMPLATE }) : callGet(name);
		fetching.then(function (s) {
			var fName = E('input', { 'class': 'cbi-input-text', value: s.name || '', style: 'width:20em', placeholder: 'my-script' });
			var fBody = E('textarea', { 'class': 'cbi-input-textarea', rows: 20, style: 'width:100%; font-family:monospace' });
			fBody.value = s.content || '';
			var optBox = E('pre', { style: 'max-height:16em; overflow:auto; background:var(--background-color-high,#f5f5f5); padding:.5em; font-size:.85em' }, '—');

			var extract = ui.createHandlerBtn(_('提取开关 (bettbox-forge)'), function () {
				return callOpts(fName.value).then(function (res) {
					optBox.textContent = (res && res.ok) ? JSON.stringify(res.options, null, 2) : ('错误: ' + (res && res.error));
				});
			});

			var save = ui.createHandlerBtn(_('保存'), function () {
				var n = fName.value.trim().replace(/\.js$/, '');
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) {
					alert(_('脚本名只能用字母数字下划线中划线')); return;
				}
				return callSave(n, fBody.value).then(function (res) {
					if (res && res.error) alert(res.error);
					else { ui.hideModal(); window.location.reload(); }
				});
			});

			ui.showModal(_('脚本: %s').format(name || _('新建')), [
				E('div', {}, [ _('文件名'), ' ', fName, ' ', extract ]),
				fBody,
				E('h4', {}, _('提取到的开关 (Compatible_With_Bettbox 契约)')),
				optBox,
				E('div', { 'class': 'right' }, [
					save, ' ',
					E('button', { 'class': 'btn', click: ui.hideModal }, _('关闭'))
				])
			]);
		});
	},

	render: function (data) {
		var self = this;
		var scripts = (data && data.scripts) || [];

		var wrap = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('JS 覆写脚本')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'class': 'cbi-section-descr' },
					_('与 Bettbox 桌面/移动端完全兼容的覆写脚本：定义 main(config) 并返回修改后的配置；')),
				E('div', {}, [
					ui.createHandlerBtn(_('新建脚本'), this.editor.bind(this, null, scripts))
				])
			])
		]);

		scripts.forEach(function (s) {
			wrap.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, s.name + ' '),
				E('div', {}, [
					ui.createHandlerBtn(_('编辑'), self.editor.bind(self, s.name, scripts)), ' ',
					E('button', { 'class': 'btn cbi-button-negative', click: function () {
						if (!confirm(_('删除脚本 %s？').format(s.name))) return;
						callDel(s.name).then(function () { window.location.reload(); });
					} }, _('删除'))
				])
			]));
		});

		if (!scripts.length)
			wrap.appendChild(E('p', {}, _('还没有脚本。Bettbox 社区的覆写脚本可以直接粘贴使用。')));

		return wrap;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
