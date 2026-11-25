'use strict';
'require baseclass';
'require rpc';
'require uci';
'require bettbox.core as Core';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';

var getProfiles = rpc.declare({ object: 'bettbox', method: 'get_profiles' });
var commitRPC = rpc.declare({ object: 'uci', method: 'commit', params: ['config'] });
var applyRPC = rpc.declare({ object: 'bettbox', method: 'apply' });

var MULTI_SUFFIXES = [
	'co.uk', 'org.uk', 'ac.uk', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
	'com.hk', 'gov.hk', 'edu.hk', 'com.tw', 'com.sg', 'com.au', 'co.jp', 'ne.jp',
	'or.jp', 'com.br', 'co.kr', 'com.tr', 'com.mx', 'co.in', 'co.nz', 'co.za',
	'com.my', 'com.vn', 'com.ph', 'com.ar'
];

var RULE_TYPES = [
	{ value: 'DOMAIN-SUFFIX', label: '域名后缀（推荐）', hint: '匹配该域名及其全部子域名' },
	{ value: 'DOMAIN', label: '精确域名', hint: '仅匹配当前完整主机名' },
	{ value: 'DOMAIN-KEYWORD', label: '域名关键词', hint: '域名包含指定关键字时匹配' },
	{ value: 'IP-CIDR', label: 'IPv4 网段 / 地址', hint: '按目标 IPv4 匹配，单个 IP 自动补 /32' },
	{ value: 'IP-CIDR6', label: 'IPv6 网段 / 地址', hint: '按目标 IPv6 匹配，单个 IP 自动补 /128' },
	{ value: 'DST-PORT', label: '目标端口', hint: '按目标端口匹配（支持单端口或范围，如 443）' }
];

function isIPv4(s) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return false;
	return s.split('.').every(function(part) {
		var n = Number(part);
		return n >= 0 && n <= 255 && String(n) === part;
	});
}

function isIPv6(s) {
	return typeof s === 'string' && s.indexOf(':') >= 0 && /^[0-9A-Fa-f:.]+$/.test(s);
}

function extractRootDomain(host) {
	var clean = String(host || '').trim().replace(/\.$/, '').toLowerCase();
	if (!clean) return '';
	var parts = clean.split('.').filter(Boolean);
	if (parts.length <= 2) return parts.join('.');
	var tail2 = parts.slice(-2).join('.');
	if (MULTI_SUFFIXES.indexOf(tail2) >= 0 && parts.length >= 3)
		return parts.slice(-3).join('.');
	return tail2;
}

function extractKeyword(host) {
	var root = extractRootDomain(host);
	if (!root) return '';
	return root.split('.')[0] || root;
}

function buildRule(type, rawValue, target, noResolve) {
	var val = String(rawValue || '').trim();
	var tgt = String(target || '').trim();
	if (!val) throw new Error('请输入匹配内容');
	if (/[\r\n,]/.test(val)) throw new Error('匹配内容不能包含逗号或换行');
	if (!tgt) throw new Error('请选择目标策略');
	if (/[\r\n,]/.test(tgt)) throw new Error('目标策略不能包含逗号或换行');

	if (type === 'IP-CIDR') {
		if (isIPv4(val)) val = val + '/32';
		var m4 = val.match(/^([^/]+)\/(\d{1,2})$/);
		var prefix4 = m4 ? Number(m4[2]) : -1;
		if (!m4 || !isIPv4(m4[1]) || prefix4 < 0 || prefix4 > 32)
			throw new Error('请输入有效的 IPv4 地址或 CIDR（如 1.2.3.4/32）');
	} else if (type === 'IP-CIDR6') {
		if (val.indexOf('/') < 0 && isIPv6(val)) val = val + '/128';
		var m6 = val.match(/^([^/]+)\/(\d{1,3})$/);
		var prefix6 = m6 ? Number(m6[2]) : -1;
		if (!m6 || !isIPv6(m6[1]) || prefix6 < 0 || prefix6 > 128)
			throw new Error('请输入有效的 IPv6 地址或 CIDR（如 2001:db8::/32）');
	} else if (type === 'DST-PORT') {
		var mp = val.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
		var p1 = mp ? Number(mp[1]) : 0;
		var p2 = mp && mp[2] ? Number(mp[2]) : p1;
		if (!mp || p1 < 1 || p1 > 65535 || p2 < 1 || p2 > 65535 || p1 > p2)
			throw new Error('请输入有效的端口号或范围（如 443 或 8000-8080）');
	} else {
		if (/\s/.test(val)) throw new Error('域名规则不能包含空格');
		val = val.toLowerCase();
	}

	var rule = type + ',' + val + ',' + tgt;
	if ((type === 'IP-CIDR' || type === 'IP-CIDR6') && noResolve)
		rule += ',no-resolve';
	return rule;
}

