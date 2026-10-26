'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
    '../luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/logs.js'), 'utf8');
const classify = new Function('rpc', source.replace('return view.extend({', 'return logLevel;\nvoid ({'))(
    { declare: () => () => {} });
const cases = [
    ['Sun Oct 25 11:35:12 2026 daemon.info mihomo[26530]: time="2026-10-25T11:35:12+08:00" level=warning msg="[TCP] error: dial tcp: i/o timeout"', 'warning'],
    ['daemon.info mihomo[1]: level=error msg="failure"', 'error'],
    ['daemon.info mihomo[1]: level="warning" msg="failure"', 'warning'],
    ['daemon.info mihomo[1]: level=info msg="error.example.com"', 'info'],
    ['daemon.info mihomo[1]: level=debug msg="error"', 'debug'],
    ['user.notice bettbox: subscription updated', 'info'],
    ['cron.err crond[1]: USER root cmd /usr/bin/bettbox cron', 'error'],
    ['daemon.warn bettbox: warning', 'warning'],
    ['daemon.crit bettbox: failure', 'error'],
    ['unstructured error message without severity', '']
];
for (const [line, expected] of cases) assert.equal(classify(line), expected, line);
assert.equal(classify(cases[0][0]) === 'error', false,
    'The screenshot warning must be excluded from an error-only view');
console.log('PASS: ' + cases.length + ' log severity cases and error-only filter');
