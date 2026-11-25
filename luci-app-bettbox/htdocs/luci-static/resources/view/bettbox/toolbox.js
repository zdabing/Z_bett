'use strict';
'require view';
'require rpc';
'require bettbox.ui as UI';

var statusRPC = rpc.declare({ object: 'bettbox', method: 'get_status' });

var TOOLS = [
	['health', '网络健康', 'activity', '分层诊断核心与 DNS 链路', 'blue'],
	['trace', '路由追踪', 'route', '查看目标命中的规则与出口链', 'green'],
	['dns', 'DNS 查询', 'globe', '对比核心 DNS 与系统解析', 'teal'],
	['traffic', '流量统计', 'traffic', '域名、节点与规则用量明细', 'purple']
];

var HEALTH_LAYERS = [
	['process', '核心进程'],
	['controller', '控制接口'],
	['core_dns', '核心 DNS'],
	['dnsmasq', 'dnsmasq'],
	['upstream', '上游 DNS（本机路径）'],
	['explicit', '显式代理访问'],
	['router_access', '路由器本机访问']
];

var HEALTH_STATUS = {
	ok: ['通过', ''],
	fail: ['失败', 'danger'],
	unknown: ['未确认', 'neutral'],
	skipped: ['未检测', 'neutral'],
	stopped: ['已停止', 'neutral']
};

var HEALTH_REASONS = {
	service_stopped: '服务未启动',
	missing_nslookup: '缺少 nslookup',
	unsupported_nslookup: '查询工具不支持该方式',
	invalid_dns_endpoint: 'DNS 地址无法检测',
	unsupported_dns_transport: '该 DNS 协议不适用于 UDP 查询',
	not_owned: '未接管 dnsmasq',
	not_configured: '未配置可检测的上游',
	mixed_disabled: 'Mixed 端口未开启',
	invalid_controller_endpoint: '控制接口地址无法检测',
	api_failed: '控制接口未正常响应',
	no_address: '未获得有效的 A 记录',
	proxy_authentication: '代理认证失败',
	connection_failed: '请求失败',
	runtime_missing: '没有运行配置'
};

var DNS_RCODES = {
	0: ['NOERROR', ''],
	1: ['FORMERR', 'danger'],
	2: ['SERVFAIL', 'danger'],
	3: ['NXDOMAIN', 'danger'],
	4: ['NOTIMP', 'neutral'],
	5: ['REFUSED', 'danger']
};

var DNS_TYPES = {
	1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR',
	15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 64: 'SVCB', 65: 'HTTPS'
};

var SKIP_LABELS = {
	missing: '目标策略不存在',
	udp: '不支持 UDP',
	pass: 'PASS 跳过'
};

function isFakeIP(addr) {
	var s = String(addr || '').trim();
	return /^198\.1[89]\./.test(s) || /^2001:0*2:/i.test(s);
}

function validHost(value) {
	var s = String(value || '').trim();
	if (!s || s.length > 253 || s.charAt(0) === '-' || !/^[A-Za-z0-9_:.-]+$/.test(s)) {
		throw new Error('请输入有效的域名或 IP 地址');
	}
	return s;
}

function validPort(value) {
	var n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 65535) {
		throw new Error('请输入 1–65535 之间的端口');
	}
	return String(n);
}

function fmtDurationUs(us) {
	var n = Number(us);
	if (!isFinite(n) || n < 0) return '—';
	if (n < 1000) return Math.round(n) + ' µs';
	return (n / 1000).toFixed(2) + ' ms';
}

function fmtDurationMs(ms) {
	var n = Number(ms);
	if (!isFinite(n) || n < 0) return '—';
	return n.toFixed(n >= 10 ? 1 : 2) + ' ms';
}