function collectTargets(proxiesMap) {
	var groups = [], seen = Object.create(null);
	if (proxiesMap && typeof proxiesMap === 'object') {
		var globalGroup = proxiesMap.GLOBAL;
		if (globalGroup && Array.isArray(globalGroup.all)) {
			globalGroup.all.forEach(function(name) {
				var p = proxiesMap[name];
				if (p && Array.isArray(p.all) && p.name !== 'GLOBAL' && !p.hidden && !seen[p.name]) {
					seen[p.name] = true;
					groups.push(p.name);
				}
			});
		}
		Object.keys(proxiesMap).forEach(function(name) {
			var p = proxiesMap[name];
			if (p && Array.isArray(p.all) && name !== 'GLOBAL' && !p.hidden && !seen[name]) {
				seen[name] = true;
				groups.push(name);
			}
		});
	}
	return { builtin: ['DIRECT', 'REJECT'], groups: groups };
}

function parseRulesJson(raw) {
	var obj = H.object(raw);
	return Array.isArray(obj.rules) ? obj.rules.filter(function(r) {
		return typeof r === 'string' && r.trim().length > 0;
	}) : [];
}

function ruleIdentity(rule) {
	var parts = String(rule || '').split(',');
	if (parts.length < 2) return '';
	return parts[0].trim().toUpperCase() + ',' + parts[1].trim().toLowerCase();
}

function isManagedProfile(profile) {
	if (!profile) return false;
	var merged = Array.isArray(profile.merge_members) && profile.merge_members.length > 0;
	return !!profile.use_managed || (merged && !profile.use_script);
}

