'use strict';
'require baseclass';
'require bettbox.ui as UI';

var nextId = 0, dialogs = 0, oldOverflow = '';

function field(label, control, wide) {
	var input = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) ? control : control.querySelector('input,select,textarea');
	if (input && !input.id) input.id = 'bettbox-sub-field-' + (++nextId);
	return E('div', { 'class': 'hub-field' + (wide ? ' wide' : '') }, [E('label', { 'for': input ? input.id : null }, label), control]);
}
function toggle(value, label, change) {
	var knob = E('span', { 'class': 'switch' + (value ? '' : ' off'), 'aria-hidden': 'true' });
	var button = E('button', { type: 'button', 'class': 'hub-toggle', role: 'switch', 'aria-checked': String(value), 'aria-label': label }, knob);
	button.addEventListener('click', function() {
		value = !value; button.setAttribute('aria-checked', String(value)); knob.classList.toggle('off', !value); change(value);
	});
	button.setValue = function(next) { value = !!next; button.setAttribute('aria-checked', String(value)); knob.classList.toggle('off', !value); };
	return button;
}
function dialog(title, content, actions, options) {
	options = options || {};
	UI.mount();
	if (!document.getElementById('bettbox-subscriptions-css')) document.head.appendChild(E('link', { id: 'bettbox-subscriptions-css', rel: 'stylesheet', href: L.resource('bettbox/subscriptions.css') + '?v=20261030-2' }));
	var busy = false, closed = false, disabled = [], controller;
	var body = E('div', { 'class': 'hub-dialog-body' }, content);
	var footer = E('footer', { 'class': 'hub-dialog-foot' }, actions || []);
	var close = UI.button('关闭', function() { return controller.close(); }, 'bb-icon-only', 'close'); close.setAttribute('aria-label', '关闭' + title);
	var heading = E('h2', { id: 'bettbox-sub-dialog-' + (++nextId) }, title);
	var element = E('dialog', { 'class': 'bb-app hub-dialog' + (options.drawer ? ' hub-drawer' : '') + (options.confirm ? ' hub-confirm' : ''), 'aria-labelledby': heading.id }, [
		E('header', { 'class': 'hub-dialog-head' }, [heading, close]), body, footer]);
	controller = {
		element: element, body: body, footer: footer,
		setBusy: function(next) {
			if (busy === next) return; busy = next;
			if (next) { disabled = Array.from(element.querySelectorAll('button,input,select,textarea')).map(function(el) { var old = el.disabled; el.disabled = true; return [el, old]; }); }
			else { disabled.forEach(function(pair) { pair[0].disabled = pair[1]; }); disabled = []; }
		},
		close: function(force) {
			if (busy || closed) return Promise.resolve(false);
			return Promise.resolve(force || !options.beforeClose ? true : options.beforeClose()).then(function(allowed) {
				if (!allowed || closed) return false;
				closed = true; element.close(); element.remove(); dialogs--;
				if (!dialogs) document.body.style.overflow = oldOverflow;
				if (options.onClose) options.onClose(); return true;
			});
		}
	};
	element.addEventListener('cancel', function(ev) { ev.preventDefault(); controller.close(); });
	if (!dialogs++) { oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
	document.body.appendChild(element); element.showModal(); return controller;
}
function confirm(title, message, label, danger) {
	return new Promise(function(resolve) {
		var box, done = false;
		function finish(value) { done = true; return box.close(true).then(function() { resolve(value); }); }
		box = dialog(title, E('p', {}, message), [UI.button('取消', function() { return finish(false); }), UI.button(label || '确认', function() { return finish(true); }, danger ? 'danger' : 'primary')], {
			confirm: true,
			onClose: function() { if (!done) resolve(false); }
		});
	});
}
function object(value) {
	try { var data = typeof value === 'string' ? JSON.parse(value || '{}') : value; return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; }
	catch (e) { return {}; }
}

return baseclass.extend({ field: field, toggle: toggle, dialog: dialog, confirm: confirm, object: object });
