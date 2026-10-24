'use strict';
'require baseclass';

/* Minimal LuCI "request" transport module.
   Some luci-base builds (this router's 25.12 snapshot) ship rpc.js with
   'require request' but omit the request.js file; without it every client
   view hangs at "Loading view…". Implements the fetch-style response
   contract rpc.js expects: { ok, status, statusText, text(), json() }. */

function makeResponse(xhr) {
	const txt = xhr.responseText ?? '';
	return {
		ok: (xhr.status >= 200 && xhr.status < 300),
		status: xhr.status,
		statusText: xhr.statusText,
		text: function () { return Promise.resolve(txt); },
		json: function () { return Promise.resolve(JSON.parse(txt)); }
	};
}

return baseclass.extend({
	request: function (method, url, options) {
		options = Object.assign({}, options);
		const xhr = new XMLHttpRequest();
		return new Promise(function (resolve, reject) {
			xhr.open(method, url, true);
			if (options.credentials !== false)
				xhr.withCredentials = true;
			const headers = Object.assign({}, options.headers);
			if (options.request != null && !headers['Content-Type'])
				headers['Content-Type'] = 'application/json';
			for (const k in headers)
				xhr.setRequestHeader(k, headers[k]);
			if (options.timeout > 0)
				xhr.timeout = options.timeout;
			xhr.onload = function () { resolve(makeResponse(xhr)); };
			xhr.onerror = function () { reject(new Error('Network error')); };
			xhr.ontimeout = function () { reject(new Error('Request timeout')); };
			xhr.send(options.request ?? null);
		});
	},

	get: function (url, options) {
		return this.request('GET', url, options);
	},

	post: function (url, data, options) {
		return this.request('POST', url, Object.assign({}, options, {
			request: (data != null && typeof data !== 'string') ? JSON.stringify(data) : (data ?? null)
		}));
	}
});
