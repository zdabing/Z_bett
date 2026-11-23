'use strict';
'require baseclass';
'require rpc';
'require bettbox.core as Core';
'require bettbox.ui as UI';
'require bettbox.subscription-controls as H';

var importRPC = rpc.declare({ object: 'bettbox', method: 'import_nodes', params: ['content'] });
var saveRPC = rpc.declare({ object: 'bettbox', method: 'save_node', params: ['node_json'] });
var deleteRPC = rpc.declare({ object: 'bettbox', method: 'del_node', params: ['id'] });
var reorderRPC = rpc.declare({ object: 'bettbox', method: 'reorder_nodes', params: ['ids_json'] });
var warpRPC = rpc.declare({ object: 'bettbox', method: 'register_warp' });
var testRPC = rpc.declare({ object: 'bettbox', method: 'test_node', params: ['id', 'dialer'] });
var applyRPC = rpc.declare({ object: 'bettbox', method: 'apply' });

var BUILTIN_PROXIES = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];
var GROUP_TYPES = ['Selector', 'URLTest', 'Fallback', 'LoadBalance'];
var DEFAULT_GROUPS = ['默认代理', '手动选择', '故障转移', 'OpenAI', 'AI', 'YouTube', 'Netflix', 'Telegram', 'GitHub', 'Google'];
var SCOPE_LABELS = {
	managed: '托管与合并订阅',
	all: '全部订阅',
	profiles: '仅指定订阅',
	none: '暂不注入'
};

function parseJSON(text) {
	if (typeof text !== 'string') return null;
	var s = text.trim();
	if (!s) return null;
	try { return JSON.parse(s); } catch (e) { return null; }
}

function errorMessage(err, fallback) {
	var msg = err && err.message ? String(err.message) : '';
	var parsed = parseJSON(msg);
	if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
	return msg || fallback || '操作失败';
}

function checkResult(res) {
	UI.checked(res);
	if (res && res.ok === false) throw new Error(res.error || '操作失败');
	return res;
}

function runNodeJob(res, fallbackErr) {
	return Promise.resolve(UI.operation(res)).then(function(jobRes) {
		var parsed = parseJSON(jobRes && jobRes.text);
		if (parsed && parsed.ok === false) throw new Error(parsed.error || fallbackErr || '操作失败');
		if (!parsed) throw new Error((jobRes && jobRes.text) || fallbackErr || '返回结果无效');
		return parsed;
	}).catch(function(err) {
		throw new Error(errorMessage(err, fallbackErr));
	});
}

function protoLabel(node) {
	var t = node && node.proxy && node.proxy.type ? String(node.proxy.type) : 'proxy';
	if (t.toLowerCase() === 'wireguard') return 'WG';
	if (t.toLowerCase() === 'hysteria2') return 'HY2';
	if (t.toLowerCase() === 'hysteria') return 'HY1';
	return t.toUpperCase();
}

function endpointText(node) {
	var p = node && node.proxy ? node.proxy : null;
	if (!p || !p.server) return '';
	var host = String(p.server);
	if (host.indexOf(':') >= 0 && host.charAt(0) !== '[') host = '[' + host + ']';
	return p.port ? (host + ':' + p.port) : host;
}

function scopeText(node) {
	if (node.scope === 'profiles') {
		var n = Array.isArray(node.profiles) ? node.profiles.length : 0;
		return '指定 ' + n + ' 个订阅';
	}
	return SCOPE_LABELS[node.scope] || '托管与合并订阅';
}

function uniqueStrings(list) {
	var seen = Object.create(null), out = [];
	(list || []).forEach(function(item) {
		var s = typeof item === 'string' ? item.trim() : '';
		if (s && !seen[s]) { seen[s] = true; out.push(s); }
	});
	return out;
}

function fetchRuntimeProxies() {
	return Core.get('/proxies').then(function(res) {
		var proxies = res && res.data && res.data.proxies;
		if (!proxies || typeof proxies !== 'object') return { groups: [], dialers: [] };
		var groups = [], nodes = [];
		Object.keys(proxies).forEach(function(name) {
			if (BUILTIN_PROXIES.indexOf(name) >= 0) return;
			var info = proxies[name] || {};
			if (GROUP_TYPES.indexOf(info.type) >= 0 || Array.isArray(info.all)) {
				if (!info.hidden) groups.push(name);
			} else {
				nodes.push(name);
			}
		});
		return { groups: groups, dialers: groups.concat(nodes) };
	}).catch(function() {
		return { groups: [], dialers: [] };
	});
}