return baseclass.extend({
	open: function(connection, options) {
		options = options || {};
		var m = connection.metadata || {};
		var rawHost = String(m.host || '').trim();
		var host = (rawHost && !isIPv4(rawHost) && !isIPv6(rawHost)) ? rawHost.replace(/\.$/, '').toLowerCase() : '';
		var destIP = String(m.destinationIP || (rawHost && (isIPv4(rawHost) || isIPv6(rawHost)) ? rawHost : '')).trim();
		var destPort = m.destinationPort ? String(m.destinationPort) : '';
		var chains = Array.isArray(connection.chains) ? connection.chains.slice().reverse() : [];

		var candidates = {
			'DOMAIN-SUFFIX': host ? extractRootDomain(host) : '',
			'DOMAIN': host,
			'DOMAIN-KEYWORD': host ? extractKeyword(host) : '',
			'IP-CIDR': destIP && isIPv4(destIP) ? destIP + '/32' : '',
			'IP-CIDR6': destIP && isIPv6(destIP) ? destIP + '/128' : '',
			'DST-PORT': destPort
		};
		var candidateValues = Object.keys(candidates).map(function(k) { return candidates[k]; }).filter(Boolean);
		var defaultType = host ? 'DOMAIN-SUFFIX' : (destIP && isIPv4(destIP) ? 'IP-CIDR' : (destIP && isIPv6(destIP) ? 'IP-CIDR6' : 'DST-PORT'));

		var activeProfile = null, profileRules = [], sharedRules = [], loaded = false, saving = false;

		var typeSelect = E('select', { 'class': 'field', 'aria-label': '规则类型' }, RULE_TYPES.map(function(t) {
			return E('option', { value: t.value }, t.label);
		}));
		typeSelect.value = defaultType;

		var hintText = E('p', { 'class': 'bb-rule-hint' });
		var valueInput = E('input', { 'class': 'field mono', type: 'text', 'aria-label': '匹配内容', placeholder: '例如 example.com' });
		valueInput.value = candidates[defaultType] || '';

		var noResolveInput = E('input', { type: 'checkbox' });
		noResolveInput.checked = true;
		var noResolveRow = E('label', { 'class': 'bb-rule-check' }, [noResolveInput, E('span', {}, '不触发 DNS 解析（no-resolve）')]);

		var targetSelect = E('select', { 'class': 'field', 'aria-label': '目标策略' }, [
			E('option', { value: 'DIRECT' }, 'DIRECT · 直连')
		]);

		var scopeSelect = E('select', { 'class': 'field', 'aria-label': '保存位置' }, [
			E('option', { value: 'profile' }, '当前订阅附加规则（加载中…）'),
			E('option', { value: 'shared' }, '全局托管共享规则（所有托管分流订阅生效）')
		]);
		var scopeWarn = E('p', { 'class': 'bb-rule-hint', hidden: true });

		var closeConnInput = E('input', { type: 'checkbox' });
		closeConnInput.checked = true;
		var closeConnRow = E('label', { 'class': 'bb-rule-check' }, [closeConnInput, E('span', {}, '保存并应用后关闭此连接（立即按新规则重建）')]);
		closeConnRow.hidden = !options.active;

		var previewCode = E('code', { 'class': 'mono' }, '—');
		var previewNote = E('p', { 'class': 'bb-rule-hint', hidden: true });
		var errorBox = E('div', { 'class': 'hub-error', role: 'alert' });
		var box;

		function currentList() {
			return scopeSelect.value === 'shared' ? sharedRules : profileRules;
		}

		function syncMeta() {
			var info = RULE_TYPES.find(function(t) { return t.value === typeSelect.value; });
			hintText.textContent = info ? info.hint : '';
			noResolveRow.hidden = typeSelect.value !== 'IP-CIDR' && typeSelect.value !== 'IP-CIDR6';
			var isShared = scopeSelect.value === 'shared';
			scopeWarn.hidden = !(isShared && activeProfile && !isManagedProfile(activeProfile));
			if (!scopeWarn.hidden)
				scopeWarn.textContent = '提示：当前订阅未启用「托管分流」，全局共享规则不会对当前订阅生效。';

			try {
				var rule = buildRule(typeSelect.value, valueInput.value, targetSelect.value, noResolveInput.checked);
				previewCode.textContent = rule;
				var list = currentList();
				var id = ruleIdentity(rule);
				var exact = list.indexOf(rule) >= 0;
				var conflict = !exact && id && list.some(function(item) { return ruleIdentity(item) === id; });
				previewNote.hidden = !(exact || conflict);
				if (exact) previewNote.textContent = '提示：目标规则列表中已存在完全相同的规则。';
				else if (conflict) previewNote.textContent = '提示：目标列表中已有同匹配条件的旧规则，新规则将置顶优先命中。';
			} catch (e) {
				previewCode.textContent = typeSelect.value + ',' + (valueInput.value.trim() || '…') + ',' + (targetSelect.value || 'DIRECT');
				previewNote.hidden = true;
			}
		}

		typeSelect.addEventListener('change', function() {
			var cur = valueInput.value.trim();
			var next = candidates[typeSelect.value] || '';
			if (!cur || candidateValues.indexOf(cur) >= 0) {
				if (next) valueInput.value = next;
			}
			errorBox.textContent = '';
			syncMeta();
		});
		valueInput.addEventListener('input', function() { errorBox.textContent = ''; syncMeta(); });
		noResolveInput.addEventListener('change', syncMeta);
		targetSelect.addEventListener('change', function() { errorBox.textContent = ''; syncMeta(); });
		scopeSelect.addEventListener('change', function() { errorBox.textContent = ''; syncMeta(); });

		function populateTargets(groups) {
			var optBuiltin = E('optgroup', { label: '内置策略' }, [
				E('option', { value: 'DIRECT' }, 'DIRECT · 直连'),
				E('option', { value: 'REJECT' }, 'REJECT · 拦截')
			]);
			var children = [optBuiltin];
			if (groups.length) {
				children.push(E('optgroup', { label: '当前策略组' }, groups.map(function(g) {
					return E('option', { value: g }, g);
				})));
			}
			targetSelect.replaceChildren.apply(targetSelect, children);
			if (chains[0] === 'DIRECT' && groups.length)
				targetSelect.value = groups.indexOf('默认代理') >= 0 ? '默认代理' : groups[0];
			else
				targetSelect.value = 'DIRECT';
		}

		var saveBtn = UI.button('保存并应用', function() {
			if (!loaded || saving) return;
			errorBox.textContent = '';
			var rule;
			try {
				rule = buildRule(typeSelect.value, valueInput.value, targetSelect.value, noResolveInput.checked);
			} catch (err) {
				errorBox.textContent = err.message;
				return;
			}
			var scope = scopeSelect.value;
			if (scope === 'profile' && !activeProfile) {
				errorBox.textContent = '当前未选用订阅，请改存为全局托管共享规则';
				return;
			}
			var list = scope === 'shared' ? sharedRules : profileRules;
			if (list.indexOf(rule) >= 0) {
				errorBox.textContent = '该规则已存在，无需重复添加';
				return;
			}
			var nextList = [rule].concat(list);
			if (scope === 'shared' && nextList.length > 512) {
				errorBox.textContent = '全局共享规则最多保存 512 条';
				return;
			}

			var section = scope === 'shared' ? 'config' : activeProfile.id;
			var option = scope === 'shared' ? 'shared_managed_rules' : 'override_rules';
			var prevRaw = uci.get('bettbox', section, option);
			var committed = false;

			saving = true;
			box.setBusy(true);
			uci.set('bettbox', section, option, JSON.stringify({ rules: nextList }));

			return uci.save().then(function() {
				return commitRPC('bettbox');
			}).then(function(res) {
				if (res && res.error) throw new Error('配置提交失败');
				committed = true;
				return applyRPC().then(UI.operation);
			}).then(function() {
				var shouldCloseConn = !!options.active && closeConnInput.checked && connection.id;
				var connClosed = false;
				var cleanup = shouldCloseConn
					? Core.del('/connections/' + encodeURIComponent(connection.id)).then(function() { connClosed = true; }).catch(function() {})
					: Promise.resolve();
				return cleanup.then(function() {
					return box.close(true).then(function() {
						if (options.onSaved) {
							options.onSaved({
								rule: rule,
								scope: scope,
								sid: activeProfile ? activeProfile.id : '',
								profileLabel: activeProfile ? (activeProfile.label || activeProfile.id) : '',
								closed: connClosed
							});
						}
					});
				});
			}).catch(function(err) {
				if (prevRaw != null && prevRaw !== '') uci.set('bettbox', section, option, prevRaw);
				else uci.unset('bettbox', section, option);
				var revert = uci.save().then(function() {
					if (!committed) return null;
					return commitRPC('bettbox').then(function(res) {
						if (res && res.error) throw new Error('配置回退提交失败');
					});
				});
				return revert.then(function() {
					errorBox.textContent = committed ? ('规则应用失败，已自动回退：' + err.message) : ('保存失败：' + err.message);
				}, function() {
					errorBox.textContent = '保存失败且回退失败，请前往订阅设置核对规则：' + err.message;
				});
			}).finally(function() {
				saving = false;
				if (box.element.isConnected) box.setBusy(false);
			});
		}, 'primary', 'save');
		saveBtn.disabled = true;

		var contextBlock = E('div', { 'class': 'bb-rule-context' }, [
			E('div', {}, [E('strong', {}, '目标：'), E('span', { 'class': 'mono' }, host || destIP || '—')]),
			E('div', {}, [E('strong', {}, '当前命中：'), E('span', {}, [connection.rule, connection.rulePayload].filter(Boolean).join(' ') || '—')]),
			E('div', {}, [E('strong', {}, '当前链路：'), E('span', {}, chains.length ? chains.join(' → ') : '—')])
		]);

		var previewBox = E('div', { 'class': 'bb-rule-preview-box' }, [
			E('div', { 'class': 'small muted', style: 'margin-bottom:4px' }, '生成规则预览'),
			previewCode,
			previewNote
		]);

		box = H.dialog('添加分流规则', [
			contextBlock,
			H.field('规则类型', E('div', {}, [typeSelect, hintText]), true),
			H.field('匹配内容', valueInput, true),
			noResolveRow,
			H.field('目标策略', targetSelect, true),
			H.field('保存位置', E('div', {}, [scopeSelect, scopeWarn]), true),
			closeConnRow,
			previewBox,
			errorBox
		], [
			UI.button('取消', function() { return box.close(); }),
			saveBtn
		], {
			className: 'bb-rule-dialog',
			beforeClose: function() { return !saving; }
		});

		syncMeta();

		if (uci.unload) uci.unload('bettbox');
		Promise.all([
			getProfiles(),
			Core.get('/proxies').catch(function() { return null; }),
			uci.load('bettbox')
		]).then(function(results) {
			if (!box.element.isConnected) return;
			var profRes = results[0] || {};
			var proxiesRes = results[1] && results[1].data && results[1].data.proxies ? results[1].data.proxies : null;
			var activeId = uci.get('bettbox', 'config', 'profile') || '';
			var list = Array.isArray(profRes.profiles) ? profRes.profiles : [];
			activeProfile = list.find(function(p) { return p.id === activeId; }) || null;
			profileRules = activeProfile ? parseRulesJson(uci.get('bettbox', activeProfile.id, 'override_rules') || activeProfile.override_rules) : [];
			sharedRules = parseRulesJson(uci.get('bettbox', 'config', 'shared_managed_rules'));

			var profileOpt = scopeSelect.querySelector('option[value="profile"]');
			if (activeProfile) {
				profileOpt.textContent = '当前订阅附加规则（' + (activeProfile.label || activeProfile.id) + '）';
				profileOpt.disabled = false;
				scopeSelect.value = 'profile';
			} else {
				profileOpt.textContent = '当前未选用订阅（不可用）';
				profileOpt.disabled = true;
				scopeSelect.value = 'shared';
			}

			var targetInfo = collectTargets(proxiesRes);
			var groups = targetInfo.groups.length ? targetInfo.groups : ['默认代理'];
			populateTargets(groups);

			loaded = true;
			saveBtn.disabled = false;
			syncMeta();
		}).catch(function(err) {
			if (!box.element.isConnected) return;
			errorBox.textContent = '无法读取订阅或策略组信息：' + (err && err.message || err);
		});

		return box;
	}
});
