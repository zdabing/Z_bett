'use strict';
// SPDX-License-Identifier: GPL-3.0
// Decision-only module; external target failures never authorize a core restart.
export function health_summary(layers) {
	let failed = [], missing = [];
	for (let key in keys(layers)) {
		if (layers[key].status == 'fail') push(failed, key);
		if (layers[key].status == 'unknown') push(missing, key);
	}
	for (let key in ['controller','core_dns']) if (layers[key]?.status == 'skipped') push(missing, key);
	if (layers.process?.status == 'stopped') return { status: 'stopped', issue: 'service_stopped', action: 'none', message: '服务未启动' };
	if (layers.process?.status == 'unknown') return { status: 'unknown', issue: 'process_unknown', action: 'inspect_service', message: '暂时无法确认核心进程状态' };
	if (layers.controller?.status == 'fail') return { status: 'degraded', issue: 'controller_failed', action: 'confirm_controller', message: '核心进程存在，控制接口不可用；需复核接口配置与核心状态' };
	if (layers.core_dns?.status == 'fail') return { status: 'degraded', issue: 'core_dns_failed', action: 'inspect_dns', message: '核心 DNS 未返回有效地址；检查 DNS 配置、上游和网络' };
	if (layers.dnsmasq?.status == 'fail') return { status: 'degraded', issue: 'dnsmasq_failed', action: 'inspect_dnsmasq', message: 'dnsmasq 查询失败；先核对监听和转发链路' };
	if (layers.explicit?.status == 'fail') return { status: 'degraded', issue: 'explicit_failed', action: 'inspect_outbound', message: '显式代理访问失败；检查当前出口、认证和测试目标' };
	if (layers.router_access?.status == 'fail') return { status: 'degraded', issue: 'router_access_failed', action: 'inspect_router_path', message: '路由器本机访问失败；此结果不代表局域网设备的透明代理状态' };
	if (length(failed)) return { status: 'degraded', issue: 'upstream_failed', action: 'inspect_upstream', message: '上游 DNS 查询失败；需核对实际路由路径' };
	if (length(missing)) return { status: 'partial', issue: 'checks_unavailable', action: 'inspect_checks', message: '部分检测无法完成，请查看各项结果' };
	return { status: 'ok', issue: 'none', action: 'none', message: '已完成的链路检测通过' };
};
