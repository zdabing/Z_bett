'use strict';
// Verify subscription icon rendering in the real LuCI view, without a router.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = path.join(__dirname, '../luci-app-bettbox/htdocs/luci-static/resources');
const source = fs.readFileSync(path.join(base, 'view/bettbox/proxies.js'), 'utf8');
const shared = fs.readFileSync(path.join(base, 'bettbox/ui.js'), 'utf8');
const css = fs.readFileSync(path.join(base, 'bettbox/ui.css'), 'utf8');
const image = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="red"/></svg>';

(async () => {
    const browser = await chromium.launch({ headless: true,
        ...(process.env.BETTBOX_BROWSER ? { executablePath: process.env.BETTBOX_BROWSER } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route('http://fixture.test/**', route => route.fulfill({
        contentType: route.request().url().endsWith('.svg') ? 'image/svg+xml' : 'text/html',
        body: route.request().url().endsWith('.svg') ? image : '<!doctype html><html><body><div id="view"></div></body></html>'
    }));
    await page.route('https://icons.example.test/**', route => route.fulfill({
        status: route.request().url().includes('broken') ? 404 : 200,
        contentType: 'image/svg+xml', body: route.request().url().includes('broken') ? 'invalid image' : image
    }));
    try {
        await page.goto('http://fixture.test/');
        await page.addStyleTag({ content: css });
        await page.evaluate(({ source, shared, image }) => {
            function E(tag, attributes = {}, children = []) {
                const el = document.createElement(tag);
                for (const [key, value] of Object.entries(attributes)) {
                    if (value == null) continue;
                    if (typeof value === 'function') el.addEventListener(key, value);
                    else el.setAttribute(key, String(value));
                }
                for (const child of [children].flat(Infinity)) {
                    if (child != null) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
                }
                return el;
            }
            const rpc = { declare: () => async () => ({}) };
            const L = { url: () => '#', resource: () => 'data:text/css,/*fixture*/' };
            const ui = { addNotification() {}, showModal() {}, hideModal() {} };
            const UI = new Function('baseclass', 'ui', 'rpc', 'E', 'L', shared)(
                { extend: value => value }, ui, rpc, E, L);
            const fixtures = {
                GLOBAL: { all: ['订阅组', '无图标组'] },
                '订阅组': { name: '订阅组', type: 'Selector', all: ['自定义', '缺省', '损坏', '相对路径', '无效图标'], now: '自定义', icon: 'https://icons.example.test/group.svg' },
                '无图标组': { name: '无图标组', type: 'URLTest', all: ['缺省'], now: '缺省' },
                '自定义': { name: '自定义', type: 'VLESS', icon: 'data:image/svg+xml,' + encodeURIComponent(image) },
                '缺省': { name: '缺省', type: 'Trojan' },
                '损坏': { name: '损坏', type: 'VLESS', icon: 'https://icons.example.test/broken.svg' },
                '相对路径': { name: '相对路径', type: 'VLESS', icon: '/custom.svg' },
                '无效图标': { name: '无效图标', type: 'VLESS', icon: 'javascript:alert(1)' }
            };
            const Core = { get: async () => ({ data: { proxies: fixtures } }) };
            const view = new Function('view', 'poll', 'uci', 'ui', 'Core', 'UI', 'E', 'L', source)(
                { extend: value => value }, { add() {} }, { get: () => '', load: async () => {} }, ui, Core, UI, E, L);
            document.querySelector('#view').append(view.render());
        }, { source, shared, image });
        await page.waitForSelector('[data-proxy-name="自定义"] img');
        assert.equal(await page.locator('[data-group-name="订阅组"] .v4-group-icon img').getAttribute('src'), 'https://icons.example.test/group.svg');
        assert.ok((await page.locator('[data-group-name="订阅组"] .v4-current img').getAttribute('src')).startsWith('data:image/'));
        assert.ok((await page.locator('[data-proxy-name="自定义"] img').getAttribute('src')).startsWith('data:image/'));
        await page.waitForFunction(() => !document.querySelector('[data-proxy-name="损坏"] img'));
        assert.equal(await page.locator('[data-proxy-name="损坏"] .v4-node-icon svg').count(), 1);
        assert.equal(await page.locator('[data-proxy-name="缺省"] .v4-node-icon svg').count(), 2);
        assert.equal(await page.locator('[data-proxy-name="无效图标"] img').count(), 0);
        await page.waitForFunction(() => document.querySelector('[data-proxy-name="相对路径"] img').naturalWidth > 0);
        for (const width of [320, 390, 768, 1600]) {
            await page.setViewportSize({ width, height: 1000 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        }
        await page.locator('[data-expand-group="无图标组"]').click();
        assert.equal(await page.locator('[data-group-name="无图标组"] .v4-group-icon svg').count(), 1);
        assert.equal(await page.locator('[data-group-name="无图标组"] .v4-current-icon svg').count(), 1);
        assert.equal(await page.locator('[data-group-name="无图标组"] [data-proxy-name]').count(), 0);
        assert.deepEqual(errors, []);
        console.log('PASS: subscription group/current/node icons, missing/broken fallbacks, relative/data images and responsive sizing');
    } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
