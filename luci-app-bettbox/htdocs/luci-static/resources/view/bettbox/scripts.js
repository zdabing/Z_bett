'use strict';
'require view';

// Retain old bookmarks while the script library lives under subscriptions.
return view.extend({
    render: function() {
        var target = new URL(L.url('admin','services','bettbox','profiles'), window.location.href);
        target.search = window.location.search;
        target.searchParams.set('section', 'scripts');
        window.location.replace(target.href);
        return E('p', {}, '正在打开脚本管理…');
    },
    handleSaveApply: null, handleSave: null, handleReset: null
});
