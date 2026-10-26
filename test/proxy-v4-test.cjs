'use strict';
// Actual production view + UI + CSS, with a controlled controller/diagnostic transport.
// Requires Playwright; no router, credentials or external network access.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const resources = path.join(root, 'luci-app-bettbox/htdocs/luci-static/resources');
const source = fs.readFileSync(path.join(resources, 'view/bettbox/proxies.js'), 'utf8');
const shared = fs.readFileSync(path.join(resources, 'bettbox/ui.js'), 'utf8');
const css = fs.readFileSync(path.join(resources, 'bettbox/ui.css'), 'utf8');
const out = path.join(root, 'dist/implementation');
const longName = '节点 "引号" <测试> ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

(async () => {
    fs.mkdirSync(out, { recursive: true });
    const browser = await chromium.launch({ headless: true,
        ...(process.env.BETTBOX_BROWSER ? { executablePath: process.env.BETTBOX_BROWSER } : {}) });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="view"></div><div id="modal"></div></body></html>' }));
    try {
        await page.goto('http://fixture.test/');
        if (process.env.BETTBOX_THEME_CSS) await page.addStyleTag({ path: process.env.BETTBOX_THEME_CSS });
        await page.addStyleTag({ content: 'body{margin:0;font:14px "Microsoft YaHei",sans-serif}.panel{padding:28px}' });
        await page.addStyleTag({ content: css });
        await page.evaluate(({ source, shared, longName }) => {
            function E(tag, attributes = {}, content = []) {
                const el = document.createElement(tag);
                for (const [key, value] of Object.entries(attributes)) {
                    if (value == null) continue;
                    if (typeof value === 'function') el.addEventListener(key, value);
                    else el.setAttribute(key, String(value));
                }
                for (const child of [content].flat(Infinity)) if (child != null)
                    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
                return el;
            }
            const rpc = { declare: () => async () => ({}) };
            const L = { url: (...args) => '/' + args.join('/'), resource: () => 'data:text/css,/*fixture*/' };
            const ui = { addNotification: (_, el) => window.state.errors.push(el.textContent),
                showModal: (title, children) => document.querySelector('#modal').replaceChildren(...children),
                hideModal: () => document.querySelector('#modal').replaceChildren() };
            const UI = new Function('baseclass', 'ui', 'rpc', 'E', 'L', shared)({ extend: v => v }, ui, rpc, E, L);
            let state;
            const seed = {
                GLOBAL: { all: ['默认代理', '自动选择', '流媒体', '隐藏组', '循环组'] },
                '默认代理': { type: 'Selector', all: ['节点 A', '自动选择', 'DIRECT', 'REJECT'], now: '自动选择' },
                '自动选择': { type: 'URLTest', all: ['节点 A', '节点 B', longName], now: '节点 A' },
                '流媒体': { type: 'Selector', all: ['节点 B', 'DIRECT', 'PASS'], now: '节点 B' },
                '隐藏组': { type: 'Selector', hidden: true, all: ['节点 A'], now: '节点 A' },
                '循环组': { type: 'Selector', all: ['循环 A'], now: '循环 A' },
                '循环 A': { type: 'Selector', hidden: true, all: ['循环 B'], now: '循环 B' },
                '循环 B': { type: 'Selector', hidden: true, all: ['循环 A'], now: '循环 A' },
                '追加组': { type: 'Selector', all: ['隐藏组', '节点 B'], now: '隐藏组' },
                '节点 A': { type: 'VLESS', history: [{ delay: 185 }] },
                '节点 B': { type: 'Trojan', history: [{ delay: 80 }] },
                [longName]: { type: 'Shadowsocks' },
                DIRECT: { type: 'Direct', history: [{ delay: 13 }] }, REJECT: { type: 'Reject' }, PASS: { type: 'Pass' }
            };
            const Core = {
                get: async () => {
                    state.gets++;
                    if (state.deferGet) {
                        state.deferGet = false;
                        const old = structuredClone(state.data);
                        return new Promise(resolve => { state.releaseGet = () => resolve({ data: { proxies: old } }); });
                    }
                    if (state.failGet) throw Object.assign(new Error('fixture connection failure'), { httpStatus: state.failGet });
                    return { data: { proxies: structuredClone(state.data) } };
                },
                put: async (url, body) => {
                    state.puts.push({ url, body });
                    if (state.failPut) throw new Error('fixture selection failure');
                    state.data[decodeURIComponent(url.split('/').pop())].now = body.name;
                    return { status: 204 };
                }
            };
            UI.job = (kind, args) => new Promise((resolve, reject) => {
                const job = { kind, target: decodeURIComponent(args[0]), url: decodeURIComponent(args[1]), done: false };
                state.jobs.push(job); state.active++; state.maxActive = Math.max(state.maxActive, state.active);
                job.finish = (error, delay = 77) => {
                    if (job.done) return;
                    job.done = true; state.active--;
                    if (error) reject(new Error(error)); else resolve({ text: JSON.stringify({ delay }) });
                };
            });
            const view = new Function('view', 'poll', 'uci', 'ui', 'Core', 'UI', 'E', 'L', source)(
                { extend: v => v }, { add: fn => state.poll = fn }, { get: () => '', load: async () => {} }, ui, Core, UI, E, L);
            window.resetFixture = ({ keepStorage = false, failure = 0, empty = false } = {}) => {
                if (!keepStorage) localStorage.clear();
                state = window.state = { data: empty ? {} : structuredClone(seed), gets: 0, puts: [], jobs: [],
                    active: 0, maxActive: 0, errors: [], failGet: failure };
                document.querySelector('#view').replaceChildren(view.render());
            };
            window.finishJobs = error => state.jobs.filter(j => !j.done).forEach(j => j.finish(error));
            window.resetFixture();
        }, { source, shared, longName });
        const reset = async options => {
            await page.evaluate(options => window.resetFixture(options), options || {});
            await page.waitForFunction(() => !document.querySelector('.v4-loading'));
        };
        const testNode = name => page.locator('[data-test-node=' + JSON.stringify(name) + ']').first();
        const choose = (name, node) => page.locator('[data-select-group=' + JSON.stringify(name) + '][data-node=' + JSON.stringify(node) + ']');
        const waitData = () => page.waitForSelector('[data-group-name="默认代理"]');
        const all = () => page.getByRole('button', { name: '全部测速', exact: true });
        const refresh = () => page.getByRole('button', { name: '刷新', exact: true });
        const drain = async () => {
            for (let i = 0; i < 12; i++) {
                await page.evaluate(() => window.finishJobs());
                await page.waitForTimeout(10);
                if (!await page.evaluate(() => state.active)) break;
            }
            await page.waitForFunction(() => !document.querySelector('.v4-group-test.testing'));
        };
        await waitData();
        assert.deepEqual(await page.locator('[data-expand-group]').evaluateAll(nodes => nodes.map(n => n.dataset.expandGroup).sort()), ['默认代理', '自动选择', '流媒体', '循环组', '追加组'].sort());
        assert.equal(await page.locator('.v4-group.open').count(), 2);
        assert.equal(await page.locator('[data-group-name="默认代理"] .v4-current').getAttribute('title'), '自动选择 → 节点 A');
        assert.equal(await page.locator('[data-group-name="循环组"] .v4-current').getAttribute('title'), '策略组出口形成循环');
        assert.equal(await page.locator('测试').count(), 0); // untrusted node text never becomes markup

        for (const width of [320, 360, 390, 430, 768, 1024, 1600]) {
            await page.setViewportSize({ width, height: 1000 });
            const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth,
                columns: getComputedStyle(document.querySelector('.v4-groups')).gridTemplateColumns.split(' ').length,
                nodes: getComputedStyle(document.querySelector('.v4-node-grid')).gridTemplateColumns.split(' ').length,
                cards: [...document.querySelectorAll('.v4-group')].map(el => ({ name: el.dataset.groupName, top: el.getBoundingClientRect().top })),
                overflowing: [...document.querySelectorAll('.v4-group *')].some(el => {
                    const card = el.closest('.v4-group').getBoundingClientRect();
                    return el.getBoundingClientRect().right > card.right + 1;
                }) }));
            assert.ok(size.scroll <= width + 1, 'overflow at ' + width);
            assert.equal(size.overflowing, false, 'card child overflow at ' + width);
            if (width < 600) assert.equal(size.nodes, 2);
            if (width >= 900) assert.equal(size.columns, 2);
            else assert.deepEqual(size.cards.sort((a, b) => a.top - b.top).map(c => c.name), ['默认代理', '自动选择', '流媒体', '循环组', '追加组']);
            if ([390, 1600].includes(width)) await page.screenshot({ path: path.join(out, 'proxies-v4-' + (width === 390 ? 'mobile' : 'desktop') + '.png'), fullPage: true });
        }
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        await page.waitForFunction(() => ['.v4-control-actions .btn', '.v4-group-test'].every(selector =>
            getComputedStyle(document.querySelector(selector)).backgroundColor === 'rgba(0, 0, 0, 0)'));
        assert.equal(await page.locator('.v4-control-actions .btn').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
        assert.equal(await page.locator('.v4-group-test').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
        await page.waitForTimeout(180); // allow the shared button palette transition to finish before capture
        await page.screenshot({ path: path.join(out, 'proxies-v4-dark-mobile.png'), fullPage: true });
        await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

        await page.locator('[data-expand-group="默认代理"]').click();
        assert.equal(await page.locator('[data-group-name="默认代理"] .v4-current').count(), 1);
        await reset({ keepStorage: true });
        assert.equal(await page.locator('.v4-group.open').count(), 1, 'expanded state survives view reconstruction');
        await refresh().click();
        assert.equal(await page.locator('.v4-group.open').count(), 1, 'snapshot refresh keeps collapsed state');
        await page.getByRole('button', { name: '全部收起', exact: true }).click();
        assert.equal(await page.locator('.v4-group.open').count(), 0);
        await page.getByRole('button', { name: '全部展开', exact: true }).click();
        assert.equal(await page.locator('.v4-group.open').count(), 5);

        await page.getByRole('searchbox').fill('节点 B');
        assert.equal(await page.locator('.v4-group').count(), 3);
        assert.deepEqual(await page.locator('[data-proxy-name]').evaluateAll(nodes => [...new Set(nodes.map(n => n.dataset.proxyName))]), ['节点 B']);
        await page.getByRole('searchbox').fill('流媒体');
        assert.equal(await page.locator('[data-proxy-name]').count(), 3, 'matching group displays its complete membership');
        await page.getByRole('searchbox').fill('missing');
        assert.equal(await page.locator('.v4-no-data').textContent(), '没有匹配的策略组或节点');
        await page.getByRole('searchbox').fill('');
        await page.getByRole('combobox', { name: '节点排序' }).selectOption('delay');
        assert.equal(await page.locator('[data-group-name="自动选择"] [data-proxy-name]').first().getAttribute('data-proxy-name'), '节点 B');
        await page.getByRole('combobox', { name: '节点排序' }).selectOption('name');
        await page.getByRole('button', { name: '切换节点卡片/列表视图' }).click();
        assert.equal(await page.locator('.v4-node-grid.list-view').count(), 5);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await reset();

        await choose('默认代理', 'DIRECT').click();
        await page.waitForFunction(() => document.querySelector('[data-select-group="默认代理"][data-node="DIRECT"]').getAttribute('aria-pressed') === 'true');
        assert.deepEqual(await page.evaluate(() => state.puts), [{ url: '/proxies/' + encodeURIComponent('默认代理'), body: { name: 'DIRECT' } }]);
        await page.evaluate(() => { state.failPut = true; });
        await choose('默认代理', '节点 A').click();
        await page.waitForFunction(() => state.errors.length === 1);
        assert.equal(await choose('默认代理', 'DIRECT').getAttribute('aria-pressed'), 'true');
        await page.evaluate(() => { state.failPut = false; state.deferGet = true; });
        await refresh().click();
        await page.waitForFunction(() => state.releaseGet);
        await choose('默认代理', '节点 A').click();
        await page.waitForFunction(() => state.data['默认代理'].now === '节点 A');
        await page.evaluate(() => state.releaseGet());
        await page.waitForFunction(() => document.querySelector('[data-select-group="默认代理"][data-node="节点 A"]').getAttribute('aria-pressed') === 'true');
        assert.equal(await page.locator('[data-group-name="默认代理"] .v4-current').getAttribute('title'), '节点 A');
        await reset();

        await testNode('节点 A').click();
        await page.waitForFunction(() => state.jobs.length === 1);
        assert.equal(await page.locator('[data-test-node="自动选择"]:enabled').count(), 1, 'an unrequested alias must not spin');
        await page.locator('[data-proxy-name="节点 B"]').first().click({ button: 'right' });
        await page.waitForFunction(() => state.jobs.length === 2);
        assert.equal(await page.evaluate(() => state.puts.length), 0, 'test click and right-click never select');
        await page.evaluate(() => state.jobs[0].finish('504 timeout'));
        await page.waitForSelector('[data-test-node="节点 A"].timeout');
        await testNode('节点 A').click();
        await page.waitForFunction(() => state.jobs.length === 3);
        await drain();
        assert.match(await testNode('节点 A').textContent(), /77 ms/);
        assert.equal(await choose('默认代理', '自动选择').getAttribute('aria-pressed'), 'true');

        await reset();
        await page.locator('[data-test-group="自动选择"]').click();
        await page.waitForFunction(() => state.jobs.length === 2);
        await all().click();
        assert.equal(await page.locator('.v4-latency.queued').count() > 0, true);
        await drain();
        await page.waitForFunction(() => document.querySelector('.heading-actions .primary').textContent.includes('全部测速'));
        assert.equal(await all().isEnabled(), true);
        const queueState = await page.evaluate(() => ({ max: state.maxActive, targets: state.jobs.map(j => j.target), puts: state.puts.length }));
        assert.equal(queueState.max, 2, 'one shared two-job queue across all groups');
        assert.deepEqual(queueState.targets.sort(), ['节点 A', '节点 B', longName, 'DIRECT'].sort(), 'aliases deduplicate and rejects/cycles are excluded');
        assert.equal(queueState.puts, 0);

        await page.getByRole('button', { name: '测试设置', exact: true }).click();
        await page.getByRole('textbox', { name: '测试地址', exact: true }).fill('javascript:alert(1)');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        assert.equal(await page.evaluate(() => state.errors.length), 1);
        await page.getByRole('textbox', { name: '测试地址', exact: true }).fill('https://example.test/probe?one=1&two=2');
        await page.getByRole('button', { name: '保存', exact: true }).click();
        assert.match(await testNode(longName).textContent(), /测试/, 'results are scoped to test URL');
        await testNode(longName).click();
        await page.waitForFunction(() => state.jobs.length === 5);
        assert.equal(await page.evaluate(() => state.jobs[4].url), 'https://example.test/probe?one=1&two=2');
        await drain();

        await page.evaluate(() => { state.failGet = 403; });
        await refresh().click();
        await page.waitForSelector('.v4-connection-state:not([hidden])');
        assert.match(await page.locator('.v4-connection-state').textContent(), /控制器认证失败/);
        assert.equal(await page.locator('[data-group-name]').count(), 5, 'offline keeps the last snapshot');
        assert.equal(await page.locator('[data-select-group]:enabled,[data-test-node]:enabled,[data-test-group]:enabled').count(), 0);
        assert.equal(await all().isDisabled(), true);
        await page.evaluate(() => { state.failGet = 0; });
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await page.waitForSelector('.v4-connection-state[hidden]', { state: 'attached' });
        assert.equal(await all().isEnabled(), true);
        await reset({ failure: 504 });
        assert.match(await page.locator('.v4-connection-state').textContent(), /控制器连接超时/);
        assert.equal(await page.locator('[data-group-name]').count(), 0);
        assert.ok((await page.locator('.v4-no-data').boundingBox()).height < 150, 'initial failure remains compact');
        await reset({ empty: true });
        assert.match(await page.locator('.v4-no-data').textContent(), /暂无策略组/);
        assert.equal(await page.locator('.v4-connection-state').isHidden(), true);
        assert.deepEqual(errors, []);
        console.log('PASS: production V4 proxy UI, 7 widths, persistence/search/sort/list, selection races, independent tests, shared queue/dedup, URL validation and offline recovery');
    } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
