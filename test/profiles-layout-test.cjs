'use strict';
// Browser layout regression for the actual LuCI view and its shared stylesheet.
// Dependency: Playwright. No router, credentials or network calls are required.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
const resources = path.join(root, 'luci-app-bettbox/htdocs/luci-static/resources');
const source = fs.readFileSync(path.join(resources, 'view/bettbox/profiles.js'), 'utf8');
const shared = fs.readFileSync(path.join(resources, 'bettbox/ui.js'), 'utf8');
const stylesheet = fs.readFileSync(path.join(resources, 'bettbox/ui.css'), 'utf8');
const screenshotDir = path.join(root, 'dist/implementation');

(async () => {
    fs.mkdirSync(screenshotDir, { recursive: true });
    const browser = await chromium.launch({ headless: true,
        ...(process.env.BETTBOX_BROWSER ? { executablePath: process.env.BETTBOX_BROWSER } : {}) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body class="logged-in"><div id="view"></div></body></html>');
    if (process.env.BETTBOX_THEME_CSS) await page.addStyleTag({ path: process.env.BETTBOX_THEME_CSS });
    await page.addStyleTag({ content: 'body{margin:0;font:14px "Microsoft YaHei",sans-serif}.panel{padding:28px}#view{padding:0}' });
    await page.addStyleTag({ content: stylesheet });
    await page.evaluate(({ source, shared }) => {
        function E(tag, attributes = {}, content = []) {
            const node = document.createElement(tag);
            for (const [key, value] of Object.entries(attributes)) {
                if (value == null) continue;
                if (typeof value === 'function') node.addEventListener(key, value);
                else node.setAttribute(key, String(value));
            }
            for (const child of [content].flat(Infinity)) {
                if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
            }
            return node;
        }
        const rpc = { declare: () => async () => ({ ok: true }) };
        const ui = { createHandlerFn: (_, callback) => callback, showModal() {}, hideModal() {}, addNotification() {} };
        const uci = { get: () => 'active', load: async () => {} };
        const L = { url: (...parts) => '/' + parts.join('/'), env: {}, resource: () => 'data:text/css,/*test*/' };
        const UI = new Function('baseclass', 'ui', 'rpc', 'E', 'L', shared)({ extend: value => value }, ui, rpc, E, L);
        const view = new Function('view', 'rpc', 'uci', 'ui', 'UI', 'E', 'L', '_', source)(
            { extend: value => value }, rpc, uci, ui, UI, E, L, value => value);
        window.renderProfileFixture = count => {
            const profiles = Array.from({ length: count }, (_, i) => ({
                id: i === 1 ? 'active' : 'subscription' + i,
                label: i === 0 ? 'NekoCloud' : i === 1 ? 'sub1792855687' : '长名称订阅 · Example ABCDEFGHIJKLMNOPQRSTUVWXYZ ' + i,
                url: 'https://example.invalid/subscription',
                sub_total: i === 1 ? 0 : 128 * 1024 ** 3,
                sub_upload: i === 1 ? 0 : 949.58 * 1024 ** 2,
                sub_download: i === 1 ? 0 : 59.65 * 1024 ** 3,
                sub_expire: i === 1 ? 0 : 1817740800,
                auto_update: true, update_interval: 720,
                use_script: true, script: i > 1 ? 'very_long_script_name_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789' : 'mihomoScript',
                last_update: 1792995000
            }));
            document.querySelector('#view').replaceChildren(view.render([{ profiles }, { scripts: [] }]));
        };
    }, { source, shared });

    let checks = 0;
    try {
        for (const count of [1, 2, 3, 6]) {
            await page.evaluate(count => window.renderProfileFixture(count), count);
            for (const width of [320, 360, 390, 430, 768, 1024, 1600]) {
                await page.setViewportSize({ width, height: 950 });
                const result = await page.evaluate(() => {
                    const grid = document.querySelector('.profile-grid').getBoundingClientRect();
                    return {
                        scroll: document.documentElement.scrollWidth,
                        gridRight: grid.right,
                        cards: [...document.querySelectorAll('.panel.profile')].map(card => {
                            const style = getComputedStyle(card), box = card.getBoundingClientRect();
                            const heading = card.querySelector('.profile-top').getBoundingClientRect();
                            const actions = card.querySelector('.profile-actions').getBoundingClientRect();
                            return { left: box.left, right: box.right, top: box.top,
                                padding: parseFloat(style.paddingLeft), headingLeft: heading.left,
                                actionsRight: actions.right,
                                overflowingChild: [...card.querySelectorAll('*')].some(el => el.getBoundingClientRect().right > box.right + 1) };
                        })
                    };
                });
                assert.ok(result.scroll <= width + 1, 'page overflow: ' + count + ' cards / ' + width);
                assert.equal(result.cards.length, count);
                for (const card of result.cards) {
                    assert.ok(card.padding >= 15, 'generic panel reset must not erase profile padding');
                    assert.ok(card.headingLeft - card.left >= 15, 'heading must not touch card border');
                    assert.ok(card.right - card.actionsRight >= 15, 'buttons must stay inside padded card');
                    assert.equal(card.overflowingChild, false, 'long values stay inside the card');
                }
                if (count === 2 && width >= 768) {
                    assert.equal(result.cards[0].top, result.cards[1].top, 'two desktop cards share one row');
                    assert.ok(Math.abs(result.cards[1].right - result.gridRight) <= 1, 'no empty fixed third column');
                }
                if (count === 2 && [390, 1600].includes(width)) await page.screenshot({
                    path: path.join(screenshotDir, 'profiles-fixed-' + (width === 390 ? 'mobile' : 'desktop') + '.png'), fullPage: true
                });
                checks++;
            }
        }
        assert.deepEqual(errors, []);
        console.log('PASS: ' + checks + ' production profile layouts, padding, long values and filled rows');
    } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exit(1); });
