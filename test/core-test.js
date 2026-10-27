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
    const calls = [], files = new Map([['/usr/libexec/bettbox/diagnostic.uc','// worker fixture']]), removed = [], locks = new Set();
    let workspace = 0;
    const runtime = {
        access: name => name.startsWith('/var/run/bettbox-service') || name.includes('bettbox-job.') ? files.has(name) : true,
        lsdir: () => [], stat: name => locks.has(name) ? {mtime:10000} : null, time: () => 10000,
        popen: cmd => {
            calls.push(cmd);
            const temporary = cmd.includes('mktemp -d');
            const output = temporary ? '/tmp/' + (cmd.includes('bettbox-job.') ? 'bettbox-job.T' : 'bettbox-api.T') + (++workspace) : (options.output || '');
            return { read: () => output, close: () => temporary ? 0 : (options.code || 0) };
        },
        readfile: name => files.get(name) || '',
        unlink: name => { removed.push(name); files.delete(name); },
        writefile: (name, value) => { if(options.writeFailure)return null; files.set(name,value); return value.length; },
        cursor: () => ({ get: (config, sid, option) => {
            if (option === 'profile') return 'active';
            if (option === 'external_controller') return '127.0.0.1:9097';
            return null;
        }, delete() {}, commit() {}, foreach() {} }),
        system: cmd => {
            calls.push(cmd);
            if (cmd.includes('bettbox-service.lock') && cmd.includes('mkdir')) {
                if(options.serviceBusy||locks.has('/var/run/bettbox-service.lock'))return 1;
                locks.add('/var/run/bettbox-service.lock'); return 0;
            }
            if(cmd.includes('bettbox-service.lock') && cmd.includes('rmdir')) {locks.delete('/var/run/bettbox-service.lock'); return 0;}
            if (cmd.includes('diagnostic.uc')) return options.launchFailure ? 1 : 0;
            if (cmd.includes('ubus -t 5 call service set')) return options.launchFailure ? 1 : 0;
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
    return { backend, calls, removed, files };
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
        assert.ok(calls.some(cmd=>cmd.includes('timeout 600 ucode')));
        assert.ok(!calls.some(cmd=>cmd.includes('timeout 600') && cmd.includes('ulimit -f')),'service must be allowed to write full config and Geo files');
        assert.ok(!calls.some(cmd=>cmd.includes('timeout 55 sh') && cmd.includes('apply-service')));
        checks++;
    }
    for (const method of ['update_profile', 'backup_call', 'dashboard']) {
        const { backend } = backendFixture({ code: 7, output: 'operation stopped' });
        const args = { action: method === 'backup_call' ? 'push' : method === 'dashboard' ? 'install' : 'stop', sid: 'inactive', all: '0' };
        assert.equal(backend[method].call({ args }).ok, false, method + ' must propagate failure');
        checks++;
    }
    for (const method of ['apply','service_action','core_update','package_update']) {
        const { backend } = backendFixture({launchFailure:true});
        assert.equal(backend[method].call({args:{action:method==='core_update'?'update':'stop'}}).ok,false,'job launch failure is reported'); checks++;
        const busy = backendFixture({serviceBusy:true});
        assert.equal(busy.backend[method].call({args:{action:method==='core_update'?'update':'start'}}).ok,false,'a concurrent transition is rejected'); checks++;
    }
    {
        const { backend, calls } = backendFixture();
        assert.equal(backend.diagnostic_start.call({args:{kind:'service',args_json:'["stop"]'}}).ok,false,'read-only diagnostic API cannot control services');
        assert.equal(calls.length,0); checks++;
    }
    {
        const { backend,calls }=backendFixture();
        for(const kind of ['core','core-check','package','package-check'])assert.equal(backend.diagnostic_start.call({args:{kind,args_json:'["update"]'}}).ok,false);
        for(const action of ['check','update; reboot','start'])assert.equal(backend.core_update.call({args:{action}}).ok,false);
        assert.equal(calls.length,0,'read-only diagnostics and invalid actions cannot launch core mutations'); checks++;
    }
    for(const action of ['update','rollback']){
        const { backend,calls,files }=backendFixture();
        const result=backend.core_update.call({args:{action}});
        assert.equal(result.ok,true);assert.equal(result.timeout_ms,1230000);
        assert.deepEqual(JSON.parse(files.get('/tmp/'+result.id+'/request')),{kind:'core',args:[action]});
        assert.ok(calls.some(cmd=>cmd.includes('timeout 1200 ucode')&&!cmd.includes('ulimit -f')));
        assert.equal(backend.service_action.call({args:{action:'stop'}}).ok,false,'core update excludes simultaneous UI service actions');
        files.set('/tmp/'+result.id+'/code','0');
        assert.equal(backend.service_action.call({args:{action:'stop'}}).ok,true,'completion permits the next action');checks++;
    }
    {
        const {backend,calls,files}=backendFixture();
        const result=backend.core_check.call();assert.equal(result.ok,true);assert.equal(result.timeout_ms,190000);
        assert.deepEqual(JSON.parse(files.get('/tmp/'+result.id+'/request')),{kind:'core-check',args:[]});
        assert.ok(calls.some(cmd=>cmd.includes('timeout 160 ucode')&&cmd.includes('ulimit -f')));
        assert.ok(!calls.some(cmd=>cmd.includes('bettbox-service.lock')),'version check does not block service actions');checks++;
    }
    {
        const value={ok:true,current:'v1.19.33',source:'managed'};
        assert.deepEqual(backendFixture({output:JSON.stringify(value)}).backend.core_info.call(),value);
        assert.equal(backendFixture({output:'invalid'}).backend.core_info.call().ok,false);
        assert.equal(backendFixture({output:'command failed',code:1}).backend.core_info.call().ok,false);checks++;
    }
    {
        const {backend,calls,files}=backendFixture();
        const result=backend.package_update.call();
        assert.equal(result.ok,true);assert.equal(result.timeout_ms,2430000);assert.equal(result.reconnect,true);
        assert.deepEqual(JSON.parse(files.get('/tmp/'+result.id+'/request')),{kind:'package',args:['update']});
        assert.match(files.get('/tmp/'+result.id+'/runner.sh'),/timeout 2400 ucode/);
        assert.ok(!files.get('/tmp/'+result.id+'/runner.sh').includes('ulimit -f'));
        assert.equal(files.get('/tmp/'+result.id+'/worker.uc'),'// worker fixture');
        assert.ok(calls.some(cmd=>cmd.includes('ubus -t 5 call service set')&&cmd.includes('bettbox-package-update')));
        assert.equal(backend.core_update.call({args:{action:'update'}}).ok,false);
        assert.equal(backend.service_action.call({args:{action:'stop'}}).ok,false);
        files.set('/tmp/'+result.id+'/code','0');
        assert.equal(backend.service_action.call({args:{action:'stop'}}).ok,true);checks++;
    }
    {
        const {backend,files}=backendFixture();const result=backend.package_check.call();
        assert.equal(result.timeout_ms,190000);
        assert.deepEqual(JSON.parse(files.get('/tmp/'+result.id+'/request')),{kind:'package-check',args:[]});checks++;
    }
    {
        const value={ok:true,current:{bettbox:{version:'1.19.33-r4'}}};
        assert.deepEqual(backendFixture({output:JSON.stringify(value)}).backend.package_info.call(),value);
        assert.equal(backendFixture({output:'invalid'}).backend.package_info.call().ok,false);checks++;
    }
    {
        const acl=JSON.parse(fs.readFileSync(path.join(root,'luci-app-bettbox/root/usr/share/rpcd/acl.d/luci-app-bettbox.json'),'utf8'))['luci-app-bettbox'];
        assert.ok(acl.read.ubus.bettbox.includes('core_info')&&acl.read.ubus.bettbox.includes('core_check'));
        assert.ok(!acl.read.ubus.bettbox.includes('core_update'));
        assert.ok(acl.write.ubus.bettbox.includes('core_update'));checks++;
        assert.ok(acl.read.ubus.bettbox.includes('package_info')&&acl.read.ubus.bettbox.includes('package_check'));
        assert.ok(!acl.read.ubus.bettbox.includes('package_update')&&acl.write.ubus.bettbox.includes('package_update'));checks++;
    }
    {
        const { backend, files } = backendFixture();
        const start=backend.service_action.call({args:{action:'start'}});
        assert.equal(start.ok,true);
        assert.equal(backend.service_action.call({args:{action:'stop'}}).ok,false);
        assert.equal(backend.diagnostic_status.call({args:{id:start.id}}).done,false);
        files.set('/tmp/'+start.id+'/code','1'); files.set('/tmp/'+start.id+'/output','core startup failed');
        const failed=backend.diagnostic_status.call({args:{id:start.id}});
        assert.equal(failed.ok,false); assert.match(failed.text,/startup failed/);
        assert.equal(backend.service_action.call({args:{action:'stop'}}).ok,true,'completed failure releases admission lock for retry'); checks++;
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
