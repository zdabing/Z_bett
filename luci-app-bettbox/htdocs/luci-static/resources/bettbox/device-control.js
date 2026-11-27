'use strict';
'require baseclass';
'require rpc';
'require ui';
'require uci';
'require bettbox.ui as UI';

var callHostHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
var LINK_LOCAL6_RE = /^fe[89ab][0-9a-f]:/i;
var MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
var DOCKER_MAC_RE = /^02:42:/i;

function isLinkLocal6(ip) { return LINK_LOCAL6_RE.test(ip); }
function isMac(s) { return MAC_RE.test(String(s || '').trim()); }
function normMac(s) { return String(s || '').trim().toLowerCase(); }

function isDockerMac(mac) {
	return DOCKER_MAC_RE.test(mac || '');
}

function isLocalRandomMac(mac) {
	if (!isMac(mac) || isDockerMac(mac)) return false;
	var first = parseInt(mac.slice(0, 2), 16);
	return !isNaN(first) && (first & 2) !== 0;
}

function isCidrPrefix(text) {
	var parts = String(text || '').trim().split('/');
	if (parts.length !== 2) return false;
	var bits = Number(parts[1]);
	return parts[0].indexOf(':') >= 0 ? (bits < 128) : (bits < 32);
}

function validateIpOrCidr(text) {
	var s = String(text || '').trim();
	if (!s) return false;
	var parts = s.split('/');
	if (parts.length > 2) return false;
	var addr = parts[0], ipv6 = addr.indexOf(':') >= 0;
	if (ipv6) {
		if (!/^[0-9a-f:.]+$/i.test(addr)) return false;
		try { new URL('http://[' + addr + ']/'); } catch (_) { return false; }
	} else {
		if (!/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(addr)) return false;
		if (!addr.split('.').every(function(n) { return +n <= 255; })) return false;
	}
	if (parts.length === 2) {
		if (!/^(0|[1-9]\d{0,2})$/.test(parts[1])) return false;
		if (+parts[1] > (ipv6 ? 128 : 32)) return false;
	}
	return true;
}

function parseList(val) {
	if (Array.isArray(val)) return val.map(function(s) { return String(s || '').trim(); }).filter(Boolean);
	if (typeof val === 'string') return val.trim() ? val.trim().split(/\s+/).filter(Boolean) : [];
	return [];
}

