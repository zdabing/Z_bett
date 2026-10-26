'use strict';
// Run the production LuCI view with deferred diagnostic responses. No router or
// network is used: lifecycle races and request counts are deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
    '../luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/overview.js'), 'utf8');

class Element {
    constructor(tag, attrs = {}, content = []) {
        this.tag = tag;
        this.attrs = attrs;
        this.dataset = {};
        this.listeners = {};
        this.children = [];
        for (const [key, value] of Object.entries(attrs)) {
            if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
        }
        this.replaceChildren(...[content].flat(Infinity));
    }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    get className() { return this.attrs.class || ''; }
    set className(value) { this.attrs.class = value; }
    get classList() {
        return {
            add: name => this.classList.toggle(name, true),
            remove: name => this.classList.toggle(name, false),
            toggle: (name, on) => {
                const names = new Set(this.className.split(' ').filter(Boolean));
                if (on === undefined ? !names.has(name) : on) names.add(name);
                else names.delete(name);
                this.className = [...names].join(' ');
            }
        };
    }
    set textContent(value) { this.replaceChildren(String(value)); }
    get textContent() { return this.children.map(c => c instanceof Element ? c.textContent : String(c)).join(''); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children.flat(Infinity).filter(x => x != null); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
}
const E = (tag, attrs, children) => new Element(tag, attrs || {}, children || []);
function find(root, predicate) {
    if (!(root instanceof Element)) return null;
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = find(child, predicate);
        if (match) return match;
    }
    return null;
}
const hasClass = name => node => node.className.split(' ').includes(name);
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(running) {
    let clock = 100000;
    const status = { enabled: running, running, mode: 'rule' };
    const jobs = [], polls = [];
    class Clock extends Date { static now() { return clock; } }
    const rpc = { declare: spec => async () => spec.method === 'get_status' ? { ...status } : { ok: true } };
    const UI = {
        tag: text => E('span', {}, text), icon: () => E('svg'),
        bytes: value => String(value || 0), speed: value => String(value),
        button: (label, handler) => {
            const node = E('button', {}, label);
            node.click = () => handler();
            return node;
        },
        page: (id, title, actions, content) => E('main', {}, [actions, content]),
        panel: (title, icon, content) => E('section', {}, content),
        checked: result => { assert.equal(result.ok, true); return result; },
        error: err => { throw err; },
        job: (kind, args) => new Promise((resolve, reject) => jobs.push({ kind, via: args[0], resolve, reject }))
    };
    const view = new Function('view', 'rpc', 'poll', 'uci', 'ui', 'Core', 'UI', 'E', 'L', 'document', 'Date', source)(
        { extend: value => value }, rpc, { add: callback => polls.push(callback) },
        { load: async () => {}, get: () => '', set() {}, save: async () => {} }, {},
        { get: async () => ({ data: { connections: [], proxies: {} } }) }, UI, E,
        { url: () => '/' },
        { createElementNS: (namespace, tag) => E(tag), createTextNode: text => text }, Clock);
    const root = view.render([{ ...status }, { lan: {}, wan: {} }]);
    const grid = find(root, hasClass('exit-grid'));
    const parts = via => {
        const block = grid.children[via === 'direct' ? 0 : 1];
        return { ip: find(block, hasClass('ip-address')), state: find(block, hasClass('muted')) };
    };
    return {
        jobs, parts, status,
        retry: () => find(root, el => el.tag === 'button' && el.textContent === '检测').click(),
        poll: async () => { clock += 11000; await polls[0](); await flush(); }
    };
}
function finish(job, ip) {
    job.resolve({ text: JSON.stringify({ ip, country: 'CN', organization_name: 'fixture ISP' }) });
}

