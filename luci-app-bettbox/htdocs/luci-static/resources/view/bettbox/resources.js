'use strict';
'require view';
'require rpc';
'require ui';

var callStatus = rpc.declare({ object: 'bettbox', method: 'get_status' });
var callGeoUpdate = rpc.declare({ object: 'bettbox', method: 'geo_update' });

return view.extend({
	load: function () {
		return callStatus();
	},

	render: function (st) {
		var dashTarget = '';
		if (st.controller) {
			var port = st.controller.split(':')[1] || '9097';
			dashTarget = 'http://' + (window.location.hostname || '') + ':' + port + '/ui/';
		}

		return E([
			E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('资源与面板')),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, _('GeoData 资源 (GeoSite / GeoIP / ASN)')),
					E('div', { 'class': 'cbi-section-descr' },
						_('内核开启 geo-auto-update 后按设置页的间隔自动更新；也可手动删除后重启内核强制重新下载。GeoX 地址在"设置 → Geo"中自定义，默认使用 appshubcc/bett-rules（与上游一致）。')),
					E('div', {}, [
						ui.createHandlerBtn(_('强制更新 Geo'), function () {
							return callGeoUpdate().then(function () {
								ui.addNotification(null, E('p', {}, _('已删除本地 Geo 文件并重启内核，内核会重新下载')), 'info');
							});
						})
					])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, _('控制面板 (zashboard)')),
					E('div', { 'class': 'cbi-section-descr' }, _('外部面板与 Bettbox 的 OnlinePanel 一致，安装后经内核 external-ui 提供。')),
					E('div', {}, [
						ui.createHandlerBtn(_('安装 / 更新面板'), function () {
							ui.showModal(_('正在下载 zashboard…'));
							return rpc.declare({ object: 'bettbox', method: 'dashboard', params: [ 'action' ] })('install')
								.then(function (res) {
									ui.hideModal();
									ui.addNotification(null, E('pre', {}, res.text || (res.ok ? 'OK' : 'failed')), res.ok ? 'info' : 'error');
									window.location.reload();
								});
						}),
						' ',
						st.external_ui ? E('a', { 'class': 'btn', href: dashTarget, target: '_blank', rel: 'noopener' }, _('打开面板')) : null
					])
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, _('备份与恢复')),
					E('div', { 'class': 'cbi-section-descr' }, _('用 SSH 执行：') + E('br', {}),
						E('code', {}, 'bettbox backup create /tmp/bettbox.tar  / bettbox backup restore /tmp/bettbox.tar')),
					E('div', { 'class': 'cbi-section-descr' }, _('包含：UCI 配置、订阅 profile、覆写脚本、规则文件。'))
				])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