function create(opts) {
	var cfg = opts.config || {};
	var groupNames = Array.isArray(opts.groupNames) ? opts.groupNames.slice() : [];
	var onChange = typeof opts.onChange === 'function' ? opts.onChange : function() {};

	var rawControlEnabled = cfg.device_control_enabled;
	var rawMode = cfg.device_mode || 'off';
	var rawMacs = Array.from(new Set(parseList(cfg.device_macs).map(normMac).filter(isMac)));
	var rawIps = Array.from(new Set(parseList(cfg.device_ips)));
	var rawFallbacks = [];
	var fallbackParseError = '';
	try {
		rawFallbacks = JSON.parse(cfg.device_fallbacks || '[]');
		if (!Array.isArray(rawFallbacks) || rawFallbacks.length > 64 || rawFallbacks.some(function(row) {
			return !row || !Array.isArray(row.addresses) || row.addresses.some(function(ip) { return typeof ip !== 'string'; }) || typeof row.target !== 'string';
		})) throw new Error();
	} catch (_) {
		rawFallbacks = [];
		fallbackParseError = '已保存的设备兜底策略格式无效，保存后将使用当前列表覆盖。';
	}

	var inferredEnabled = rawControlEnabled === '1'
		? true
		: (rawControlEnabled === '0' ? false : (rawMode !== 'off' || rawFallbacks.length > 0));

	var state = {
		enabled: inferredEnabled,
		defaultPolicy: rawMode === 'include' ? 'bypass' : 'proxy',
		rows: [],
		advIps: rawIps.slice(),
		advFallbacks: []
	};

	var hostsByMac = {};
	var macByIp = {};
	var staticMacs = {};
	var hostsLoaded = false;
	var hostsLoading = false;
	var hostsFailed = false;
	var disabled = false;
	var searchQuery = '';

	function defaultGroupTarget() {
		return groupNames.length ? groupNames[0] : 'DIRECT';
	}

	function initFromSaved() {
		var map = {};
		rawMacs.forEach(function(mac) {
			map[mac] = {
				mac: mac,
				action: state.defaultPolicy === 'bypass' ? 'rule_global' : 'bypass',
				target: defaultGroupTarget(),
				savedIp: ''
			};
		});
		rawFallbacks.forEach(function(fb) {
			var target = fb.target || 'inherit';
			var addresses = Array.isArray(fb.addresses) ? fb.addresses.filter(Boolean) : [];
			var remaining = [];
			addresses.forEach(function(addr) {
				var clean = String(addr).trim();
				var bare = clean.replace(/\/32$/, '');
				var mac = !isCidrPrefix(clean) ? macByIp[bare] : null;
				if (mac) {
					var act = target === 'DIRECT' ? 'rule_direct' : (target === 'inherit' ? 'rule_global' : 'rule_group');
					if (!map[mac]) {
						map[mac] = { mac: mac, action: act, target: act === 'rule_group' ? target : defaultGroupTarget(), savedIp: bare };
					} else if (map[mac].action !== 'bypass') {
						map[mac].action = act;
						if (act === 'rule_group') map[mac].target = target;
						map[mac].savedIp = bare;
					}
				} else {
					remaining.push(clean);
				}
			});
			if (remaining.length) {
				state.advFallbacks.push({ addresses: remaining, target: target });
			}
		});
		state.rows = Object.keys(map).map(function(k) { return map[k]; });
	}

	function absorbFallbacksIntoHosts() {
		var nextAdv = [];
		var merged = false;
		state.advFallbacks.forEach(function(fb) {
			var remaining = [];
			fb.addresses.forEach(function(addr) {
				var clean = String(addr).trim();
				var bare = clean.replace(/\/32$/, '');
				var mac = !isCidrPrefix(clean) ? macByIp[bare] : null;
				if (mac) {
					var act = fb.target === 'DIRECT' ? 'rule_direct' : (fb.target === 'inherit' ? 'rule_global' : 'rule_group');
					var existing = state.rows.find(function(r) { return r.mac === mac; });
					if (!existing) {
						state.rows.push({ mac: mac, action: act, target: act === 'rule_group' ? fb.target : defaultGroupTarget(), savedIp: bare });
						merged = true;
					} else if (existing.action !== 'bypass') {
						existing.action = act;
						if (act === 'rule_group') existing.target = fb.target;
						existing.savedIp = bare;
						merged = true;
					} else {
						remaining.push(clean);
					}
				} else {
					remaining.push(clean);
				}
			});
			if (remaining.length) nextAdv.push({ addresses: remaining, target: fb.target });
		});
		if (merged) state.advFallbacks = nextAdv;
		return merged;
	}

	initFromSaved();

	function hostFor(mac) {
		return hostsByMac[mac] || null;
	}

	function resolvedIp(row) {
		var h = hostFor(row.mac);
		if (h && h.ipv4) return h.ipv4;
		if (h && h.ips && h.ips.length) return h.ips[0];
		return row.savedIp || '';
	}

	function displayName(mac) {
		var h = hostFor(mac);
		if (h && h.name) return h.name;
		if (isDockerMac(mac)) return '容器（疑似）';
		return '未命名设备';
	}

	function hintFor(row) {
		var h = hostFor(row.mac);
		var ip = resolvedIp(row);
		var isStatic = !!staticMacs[row.mac];
		if ((state.defaultPolicy === 'proxy' && row.action === 'rule_global') ||
			(state.defaultPolicy === 'bypass' && row.action === 'bypass')) {
			return { tone: 'muted', text: '与未列设备默认策略一致，保存后自动移出特例列表' };
		}
		if (isDockerMac(row.mac)) return { tone: 'warn', text: '02:42 开头，多为 Docker 地址' };
		if (isLocalRandomMac(row.mac)) return { tone: 'warn', text: '私有 Wi-Fi 地址，MAC 可能变化' };
		if (row.action === 'bypass') return { tone: 'muted', text: 'DNS 已自动改用真实解析' };
		if ((row.action === 'rule_direct' || row.action === 'rule_group') && !ip) {
			return { tone: 'warn', text: '设备离线且无 IP，兜底规则暂无法生效' };
		}
		if ((row.action === 'rule_direct' || row.action === 'rule_group') && h && !isStatic) {
			return { tone: 'warn', text: '动态 IP，建议设为静态租约以固定出口' };
		}
		if (row.action === 'rule_direct') return { tone: 'muted', text: '先匹配订阅规则，没命中再直连' };
		if (row.action === 'rule_group') return { tone: 'muted', text: '先匹配订阅规则，没命中走所选出口' };
		return { tone: 'muted', text: '进入规则分流，兜底跟随全局' };
	}

	function exportPayload() {
		var enabled = !!state.enabled;
		var defaultPolicy = state.defaultPolicy;
		var macs = [];
		var fallbacks = [];

		// Always preserve configured lists in UCI even when disabled so toggling
		// the master switch off never wipes the user's saved device rules.
		state.rows.forEach(function(row) {
			if (defaultPolicy === 'proxy') {
				if (row.action === 'bypass') macs.push(row.mac);
			} else {
				if (row.action !== 'bypass') macs.push(row.mac);
			}
			if (row.action === 'rule_direct' || row.action === 'rule_group') {
				var ip = resolvedIp(row);
				if (ip) {
					fallbacks.push({
						addresses: [ip],
						target: row.action === 'rule_direct' ? 'DIRECT' : (row.target || 'DIRECT')
					});
				}
			}
		});
		state.advFallbacks.forEach(function(fb) {
			var addrs = (fb.addresses || []).map(function(a) { return String(a || '').trim(); }).filter(Boolean);
			if (addrs.length) fallbacks.push({ addresses: addrs, target: fb.target || 'inherit' });
		});

		var advIps = Array.from(new Set(state.advIps.map(function(s) { return String(s || '').trim(); }).filter(Boolean)));
		var deviceMode = 'off';
		if (enabled) {
			if (defaultPolicy === 'bypass') deviceMode = 'include';
			else if (macs.length > 0 || advIps.length > 0) deviceMode = 'exclude';
		}

		return {
			device_control_enabled: enabled ? '1' : '0',
			device_mode: deviceMode,
			device_macs: Array.from(new Set(macs)),
			device_ips: advIps,
			device_fallbacks: fallbacks
		};
	}

	function snapshot() {
		return JSON.stringify({
			enabled: state.enabled,
			defaultPolicy: state.defaultPolicy,
			rows: state.rows.map(function(r) { return [r.mac, r.action, r.action === 'rule_group' ? r.target : '', r.savedIp || '']; }),
			advIps: state.advIps,
			advFallbacks: state.advFallbacks
		});
	}

	var originalSnapshot = fallbackParseError ? 'invalid' : snapshot();

	function isDirty() {
		return snapshot() !== originalSnapshot;
	}

	function markSaved() {
		originalSnapshot = snapshot();
	}

	function validate() {
		if (!state.enabled) return;
		var macs = [];
		var allFbAddrs = [];
		var seenFb = {};
		state.rows.forEach(function(row) {
			if (!isMac(row.mac)) throw new Error('设备 MAC 地址无效：' + row.mac);
			macs.push(row.mac);
			if (row.action === 'rule_direct' || row.action === 'rule_group') {
				var ip = resolvedIp(row);
				if (!ip) throw new Error('设备「' + displayName(row.mac) + ' (' + row.mac + ')」当前离线且无已知 IP，无法生成兜底分流规则；请先上线或改为「完全不走代理」。');
				if (!validateIpOrCidr(ip)) throw new Error('设备 IP 地址无效：' + ip);
				if (seenFb[ip]) throw new Error('兜底策略 IP 地址重复：' + ip);
				seenFb[ip] = true;
				allFbAddrs.push(ip);
			}
		});
		if (macs.length > 256) throw new Error('设备列表最多 256 台');
		state.advIps.forEach(function(ip) {
			if (!validateIpOrCidr(ip)) throw new Error('高级 IP 或网段无效：' + ip);
		});
		if (state.advIps.length > 256) throw new Error('高级 IP 列表最多 256 项');
		state.advFallbacks.forEach(function(fb) {
			if (!fb.addresses || !fb.addresses.length) throw new Error('高级网段兜底策略需要填写 IP 或网段');
			fb.addresses.forEach(function(ip) {
				if (!validateIpOrCidr(ip)) throw new Error('高级兜底 IP 或网段无效：' + ip);
				if (seenFb[ip]) throw new Error('兜底策略 IP 地址重复：' + ip);
				seenFb[ip] = true;
				allFbAddrs.push(ip);
			});
		});
		if (allFbAddrs.length > 256) throw new Error('兜底策略 IP 地址总数最多 256 项');
	}

	/* ---------- DOM Construction ---------- */

	var root = E('div', { 'class': 'bb-dev-page' });

	var enableSwitch = E('button', {
		type: 'button',
		'class': 'switch' + (state.enabled ? '' : ' off'),
		role: 'switch',
		'aria-checked': String(state.enabled),
		'aria-label': '启用设备分流控制'
	});
	var defaultSeg = E('div', { 'class': 'segmented bb-dev-default-seg', role: 'radiogroup', 'aria-label': '未在列表设备的默认策略' });
	var segProxyBtn = E('button', { type: 'button', 'data-policy': 'proxy' }, '其余进入分流');
	var segBypassBtn = E('button', { type: 'button', 'data-policy': 'bypass' }, '其余不走代理');
	defaultSeg.appendChild(segProxyBtn);
	defaultSeg.appendChild(segBypassBtn);

	var headerPanel = E('section', { 'class': 'panel settings-panel bb-dev-header-panel' }, [
		E('div', { 'class': 'bb-dev-header' }, [
			E('div', { 'class': 'bb-dev-header-copy' }, [
				E('h2', {}, [UI.badge('lan', 'bb-section-icon', 'teal'), document.createTextNode('设备分流控制')]),
				E('p', { 'class': 'bb-dev-subtitle' }, '为每台设备选择流量的处理方式。设备按 MAC 地址识别，换 IP 也不会失效。')
			]),
			E('div', { 'class': 'bb-dev-header-actions' }, [
				defaultSeg,
				E('label', { 'class': 'bb-dev-enable-wrap' }, [
					E('span', {}, '启用设备分流控制'),
					enableSwitch
				])
			])
		])
	]);

	var kpiBypassNum = E('div', { 'class': 'bb-dev-kpi-num is-ok' }, '0');
	var kpiBypassSub = E('div', { 'class': 'bb-dev-kpi-sub' }, '在内核层放行，不经过 mihomo');
	var kpiProxyNum = E('div', { 'class': 'bb-dev-kpi-num is-accent' }, '0');
	var kpiProxySub = E('div', { 'class': 'bb-dev-kpi-sub' }, '先进入 mihomo，按规则决定去向');
	var kpiOtherNum = E('div', { 'class': 'bb-dev-kpi-num is-muted' }, '其余');
	var kpiOtherTitle = E('div', { 'class': 'bb-dev-kpi-title' }, '跟随全局设置');
	var kpiOtherSub = E('div', { 'class': 'bb-dev-kpi-sub' }, '未出现在下方列表的设备');

	var kpiGrid = E('div', { 'class': 'bb-dev-kpis' }, [
		E('div', { 'class': 'bb-dev-kpi' }, [kpiBypassNum, E('div', { 'class': 'bb-dev-kpi-title' }, '完全不走代理'), kpiBypassSub]),
		E('div', { 'class': 'bb-dev-kpi' }, [kpiProxyNum, E('div', { 'class': 'bb-dev-kpi-title' }, '进入规则分流'), kpiProxySub]),
		E('div', { 'class': 'bb-dev-kpi' }, [kpiOtherNum, kpiOtherTitle, kpiOtherSub])
	]);

	var guideBanner = E('div', { 'class': 'bb-dev-guide' }, [
		E('strong', {}, '怎么选：'),
		document.createTextNode('想让设备彻底不受代理影响、也不拖慢路由器，选「完全不走代理」，这类设备会自动使用真实 DNS，不会拿到 198.18.x.x 的假 IP。其余选项的流量仍会先进入 mihomo（TCP 走内核重定向加速，UDP 走 TUN）。')
	]);

	var errorBanner = E('div', { 'class': 'bb-dev-warn-banner', hidden: !fallbackParseError }, fallbackParseError);

	var searchInput = E('input', {
		type: 'search',
		'class': 'field bb-dev-search',
		placeholder: '搜索设备名称、MAC 或 IP',
		'aria-label': '搜索设备名称、MAC 或 IP',
		autocomplete: 'off'
	});
	var addBtn = UI.button('添加设备', openAddModal, 'primary small', 'plus');
	var tableRowsHost = E('div', { 'class': 'bb-dev-rows' });
	var tableFoot = E('div', { 'class': 'bb-dev-foot' }, '没有出现在列表里的设备，一律跟随全局设置。');

	var listPanel = E('section', { 'class': 'panel settings-panel bb-dev-list-panel' }, [
		E('div', { 'class': 'bb-dev-list-head' }, [
			E('div', { 'class': 'bb-dev-list-title' }, '设备列表'),
			E('div', { 'class': 'bb-dev-list-tools' }, [
				E('label', { 'class': 'search bb-dev-search-wrap' }, [UI.icon('search'), searchInput]),
				addBtn
			])
		]),
		E('div', { 'class': 'bb-dev-table-wrap' }, [
			E('div', { 'class': 'bb-dev-row bb-dev-head' }, [
				E('div', {}, '设备'),
				E('div', {}, '当前 IP'),
				E('div', {}, '处理方式'),
				E('div', {}, '流量路径'),
				E('div', {}, '提示'),
				E('div', {})
			]),
			tableRowsHost
		]),
		tableFoot
	]);

	/* ---------- Advanced IP / CIDR Fold ---------- */

	var advIpInput = E('input', { type: 'text', 'class': 'field', placeholder: '输入 IPv4 / IPv6 或 CIDR，如 10.0.0.0/24', 'aria-label': '高级 IP 或网段' });
	var advIpAddBtn = UI.button('添加网段', function() {
		var val = advIpInput.value.trim();
		if (!val) return;
		if (!validateIpOrCidr(val)) { UI.error('IP 或网段格式无效：' + val); return; }
		if (state.advIps.indexOf(val) < 0) {
			state.advIps.push(val);
			advIpInput.value = '';
			paint();
			onChange();
		}
	}, 'small', 'plus');
	var advIpList = E('div', { 'class': 'bb-dev-adv-chips' });
	var advFbList = E('div', { 'class': 'bb-dev-adv-fbs' });
	var advFbAddBtn = UI.button('添加网段兜底规则', function() {
		state.advFallbacks.push({ addresses: [''], target: 'DIRECT' });
		paint();
		onChange();
	}, 'small', 'plus');
	var advIpLabel = E('div', { 'class': 'bb-dev-adv-label' }, '内核直通 IP / 网段（不经过 mihomo）');

	var advDetails = E('details', { 'class': 'panel settings-panel settings-fold bb-dev-adv-panel' }, [
		E('summary', { 'class': 'panel-head' }, [
			E('h2', {}, [UI.badge('grid', 'bb-section-icon', 'orange'), document.createTextNode('高级：按 IP / 网段添加（仅 IPv4 / CIDR，不推荐）')]),
			E('span', { 'class': 'settings-fold-hint' }, [E('span', {}, '展开 / 收起'), UI.icon('chevron')])
		]),
		E('div', { 'class': 'bb-dev-adv-body' }, [
			E('p', { 'class': 'bb-dev-adv-note' }, 'IP 会随 DHCP 变化，且不覆盖随机 IPv6。只有无法读取 MAC 的设备或整个网段才建议使用。'),
			E('div', { 'class': 'bb-dev-adv-block' }, [
				advIpLabel,
				E('div', { 'class': 'bb-dev-adv-input-row' }, [advIpInput, advIpAddBtn]),
				advIpList
			]),
			E('div', { 'class': 'bb-dev-adv-block' }, [
				E('div', { 'class': 'bb-dev-adv-label' }, '按网段指定兜底出口（进入 mihomo 规则后生效）'),
				advFbList,
				advFbAddBtn
			])
		])
	]);

	var bodyWrap = E('div', { 'class': 'bb-dev-body' }, [kpiGrid, guideBanner, errorBanner, listPanel, advDetails]);
	root.appendChild(headerPanel);
	root.appendChild(bodyWrap);

	/* ---------- Events ---------- */

	enableSwitch.addEventListener('click', function() {
		if (disabled) return;
		state.enabled = !state.enabled;
		paint();
		onChange();
	});

	[segProxyBtn, segBypassBtn].forEach(function(btn) {
		btn.addEventListener('click', function() {
			if (disabled) return;
			var next = btn.dataset.policy;
			if (next === state.defaultPolicy) return;
			state.defaultPolicy = next;
			paint();
			onChange();
		});
	});

	searchInput.addEventListener('input', function() {
		searchQuery = searchInput.value.trim().toLowerCase();
		paintRows();
	});

	advIpInput.addEventListener('keydown', function(ev) {
		if (ev.key === 'Enter') { ev.preventDefault(); advIpAddBtn.click(); }
	});

	/* ---------- Add Device Modal ---------- */

	function openAddModal() {
		if (disabled) return;
		loadHosts();
		var modalSearch = E('input', { type: 'search', 'class': 'field', placeholder: '搜索设备名称、IP 或输入 MAC 地址（如 aa:bb:cc:dd:ee:ff）', autocomplete: 'off' });
		var actionSel = E('select', { 'class': 'field', 'aria-label': '添加后的默认处理方式' }, [
			E('option', { value: 'bypass' }, '完全不走代理（内核放行）'),
			E('option', { value: 'rule_direct' }, '进入规则，未命中走直连'),
			E('option', { value: 'rule_group' }, '进入规则，未命中走指定节点'),
			E('option', { value: 'rule_global' }, '进入规则，跟随全局')
		]);
		actionSel.value = state.defaultPolicy === 'bypass' ? 'rule_global' : 'bypass';
		var candidateList = E('div', { 'class': 'bb-dev-modal-list' });
		var manualErr = E('div', { 'class': 'bb-dev-modal-err', hidden: true });
		var picked = {};

		function addSelectedDevices() {
			var macs = Object.keys(picked).filter(function(k) { return picked[k]; });
			var typed = modalSearch.value.trim();
			if (!macs.length && isMac(typed)) macs = [normMac(typed)];
			if (!macs.length) {
				manualErr.textContent = '请至少勾选一台设备，或在搜索框输入有效 MAC 地址。';
				manualErr.hidden = false;
				return;
			}
			var act = actionSel.value;
			var added = false;
			macs.forEach(function(mac) {
				if (state.rows.some(function(r) { return r.mac === mac; })) return;
				var h = hostFor(mac);
				state.rows.push({
					mac: mac,
					action: act,
					target: defaultGroupTarget(),
					savedIp: (h && h.ipv4) || ''
				});
				added = true;
			});
			ui.hideModal();
			if (added) {
				if (!state.enabled) state.enabled = true;
				paint();
				onChange();
			}
		}

		function paintCandidates() {
			manualErr.hidden = true;
			var q = modalSearch.value.trim().toLowerCase();
			var existing = {};
			state.rows.forEach(function(r) { existing[r.mac] = true; });
			var list = Object.keys(hostsByMac).map(function(k) { return hostsByMac[k]; }).filter(function(h) {
				if (existing[h.mac]) return false;
				if (!q) return true;
				return ((h.name || '') + ' ' + h.mac + ' ' + (h.ips || []).join(' ')).toLowerCase().indexOf(q) >= 0;
			}).sort(function(a, b) {
				var aOn = a.ips && a.ips.length ? 0 : 1;
				var bOn = b.ips && b.ips.length ? 0 : 1;
				return aOn - bOn || (a.name || a.mac).localeCompare(b.name || b.mac, undefined, { numeric: true });
			});

			candidateList.replaceChildren();
			if (isMac(q) && !existing[normMac(q)] && !hostsByMac[normMac(q)]) {
				var m = normMac(q);
				var on = !!picked[m];
				var manualRow = E('button', { type: 'button', 'class': 'bb-dev-pick-item' + (on ? ' is-picked' : '') }, [
					E('div', { 'class': 'bb-dev-pick-copy' }, [
						E('strong', {}, '手动添加 MAC 地址'),
						E('span', { 'class': 'mono muted' }, m)
					]),
					E('span', { 'class': 'bb-dev-pick-mark' }, UI.icon(on ? 'check' : 'plus'))
				]);
				manualRow.addEventListener('click', function() { picked[m] = !picked[m]; paintCandidates(); });
				candidateList.appendChild(manualRow);
			}

			if (!list.length && !candidateList.children.length) {
				candidateList.appendChild(E('div', { 'class': 'bb-dev-modal-empty' }, hostsLoading ? '正在读取路由器设备列表…' : (hostsFailed ? '设备列表读取失败，请直接输入 MAC 地址添加' : '没有更多可添加的局域网设备，可直接输入 MAC 地址')));
				return;
			}
			list.forEach(function(h) {
				var on = !!picked[h.mac];
				var ipText = h.ipv4 || (h.ips && h.ips[0]) || '离线，暂无 IP';
				var lease = staticMacs[h.mac] ? ' · 静态租约' : (h.ipv4 ? ' · 动态 IP' : '');
				var item = E('button', { type: 'button', 'class': 'bb-dev-pick-item' + (on ? ' is-picked' : '') }, [
					E('div', { 'class': 'bb-dev-pick-copy' }, [
						E('strong', {}, h.name || (isDockerMac(h.mac) ? '容器（疑似）' : '未命名设备')),
						E('span', { 'class': 'mono muted' }, h.mac + ' · ' + ipText + lease)
					]),
					E('span', { 'class': 'bb-dev-pick-mark' }, UI.icon(on ? 'check' : 'plus'))
				]);
				item.addEventListener('click', function() { picked[h.mac] = !picked[h.mac]; paintCandidates(); });
				candidateList.appendChild(item);
			});
		}

		modalSearch.addEventListener('input', paintCandidates);
		modalSearch.addEventListener('keydown', function(ev) {
			if (ev.key === 'Enter') { ev.preventDefault(); addSelectedDevices(); }
		});
		paintCandidates();

		UI.modal('添加设备', [
			UI.field('处理方式', actionSel),
			UI.field('选择局域网设备或输入 MAC', modalSearch),
			candidateList,
			manualErr
		], [
			UI.button('取消', ui.hideModal),
			UI.button('确认添加', addSelectedDevices, 'primary', 'check')
		]);
	}

	/* ---------- Render ---------- */

	function targetChoices(currentTarget) {
		var list = groupNames.map(function(name) { return [name, name]; });
		list.push(['REJECT', '拒绝连接 (REJECT)']);
		if (currentTarget && currentTarget !== 'DIRECT' && currentTarget !== 'inherit' && !list.some(function(item) { return item[0] === currentTarget; })) {
			list.unshift([currentTarget, currentTarget + '（已保存）']);
		}
		return list;
	}

	function paintRows() {
		tableRowsHost.replaceChildren();
		var visible = state.rows.filter(function(row) {
			if (!searchQuery) return true;
			var h = hostFor(row.mac);
			var hay = (displayName(row.mac) + ' ' + row.mac + ' ' + resolvedIp(row) + ' ' + ((h && h.ips) ? h.ips.join(' ') : '')).toLowerCase();
			return hay.indexOf(searchQuery) >= 0;
		});

		if (!visible.length) {
			var emptyMsg = state.rows.length ? '未找到匹配的设备，请调整搜索关键字。' : '尚未添加任何设备。点击右上角「添加设备」即可按 MAC 配置分流方式。';
			tableRowsHost.appendChild(E('div', { 'class': 'bb-dev-empty' }, [
				E('span', {}, emptyMsg)
			]));
			return;
		}

		visible.forEach(function(row) {
			var h = hostFor(row.mac);
			var ip = resolvedIp(row);
			var online = !!(h && h.ips && h.ips.length);
			var isStatic = !!staticMacs[row.mac];
			var name = displayName(row.mac);

			var ipCellChildren = [];
			if (ip) {
				ipCellChildren.push(E('div', { 'class': 'bb-dev-ip-main' }, [
					E('span', { 'class': 'bb-dev-dot ' + (online ? 'is-online' : 'is-offline') }),
					E('span', { 'class': 'mono' }, ip)
				]));
				var leaseLabel = isStatic ? '静态租约' : (online ? '动态 IP' : '历史记录 IP');
				ipCellChildren.push(E('div', { 'class': 'bb-dev-ip-sub' + (!isStatic && online ? ' is-warn' : '') }, leaseLabel));
			} else {
				ipCellChildren.push(E('div', { 'class': 'bb-dev-ip-main muted' }, [
					E('span', { 'class': 'bb-dev-dot is-offline' }),
					E('span', {}, '离线，暂无 IP')
				]));
			}

			var actionSel = E('select', { 'class': 'field bb-dev-action-sel', 'aria-label': name + ' 的处理方式' }, [
				E('option', { value: 'bypass' }, '完全不走代理'),
				E('option', { value: 'rule_direct' }, '进入规则，未命中走直连'),
				E('option', { value: 'rule_group' }, '进入规则，未命中走指定节点'),
				E('option', { value: 'rule_global' }, '进入规则，跟随全局')
			]);
			actionSel.value = row.action;
			actionSel.disabled = disabled || !state.enabled;
			actionSel.addEventListener('change', function() {
				row.action = actionSel.value;
				if (row.action === 'rule_group' && (!row.target || row.target === 'DIRECT' || row.target === 'inherit')) {
					row.target = defaultGroupTarget();
				}
				paint();
				onChange();
			});

			var actionCellItems = [actionSel];
			if (row.action === 'rule_group') {
				var targetSel = E('select', { 'class': 'field bb-dev-target-sel', 'aria-label': name + ' 的兜底出口' }, targetChoices(row.target).map(function(item) {
					return E('option', { value: item[0] }, item[1]);
				}));
				targetSel.value = row.target || defaultGroupTarget();
				targetSel.disabled = disabled || !state.enabled;
				targetSel.addEventListener('change', function() {
					row.target = targetSel.value;
					paintKpis();
					onChange();
				});
				actionCellItems.push(targetSel);
			}

			var isBypass = row.action === 'bypass';
			var pathBadge = E('span', { 'class': 'bb-dev-path-tag ' + (isBypass ? 'is-bypass' : 'is-proxy') }, isBypass ? '不经过 mihomo' : '经过 mihomo');
			var hint = hintFor(row);
			var hintEl = hint.tone === 'warn'
				? E('span', { 'class': 'bb-dev-hint-tag' }, hint.text)
				: E('span', { 'class': 'bb-dev-hint-text' }, hint.text);

			var rmBtn = E('button', { type: 'button', 'class': 'btn text small bb-dev-rm', 'aria-label': '移除 ' + name, disabled: (disabled || !state.enabled) ? true : null }, '移除');
			rmBtn.addEventListener('click', function() {
				state.rows = state.rows.filter(function(r) { return r !== row; });
				paint();
				onChange();
			});

			tableRowsHost.appendChild(E('div', { 'class': 'bb-dev-row' }, [
				E('div', { 'class': 'bb-dev-col-device' }, [
					E('div', { 'class': 'bb-dev-name' }, name),
					E('div', { 'class': 'bb-dev-mac mono' }, row.mac)
				]),
				E('div', { 'class': 'bb-dev-col-ip' }, ipCellChildren),
				E('div', { 'class': 'bb-dev-col-action' }, actionCellItems),
				E('div', { 'class': 'bb-dev-col-path' }, [pathBadge]),
				E('div', { 'class': 'bb-dev-col-hint' }, [hintEl]),
				E('div', { 'class': 'bb-dev-col-rm' }, [rmBtn])
			]));
		});
		UI.enhanceSelects(tableRowsHost);
	}

	function paintAdvanced() {
		advIpLabel.textContent = state.defaultPolicy === 'bypass' ? '白名单 IP / 网段（进入 mihomo 规则分流）' : '内核放行 IP / 网段（完全不走代理）';
		advIpList.replaceChildren();
		state.advIps.forEach(function(ip) {
			var rm = E('button', { type: 'button', 'class': 'device-picker-remove', 'aria-label': '移除 ' + ip, disabled: (disabled || !state.enabled) ? true : null }, UI.icon('close'));
			rm.addEventListener('click', function() {
				state.advIps = state.advIps.filter(function(x) { return x !== ip; });
				paint();
				onChange();
			});
			advIpList.appendChild(E('span', { 'class': 'device-picker-chip' }, [E('span', { 'class': 'mono' }, ip), rm]));
		});

		advFbList.replaceChildren();
		state.advFallbacks.forEach(function(fb) {
			var ipInp = E('input', { type: 'text', 'class': 'field', value: (fb.addresses || []).join(' '), placeholder: '如 10.0.0.0/24（多个用空格分隔）', disabled: (disabled || !state.enabled) ? true : null });
			ipInp.addEventListener('input', function() {
				fb.addresses = ipInp.value.trim() ? ipInp.value.trim().split(/[\s,]+/).filter(Boolean) : [];
				onChange();
			});
			var choices = [['inherit', '跟随全局'], ['DIRECT', '直连 (DIRECT)'], ['REJECT', '拒绝连接 (REJECT)']].concat(groupNames.map(function(n) { return [n, n]; }));
			if (fb.target && !choices.some(function(c) { return c[0] === fb.target; })) choices.push([fb.target, fb.target + '（已保存）']);
			var tSel = E('select', { 'class': 'field', 'aria-label': '网段兜底出口', disabled: (disabled || !state.enabled) ? true : null }, choices.map(function(c) { return E('option', { value: c[0] }, c[1]); }));
			tSel.value = fb.target || 'DIRECT';
			tSel.addEventListener('change', function() { fb.target = tSel.value; onChange(); });
			var rm = UI.button('移除', function() {
				state.advFallbacks = state.advFallbacks.filter(function(x) { return x !== fb; });
				paint();
				onChange();
			}, 'small', 'close');
			rm.disabled = disabled || !state.enabled;
			advFbList.appendChild(E('div', { 'class': 'bb-dev-adv-fb-row' }, [ipInp, tSel, rm]));
		});
		UI.enhanceSelects(advFbList);
		advIpInput.disabled = disabled || !state.enabled;
		advIpAddBtn.disabled = disabled || !state.enabled;
		advFbAddBtn.disabled = disabled || !state.enabled;
	}

	function paintKpis() {
		var bypassCount = 0, proxyCount = 0;
		state.rows.forEach(function(r) {
			if (r.action === 'bypass') bypassCount++;
			else proxyCount++;
		});
		if (state.defaultPolicy === 'proxy') {
			kpiBypassNum.textContent = String(bypassCount);
			kpiProxyNum.textContent = String(proxyCount);
			kpiOtherNum.textContent = '其余';
			kpiOtherTitle.textContent = '跟随全局设置';
			kpiOtherSub.textContent = '未出现在下方列表的设备';
			tableFoot.textContent = '没有出现在列表里的设备，一律跟随全局设置（进入规则分流）。';
		} else {
			kpiBypassNum.textContent = bypassCount ? '其余 + ' + bypassCount : '其余';
			kpiProxyNum.textContent = String(proxyCount);
			kpiOtherNum.textContent = '默认直通';
			kpiOtherTitle.textContent = '未列设备不走代理';
			kpiOtherSub.textContent = '仅列表中的分流设备进入 mihomo';
			tableFoot.textContent = '没有出现在列表里的设备，一律完全不走代理（内核层直接放行并走真实 DNS）。';
		}
	}

	function paint() {
		enableSwitch.classList.toggle('off', !state.enabled);
		enableSwitch.setAttribute('aria-checked', String(state.enabled));
		enableSwitch.disabled = disabled;
		defaultSeg.hidden = !state.enabled;
		segProxyBtn.classList.toggle('active', state.defaultPolicy === 'proxy');
		segBypassBtn.classList.toggle('active', state.defaultPolicy === 'bypass');
		segProxyBtn.disabled = disabled;
		segBypassBtn.disabled = disabled;
		bodyWrap.classList.toggle('is-off', !state.enabled);
		addBtn.disabled = disabled || !state.enabled;
		searchInput.disabled = disabled;
		paintKpis();
		paintRows();
		paintAdvanced();
	}

	function loadHosts() {
		if (hostsLoaded || hostsLoading) return Promise.resolve();
		hostsLoading = true;
		hostsFailed = false;
		return Promise.all([
			Promise.resolve().then(callHostHints).catch(function() { hostsFailed = true; return {}; }),
			uci.load('dhcp').then(function() { return uci.sections('dhcp', 'host') || []; }).catch(function() { return []; })
		]).then(function(res) {
			var hints = res[0] || {};
			var dhcpHosts = res[1] || [];
			hostsByMac = {};
			macByIp = {};
			staticMacs = {};
			var ipOwners = {};

			dhcpHosts.forEach(function(sec) {
				var macList = parseList(sec.mac).map(normMac).filter(isMac);
				var ip = String(sec.ip || '').trim();
				var name = String(sec.name || '').trim();
				macList.forEach(function(mac) {
					staticMacs[mac] = true;
					if (!hostsByMac[mac]) hostsByMac[mac] = { mac: mac, name: name, ipv4: '', ips: [] };
					if (name && !hostsByMac[mac].name) hostsByMac[mac].name = name;
					if (ip) {
						if (!hostsByMac[mac].ipv4 && ip.indexOf(':') < 0) hostsByMac[mac].ipv4 = ip;
						if (hostsByMac[mac].ips.indexOf(ip) < 0) hostsByMac[mac].ips.push(ip);
						ipOwners[ip] = (ipOwners[ip] || []).concat([mac]);
					}
				});
			});

			Object.keys(hints).forEach(function(rawKey) {
				if (!isMac(rawKey)) return;
				var mac = normMac(rawKey);
				var h = hints[rawKey] || {};
				var name = String(h.name || '').trim();
				var v4 = (h.ipaddrs || []).map(function(s) { return String(s || '').trim(); }).filter(Boolean);
				var v6 = (h.ip6addrs || []).map(function(s) { return String(s || '').trim(); }).filter(function(s) { return s && !isLinkLocal6(s); });
				var ips = v4.concat(v6);
				if (!hostsByMac[mac]) hostsByMac[mac] = { mac: mac, name: name, ipv4: v4[0] || '', ips: [] };
				if (name && !hostsByMac[mac].name) hostsByMac[mac].name = name;
				if (!hostsByMac[mac].ipv4 && v4[0]) hostsByMac[mac].ipv4 = v4[0];
				ips.forEach(function(ip) {
					if (hostsByMac[mac].ips.indexOf(ip) < 0) hostsByMac[mac].ips.push(ip);
					if (!ipOwners[ip]) ipOwners[ip] = [];
					if (ipOwners[ip].indexOf(mac) < 0) ipOwners[ip].push(mac);
				});
			});

			Object.keys(ipOwners).forEach(function(ip) {
				if (ipOwners[ip].length === 1) macByIp[ip] = ipOwners[ip][0];
			});

			hostsLoaded = true;
			var wasClean = !isDirty();
			absorbFallbacksIntoHosts();
			if (state.advIps.length > 0 || state.advFallbacks.length > 0) advDetails.open = true;
			if (wasClean && !fallbackParseError) originalSnapshot = snapshot();
		}).finally(function() {
			hostsLoading = false;
			paint();
		});
	}

	paint();

	return {
		element: root,
		loadDevices: loadHosts,
		isDirty: isDirty,
		markSaved: markSaved,
		validate: validate,
		getPayload: exportPayload,
		isTakeoverActive: function() {
			return exportPayload().device_mode !== 'off';
		},
		setDisabled: function(val) {
			disabled = !!val;
			paint();
		}
	};
}

return baseclass.extend({ create: create });