function fmtTime(epochSec) {
	if (!epochSec) return '';
	var d = new Date(Number(epochSec) * 1000);
	return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

function dateOffset(daysBack) {
	var d = new Date();
	d.setDate(d.getDate() - daysBack);
	return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function pushHistory(list, value) {
	var s = String(value || '').trim();
	if (!s) return list;
	var next = [s].concat((list || []).filter(function(x) { return x !== s; }));
	return next.slice(0, 6);
}

function parseJSON(text) {
	if (typeof text !== 'string') return null;
	try { return JSON.parse(text); } catch (e) { return null; }
}

function parseNslookup(text) {
	var lines = String(text || '').split(/\r?\n/);
	var server = '', inAnswer = false, addresses = [], seen = Object.create(null);
	lines.forEach(function(line) {
		var s = line.trim();
		if (!s) return;
		if (/^Name:/i.test(s)) {
			inAnswer = true;
			return;
		}
		if (!inAnswer) {
			var sm = s.match(/^Server:\s*(.+)$/i);
			if (sm) server = sm[1].trim();
			return;
		}
		var am = s.match(/^Address(?:\s+\d+)?:\s*(.+)$/i);
		if (am) {
			var addr = am[1].trim().split(/\s+/)[0];
			if (addr && !seen[addr]) {
				seen[addr] = true;
				addresses.push(addr);
			}
		}
	});
	return { server: server, addresses: addresses };
}

function copyButton(value, label) {
	var btn = UI.button(label || '复制', function() { return UI.copy(String(value)); }, 'bb-tb-mini', 'copy');
	btn.title = '复制 ' + String(value);
	return btn;
}

function makeSegmented(items, activeVal, onSelect, ariaLabel) {
	return E('div', { 'class': 'bb-tb-seg', role: 'group', 'aria-label': ariaLabel || '切换选项' }, items.map(function(item) {
		var val = item[0], text = item[1];
		var on = val === activeVal;
		var btn = E('button', {
			type: 'button',
			'class': 'bb-tb-seg-btn' + (on ? ' active' : ''),
			'aria-pressed': String(on)
		}, text);
		btn.addEventListener('click', function() { onSelect(val); });
		return btn;
	}));
}

return view.extend({
	load: function() {
		return statusRPC().catch(function() { return null; });
	},

	render: function(statusData) {
		if (!document.getElementById('bettbox-health-css')) {
			document.head.appendChild(E('link', {
				id: 'bettbox-health-css',
				rel: 'stylesheet',
				href: L.resource('bettbox/health.css') + '?v=20261125-2'
			}));
		}

		var requested = new URLSearchParams(window.location.search).get('tool');
		var active = TOOLS.some(function(t) { return t[0] === requested; }) ? requested : 'health';
		var cachedHealth = statusData && statusData.health && statusData.health.layers ? statusData.health : null;

		var states = {
			health: {
				domain: (cachedHealth && cachedHealth.target) || 'www.baidu.com',
				running: false,
				report: cachedHealth,
				cached: !!cachedHealth,
				error: '',
				finished: cachedHealth ? fmtTime(cachedHealth.checked_at) : ''
			},
			trace: {
				target: 'www.youtube.com',
				network: 'tcp',
				port: '443',
				onlyMatched: false,
				stepQuery: '',
				showAllSteps: false,
				history: [],
				running: false,
				report: null,
				error: '',
				finished: ''
			},
			dns: {
				domain: 'www.baidu.com',
				type: 'A',
				mode: 'follow',
				server: '223.5.5.5',
				history: [],
				running: false,
				raw: '',
				parsed: null,
				error: '',
				finished: ''
			},
			traffic: {
				range: '7d',
				from: dateOffset(6),
				to: dateOffset(0),
				hostFilter: '',
				dimension: 'hosts',
				loading: false,
				loaded: false,
				result: null,
				error: '',
				requestSeq: 0
			}
		};

		var tabButtons = Object.create(null);
		var workspace = E('div', { 'class': 'bb-tb-workspace', role: 'tabpanel' });

		function selectTool(id, skipUrl) {
			active = id;
			if (!skipUrl) {
				var url = new URL(window.location.href);
				url.searchParams.set('tool', id);
				window.history.replaceState({}, '', url.href);
			}
			draw();
			if (id === 'traffic' && !states.traffic.loaded && !states.traffic.loading) {
				loadTraffic();
			}
		}

		function jumpToTool(toolId, patch, autoRun) {
			var st = states[toolId];
			if (patch) Object.assign(st, patch);
			selectTool(toolId, false);
			if (autoRun) {
				if (toolId === 'trace') runTrace();
				else if (toolId === 'dns') runDns();
				else if (toolId === 'health') runHealth();
				else if (toolId === 'traffic') loadTraffic();
			}
		}

		/* ---------------- Tool 1: 网络健康 ---------------- */

		function runHealth() {
			var st = states.health;
			if (st.running) return Promise.resolve();
			var target;
			try { target = validHost(st.domain); } catch (err) { st.error = err.message; draw(); return Promise.resolve(); }
			st.domain = target;
			st.running = true;
			st.error = '';
			draw();
			return UI.job('health', [target]).then(function(res) {
				var report = parseJSON(res && res.text);
				if (!report || !report.layers || !report.summary) throw new Error('未获得有效的分层检测结果');
				st.report = report;
				st.cached = false;
			}).catch(function(err) {
				st.error = err.message || '网络健康检测失败';
			}).finally(function() {
				st.running = false;
				st.finished = new Date().toLocaleTimeString();
				draw();
			});
		}

		function renderHealth() {
			var st = states.health;
			var domainInput = E('input', {
				'class': 'field',
				type: 'text',
				value: st.domain,
				placeholder: '输入测试域名（如 www.baidu.com）',
				'aria-label': '测试域名'
			});
			domainInput.addEventListener('input', function() { st.domain = domainInput.value; });
			domainInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); runHealth(); } });

			var runBtn = UI.button(st.running ? '检测中…' : '开始检测', runHealth, 'primary', 'activity');
			runBtn.disabled = st.running;

			var presetChips = ['www.baidu.com', 'www.google.com', 'github.com', 'chatgpt.com'].map(function(d) {
				var chip = E('button', {
					type: 'button',
					'class': 'bb-tb-chip' + (st.domain === d ? ' active' : '')
				}, d);
				chip.disabled = st.running;
				chip.addEventListener('click', function() {
					st.domain = d;
					runHealth();
				});
				return chip;
			});

			var nodes = [
				E('div', { 'class': 'bb-tb-bar bb-tb-bar-health' }, [
					E('div', { 'class': 'bb-tb-bar-grow' }, [domainInput]),
					runBtn
				]),
				E('div', { 'class': 'bb-tb-presets' }, [E('span', { 'class': 'bb-tb-preset-label' }, '常用测试：')].concat(presetChips))
			];

			if (st.error) {
				nodes.push(E('div', { 'class': 'bb-tb-banner danger', role: 'alert' }, [
					E('div', { 'class': 'bb-tb-banner-main' }, [UI.tag('失败', 'danger'), E('strong', {}, st.error)])
				]));
			}

			if (st.running && !st.report) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder', role: 'status' }, '正在并行检测核心进程、DNS 与出口链路…'));
				return nodes;
			}

			var report = st.report;
			if (!report) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder' }, '点击「开始检测」验证路由器 7 层网络与内存状态。'));
				return nodes;
			}

			var summary = report.summary || {};
			var layers = report.layers || {};
			var memory = report.memory || {};
			var target = report.target || st.domain;
			var tone = summary.status === 'ok' ? 'ok'
				: (summary.status === 'degraded' || summary.status === 'fail' ? 'danger' : 'warn');
			var dnsFailed = ['core_dns', 'dnsmasq', 'upstream'].some(function(k) { return layers[k] && layers[k].status === 'fail'; });

			var bannerActions = [
				UI.button('路由追踪分析', function() {
					jumpToTool('trace', { target: target, network: 'tcp', port: '443' }, true);
				}, 'bb-tb-mini', 'route')
			];
			if (dnsFailed) {
				bannerActions.unshift(UI.button('DNS 查询排查', function() {
					jumpToTool('dns', { domain: target, mode: 'follow', type: 'A' }, true);
				}, 'bb-tb-mini', 'globe'));
			}

			nodes.push(E('div', { 'class': 'bb-tb-banner ' + tone }, [
				E('div', { 'class': 'bb-tb-banner-main' }, [
					UI.tag(summary.status === 'ok' ? '链路正常' : (summary.status === 'stopped' ? '服务已停止' : '存在异常'),
						summary.status === 'ok' ? '' : (tone === 'danger' ? 'danger' : 'neutral')),
					E('strong', {}, summary.message || '检测完成'),
					E('span', { 'class': 'bb-tb-banner-meta mono' }, [
						target,
						st.finished ? ((st.cached ? ' · 缓存于 ' : ' · 检测于 ') + st.finished) : ''
					].join(''))
				]),
				E('div', { 'class': 'button-row' }, bannerActions)
			]));

			nodes.push(E('div', { 'class': 'bb-health-grid' }, HEALTH_LAYERS.map(function(pair, idx) {
				var key = pair[0], label = pair[1];
				var item = layers[key] || { status: 'unknown' };
				var meta = HEALTH_STATUS[item.status] || ['未确认', 'neutral'];
				var detail = item.reason
					? (HEALTH_REASONS[item.reason] || item.reason)
					: (item.http_status ? ('HTTP ' + item.http_status + ' · ' + Math.round(item.latency_ms || 0) + ' ms') : (item.status === 'ok' ? '响应正常' : '检测未完成'));
				return E('div', { 'class': 'bb-health-layer is-' + (item.status || 'unknown') }, [
					E('strong', {}, (idx + 1) + '. ' + label),
					UI.tag(meta[0], meta[1]),
					E('span', { 'class': 'small muted' }, detail)
				]);
			})));

			nodes.push(E('dl', { 'class': 'bb-health-memory' }, [
				['核心 RSS', memory.VmRSS],
				['核心 PSS', memory.Pss],
				['历史峰值', memory.VmHWM],
				['系统可用', memory.system_available]
			].map(function(pair) {
				return E('div', {}, [E('dt', {}, pair[0]), E('dd', { 'class': 'mono' }, UI.bytes(pair[1]))]);
			})));

			nodes.push(E('p', { 'class': 'small muted', style: 'margin:12px 0 0' }, '注：本检测验证路由器本机与核心链路；局域网终端透明代理连通性请在终端验证。'));
			return nodes;
		}

		/* ---------------- Tool 2: 路由追踪 ---------------- */

		function runTrace() {
			var st = states.trace;
			if (st.running) return Promise.resolve();
			var targetVal = String(st.target || '').trim();
			if (!targetVal || targetVal.length > 512) {
				st.error = '请输入域名、IP 地址或网址';
				draw();
				return Promise.resolve();
			}
			var portVal;
			try { portVal = validPort(st.port); } catch (err) { st.error = err.message; draw(); return Promise.resolve(); }
			st.target = targetVal;
			st.port = portVal;
			st.history = pushHistory(st.history, targetVal);
			st.running = true;
			st.error = '';
			st.showAllSteps = false;
			draw();
			return UI.job('toolbox', ['trace', targetVal, st.network, portVal]).then(function(res) {
				var report = parseJSON(res && res.text);
				if (!report) throw new Error((res && res.text) || '路由追踪返回格式无效');
				if (report.error) throw new Error(report.error === 'invalid' ? '无效的追踪目标' : report.error);
				st.report = report;
			}).catch(function(err) {
				st.error = err.message || '路由追踪失败';
			}).finally(function() {
				st.running = false;
				st.finished = new Date().toLocaleTimeString();
				draw();
			});
		}

		function traceSummaryText(report) {
			var chain = (report.chains || []).map(function(c) { return c.name; }).join(' -> ') || '—';
			var rule = report.matched
				? ('#' + (report.matched.index + 1) + ' ' + [report.matched.type, report.matched.payload, report.matched.adapter].filter(Boolean).join(','))
				: (report['fallback-direct'] ? '未命中规则（回退 DIRECT）' : '直连/全局模式');
			var dns = (report['resolved-ips'] || []).join(', ') || (report['hosts-ips'] || []).join(', ') || report['dst-ip'] || report['resolve-error'] || '—';
			return [
				'目标: ' + report.target + ' (' + String(report.network || '').toUpperCase() + ':' + report.port + ')',
				'模式: ' + report.mode + ' | 匹配耗时: ' + fmtDurationMs(report['match-time']),
				'命中规则: ' + rule,
				'出口链路: ' + chain,
				'DNS 解析: ' + dns
			].join('\n');
		}

		function renderTrace() {
			var st = states.trace;
			var targetInput = E('input', {
				'class': 'field',
				type: 'text',
				value: st.target,
				placeholder: '输入域名、URL 或 IP（如 chatgpt.com、1.1.1.1）',
				'aria-label': '追踪目标'
			});
			targetInput.addEventListener('input', function() { st.target = targetInput.value; });
			targetInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); runTrace(); } });

			var netSeg = makeSegmented([['tcp', 'TCP'], ['udp', 'UDP']], st.network, function(val) {
				st.network = val;
				draw();
			}, '追踪协议');

			var portInput = E('input', {
				'class': 'field bb-tb-port mono',
				type: 'number',
				min: '1',
				max: '65535',
				value: st.port,
				'aria-label': '目标端口'
			});
			portInput.addEventListener('input', function() { st.port = portInput.value; });
			portInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); runTrace(); } });

			var portWrap = E('div', { 'class': 'bb-tb-port-wrap' }, [portInput].concat(['443', '80', '53'].map(function(p) {
				var b = E('button', { type: 'button', 'class': 'bb-tb-chip' + (st.port === p ? ' active' : '') }, p);
				b.addEventListener('click', function() { st.port = p; draw(); });
				return b;
			})));

			var runBtn = UI.button(st.running ? '追踪中…' : '开始追踪', runTrace, 'primary', 'route');
			runBtn.disabled = st.running;

			var quickTargets = ['www.youtube.com', 'chatgpt.com', 'github.com', 'www.baidu.com', '1.1.1.1'];
			var allQuick = st.history.concat(quickTargets.filter(function(q) { return st.history.indexOf(q) < 0; })).slice(0, 7);

			var nodes = [
				E('div', { 'class': 'bb-tb-bar bb-tb-bar-trace' }, [
					E('div', { 'class': 'bb-tb-bar-grow' }, [targetInput]),
					netSeg,
					portWrap,
					runBtn
				]),
				E('div', { 'class': 'bb-tb-presets' }, [E('span', { 'class': 'bb-tb-preset-label' }, '快捷目标：')].concat(allQuick.map(function(item) {
					var chip = E('button', {
						type: 'button',
						'class': 'bb-tb-chip' + (st.target === item ? ' active' : '')
					}, item);
					chip.disabled = st.running;
					chip.addEventListener('click', function() { st.target = item; runTrace(); });
					return chip;
				})))
			];

			if (st.error) {
				nodes.push(E('div', { 'class': 'bb-tb-banner danger', role: 'alert' }, [
					E('div', { 'class': 'bb-tb-banner-main' }, [UI.tag('失败', 'danger'), E('strong', {}, st.error)])
				]));
			}

			if (st.running && !st.report) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder', role: 'status' }, '正在核心规则引擎中模拟匹配分流路径…'));
				return nodes;
			}

			var r = st.report;
			if (!r) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder' }, '输入任意域名或 IP 模拟 Mihomo 真实分流判定（不产生真实外网连接）。'));
				return nodes;
			}

			/* Chain Hero */
			var chainNodes = [];
			(r.chains || []).forEach(function(hop, idx) {
				if (idx > 0) chainNodes.push(E('span', { 'class': 'bb-trace-arrow', 'aria-hidden': 'true' }, UI.icon('arrow')));
				var isEnd = idx === r.chains.length - 1;
				chainNodes.push(E('span', { 'class': 'bb-trace-hop' + (isEnd ? ' final' : '') }, [
					E('strong', {}, hop.name),
					hop.type ? E('small', {}, hop.type) : ''
				]));
			});
			if (!chainNodes.length) chainNodes.push(E('span', { 'class': 'muted' }, '无出口链路'));

			nodes.push(E('section', { 'class': 'bb-trace-hero' }, [
				E('div', { 'class': 'bb-trace-hero-head' }, [
					E('div', { 'class': 'bb-tb-badges' }, [
						UI.tag((r.mode || 'rule').toUpperCase() + ' 模式'),
						UI.tag((r.network || 'tcp').toUpperCase() + ':' + r.port, 'neutral'),
						UI.tag(r['support-udp'] ? '支持 UDP' : '不支持 UDP', r['support-udp'] ? '' : 'neutral'),
						r['fallback-direct'] ? UI.tag('未命中回退 DIRECT', 'danger') : '',
						E('span', { 'class': 'small muted mono' }, '匹配耗时 ' + fmtDurationMs(r['match-time']))
					]),
					UI.button('复制摘要', function() { return UI.copy(traceSummaryText(r)); }, 'bb-tb-mini', 'copy')
				]),
				E('div', { 'class': 'bb-trace-chain', 'aria-label': '出口策略链' }, chainNodes)
			]));

			/* Two summary cards: Matched Rule + DNS Resolution */
			var ruleBody;
			if (r.matched) {
				ruleBody = E('div', { 'class': 'bb-trace-kv' }, [
					E('div', {}, [E('span', { 'class': 'muted' }, '序号'), E('strong', { 'class': 'mono' }, '#' + (r.matched.index + 1))]),
					E('div', {}, [E('span', { 'class': 'muted' }, '类型'), E('strong', { 'class': 'mono' }, r.matched.type)]),
					E('div', { 'class': 'wide' }, [E('span', { 'class': 'muted' }, '规则内容'), E('strong', { 'class': 'mono' }, r.matched.payload || '（无）')]),
					E('div', {}, [E('span', { 'class': 'muted' }, '指向'), E('strong', {}, r.matched.adapter)]),
					E('div', {}, [E('span', { 'class': 'muted' }, '单条耗时'), E('strong', { 'class': 'mono' }, fmtDurationUs(r.matched.duration))])
				]);
			} else {
				ruleBody = E('p', { 'class': 'small muted', style: 'margin:0' }, r['fallback-direct'] ? '遍历全部规则均未命中，已回退 DIRECT。' : '当前模式未经过规则表匹配。');
			}

			var ipPills = [];
			(r['hosts-ips'] || []).forEach(function(ip) {
				ipPills.push(E('span', { 'class': 'bb-tb-ip-pill' }, [E('em', {}, 'Hosts'), E('code', {}, ip)]));
			});
			(r['resolved-ips'] || []).forEach(function(ip) {
				ipPills.push(E('span', { 'class': 'bb-tb-ip-pill' }, [E('code', {}, ip), isFakeIP(ip) ? UI.tag('Fake-IP') : '']));
			});
			if (!ipPills.length && r['dst-ip']) {
				ipPills.push(E('span', { 'class': 'bb-tb-ip-pill' }, [E('code', {}, r['dst-ip']), isFakeIP(r['dst-ip']) ? UI.tag('Fake-IP') : '']));
			}

			var dnsBody = [
				E('div', { 'class': 'bb-tb-badges', style: 'margin-bottom:10px' }, [
					r['dns-mode'] ? UI.tag('DNS: ' + r['dns-mode'], 'neutral') : '',
					r['resolve-time'] > 0 ? E('span', { 'class': 'small muted mono' }, '解析耗时 ' + fmtDurationMs(r['resolve-time'])) : '',
					r['resolved-by'] >= 0 ? E('span', { 'class': 'small muted' }, '由第 #' + (r['resolved-by'] + 1) + ' 条触发解析') : ''
				]),
				r['resolve-error']
					? E('div', { 'class': 'bb-tb-inline-err' }, '解析错误：' + r['resolve-error'])
					: (ipPills.length
						? E('div', { 'class': 'bb-dns-pills' }, ipPills)
						: E('p', { 'class': 'small muted', style: 'margin:0' }, r.host ? '匹配全程仅使用域名规则，未触发 IP 解析' : '目标本身为 IP 地址'))
			];

			var dnsCardActions = r.host ? [
				UI.button('查 DNS', function() {
					jumpToTool('dns', { domain: r.host, mode: 'follow', type: 'A' }, true);
				}, 'bb-tb-mini', 'globe')
			] : [];

			nodes.push(E('div', { 'class': 'bb-trace-cards' }, [
				E('section', { 'class': 'bb-trace-card' }, [
					E('div', { 'class': 'bb-trace-card-head' }, [
						E('h3', {}, '命中规则'),
						E('span', { 'class': 'small muted mono' }, '已检 ' + (r.checked || 0) + ' / ' + (r.total || 0) + (r.truncated ? '（截断）' : ''))
					]),
					ruleBody
				]),
				E('section', { 'class': 'bb-trace-card' }, [
					E('div', { 'class': 'bb-trace-card-head' }, [
						E('h3', {}, 'DNS 与地址信息'),
						E('div', {}, dnsCardActions)
					])
				].concat(dnsBody))
			]));

			/* Collapsible Steps Explorer */
			var steps = Array.isArray(r.steps) ? r.steps : [];
			if (steps.length) {
				var q = String(st.stepQuery || '').trim().toLowerCase();
				var filtered = steps.filter(function(s) {
					if (st.onlyMatched && !s.matched && !s.skipped && !s.resolve) return false;
					if (!q) return true;
					return (String(s.type) + ' ' + String(s.payload) + ' ' + String(s.adapter)).toLowerCase().indexOf(q) >= 0;
				});
				var limit = st.showAllSteps ? filtered.length : Math.min(filtered.length, 200);
				var visibleSteps = filtered.slice(0, limit);

				var stepFilterSeg = makeSegmented([
					[false, '全部已检 (' + steps.length + ')'],
					[true, '关键步骤']
				], st.onlyMatched, function(val) { st.onlyMatched = val; st.showAllSteps = false; draw(); }, '步骤过滤');

				var stepSearch = E('input', {
					type: 'search',
					'class': 'field bb-tb-step-search',
					value: st.stepQuery,
					placeholder: '过滤类型 / 规则 / 策略…',
					'aria-label': '过滤匹配步骤'
				});
				stepSearch.addEventListener('input', function() { st.stepQuery = stepSearch.value; st.showAllSteps = false; draw(); });

				var tbody = E('tbody', {}, visibleSteps.map(function(s) {
					var badge;
					if (s.matched) badge = UI.tag('命中', '');
					else if (s.skipped) badge = UI.tag('跳过 · ' + (SKIP_LABELS[s.skipped] || s.skipped), 'neutral');
					else if (s.resolve) badge = UI.tag('触发 DNS', 'neutral');
					else badge = E('span', { 'class': 'small muted' }, '未匹配');
					return E('tr', { 'class': s.matched ? 'is-matched' : (s.skipped ? 'is-skipped' : '') }, [
						E('td', { 'class': 'mono muted' }, String(s.index + 1)),
						E('td', { 'class': 'mono' }, s.type || ''),
						E('td', { 'class': 'mono bb-tb-cell-wrap' }, s.payload || '—'),
						E('td', { 'class': 'bb-tb-cell-wrap' }, s.adapter || '—'),
						E('td', {}, badge),
						E('td', { 'class': 'mono muted' }, fmtDurationUs(s.duration))
					]);
				}));

				var tableWrap = [
					E('div', { 'class': 'bb-tb-fold-tools' }, [stepFilterSeg, stepSearch]),
					filtered.length
						? E('div', { 'class': 'bb-tb-table-wrap' }, [
							E('table', { 'class': 'bb-tb-table' }, [
								E('thead', {}, E('tr', {}, [
									E('th', {}, '#'),
									E('th', {}, '类型'),
									E('th', {}, '规则内容'),
									E('th', {}, '目标'),
									E('th', {}, '状态'),
									E('th', {}, '耗时')
								])),
								tbody
							])
						])
						: E('p', { 'class': 'small muted', style: 'margin:8px 0 0' }, '没有符合筛选条件的步骤。')
				];
				if (filtered.length > limit) {
					var moreBtn = UI.button('显示全部剩余 ' + (filtered.length - limit) + ' 条', function() {
						st.showAllSteps = true;
						draw();
					}, 'bb-tb-mini');
					tableWrap.push(E('div', { style: 'margin-top:10px' }, [moreBtn]));
				}

				nodes.push(E('details', { 'class': 'bb-tb-fold', open: (st.onlyMatched || !!q || st.showAllSteps) ? true : null }, [
					E('summary', {}, [
						E('span', { 'class': 'bb-tb-fold-title' }, [UI.icon('chevron'), E('strong', {}, '规则逐条匹配明细（' + steps.length + ' 条）')]),
						E('span', { 'class': 'small muted' }, r.truncated ? '已达上限 3000 条' : '按顺序执行')
					]),
					E('div', { 'class': 'bb-tb-fold-body' }, tableWrap)
				]));
			}

			return nodes;
		}

		/* ---------------- Tool 3: DNS 查询 ---------------- */

		function runDns() {
			var st = states.dns;
			if (st.running) return Promise.resolve();
			var domainVal, serverVal = '';
			try {
				domainVal = validHost(st.domain);
				if (st.mode === 'custom') serverVal = validHost(st.server);
			} catch (err) {
				st.error = err.message;
				draw();
				return Promise.resolve();
			}
			st.domain = domainVal;
			if (st.mode === 'custom') st.server = serverVal;
			st.history = pushHistory(st.history, domainVal);
			st.running = true;
			st.error = '';
			draw();
			return UI.job('toolbox', ['dns', domainVal, st.type, st.mode, serverVal]).then(function(res) {
				var raw = (res && res.text) || '';
				st.raw = raw;
				st.parsed = st.mode === 'follow' ? parseJSON(raw) : parseNslookup(raw);
			}).catch(function(err) {
				st.error = err.message || 'DNS 查询失败';
			}).finally(function() {
				st.running = false;
				st.finished = new Date().toLocaleTimeString();
				draw();
			});
		}

		function renderDns() {
			var st = states.dns;
			var domainInput = E('input', {
				'class': 'field',
				type: 'text',
				value: st.domain,
				placeholder: '输入查询域名（如 www.baidu.com）',
				'aria-label': '查询域名'
			});
			domainInput.addEventListener('input', function() { st.domain = domainInput.value; });
			domainInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); runDns(); } });

			var runBtn = UI.button(st.running ? '查询中…' : '查询 DNS', runDns, 'primary', 'globe');
			runBtn.disabled = st.running;

			var quickDomains = ['www.baidu.com', 'www.google.com', 'chatgpt.com', 'github.com'];
			var allQuick = st.history.concat(quickDomains.filter(function(q) { return st.history.indexOf(q) < 0; })).slice(0, 6);

			var modeSeg = makeSegmented([
				['follow', '核心 DNS'],
				['system', '系统 dnsmasq'],
				['custom', '自定义服务器']
			], st.mode, function(val) {
				if (st.mode === val) return;
				st.mode = val;
				st.raw = '';
				st.parsed = null;
				st.error = '';
				draw();
			}, 'DNS 查询路径');

			var optionsRow = [modeSeg, makeSegmented([
				['A', 'A'], ['AAAA', 'AAAA'], ['CNAME', 'CNAME'],
				['TXT', 'TXT'], ['MX', 'MX'], ['NS', 'NS']
			], st.type, function(val) {
				st.type = val;
				if (st.domain.trim()) runDns();
				else draw();
			}, '记录类型')];
			if (st.mode === 'custom') {
				var srvInput = E('input', {
					'class': 'field bb-tb-server mono',
					type: 'text',
					value: st.server,
					placeholder: 'DNS 服务器 IP（如 223.5.5.5）',
					'aria-label': '指定 DNS 服务器'
				});
				srvInput.addEventListener('input', function() { st.server = srvInput.value; });
				srvInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); runDns(); } });
				optionsRow.push(E('div', { 'class': 'bb-tb-server-wrap' }, [srvInput].concat(['223.5.5.5', '119.29.29.29', '1.1.1.1', '8.8.8.8'].map(function(ip) {
					var b = E('button', { type: 'button', 'class': 'bb-tb-chip' + (st.server === ip ? ' active' : '') }, ip);
					b.addEventListener('click', function() { st.server = ip; runDns(); });
					return b;
				}))));
			}

			var nodes = [
				E('div', { 'class': 'bb-tb-bar bb-tb-bar-dns' }, [
					E('div', { 'class': 'bb-tb-bar-grow' }, [domainInput]),
					runBtn
				]),
				E('div', { 'class': 'bb-tb-presets' }, [E('span', { 'class': 'bb-tb-preset-label' }, '快捷域名：')].concat(allQuick.map(function(d) {
					var chip = E('button', { type: 'button', 'class': 'bb-tb-chip' + (st.domain === d ? ' active' : '') }, d);
					chip.disabled = st.running;
					chip.addEventListener('click', function() { st.domain = d; runDns(); });
					return chip;
				}))),
				E('div', { 'class': 'bb-tb-options' }, optionsRow)
			];

			if (st.error) {
				nodes.push(E('div', { 'class': 'bb-tb-banner danger', role: 'alert' }, [
					E('div', { 'class': 'bb-tb-banner-main' }, [UI.tag('失败', 'danger'), E('strong', {}, st.error)])
				]));
			}

			if (st.running && !st.raw) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder', role: 'status' }, '正在执行 DNS 解析…'));
				return nodes;
			}

			if (!st.raw) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder' }, '可对比核心内部分流 DNS、系统 dnsmasq 与外部指定 DNS 的解析差异。'));
				return nodes;
			}

			var traceJump = UI.button('路由追踪', function() {
				jumpToTool('trace', { target: st.domain, network: 'tcp', port: '443' }, true);
			}, 'bb-tb-mini', 'route');

			if (st.mode === 'follow' && st.parsed && typeof st.parsed === 'object') {
				var p = st.parsed;
				var rcode = DNS_RCODES[p.Status] || ['STATUS ' + p.Status, 'neutral'];
				var answers = Array.isArray(p.Answer) ? p.Answer : [];

				nodes.push(E('div', { 'class': 'bb-tb-banner ' + (p.Status === 0 ? 'ok' : 'danger') }, [
					E('div', { 'class': 'bb-tb-banner-main' }, [
						UI.tag(rcode[0], rcode[1]),
						E('strong', {}, st.domain + ' · ' + st.type),
						E('span', { 'class': 'bb-tb-banner-meta' }, answers.length + ' 条应答' + (st.finished ? ' · ' + st.finished : ''))
					]),
					E('div', { 'class': 'button-row' }, [traceJump])
				]));

				if (answers.length) {
					nodes.push(E('div', { 'class': 'bb-tb-table-wrap' }, [
						E('table', { 'class': 'bb-tb-table' }, [
							E('thead', {}, E('tr', {}, [
								E('th', {}, '域名'),
								E('th', {}, '类型'),
								E('th', {}, 'TTL'),
								E('th', {}, '解析结果'),
								E('th', {}, '操作')
							])),
							E('tbody', {}, answers.map(function(ans) {
								var tName = DNS_TYPES[ans.type] || String(ans.type || '');
								var val = String(ans.data || '');
								return E('tr', {}, [
									E('td', { 'class': 'mono bb-tb-cell-wrap' }, ans.name || st.domain),
									E('td', {}, UI.tag(tName, 'neutral')),
									E('td', { 'class': 'mono muted' }, ans.TTL != null ? (ans.TTL + 's') : '—'),
									E('td', { 'class': 'mono bb-tb-cell-wrap' }, [
										E('span', {}, val + ' '),
										isFakeIP(val) ? UI.tag('Fake-IP') : ''
									]),
									E('td', {}, copyButton(val))
								]);
							}))
						])
					]));
				} else {
					nodes.push(E('div', { 'class': 'bb-tb-placeholder' }, p.Comment ? String(p.Comment) : '无应答记录（Empty Answer）。'));
				}

				nodes.push(E('details', { 'class': 'bb-tb-fold' }, [
					E('summary', {}, [
						E('span', { 'class': 'bb-tb-fold-title' }, [UI.icon('chevron'), E('strong', {}, '原始 JSON 响应')])
					]),
					E('div', { 'class': 'bb-tb-fold-body' }, [E('pre', { 'class': 'tool-result' }, JSON.stringify(p, null, 2))])
				]));
			} else {
				var ns = (st.parsed && st.parsed.addresses) ? st.parsed : parseNslookup(st.raw);
				var addrs = ns.addresses || [];
				nodes.push(E('div', { 'class': 'bb-tb-banner ' + (addrs.length ? 'ok' : 'warn') }, [
					E('div', { 'class': 'bb-tb-banner-main' }, [
						UI.tag(addrs.length ? '解析成功' : '无地址记录', addrs.length ? '' : 'neutral'),
						E('strong', {}, st.domain),
						E('span', { 'class': 'bb-tb-banner-meta mono' }, [
							ns.server ? ('Server ' + ns.server) : (st.mode === 'custom' ? st.server : '127.0.0.1'),
							st.finished ? (' · ' + st.finished) : ''
						].join(''))
					]),
					E('div', { 'class': 'button-row' }, [traceJump])
				]));

				if (addrs.length) {
					nodes.push(E('div', { 'class': 'bb-dns-pills', style: 'margin-bottom:14px' }, addrs.map(function(ip) {
						return E('span', { 'class': 'bb-tb-ip-pill' }, [
							E('code', {}, ip),
							isFakeIP(ip) ? UI.tag('Fake-IP') : '',
							copyButton(ip)
						]);
					})));
				}

				nodes.push(E('details', { 'class': 'bb-tb-fold', open: addrs.length ? null : true }, [
					E('summary', {}, [
						E('span', { 'class': 'bb-tb-fold-title' }, [UI.icon('chevron'), E('strong', {}, 'nslookup 原始输出')])
					]),
					E('div', { 'class': 'bb-tb-fold-body' }, [E('pre', { 'class': 'tool-result' }, st.raw)])
				]));
			}

			return nodes;
		}

		/* ---------------- Tool 4: 流量统计 ---------------- */

		function loadTraffic() {
			var st = states.traffic;
			if (!st.from || !st.to || st.from > st.to) {
				st.error = '请选择有效的起止日期';
				draw();
				return Promise.resolve();
			}
			var seq = ++st.requestSeq;
			st.loading = true;
			st.error = '';
			draw();
			return UI.job('toolbox', ['traffic-stats', st.from, st.to, st.hostFilter.trim()]).then(function(job) {
				if (seq !== st.requestSeq) return;
				var parsed = parseJSON(job && job.text);
				if (!parsed) throw new Error((job && job.text) || '无法解析流量统计数据');
				st.result = parsed;
				st.loaded = true;
			}).catch(function(err) {
				if (seq === st.requestSeq) st.error = err.message || '读取流量统计失败';
			}).finally(function() {
				if (seq === st.requestSeq) {
					st.loading = false;
					draw();
				}
			});
		}

		function setTrafficRange(key) {
			var st = states.traffic;
			st.range = key;
			if (key === '1d') { st.from = dateOffset(0); st.to = dateOffset(0); loadTraffic(); }
			else if (key === '7d') { st.from = dateOffset(6); st.to = dateOffset(0); loadTraffic(); }
			else if (key === '30d') { st.from = dateOffset(29); st.to = dateOffset(0); loadTraffic(); }
			else draw();
		}

		function renderTraffic() {
			var st = states.traffic;
			var rangeSeg = makeSegmented([
				['1d', '今天'],
				['7d', '近 7 天'],
				['30d', '近 30 天'],
				['custom', '自定义']
			], st.range, setTrafficRange, '统计日期范围');

			var hostInput = E('input', {
				'class': 'field',
				type: 'search',
				value: st.hostFilter,
				placeholder: '按域名过滤明细（可选）…',
				'aria-label': '按域名过滤'
			});
			hostInput.addEventListener('input', function() { st.hostFilter = hostInput.value; });
			hostInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); loadTraffic(); } });

			var refreshBtn = UI.button(st.loading ? '查询中…' : '刷新统计', loadTraffic, 'primary', 'refresh');
			refreshBtn.disabled = st.loading;

			var nodes = [
				E('div', { 'class': 'bb-tb-bar bb-tb-bar-traffic' }, [
					rangeSeg,
					E('div', { 'class': 'bb-tb-bar-grow' }, [hostInput]),
					refreshBtn
				])
			];

			if (st.range === 'custom') {
				var fromInput = E('input', { 'class': 'field', type: 'date', value: st.from, 'aria-label': '开始日期' });
				var toInput = E('input', { 'class': 'field', type: 'date', value: st.to, 'aria-label': '结束日期' });
				fromInput.addEventListener('change', function() { st.from = fromInput.value; });
				toInput.addEventListener('change', function() { st.to = toInput.value; });
				nodes.push(E('div', { 'class': 'bb-tb-dates' }, [
					UI.field('开始日期', fromInput),
					UI.field('结束日期', toInput)
				]));
			}

			if (st.error) {
				nodes.push(E('div', { 'class': 'bb-tb-banner danger', role: 'alert' }, [
					E('div', { 'class': 'bb-tb-banner-main' }, [UI.tag('失败', 'danger'), E('strong', {}, st.error)])
				]));
			}

			var r = st.result;
			if (st.loading && !r) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder', role: 'status' }, '正在统计所选时间范围内的流量数据…'));
				return nodes;
			}
			if (!r) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder' }, '暂无流量统计数据（点击「刷新统计」重新查询）。'));
				return nodes;
			}

			var totalUp = Number(r.up) || 0, totalDown = Number(r.down) || 0, total = totalUp + totalDown;
			var proxyUp = Number(r['proxy-up']) || 0, proxyDown = Number(r['proxy-down']) || 0, proxyTotal = proxyUp + proxyDown;
			var directTotal = Math.max(0, total - proxyTotal);
			var proxyPct = total > 0 ? ((proxyTotal * 100) / total).toFixed(1) + '%' : '0%';
			var directPct = total > 0 ? ((directTotal * 100) / total).toFixed(1) + '%' : '0%';

			nodes.push(E('div', { 'class': 'bb-traffic-kpis' }, [
				E('div', { 'class': 'bb-traffic-kpi' }, [
					E('span', { 'class': 'muted' }, '总流量'),
					E('strong', { 'class': 'mono' }, UI.bytes(total)),
					E('small', { 'class': 'mono muted' }, '↑ ' + UI.bytes(totalUp) + ' · ↓ ' + UI.bytes(totalDown))
				]),
				E('div', { 'class': 'bb-traffic-kpi' }, [
					E('span', { 'class': 'muted' }, '代理流量 (' + proxyPct + ')'),
					E('strong', { 'class': 'mono' }, UI.bytes(proxyTotal)),
					E('small', { 'class': 'mono muted' }, '↑ ' + UI.bytes(proxyUp) + ' · ↓ ' + UI.bytes(proxyDown))
				]),
				E('div', { 'class': 'bb-traffic-kpi' }, [
					E('span', { 'class': 'muted' }, '直连 / 其他 (' + directPct + ')'),
					E('strong', { 'class': 'mono' }, UI.bytes(directTotal)),
					E('small', { 'class': 'muted' }, '含局域网与直连规则')
				]),
				E('div', { 'class': 'bb-traffic-kpi' }, [
					E('span', { 'class': 'muted' }, '规则命中'),
					E('strong', { 'class': 'mono' }, String(r['rule-hits'] || 0) + ' 次'),
					E('small', { 'class': 'muted' }, r.since ? ('统计自 ' + r.since) : (st.from + ' ~ ' + st.to))
				])
			]));

			var dimSeg = makeSegmented([
				['hosts', '域名'],
				['nodes', '节点'],
				['profiles', '订阅'],
				['rules', '规则'],
				['series', '趋势']
			], st.dimension, function(val) { st.dimension = val; draw(); }, '统计维度');
			nodes.push(E('div', { 'class': 'bb-tb-options' }, [dimSeg]));

			var rows = Array.isArray(r[st.dimension]) ? r[st.dimension] : [];
			if (!rows.length) {
				nodes.push(E('div', { 'class': 'bb-tb-placeholder' }, '所选维度在该时段暂无流量记录。'));
				return nodes;
			}

			var maxBytes = rows.reduce(function(acc, item) {
				var sum = (Number(item.up) || 0) + (Number(item.down) || 0);
				return sum > acc ? sum : acc;
			}, 1);

			if (st.dimension === 'series') {
				nodes.push(E('div', { 'class': 'bb-traffic-series' }, rows.map(function(pt) {
					var up = Number(pt.up) || 0, down = Number(pt.down) || 0, sum = up + down;
					var pct = Math.min(100, (sum * 100) / maxBytes).toFixed(1);
					return E('div', { 'class': 'bb-series-row' }, [
						E('span', { 'class': 'bb-series-label mono' }, pt.label || '—'),
						E('div', { 'class': 'bb-bar-track' }, [E('div', { 'class': 'bb-bar-fill', style: 'width:' + pct + '%' })]),
						E('span', { 'class': 'bb-series-val mono' }, UI.bytes(sum) + '（↑ ' + UI.bytes(up) + ' · ↓ ' + UI.bytes(down) + '）')
					]);
				})));
			} else {
				nodes.push(E('div', { 'class': 'bb-traffic-list' }, rows.map(function(item, idx) {
					var up = Number(item.up) || 0, down = Number(item.down) || 0, sum = up + down;
					var pct = Math.min(100, (sum * 100) / maxBytes).toFixed(1);
					var name = item.name || item.label || '—';
					var headRight = [
						item.hits ? E('span', { 'class': 'small muted mono' }, item.hits + ' 次') : '',
						E('strong', { 'class': 'mono' }, UI.bytes(sum))
					];
					if (st.dimension === 'hosts' && item.name) {
						headRight.push(UI.button('追踪', function() {
							jumpToTool('trace', { target: item.name, network: 'tcp', port: '443' }, true);
						}, 'bb-tb-mini', 'route'));
					}
					var subs = Array.isArray(item.subs) && item.subs.length
						? E('div', { 'class': 'bb-traffic-subs' }, item.subs.slice(0, 6).map(function(sub) {
							return E('span', { 'class': 'bb-tb-chip static mono' }, sub.name + ' · ' + UI.bytes((Number(sub.up) || 0) + (Number(sub.down) || 0)));
						}))
						: '';
					return E('div', { 'class': 'bb-traffic-row' }, [
						E('div', { 'class': 'bb-traffic-row-top' }, [
							E('div', { 'class': 'bb-traffic-row-name' }, [
								E('span', { 'class': 'bb-traffic-rank mono' }, String(idx + 1)),
								E('strong', { 'class': 'mono' }, name)
							]),
							E('div', { 'class': 'bb-traffic-row-metrics' }, headRight)
						]),
						E('div', { 'class': 'bb-bar-track' }, [E('div', { 'class': 'bb-bar-fill', style: 'width:' + pct + '%' })]),
						E('div', { 'class': 'bb-traffic-row-sub small muted mono' }, '↑ ' + UI.bytes(up) + ' · ↓ ' + UI.bytes(down)),
						subs
					]);
				})));
			}

			return nodes;
		}

		/* ---------------- Shell ---------------- */

		function draw() {
			var meta = TOOLS.filter(function(t) { return t[0] === active; })[0];
			TOOLS.forEach(function(t) {
				var btn = tabButtons[t[0]];
				if (!btn) return;
				var on = t[0] === active;
				btn.classList.toggle('active', on);
				btn.setAttribute('aria-selected', String(on));
			});
			if (tabButtons[active]) workspace.setAttribute('aria-labelledby', tabButtons[active].id);

			var body;
			if (active === 'trace') body = renderTrace();
			else if (active === 'dns') body = renderDns();
			else if (active === 'traffic') body = renderTraffic();
			else body = renderHealth();

			workspace.replaceChildren(UI.panel(meta[1], meta[2], body));
		}

		var tabBar = E('div', { 'class': 'bb-tb-tabs', role: 'tablist', 'aria-label': '诊断工具切换' }, TOOLS.map(function(t) {
			var btn = E('button', {
				type: 'button',
				role: 'tab',
				id: 'bettbox-tb-tab-' + t[0],
				'class': 'bb-tb-tab',
				'aria-selected': String(t[0] === active)
			}, [
				UI.badge(t[2], 'bb-small-icon', t[4]),
				E('span', { 'class': 'bb-tb-tab-copy' }, [
					E('strong', {}, t[1]),
					E('small', {}, t[3])
				])
			]);
			btn.addEventListener('click', function() { selectTool(t[0], false); });
			tabButtons[t[0]] = btn;
			return btn;
		}));

		draw();
		if (active === 'traffic') loadTraffic();

		return UI.page('toolbox', '工具箱', [], [
			E('div', { 'class': 'bb-tb-page' }, [tabBar, workspace])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
