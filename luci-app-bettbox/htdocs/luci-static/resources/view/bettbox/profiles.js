'use strict';
'require view';
'require bettbox.subscriptions as Subscriptions';

return view.extend({
    load: function() { return Subscriptions.load(); },
    render: function(data) { return Subscriptions.render(data); },
    handleSaveApply: null, handleSave: null, handleReset: null
});
