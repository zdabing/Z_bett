'use strict';
'require view';
'require rpc';
'require uci';
'require form';

var callApply = rpc.declare({ object: 'bettbox', method: 'apply' });

return view.extend({
	load: function () {
		return uci.load('bettbox');
	},

	render: function () {
		var m, s, o;
		m = new form.Map('bettbox', _('Bettbox 设置'));

		/* ---------- 核心（常规/端口/控制器/守护/Geo 都在 core 'config' 段） ---------- */
		s = m.section(form.NamedSection, 'config', 'core', _('常规'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('启用服务'));
		o = s.option(form.ListValue, 'profile', _('当前订阅'));
		uci.sections('bettbox', 'subscription', function (sec) {
			var sid = sec['.name'];
			o.value(sid, (sec.label || sid) + ' (' + sid + ')');
		});
		o = s.option(form.ListValue, 'mode', _('运行模式'));
		o.value('rule', '规则 (Rule)');
		o.value('global', '全局 (Global)');
		o.value('direct', '直连 (Direct)');
		o = s.option(form.ListValue, 'log_level', _('日志级别'));
		o.value('silent', 'silent'); o.value('error', 'error'); o.value('warning', 'warning');
		o.value('info', 'info'); o.value('debug', 'debug');
		o = s.option(form.Flag, 'ipv6', _('IPv6'));

		o = s.option(form.Value, 'mixed_port', _('Mixed 端口 (HTTP+SOCKS)')); o.datatype = 'port';
		o = s.option(form.Value, 'tproxy_port', _('TPROXY 端口')); o.datatype = 'port';
		o = s.option(form.Value, 'redir_port', _('REDIR 端口 (0=关闭)')); o.datatype = 'port';
		o = s.option(form.Value, 'socks_port', _('SOCKS 端口 (0=关闭)')); o.datatype = 'port';
		o = s.option(form.Value, 'port', _('HTTP 端口 (0=关闭)')); o.datatype = 'port';

		o = s.option(form.Flag, 'allow_lan', _('允许局域网'));
		o = s.option(form.DynamicList, 'authentication', _('入站认证 (user:pass)'));
		o = s.option(form.DynamicList, 'skip_auth_prefixes', _('免认证网段'));
		o = s.option(form.Value, 'external_controller', _('控制 API 监听')); o.placeholder = '127.0.0.1:9097';
		o = s.option(form.Value, 'secret', _('控制 API 密钥')); o.password = true;
		o = s.option(form.Flag, 'external_ui', _('启用内置面板 (zashboard)'));
		o = s.option(form.Value, 'test_url', _('测延迟 URL')); o.placeholder = 'https://www.gstatic.com/generate_204';

		o = s.option(form.ListValue, 'transparent_mode', _('透明代理模式'));
		o.value('tun', 'TUN (推荐，内核自管路由)');
		o.value('tproxy', 'TPROXY (TCP+UDP)');
		o.value('redir', 'REDIR (仅 TCP)');
		o.value('off', '关闭 (仅本地入站)');
		o = s.option(form.Flag, 'hijack_dnsmasq', _('dnsmasq 转发到内核 DNS'), _('LAN 的 DNS 经 dnsmasq 转发到 mihomo DNS，分流对无需配置的客户端生效'));

		o = s.option(form.Flag, 'geo_auto_update', _('自动更新 Geo'));
		o = s.option(form.Value, 'geo_update_interval', _('Geo 更新间隔 (小时)')); o.datatype = 'uinteger';
		o = s.option(form.Flag, 'geodata_mode', 'geodata-mode (使用 dat 而非 mmdb)');
		o = s.option(form.Value, 'geox_mmdb', 'geox-url · mmdb'); o.placeholder = 'https://…/country.mmdb';
		o = s.option(form.Value, 'geox_geosite', 'geox-url · geosite'); o.placeholder = 'https://…/geosite.dat';
		o = s.option(form.Value, 'geox_asn', 'geox-url · asn'); o.placeholder = 'https://…/GeoLite2-ASN.mmdb';

		o = s.option(form.Flag, 'watchdog', _('看门狗'), _('控制器健康检查连续失败自动重启内核'));
		o = s.option(form.Value, 'watchdog_interval', _('检查间隔 (秒)')); o.datatype = 'uinteger';

		/* ---------- TUN ---------- */
		s = m.section(form.NamedSection, 'tun', 'tun', _('TUN'));
		s.addremove = false;

		o = s.option(form.ListValue, 'stack', 'TUN 栈');
		o.value('mixed', 'mixed'); o.value('gvisor', 'gvisor'); o.value('system', 'system');
		o = s.option(form.Value, 'device', _('设备名')); o.placeholder = 'bettbox';
		o = s.option(form.Flag, 'auto_route', 'auto-route');
		o = s.option(form.Flag, 'auto_redirect', 'auto-redirect');
		o = s.option(form.Flag, 'strict_route', 'strict-route');
		o = s.option(form.Value, 'mtu', 'MTU'); o.datatype = 'uinteger'; o.placeholder = '9000';
		o = s.option(form.Value, 'dns_hijack', 'dns-hijack'); o.placeholder = 'any:53';

		/* ---------- DNS ---------- */
		s = m.section(form.NamedSection, 'dns', 'dns', _('DNS'));
		s.addremove = false;

		o = s.option(form.Flag, 'override', _('覆写 DNS 配置'), _('关闭则沿用订阅自带的 DNS 段'));
		o = s.option(form.Value, 'listen', _('DNS 监听')); o.placeholder = '0.0.0.0:1053';
		o = s.option(form.ListValue, 'enhanced_mode', _('增强模式'));
		o.value('fake-ip', 'fake-ip'); o.value('redir-host', 'redir-host');
		o = s.option(form.Value, 'fake_ip_range', 'fake-ip-range'); o.placeholder = '198.18.0.1/16';
		o = s.option(form.Flag, 'respect_rules', 'respect-rules (DNS 解析走代理规则)');
		o = s.option(form.Flag, 'ipv6', _('DNS IPv6 解析'));
		o = s.option(form.DynamicList, 'nameserver', 'nameserver');
		o = s.option(form.DynamicList, 'default_nameserver', 'default-nameserver (DoH 引导用 IP)');
		o = s.option(form.DynamicList, 'fallback', 'fallback');

		/* ---------- QUIC ---------- */
		s = m.section(form.NamedSection, 'quic', 'quic', _('QUIC'));
		s.addremove = false;

		o = s.option(form.Flag, 'block', _('禁用 QUIC'), _('注入与上游一致的 UDP:443 REJECT 前置规则'));
		o = s.option(form.Flag, 'exclude_china', _('国内站点不拦截'));

		/* ---------- 嗅探 ---------- */
		s = m.section(form.NamedSection, 'sniffer', 'sniffer', _('嗅探 (Sniffer)'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('启用流量嗅探'));
		o = s.option(form.Flag, 'override_destination', 'override-destination');

		/* ---------- NTP ---------- */
		s = m.section(form.NamedSection, 'ntp', 'ntp', _('NTP'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('启用 NTP 校时'));
		o = s.option(form.Value, 'server', _('服务器')); o.placeholder = 'time.apple.com';
		o = s.option(form.Value, 'port', _('端口')); o.datatype = 'port'; o.placeholder = '123';
		o = s.option(form.Value, 'interval', _('间隔 (分钟)')); o.datatype = 'uinteger';

		/* ---------- 实验选项 ---------- */
		s = m.section(form.NamedSection, 'experimental', 'experimental', _('实验选项'));
		s.addremove = false;

		o = s.option(form.Flag, 'quic_gso', 'quic-go-disable-gso');
		o = s.option(form.Flag, 'quic_ecn', 'quic-go-disable-ecn');

		/* 保存后热更新渲染 */
		m.on('apply', function () {
			if (uci.get('bettbox', 'config', 'enabled') == '1')
				return callApply();
			return Promise.resolve();
		});

		return m.render();
	}
});