(async () => {
    let checks = 0;
    {
        const f = fixture(true);
        await flush();
        assert.deepEqual(f.jobs.map(j => j.via), ['direct', 'proxy']); checks++;
        assert.equal(f.parts('direct').ip.textContent, '检测中…'); checks++;
        assert.equal(f.parts('proxy').ip.textContent, '检测中…'); checks++;
        const pending = f.retry();
        await f.poll();
        assert.equal(f.jobs.length, 2, 'in-flight checks are shared by refresh and button'); checks++;
        finish(f.jobs[0], '203.0.113.1'); finish(f.jobs[1], '198.51.100.1');
        await pending; await flush();
        assert.equal(f.parts('direct').ip.textContent, '203.0.113.1'); checks++;
        assert.equal(f.parts('proxy').ip.textContent, '198.51.100.1'); checks++;
        await f.poll(); await f.poll();
        assert.equal(f.jobs.length, 2, 'ordinary telemetry polls do not query exits'); checks++;
        const next = f.retry(); await flush();
        assert.equal(f.jobs.length, 4, 'manual refresh starts new checks after completion'); checks++;
        finish(f.jobs[2], '203.0.113.2'); finish(f.jobs[3], '198.51.100.2'); await next;
    }
    {
        const f = fixture(false); await flush();
        assert.deepEqual(f.jobs.map(j => j.via), ['direct'], 'direct query is independent of proxy service'); checks++;
        assert.equal(f.parts('proxy').ip.textContent, '未启用'); checks++;
        finish(f.jobs[0], '203.0.113.3'); await flush();
        f.status.running = f.status.enabled = true; await f.poll();
        assert.equal(f.jobs[1].via, 'proxy', 'starting the core queries proxy automatically'); checks++;
        f.status.running = f.status.enabled = false; await f.poll();
        finish(f.jobs[1], '198.51.100.3'); await flush();
        assert.equal(f.parts('proxy').ip.textContent, '未启用', 'late response after stop must be ignored'); checks++;
        assert.equal(f.parts('direct').ip.textContent, '203.0.113.3'); checks++;
        f.status.running = f.status.enabled = true; await f.poll();
        assert.equal(f.jobs.length, 3); checks++;
        finish(f.jobs[2], '198.51.100.4'); await flush();
        assert.equal(f.parts('proxy').ip.textContent, '198.51.100.4'); checks++;
    }
    {
        const f = fixture(true); await flush();
        finish(f.jobs[0], '203.0.113.5');
        f.status.running = false; await f.poll();
        f.status.running = true; await f.poll();
        assert.equal(f.jobs.length, 2, 'restart waits for the bounded in-flight check'); checks++;
        finish(f.jobs[1], '198.51.100.5'); await flush();
        assert.equal(f.jobs.length, 3, 'restart schedules a fresh proxy request'); checks++;
        assert.notEqual(f.parts('proxy').ip.textContent, '198.51.100.5'); checks++;
        finish(f.jobs[2], '198.51.100.6'); await flush();
        assert.equal(f.parts('proxy').ip.textContent, '198.51.100.6'); checks++;
        f.status.mode = 'global'; await f.poll();
        assert.equal(f.jobs.length, 4, 'mode changes refresh the proxy result'); checks++;
        finish(f.jobs[3], '198.51.100.7'); await flush();
    }
    {
        const f = fixture(true); await flush();
        f.jobs[0].reject(new Error('lookup failed')); finish(f.jobs[1], '198.51.100.8'); await flush();
        assert.equal(f.parts('direct').state.textContent, '检测失败'); checks++;
        assert.equal(f.parts('proxy').ip.textContent, '198.51.100.8', 'failure in one column does not hide the other'); checks++;
        const retry = f.retry(); await flush();
        finish(f.jobs[2], '203.0.113.8'); finish(f.jobs[3], '198.51.100.9'); await retry;
        assert.equal(f.parts('direct').ip.textContent, '203.0.113.8'); checks++;
    }
    console.log('PASS: ' + checks + ' overview automatic exit checks');
})().catch(err => { console.error(err); process.exit(1); });
