'use strict';
'require view';

// Retain old bookmarks while resources and maintenance live under settings.
return view.extend({
	render: function() {
		var target = new URL(L.url('admin', 'services', 'bettbox', 'settings'), window.location.href);
		target.search = window.location.search;
		target.searchParams.set('category', 'resources');
		window.location.replace(target.href);
		return E('p', {}, '正在打开资源与维护…');
	},
	handleSaveApply: null, handleSave: null, handleReset: null
});
