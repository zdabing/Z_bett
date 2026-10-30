#!/usr/bin/ucode
// SPDX-License-Identifier: GPL-3.0
import { readfile } from 'fs';
import { health_summary } from '/usr/libexec/bettbox/health-policy.uc';
let work = ARGV[0];
function parsed(path) { try { return json(readfile(path)); } catch(e) { return null; } }
let service = parsed(work + '/service.json');
let instance = service?.bettbox?.instances?.core;
let stopped = type(service) == 'object' && service.error == null && instance?.running !== true;
let layers = { process: { status: stopped ? 'stopped' : instance?.running === true ? 'ok' : 'unknown', scope: 'router' } };
for (let key in ['controller','core_dns','dnsmasq','upstream','explicit','router_access']) {
	let code = trim(readfile(work + '/' + key + '.code') ?? '3');
	let reason = trim(readfile(work + '/' + key + '.reason') ?? '');
	layers[key] = { status: stopped ? 'skipped' : code == '0' ? 'ok' : code == '1' ? 'fail' : code == '2' ? 'skipped' : 'unknown', scope: 'router' };
	if (length(reason)) layers[key].reason = reason;
	if (key in ['explicit','router_access']) {
		let raw = split(trim(readfile(work + '/' + key + '.http') ?? ''), ' ');
		layers[key].http_status = int(raw[0]);
		layers[key].latency_ms = (+raw[1] || 0) * 1000;
	}
}
let pid = instance?.pid;
let memory = {};
function metric(text, key) {
	for (let line in split(text, '\n')) {
		let fields = split(line, ':');
		if (fields[0] == key) { let m = match(fields[1] ?? '', /^[ \t]*([0-9]+)/); return m ? int(m[1]) : null; }
	}
	return null;
}
if (type(pid) == 'int' && pid > 0) {
	let status = readfile('/proc/' + pid + '/status') ?? '';
	let rollup = readfile('/proc/' + pid + '/smaps_rollup') ?? '';
	for (let key in ['VmRSS','VmHWM','VmSwap']) { let v = metric(status, key); memory[key] = v == null ? null : v * 1024; }
	let pss = metric(rollup, 'Pss'); memory.Pss = pss == null ? null : pss * 1024;
	memory.threads = metric(status, 'Threads');
}
let available = metric(readfile('/proc/meminfo') ?? '', 'MemAvailable');
memory.system_available = available == null ? null : available * 1024;
let target = trim(readfile(work + '/target') ?? '');
let summary = health_summary(layers);
if (ARGV[1] == 'summary') print(summary.issue);
else print(sprintf('%J', { checked_at: time(), pid: pid, config_stamp: trim(readfile(work + '/stamp') ?? ''), target: target, scope: 'router', lan_validation: 'not_tested', summary: summary, layers: layers, memory: memory }));
