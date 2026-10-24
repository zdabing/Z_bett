'use strict';
'require view';
'require rpc';
'require ui';

/* LuCI 25.12 removed ui.createHandlerBtn; shim it on top of createHandlerFn. */
if (!ui.createHandlerBtn)
	ui.createHandlerBtn = function(label, fn) {
		return E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(null, fn) }, label);
	};

var callList = rpc.declare({ object: 'bettbox', method: 'get_scripts' });
var callGet = rpc.declare({ object: 'bettbox', method: 'get_script', params: [ 'name' ] });
var callSave = rpc.declare({ object: 'bettbox', method: 'save_script', params: [ 'name', 'content' ] });
var callDel = rpc.declare({ object: 'bettbox', method: 'del_script', params: [ 'name' ] });
var callOpts = rpc.declare({ object: 'bettbox', method: 'script_options', params: [ 'name' ] });
var callImportUrl = rpc.declare({ object: 'bettbox', method: 'import_script_url', params: [ 'url', 'name' ] });

var TEMPLATE =
	'// const Compatible_With_Bettbox = { ruleOptionsEnable: true, policyGroupOptions: [\'🚀 节点选择\'] };\n' +
	'// const ruleOptionsEnable = { \'🚀 节点选择\': true };\n' +
	'function main(config) {\n' +
	'  // config.rules = [\'DOMAIN,example.com,DIRECT\', ...(config.rules || [])];\n' +
	'  return config;\n' +
	'}\n';

function validName(n) {
	return /^[A-Za-z0-9_-]{1,64}$/.test(n);
}

return view.extend({
	load: function () { return callList(); },

	/* upstream editor.dart _ImportOptionsDialog: URL import / file import,
	   plus direct paste in the editor itself. */
	importDialog: function (scripts, ev) {
		var self = this;

		var fName = E('input', { 'class': 'cbi-input-text', style: 'width:100%', placeholder: 'my-script（可选，默认取 URL 文件名）' });
		var fUrl = E('input', { 'class': 'cbi-input-text', style: 'width:100%', placeholder: 'https://example.com/override.js' });
		var urlOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '');

		var fFile = E('input', { type: 'file', accept: '.js,text/javascript', style: 'width:100%' });
		var fileOut = E('pre', { style: 'min-height:2.2em; max-height:24em; overflow:auto; font-size:.85em' }, '');

		function doImportUrl() {
			var u = fUrl.value.trim();
			if (!/^https?:\/\//.test(u)) { urlOut.textContent = '错误: 需要 http(s):// 链接'; return; }
			urlOut.textContent = '…';
			callImportUrl(u, fName.value.trim()).then(function (res) {
				if (res && res.ok) {
					ui.hideModal();
					window.location.reload();
				} else {
					urlOut.textContent = '错误: ' + ((res && (res.error || res.text)) || '未知');
				}
			});
		}

		function doImportFile() {
			var f = fFile.files && fFile.files[0];
			if (!f) { fileOut.textContent = '错误: 未选择文件'; return; }
			var n = fName.value.trim() || f.name.replace(/\.js$/, '');
			if (!validName(n)) { fileOut.textContent = '错误: 脚本名只能用字母数字下划线中划线'; return; }
			fileOut.textContent = '…';
			var rd = new FileReader();
			rd.onload = function () {
				callSave(n, String(rd.result)).then(function (res) {
					if (res && res.error) { fileOut.textContent = '错误: ' + res.error; return; }
					ui.hideModal();
					window.location.reload();
				});
			};
			rd.onerror = function () { fileOut.textContent = '错误: 文件读取失败'; };
			rd.readAsText(f);
		}

		var body = E('div', {}, [
			E('h4', {}, '通过 URL 导入'),
			E('div', { style: 'margin-bottom:.3em' }, fUrl),
			E('div', { style: 'margin-bottom:.3em' }, fName),
			E('div', {}, [ ui.createHandlerBtn(_('导入'), doImportUrl) ]),
			urlOut,
			E('hr'),
			E('h4', {}, '通过文件导入'),
			E('div', { style: 'margin-bottom:.3em' }, fFile),
			E('div', { style: 'margin-bottom:.3em' }, fName),
			E('div', {}, [ ui.createHandlerBtn(_('导入'), doImportFile) ]),
			fileOut
		]);

		ui.showModal(_('导入'), [
			body,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', click: ui.createHandlerFn(null, ui.hideModal) }, _('关闭'))
			])
		]);
	},

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
				if (!validName(n)) { alert(_('脚本名只能用字母数字下划线中划线')); return; }
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
					E('button', { 'class': 'btn', click: ui.createHandlerFn(null, ui.hideModal) }, _('关闭'))
				])
			]);
		});
	},

	render: function (data) {
		var self = this;
		var scripts = (data && data.scripts) || [];

		var wrap = E('div', { 'class': 'cbi-map' }, [
			E('div', { 'class': 'cbi-section' }, [
				E('div', {}, [
					ui.createHandlerBtn(_('新建脚本'), self.editor.bind(self, null, scripts)), ' ',
					ui.createHandlerBtn(_('导入'), self.importDialog.bind(self, scripts))
				])
			])
		]);

		scripts.forEach(function (s) {
			wrap.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, s.name + ' '),
				E('div', {}, [
					ui.createHandlerBtn(_('编辑'), self.editor.bind(self, s.name, scripts)), ' ',
					E('button', { 'class': 'btn cbi-button-negative', click: ui.createHandlerFn(null, function () {
						if (!confirm(_('删除脚本 %s？').format(s.name))) return;
						callDel(s.name).then(function () { window.location.reload(); });
					}) }, _('删除'))
				])
			]));
		});

		if (!scripts.length)
			wrap.appendChild(E('p', {}, _('还没有脚本。可粘贴代码、从 URL 或本地文件导入；Bettbox 社区的覆写脚本可直接使用。')));

		return wrap;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
