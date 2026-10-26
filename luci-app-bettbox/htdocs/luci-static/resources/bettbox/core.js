'use strict';
'require baseclass';
'require rpc';

/* HTTP views use the LAN controller. HTTPS and loopback-only controllers
   use LuCI RPC; streaming telemetry uses bounded snapshots on that path. */

var getStatusRpc = rpc.declare({ object: 'bettbox', method: 'get_status' });
var proxyRpc = rpc.declare({ object: 'bettbox', method: 'api_proxy', params: [ 'method', 'path', 'body' ] });

function checked(res) {
	if (!res || res.error || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) {
		var err = new Error((res && (res.error || (res.data && (res.data.message || res.data.error)) || res.raw)) || 'Core request failed');
		err.httpStatus = res ? res.status : 0;
		throw err;
	}
	return res;
}

return baseclass.extend({
	base: 'http://' + (window.location.hostname || '10.0.0.1') + ':9097',
	secret: '',
	port: '9097',
	_init: null,
	useRelay: false,

	init: function () {
		if (this._init == null) {
			var self = this;
			this._init = getStatusRpc().then(function (st) {
				self.secret = (st && st.secret) || '';
				var ctl = ((st && st.controller) || '').split(':');
				self.port = ctl[ctl.length - 1] || '9097';
				var host = window.location.hostname || '10.0.0.1';
				if (host.indexOf(':') >= 0 && host.charAt(0) !== '[') host = '[' + host + ']';
				self.base = 'http://' + host + ':' + self.port;
				self.useRelay = window.location.protocol === 'https:' || (st && st.allow_lan === false) ||
					(host.indexOf(':') >= 0 && ((st && st.controller) || '').charAt(0) !== '[');
				return self;
			}).catch(function (err) { self._init = null; throw err; });
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
		return this.init().then(function () {
			if (self.useRelay) return proxyRpc(method, path, body || '').then(checked);
			// init must supply the secret before the first request headers are built.
			var opt = { method: method, headers: self._headers() };
			if (body != null && body !== '') opt.body = body;
			var abort = new AbortController();
			opt.signal = abort.signal;
			var timeout = window.setTimeout(function () { abort.abort(); }, 8000);
			return fetch(self.base + path, opt).then(function (res) {
				return res.text().then(function (raw) {
					var data = null;
					if (raw.trim()) { try { data = JSON.parse(raw); } catch (e) {} }
					return checked({ status: res.status, data: data, raw: raw });
				});
			}).finally(function () { window.clearTimeout(timeout); }).catch(function (err) {
				// Never replay a write after an ambiguous connection failure.
				if (method !== 'GET' || err.httpStatus != null) throw err;
				self.useRelay = true;
				return proxyRpc(method, path, body || '').then(checked);
			});
		});
	},

	get: function (path) { return this.api('GET', path, ''); },
	put: function (path, body) { return this.api('PUT', path, JSON.stringify(body)); },
	patch: function (path, body) { return this.api('PATCH', path, JSON.stringify(body)); },
	del: function (path) { return this.api('DELETE', path, ''); },

	/* Live NDJSON stream (/traffic, /memory push one JSON object per line).
	   Returns { stop, promise }; cb(chunk) fires per sample. */
	stream: function (path, cb) {
		var self = this, stopped = false, timer = null, previous = null, reader = null;
		var abort = new AbortController();
		var ctrl = { stop: function () {
			stopped = true;
			if (timer != null) window.clearTimeout(timer);
			abort.abort();
			if (reader) reader.cancel().catch(function () {});
		} };
		function snapshots() {
			if (stopped) return Promise.resolve();
			return self.get('/connections').then(function (res) {
				if (stopped) return;
				var data = res.data || {}, now = Date.now();
				if (path === '/memory') cb({ inuse: data.memory || 0 });
				else if (path === '/traffic') {
					var next = { up: data.uploadTotal || 0, down: data.downloadTotal || 0, time: now };
					if (previous && now > previous.time)
						cb({ up: Math.max(0, next.up - previous.up) * 1000 / (now - previous.time),
							down: Math.max(0, next.down - previous.down) * 1000 / (now - previous.time) });
					previous = next;
				}
			}).catch(function () {}).then(function () {
				if (!stopped) timer = window.setTimeout(snapshots, 1000);
			});
		}
		ctrl.promise = this.init().then(function () {
			if (stopped) return;
			if (self.useRelay) return snapshots();
			return fetch(self.base + path, { headers: self._headers(), signal: abort.signal }).then(function (res) {
				checked({ status: res.status });
				reader = res.body.getReader();
				var dec = new TextDecoder(), buf = '';
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
			});
		}).catch(function () { if (!stopped) return snapshots(); });
		return ctrl;
	}
});
