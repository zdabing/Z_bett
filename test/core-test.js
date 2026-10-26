'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

function coreFixture(options = {}) {
    const calls = [], timers = new Map();
    let timerId = 0;
    const runtime = {
        baseclass: { extend: value => value },
        rpc: { declare: spec => spec.method === 'get_status' ?
            async () => ({ controller: '127.0.0.1:9197', allow_lan: true, secret: 'test-key', ...options.status }) :
            async (...args) => { calls.push({ rpc: args }); return options.relay ? options.relay(...args) : { status: 200, data: {} }; } },
        window: { location: { hostname: options.hostname || '10.0.0.1', protocol: options.protocol || 'http:' },
            setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
            clearTimeout: id => timers.delete(id) },
        fetch: async (url, opt) => {
            calls.push({ url, opt });
            return options.fetch ? options.fetch(url, opt) : { status: 200, text: async () => '{"ok":true}' };
        },
        AbortController, TextDecoder, Date
    };
    const code = fs.readFileSync(path.join(root, 'luci-app-bettbox/htdocs/luci-static/resources/bettbox/core.js'), 'utf8');
    const client = new Function(...Object.keys(runtime), code)(...Object.values(runtime));
    return { client, calls, timers };
}

function backendFixture(options = {}) {
    const calls = [], files = new Map(), removed = [];
    let workspace = 0;
    const runtime = {
        access: () => true, lsdir: () => [], stat: () => ({ size: 1 }),
        popen: cmd => {
            calls.push(cmd);
            const temporary = cmd.includes('mktemp -d');
            const output = temporary ? '/tmp/bettbox-api.T' + (++workspace) : (options.output || '');
            return { read: () => output, close: () => temporary ? 0 : (options.code || 0) };
        },
        readfile: name => files.get(name) || '',
        unlink: name => { removed.push(name); files.delete(name); },
        writefile: () => options.writeFailure ? null : 10,
        cursor: () => ({ get: (config, sid, option) => {
            if (option === 'profile') return 'active';
            if (option === 'external_controller') return '127.0.0.1:9097';
            return null;
        }, delete() {}, commit() {}, foreach() {} }),
        system: cmd => {
            calls.push(cmd);
            const dir = '/tmp/bettbox-api.T' + workspace;
            if (cmd.includes('curl')) { files.set(dir + '/body', '{"ok":true}'); files.set(dir + '/code', '200'); }
            return 0;
        },
        sprintf: (fmt, ...args) => { let i = 0; return fmt.replace(/%([sdJ%])/g, (_, k) => k === '%' ? '%' : k === 'J' ? JSON.stringify(args[i++]) : String(args[i++])); },
        replace: (value, expression, replacement) => value.replace(expression, replacement),
        trim: value => value.trim(), split: (value, separator) => value.split(separator),
        length: value => value == null ? 0 : value.length, int: value => Number.parseInt(value, 10),
        match: (value, expression) => value.match(expression), uc: value => value.toUpperCase(),
        type: value => value == null ? 'null' : Number.isInteger(value) ? 'int' : typeof value,
        push: (items, value) => items.push(value), json: JSON.parse, substr: (value, start, size) => value.substr(start, size)
    };
    const code = fs.readFileSync(path.join(root, 'luci-app-bettbox/root/usr/share/rpcd/ucode/bettbox.uc'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/for\s*\((let \w+) in /g, 'for ($1 of ')
        .replace(/(\w+) in (\[[^\]\n]+\])/g, '$2.includes($1)');
    const backend = new Function(...Object.keys(runtime), code)(...Object.values(runtime)).bettbox;
    return { backend, calls, removed };
}

(async () => {
    let checks = 0;
    {
        const { client, calls } = coreFixture();
        await client.get('/version');
        assert.equal(calls[0].opt.headers.Authorization, 'Bearer test-key');
        assert.equal(calls[0].url, 'http://10.0.0.1:9197/version');
        checks++;
    }
    {
        const { client } = coreFixture({ fetch: async () => ({ status: 204, text: async () => '' }) });
        assert.equal((await client.put('/proxies/test', { name: 'DIRECT' })).status, 204);
        checks++;
    }
    {
        const { client, calls } = coreFixture({ fetch: async () => ({ status: 500, text: async () => '{"message":"reload failed"}' }) });
        await assert.rejects(client.put('/configs', {}), /reload failed/);
        assert.equal(calls.filter(call => call.rpc).length, 0);
        checks++;
    }
    {
        const { client, calls } = coreFixture({ protocol: 'https:' });
        await client.patch('/configs', { mode: 'rule' });
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].rpc, ['PATCH', '/configs', '{"mode":"rule"}']);
        checks++;
    }
    {
        const { client, calls } = coreFixture({ status: { allow_lan: false } });
        await client.get('/connections');
        assert.ok(calls[0].rpc);
        checks++;
    }
    {
        const { client, calls } = coreFixture({ fetch: async () => { throw new Error('network'); } });
        await client.get('/connections');
        assert.equal(calls.filter(call => call.rpc).length, 1);
        checks++;
    }
    {
        const { client, calls } = coreFixture({ fetch: async () => { throw new Error('network'); } });
        await assert.rejects(client.put('/configs', {}), /network/);
        assert.equal(calls.filter(call => call.rpc).length, 0, 'Do not replay ambiguous writes');
        checks++;
    }
    {
        const { client, calls } = coreFixture({ hostname: 'fd00::1', status: { controller: '[::]:9197' } });
        await client.get('/version');
        assert.equal(calls[0].url, 'http://[fd00::1]:9197/version');
        checks++;
    }
    {
        const { client, calls, timers } = coreFixture({ protocol: 'https:', relay: () => ({ status: 200, data: { memory: 64 } }) });
        const values = [];
        const stream = client.stream('/memory', item => values.push(item));
        await stream.promise;
        assert.deepEqual(values, [{ inuse: 64 }]);
        assert.equal(calls[0].rpc[1], '/connections', 'Never relay an endless endpoint');
        assert.equal(timers.size, 1);
        stream.stop();
        assert.equal(timers.size, 0);
        checks++;
    }
    {
        let complete, signal;
        const { client } = coreFixture({ fetch: async (url, options) => {
            signal = options.signal;
            return { status: 200, body: { getReader: () => ({
                read: () => new Promise(resolve => { complete = resolve; }),
                cancel: async () => { if (complete) complete({ done: true }); }
            }) } };
        } });
        const stream = client.stream('/traffic', () => {});
        await new Promise(resolve => setImmediate(resolve));
        stream.stop();
        await stream.promise;
        assert.equal(signal.aborted, true);
        checks++;
    }
    {
        const { backend, calls } = backendFixture();
        assert.equal(backend.apply.call().ok, true);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].includes('bettbox apply-service'));
        checks++;
    }
    for (const method of ['apply', 'service_action', 'update_profile', 'backup_call', 'dashboard']) {
        const { backend } = backendFixture({ code: 7, output: 'operation stopped' });
        const args = { action: method === 'backup_call' ? 'push' : method === 'dashboard' ? 'install' : 'stop', sid: 'inactive', all: '0' };
        assert.equal(backend[method].call({ args }).ok, false, method + ' must propagate failure');
        checks++;
    }
    {
        const { backend } = backendFixture({ output: 'success; description contains the word error' });
        assert.equal(backend.backup_call.call({ args: { action: 'list' } }).ok, true);
        checks++;
    }
    {
        const { backend, removed } = backendFixture();
        for (let n = 0; n < 2; n++)
            assert.equal(backend.api_proxy.call({ args: { method: 'PATCH', path: '/configs', body: '{}' } }).status, 200);
        assert.equal(new Set(removed).size, 4, 'Each request owns its temporary files');
        checks++;
    }
    {
        const { backend } = backendFixture();
        assert.equal(backend.del_profile.call({ args: { sid: 'active' } }).ok, false);
        checks++;
    }
    {
        const { backend } = backendFixture({ writeFailure: true });
        assert.equal(backend.save_script.call({ args: { name: 'example', content: 'function main(c){return c;}' } }).ok, false);
        checks++;
    }
    {
        const { backend, calls } = backendFixture();
        assert.equal(backend.api_proxy.call({ args: { method: 'GET', path: '/traffic' } }).status, 400);
        assert.equal(calls.length, 0, 'Streaming RPC must fail before spawning curl');
        checks++;
    }
    {
        const { backend } = backendFixture({ output: '{"bettbox":{"instances":{"core":{"running":false}}}}' });
        assert.equal(backend.get_status.call().running, false, 'Ignore other applications mihomo processes');
        checks++;
    }
    console.log('PASS: ' + checks + ' core transport and RPC regression checks');
})().catch(error => { console.error(error); process.exitCode = 1; });
