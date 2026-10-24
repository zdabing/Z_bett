'use strict';
'require baseclass';
'require rpc';

/* Direct core-controller client (same model as the Bettbox app): the browser
   talks straight to the mihomo external-controller instead of going through
   rpcd->curl (~200ms/call -> ~3ms). Loaded via 'require bettbox.core'. */

var getStatusRpc = rpc.declare({ object: 'bettbox', method: 'get_status' });

return baseclass.extend({
	base: 'http://' + (window.location.hostname || '10.0.0.1') + ':9097',
	secret: '',
	port: '9097',
	_init: null,

	init: function () {
		if (this._init == null) {
			var self = this;
			this._init = getStatusRpc().then(function (st) {
				self.secret = (st && st.secret) || '';
				var ctl = ((st && st.controller) || '').split(':');
				if (ctl.length == 2 && ctl[1])
					self.port = ctl[1];
				self.base = 'http://' + (window.location.hostname || '10.0.0.1') + ':' + self.port;
				return self;
			}).catch(function () { return self; });
		}
		return this._init;
	},

	_headers: function () {
		var h = { 'Content-Type': 'application/json' };
		if (this.secret) h['Authorization'] = 'Bearer ' + this.secret;
		return h;
	},

	api: function (method, path, body) {
		var self = this;
		var opt = { method: method, headers: this._headers() };
		if (body != null && body !== '') opt.body = body;
		return this.init().then(function () {
			return fetch(self.base + path, opt).then(function (res) {
				return res.json().then(function (data) {
					return { status: res.status, data: data };
				});
			});
		});
	},

	get: function (path) { return this.api('GET', path, ''); },
	put: function (path, body) { return this.api('PUT', path, JSON.stringify(body)); },
	del: function (path) { return this.api('DELETE', path, ''); },

	/* Live NDJSON stream (/traffic, /memory push one JSON object per line).
	   Returns { stop, promise }; cb(chunk) fires per sample. */
	stream: function (path, cb) {
		var self = this, stopped = false;
		var ctrl = { stop: function () { stopped = true; } };
		ctrl.promise = this.init().then(function () {
			if (stopped) return;
			return fetch(self.base + path, { headers: self._headers() }).then(function (res) {
				var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
				function pump() {
					if (stopped) { try { reader.cancel(); } catch (e) { } return; }
					return reader.read().then(function (r) {
						if (r.done || stopped) return;
						buf += dec.decode(r.value, { stream: true });
						var lines = buf.split('\n');
						buf = lines.pop();
						lines.forEach(function (ln) {
							if (!ln.trim()) return;
							try { cb(JSON.parse(ln)); } catch (e) { }
						});
						return pump();
					});
				}
				return pump();
			}).catch(function () { /* stream ended; caller may fall back to polling */ });
		});
		return ctrl;
	}
});