return baseclass.extend({
	create: function(config) {
		var nodes = Array.isArray(config.nodes) ? config.nodes.slice() : [];
		var profiles = Array.isArray(config.profiles) ? config.profiles.slice() : [];
		var delays = Object.create(null), testing = Object.create(null);
		var busy = false, disposed = false, box = null;
		var host = E('div', { 'class': 'hub-node-library' });

		function setNotice(msg) {
			if (config.notice) config.notice.textContent = msg || '';
		}

		function emitChange() {
			return Promise.resolve(config.onChanged ? config.onChanged() : null);
		}

		function moveNode(index, delta) {
			var target = index + delta;
			if (busy || target < 0 || target >= nodes.length) return Promise.resolve();
			var ids = nodes.map(function(n) { return n.id; });
			var tmp = ids[index];
			ids[index] = ids[target];
			ids[target] = tmp;
			busy = true;
			draw();
			return reorderRPC(JSON.stringify(ids)).then(checkResult).then(function(res) {
				if (Array.isArray(res.nodes)) nodes = res.nodes;
				setNotice('已调整节点顺序；点击「应用更改」后生效。');
				return emitChange();
			}).catch(function(err) {
				setNotice('调整顺序失败：' + errorMessage(err));
			}).finally(function() {
				busy = false;
				if (!disposed) draw();
			});
		}

		function testSingleNode(node) {
			if (testing[node.id]) return Promise.resolve();
			testing[node.id] = true;
			draw();
			return testRPC(node.id, node.dialer || '').then(function(res) {
				return runNodeJob(res, '节点测速失败');
			}).then(function(parsed) {
				delays[node.id] = { delay: Number(parsed.delay) || 0, error: '' };
			}).catch(function(err) {
				delays[node.id] = { delay: 0, error: errorMessage(err, '测速超时') };
			}).finally(function() {
				delete testing[node.id];
				if (!disposed) draw();
			});
		}

		function removeNode(node) {
			return H.confirm('删除节点', '确定从节点库删除“' + (node.name || node.id) + '”？', '删除节点', true).then(function(yes) {
				if (!yes || busy) return;
				busy = true;
				draw();
				return deleteRPC(node.id).then(checkResult).then(function(res) {
					if (Array.isArray(res.nodes)) nodes = res.nodes;
					delete delays[node.id];
					setNotice('已删除节点“' + (node.name || node.id) + '”；如当前正在使用，请点击「应用更改」。');
					return emitChange();
				}).catch(function(err) {
					setNotice('删除节点失败：' + errorMessage(err));
				}).finally(function() {
					busy = false;
					if (!disposed) draw();
				});
			});
		}

		function toggleEnabled(node, value, toggleBtn) {
			if (busy) {
				toggleBtn.setValue(!!node.enabled);
				return Promise.resolve();
			}
			busy = true;
			draw();
			return saveRPC(JSON.stringify({ id: node.id, enabled: !!value })).then(checkResult).then(function(res) {
				if (Array.isArray(res.nodes)) nodes = res.nodes;
				setNotice('已' + (value ? '启用' : '停用') + '“' + (node.name || node.id) + '”；点击「应用更改」后生效。');
				return emitChange();
			}).catch(function(err) {
				toggleBtn.setValue(!!node.enabled);
				setNotice('切换节点状态失败：' + errorMessage(err));
			}).finally(function() {
				busy = false;
				if (!disposed) draw();
			});
		}

		function editNode(node) {
			var dirty = false, saving = false, proxyTouched = false;
			var enabled = !!node.enabled, landing = !!node.landing, regions = node.regions !== false;
			var scopeValue = ['managed', 'all', 'profiles', 'none'].indexOf(node.scope) >= 0 ? node.scope : 'managed';
			var selectedProfiles = Object.create(null);
			(node.profiles || []).forEach(function(id) { selectedProfiles[id] = true; });
			var selectedGroups = Object.create(null);
			(node.groups || []).forEach(function(g) { selectedGroups[g] = true; });

			var error = E('div', { 'class': 'hub-error', role: 'alert' });
			var status = E('span', { 'class': 'hub-save-state', role: 'status' });
			function changed() { dirty = true; status.textContent = '有未保存的修改'; }

			var nameInput = E('input', { 'class': 'field', type: 'text', maxlength: '256', value: node.name || '' });
			nameInput.addEventListener('input', changed);
			var enabledToggle = H.toggle(enabled, '启用节点', function(val) { enabled = val; changed(); });

			var proxyText = E('textarea', {
				'class': 'field hub-rules hub-node-yaml mono',
				rows: '9',
				'aria-label': '节点参数 JSON 或 YAML'
			});
			proxyText.value = JSON.stringify(node.proxy || {}, null, 2);
			proxyText.addEventListener('input', function() { proxyTouched = true; changed(); });

			var landingToggle = H.toggle(landing, '设为落地节点', function(val) { landing = val; changed(); });
			var dialerInput = E('input', {
				'class': 'field',
				type: 'text',
				maxlength: '256',
				placeholder: '留空直连；填写组名或节点名作为前置跳转',
				value: node.dialer || ''
			});
			dialerInput.addEventListener('input', changed);

			var dialerQuick = E('select', { 'class': 'field', 'aria-label': '从运行核心快速选择前置代理' }, [
				E('option', { value: '' }, '快速选择前置代理…')
			]);
			dialerQuick.addEventListener('change', function() {
				if (dialerQuick.value === '__clear__') {
					dialerInput.value = '';
					dialerQuick.value = '';
					changed();
				} else if (dialerQuick.value) {
					dialerInput.value = dialerQuick.value;
					dialerQuick.value = '';
					changed();
				}
			});

			var chainResult = E('span', { 'class': 'hub-node-delay', hidden: true });
			var chainTestBtn = UI.button('测试当前链路延迟', function() {
				var curDialer = dialerInput.value.trim();
				chainResult.hidden = false;
				chainResult.className = 'hub-node-delay';
				chainResult.textContent = '测速中…';
				chainTestBtn.disabled = true;
				return testRPC(node.id, curDialer).then(function(res) {
					return runNodeJob(res, '链路测速失败');
				}).then(function(parsed) {
					var ms = Number(parsed.delay) || 0;
					chainResult.className = 'hub-node-delay ok';
					chainResult.textContent = ms + ' ms' + (curDialer ? '（经 ' + curDialer + '）' : '（直连）');
					if (curDialer === (node.dialer || '')) {
						delays[node.id] = { delay: ms, error: '' };
						draw();
					}
				}).catch(function(err) {
					chainResult.className = 'hub-node-delay err';
					chainResult.textContent = errorMessage(err, '测速失败');
				}).finally(function() {
					chainTestBtn.disabled = false;
				});
			}, '', 'activity');

			var scopeSelect = E('select', { 'class': 'field', 'aria-label': '生效范围' }, [
				E('option', { value: 'managed' }, '托管与合并订阅（推荐）'),
				E('option', { value: 'all' }, '全部订阅（含外部脚本与原样配置）'),
				E('option', { value: 'profiles' }, '仅指定订阅'),
				E('option', { value: 'none' }, '暂不注入')
			]);
			scopeSelect.value = scopeValue;

			var profilePills = E('div', { 'class': 'hub-node-checks' });
			var profileField = E('div', { 'class': 'hub-field wide', hidden: scopeValue !== 'profiles' }, [
				E('label', {}, '选择生效订阅'),
				profilePills
			]);
			function drawProfiles() {
				if (!profiles.length) {
					profilePills.replaceChildren(E('span', { 'class': 'small muted' }, '暂无已添加订阅'));
					return;
				}
				profilePills.replaceChildren.apply(profilePills, profiles.map(function(p) {
					var cb = E('input', { type: 'checkbox' });
					cb.checked = !!selectedProfiles[p.id];
					cb.addEventListener('change', function() {
						if (cb.checked) selectedProfiles[p.id] = true;
						else delete selectedProfiles[p.id];
						pill.classList.toggle('active', cb.checked);
						changed();
					});
					var pill = E('label', { 'class': 'hub-check-pill' + (cb.checked ? ' active' : '') }, [
						cb,
						E('span', {}, p.label || p.id)
					]);
					return pill;
				}));
			}
			drawProfiles();
			scopeSelect.addEventListener('change', function() {
				scopeValue = scopeSelect.value;
				profileField.hidden = scopeValue !== 'profiles';
				changed();
			});

			var regionsToggle = H.toggle(regions, '自动加入匹配地区组', function(val) { regions = val; changed(); });

			var knownGroups = uniqueStrings(DEFAULT_GROUPS.concat(node.groups || []));
			var groupPills = E('div', { 'class': 'hub-node-checks' });
			var extraGroupsInput = E('input', {
				'class': 'field',
				type: 'text',
				maxlength: '512',
				placeholder: '可选：补充其他策略组名称，多个用英文逗号分隔'
			});
			extraGroupsInput.addEventListener('input', changed);

			function drawGroupPills() {
				groupPills.replaceChildren.apply(groupPills, knownGroups.map(function(g) {
					var cb = E('input', { type: 'checkbox' });
					cb.checked = !!selectedGroups[g];
					cb.addEventListener('change', function() {
						if (cb.checked) selectedGroups[g] = true;
						else delete selectedGroups[g];
						pill.classList.toggle('active', cb.checked);
						changed();
					});
					var pill = E('label', { 'class': 'hub-check-pill' + (cb.checked ? ' active' : '') }, [
						cb,
						E('span', {}, g)
					]);
					return pill;
				}));
			}
			drawGroupPills();

			var besideInput = E('input', {
				'class': 'field',
				type: 'text',
				maxlength: '128',
				placeholder: '例如：自动选择 或特定节点/组名',
				value: node.beside || ''
			});
			besideInput.addEventListener('input', changed);

			function populateLiveSuggestions() {
				fetchRuntimeProxies().then(function(live) {
					if (!box || !box.element.isConnected) return;
					var libNames = nodes.filter(function(n) { return n.id !== node.id && n.name; }).map(function(n) { return n.name; });
					var dialerOpts = uniqueStrings(libNames.concat(live.dialers));
					var selectNodes = [
						E('option', { value: '' }, '快速选择前置代理…'),
						E('option', { value: '__clear__' }, '清空（直连）')
					].concat(dialerOpts.map(function(name) {
						return E('option', { value: name }, name);
					}));
					dialerQuick.replaceChildren.apply(dialerQuick, selectNodes);

					var merged = uniqueStrings(live.groups.concat(DEFAULT_GROUPS).concat(node.groups || []));
					if (merged.length !== knownGroups.length || merged.some(function(g, i) { return g !== knownGroups[i]; })) {
						knownGroups = merged;
						drawGroupPills();
					}
				});
			}

			function persist(andApply) {
				error.textContent = '';
				var cleanName = nameInput.value.trim();
				if (!cleanName) {
					error.textContent = '节点名称不能为空';
					return;
				}
				var extra = extraGroupsInput.value.split(/[,\n]/).map(function(s) { return s.trim(); }).filter(Boolean);
				var chosenGroups = knownGroups.filter(function(g) { return !!selectedGroups[g]; });
				var finalGroups = uniqueStrings(chosenGroups.concat(extra));
				var finalProfiles = Object.keys(selectedProfiles);

				var payload = {
					id: node.id,
					name: cleanName,
					enabled: enabled,
					landing: landing,
					dialer: dialerInput.value.trim(),
					scope: scopeValue,
					profiles: finalProfiles,
					groups: finalGroups,
					beside: besideInput.value.trim(),
					regions: regions
				};
				if (proxyTouched) payload.proxy_text = proxyText.value;

				saving = true;
				box.setBusy(true);
				status.textContent = '正在保存节点…';
				return saveRPC(JSON.stringify(payload)).then(checkResult).then(function(res) {
					if (Array.isArray(res.nodes)) nodes = res.nodes;
					return emitChange().then(function() {
						if (!andApply) {
							setNotice('已保存节点“' + (res.node && res.node.name || cleanName) + '”；点击「应用更改」后生效。');
							return;
						}
						status.textContent = '正在应用配置到核心…';
						return applyRPC().then(UI.operation).then(function() {
							setNotice('已保存“' + (res.node && res.node.name || cleanName) + '”并应用到核心。');
						});
					});
				}).then(function() {
					dirty = false;
					saving = false;
					box.setBusy(false);
					return box.close(true);
				}).catch(function(err) {
					error.textContent = errorMessage(err, '保存节点失败');
					status.textContent = '请检查后重试';
				}).finally(function() {
					saving = false;
					if (box) box.setBusy(false);
				});
			}

			var sections = [
				E('section', { 'class': 'hub-form-section' }, [
					E('h3', {}, '基本信息'),
					E('div', { 'class': 'hub-setting-line' }, [
						E('div', { 'class': 'hub-setting-copy' }, [
							E('h4', { style: 'margin:0;font-size:14px' }, '启用节点'),
							E('p', { 'class': 'small muted', style: 'margin:2px 0 0' }, '停用后保留在节点库中，但不会注入任何订阅配置。')
						]),
						enabledToggle
					]),
					E('div', { 'class': 'hub-form-grid' }, [
						H.field('节点名称', nameInput, true),
						H.field('节点定义（支持 JSON 或单个 YAML Proxy 映射）', proxyText, true)
					])
				]),
				E('section', { 'class': 'hub-form-section' }, [
					E('h3', {}, '落地与链式代理'),
					E('div', { 'class': 'hub-setting-line' }, [
						E('div', { 'class': 'hub-setting-copy' }, [
							E('h4', { style: 'margin:0;font-size:14px' }, '设为落地节点 (Landing)'),
							E('p', { 'class': 'small muted', style: 'margin:2px 0 0' }, '开启后仅注入明确指定的策略组或伴随组，不扩散到其他同地区测速组。')
						]),
						landingToggle
					]),
					E('div', { 'class': 'hub-form-grid' }, [
						H.field('前置代理 (dialer-proxy)', dialerInput),
						H.field('从运行核心/节点库填充前置', dialerQuick)
					]),
					E('div', { 'class': 'hub-node-test-row' }, [chainTestBtn, chainResult])
				]),
				E('section', { 'class': 'hub-form-section' }, [
					E('h3', {}, '订阅注入与策略组'),
					E('div', { 'class': 'hub-setting-line' }, [
						E('div', { 'class': 'hub-setting-copy' }, [
							E('h4', { style: 'margin:0;font-size:14px' }, '自动匹配地区组'),
							E('p', { 'class': 'small muted', style: 'margin:2px 0 0' }, '按节点名称中的地区标识自动加入对应地区手动选择组。')
						]),
						regionsToggle
					]),
					E('div', { 'class': 'hub-form-grid' }, [
						H.field('生效范围', scopeSelect, true),
						profileField,
						E('div', { 'class': 'hub-field wide' }, [
							E('label', {}, '目标策略组（注入到列表靠前位置）'),
							groupPills
						]),
						H.field('补充自定义策略组', extraGroupsInput, true),
						H.field('伴随组 / 节点 (beside)', besideInput, true)
					])
				])
			];

			box = H.dialog('编辑节点', [
				E('div', { 'class': 'hub-editor-context' }, [
					E('span', { 'class': 'hub-node-proto' }, protoLabel(node)),
					E('strong', {}, node.name || node.id),
					endpointText(node) ? UI.tag(endpointText(node)) : ''
				]),
				E('div', { 'class': 'hub-editor-content' }, sections.concat([error]))
			], [
				status,
				E('div', {}, [
					UI.button('取消', function() { return box.close(); }),
					UI.button('保存', function() { return persist(false); }),
					UI.button('保存并应用', function() { return persist(true); }, 'primary', 'save')
				])
			], {
				drawer: true,
				beforeClose: function() {
					if (saving) return false;
					return !dirty || H.confirm('放弃修改', '节点配置有未保存的修改，确定放弃？', '放弃修改', true);
				},
				onClose: function() { box = null; }
			});
			populateLiveSuggestions();
			return box;
		}

		function add() {
			var error = E('div', { 'class': 'hub-error', role: 'alert' });
			var input = E('textarea', {
				'class': 'field hub-rules mono',
				rows: '10',
				placeholder: '粘贴分享链接（ss://、vmess://、vless://、trojan://、hysteria2://、tuic://、anytls://、socks5://、http://）、Base64 节点列表或 Clash YAML（proxies: ...）',
				'aria-label': '导入节点内容'
			});
			var fileInput = E('input', { type: 'file', accept: '.yaml,.yml,.txt,.conf,.json', hidden: true });
			var fileLabel = E('span', { 'class': 'small muted' }, '也可从本地文件导入');
			var pickBtn = UI.button('选择本地文件', function() { fileInput.click(); }, '', 'file');
			fileInput.addEventListener('change', function() {
				var file = fileInput.files && fileInput.files[0];
				if (!file) return;
				if (file.size > 262144) {
					error.textContent = '文件超过 256 KB 限制';
					return;
				}
				var reader = new FileReader();
				reader.onload = function() {
					input.value = String(reader.result || '');
					fileLabel.textContent = '已读取：' + file.name;
					error.textContent = '';
				};
				reader.onerror = function() { error.textContent = '读取文件失败'; };
				reader.readAsText(file);
			});

			var modalBox;
			var submitBtn = UI.button('导入节点', function() {
				error.textContent = '';
				var content = input.value.trim();
				if (!content) { error.textContent = '请粘贴节点分享链接或 YAML 内容'; return; }
				if (content.length > 262144) { error.textContent = '输入内容超过 256 KB 限制'; return; }
				modalBox.setBusy(true);
				return importRPC(content).then(checkResult).then(function(res) {
					if (Array.isArray(res.nodes)) nodes = res.nodes;
					var msg = '已导入 ' + (res.added || 0) + ' 个节点';
					if (res.invalid > 0) msg += '（跳过 ' + res.invalid + ' 条无效项）';
					msg += '；点击「应用更改」后写入运行配置。';
					setNotice(msg);
					return emitChange().then(function() {
						modalBox.setBusy(false);
						return modalBox.close(true);
					});
				}).catch(function(err) {
					error.textContent = errorMessage(err, '节点解析或导入失败');
				}).finally(function() {
					modalBox.setBusy(false);
				});
			}, 'primary', 'plus');

			modalBox = H.dialog('导入节点', [
				E('div', { 'class': 'hub-node-import-file' }, [pickBtn, fileLabel, fileInput]),
				H.field('分享链接 / Base64 / Clash YAML', input, true),
				error
			], [
				UI.button('取消', function() { return modalBox.close(); }),
				submitBtn
			]);
			return modalBox;
		}

		function registerWarp() {
			if (busy) return Promise.resolve();
			busy = true;
			draw();
			setNotice('正在向 Cloudflare 注册 WireGuard WARP 设备，请稍候…');
			return warpRPC().then(function(res) {
				return runNodeJob(res, 'Cloudflare WARP 注册失败');
			}).then(function(parsed) {
				if (Array.isArray(parsed.nodes)) nodes = parsed.nodes;
				var name = parsed.node && parsed.node.name ? parsed.node.name : 'Cloudflare WARP';
				setNotice('已生成 WARP 节点“' + name + '”（默认启用）；点击「应用更改」即可使用或将其设为前置节点。');
				return emitChange();
			}).catch(function(err) {
				setNotice('WARP 注册失败：' + errorMessage(err));
			}).finally(function() {
				busy = false;
				if (!disposed) draw();
			});
		}

		function apply() {
			if (busy) return Promise.resolve();
			busy = true;
			draw();
			setNotice('正在重新渲染并应用节点库配置…');
			return applyRPC().then(UI.operation).then(function() {
				setNotice('节点库配置已成功应用到运行核心。');
			}).catch(function(err) {
				setNotice('应用配置失败：' + errorMessage(err));
			}).finally(function() {
				busy = false;
				if (!disposed) draw();
			});
		}

		function renderCard(node, idx) {
			var endpoint = endpointText(node);
			var toggleBtn = H.toggle(!!node.enabled, (node.enabled ? '停用' : '启用') + ' ' + (node.name || node.id), function(val) {
				return toggleEnabled(node, val, toggleBtn);
			});

			var tags = [E('span', { 'class': 'hub-node-tag' }, scopeText(node))];
			if (node.landing) tags.unshift(E('span', { 'class': 'hub-node-tag accent' }, '落地节点'));
			if (node.dialer) tags.push(E('span', { 'class': 'hub-node-tag' }, '前置 · ' + node.dialer));
			if (node.regions) tags.push(E('span', { 'class': 'hub-node-tag' }, '地区归组'));
			if (Array.isArray(node.groups) && node.groups.length) {
				var gLabel = node.groups.slice(0, 3).join(', ') + (node.groups.length > 3 ? ' +' + (node.groups.length - 3) : '');
				tags.push(E('span', { 'class': 'hub-node-tag' }, '策略组 · ' + gLabel));
			}
			if (node.beside) tags.push(E('span', { 'class': 'hub-node-tag' }, '伴随 · ' + node.beside));
			if (testing[node.id]) {
				tags.push(E('span', { 'class': 'hub-node-delay' }, '测速中…'));
			} else if (delays[node.id]) {
				if (delays[node.id].delay > 0) tags.push(E('span', { 'class': 'hub-node-delay ok' }, delays[node.id].delay + ' ms'));
				else tags.push(E('span', { 'class': 'hub-node-delay err', title: delays[node.id].error }, delays[node.id].error));
			}

			var upBtn = UI.button('上移', function() { return moveNode(idx, -1); }, 'bb-icon-only', 'up');
			upBtn.title = '上移节点'; upBtn.disabled = busy || idx === 0;
			var downBtn = UI.button('下移', function() { return moveNode(idx, 1); }, 'bb-icon-only', 'down');
			downBtn.title = '下移节点'; downBtn.disabled = busy || idx === nodes.length - 1;
			var testBtn = UI.button(testing[node.id] ? '测速中' : '测速', function() { return testSingleNode(node); }, '', 'activity');
			testBtn.disabled = busy || !!testing[node.id];
			var editBtn = UI.button('编辑', function() { return editNode(node); }, '', 'edit');
			editBtn.disabled = busy;
			var delBtn = UI.button('删除', function() { return removeNode(node); }, 'danger', 'close');
			delBtn.disabled = busy;

			return E('article', { 'class': 'panel hub-card hub-node-card' + (node.enabled ? '' : ' inactive') }, [
				E('div', { 'class': 'hub-card-top' }, [
					E('div', { 'class': 'hub-name' }, [
						E('span', { 'class': 'hub-node-proto' }, protoLabel(node)),
						E('div', { 'class': 'hub-name-text' }, [
							E('h2', {}, node.name || node.id),
							endpoint ? E('span', { 'class': 'hub-node-endpoint mono' }, endpoint) : ''
						])
					]),
					E('div', { 'class': 'hub-card-top-right' }, [toggleBtn])
				]),
				E('div', { 'class': 'hub-node-tags' }, tags),
				E('div', { 'class': 'hub-card-actions' }, [
					E('div', { 'class': 'hub-node-order' }, [upBtn, downBtn]),
					E('div', { 'class': 'hub-card-btns' }, [testBtn, editBtn, delBtn])
				])
			]);
		}

		function draw() {
			if (disposed) return;
			if (!nodes.length) {
				host.replaceChildren(E('section', { 'class': 'panel hub-empty' }, [
					E('span', { 'class': 'hub-icon' }, UI.icon('globe')),
					E('h2', {}, '节点库为空'),
					E('p', { 'class': 'small muted', style: 'margin:0;text-align:center;max-width:440px' }, '支持导入分享链接 / Clash YAML，或一键注册 Cloudflare WARP 作为落地或直连节点；可为节点配置前置代理 (dialer-proxy) 与自动注入范围。'),
					E('div', { 'class': 'button-row' }, [
						UI.button('一键生成 WARP', registerWarp, '', 'shield'),
						UI.button('导入节点', add, 'primary', 'plus')
					])
				]));
				return;
			}
			host.replaceChildren(E('div', { 'class': 'hub-grid' }, nodes.map(function(node, idx) {
				return renderCard(node, idx);
			})));
		}

		draw();
		return {
			element: host,
			updateData: function(nextNodes, nextProfiles) {
				if (Array.isArray(nextNodes)) nodes = nextNodes.slice();
				if (Array.isArray(nextProfiles)) profiles = nextProfiles.slice();
				draw();
			},
			activate: function() { draw(); },
			dispose: function() { disposed = true; },
			add: add,
			registerWarp: registerWarp,
			apply: apply
		};
	}
});
