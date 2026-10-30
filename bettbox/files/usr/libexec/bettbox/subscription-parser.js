// SPDX-License-Identifier: GPL-3.0
// Runs on demand inside the existing QuickJS helper. No browser/Node APIs.
'use strict';

function main(input) {
    const maxBytes = 4194304, maxNodes = 2048;
    function fail(message) { throw new Error(message); }
    function decode(text) {
        try { return decodeURIComponent(text); }
        catch (_) { fail('链接含无效的百分号编码'); }
    }
    function base64(text) {
        text = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.replace(/=+$/, '').length % 4 === 1)
            fail('Base64 内容无效');
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let bits = 0, value = 0, bytes = '';
        for (const ch of text.replace(/=+$/, '')) {
            value = (value << 6) | alphabet.indexOf(ch); bits += 6;
            if (bits >= 8) { bits -= 8; bytes += '%' + ((value >> bits) & 255).toString(16).padStart(2, '0'); }
        }
        try { return decodeURIComponent(bytes); }
        catch (_) { fail('Base64 内容不是有效的 UTF-8 文本'); }
    }
    function port(value, fallback) {
        const text = String(value == null || value === '' ? fallback || '' : value);
        if (!/^[0-9]+$/.test(text) || +text < 1 || +text > 65535) fail('节点端口必须在 1–65535 之间');
        return +text;
    }
    function server(value) {
        if (typeof value !== 'string' || !value || /[\s\/@?#\x00-\x1f]/.test(value)) fail('节点服务器地址无效');
        // IPv6 is passed unchanged to the core; brackets are URI syntax only.
        function ipv4(text) { const p = text.split('.'); return p.length === 4 && p.every(x => /^(0|[1-9][0-9]{0,2})$/.test(x) && +x <= 255); }
        if (value.includes(':')) {
            const halves = value.split('::');
            if (halves.length > 2) fail('IPv6 地址无效');
            let words = 0;
            for (const half of halves) {
                const parts = half ? half.split(':') : [];
                for (let i = 0; i < parts.length; i++) {
                    const part = parts[i];
                    if (part.includes('.')) {
                        if (i !== parts.length - 1 || !value.endsWith(part) || !ipv4(part)) fail('IPv6 地址无效');
                        words += 2;
                    } else { if (!/^[0-9a-fA-F]{1,4}$/.test(part)) fail('IPv6 地址无效'); words++; }
                }
            }
            if (halves.length === 1 ? words !== 8 : words >= 8) fail('IPv6 地址无效');
        } else if (/^[0-9.]+$/.test(value) && value.includes('.') && !ipv4(value)) fail('IPv4 地址无效');
        return value.toLowerCase();
    }
    function endpoint(text, fallback) {
        const m = text.match(/^\[([^\]]+)\](?::([0-9]+))?$/) || text.match(/^([^:]+)(?::([0-9]+))?$/);
        if (!m) fail('节点地址无效，IPv6 地址请使用方括号');
        return { server: server(m[1]), port: port(m[2], fallback) };
    }
    function query(text) {
        const out = Object.create(null);
        if (!text) return out;
        for (const part of text.split('&')) {
            if (!part) continue;
            const i = part.indexOf('=');
            const key = decode(i < 0 ? part : part.slice(0, i));
            const value = decode(i < 0 ? '' : part.slice(i + 1));
            if (Object.prototype.hasOwnProperty.call(out, key) && out[key] !== value) fail('链接含重复且冲突的参数');
            out[key] = value;
        }
        return out;
    }
    function known(q, allowed) {
        for (const key of Object.keys(q)) if (!allowed.includes(key)) fail('链接含尚未支持的参数：' + key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32));
    }
    function boolean(value) {
        if (['1', 'true'].includes(value)) return true;
        if (['0', 'false'].includes(value)) return false;
        fail('布尔参数只能为 0、1、true 或 false');
    }
    function tls(node, q, enabled) {
        if (enabled) node.tls = true;
        if (q.sni || q.peer || q.servername) node[['vmess','vless'].includes(node.type) ? 'servername' : 'sni'] = q.sni || q.peer || q.servername;
        if (q.alpn) node.alpn = q.alpn.split(',').filter(Boolean);
        if (q.fp) {
            if (!['vmess','vless','trojan','anytls'].includes(node.type)) fail('该协议不支持客户端 TLS 指纹参数');
            node['client-fingerprint'] = q.fp;
        }
        const insecure = q.allowInsecure == null ? q.insecure : q.allowInsecure;
        if (insecure != null) node['skip-cert-verify'] = boolean(insecure);
    }
    function transport(node, q) {
        const network = q.type || 'tcp';
        if (!['tcp', 'ws', 'grpc', 'http', 'h2'].includes(network)) fail('尚未支持的传输方式：' + network.slice(0, 24));
        if (network !== 'grpc' && (q.serviceName || q.mode)) fail('该传输方式不支持 gRPC 参数');
        if (network === 'grpc' && (q.host || q.path)) fail('gRPC Host/路径参数尚未支持，请使用 serviceName');
        if (network !== 'tcp') node.network = network;
        if (network === 'ws') {
            node['ws-opts'] = { path: q.path || '/' };
            if (q.host) node['ws-opts'].headers = { Host: q.host };
        } else if (network === 'grpc') {
            node['grpc-opts'] = { 'grpc-service-name': q.serviceName || '' };
            if (q.mode && q.mode !== 'gun') fail('尚未支持该 gRPC 模式');
        } else if (network === 'http' || (network === 'tcp' && q.headerType === 'http')) {
            node.network = 'http';
            node['http-opts'] = { path: [q.path || '/'] };
            if (q.host) node['http-opts'].headers = { Host: q.host.split(',') };
        } else if (network === 'h2') {
            node['h2-opts'] = { path: q.path || '/' };
            if (q.host) node['h2-opts'].host = q.host.split(',');
        } else if (q.headerType && q.headerType !== 'none') fail('尚未支持该 TCP 伪装');
        if (network === 'tcp' && q.headerType !== 'http' && (q.path || q.host || q.serviceName))
            fail('TCP 链接含不适用的传输参数');
    }
    function vmess(payload) {
        let v;
        try { v = JSON.parse(base64(payload)); } catch (_) { fail('VMess 链接必须包含有效的 Base64 JSON'); }
        if (!v || typeof v !== 'object' || Array.isArray(v)) fail('VMess 配置无效');
        const allowed = ['v','ps','add','port','id','aid','scy','net','type','host','path','tls','sni','alpn','fp','allowInsecure'];
        for (const key of Object.keys(v)) if (!allowed.includes(key) && v[key] !== '' && v[key] != null) fail('VMess 含尚未支持的字段');
        if (!/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(v.id || '')) fail('VMess UUID 无效');
        const node = { name: v.ps || '', type: 'vmess', server: server(v.add), port: port(v.port), uuid: v.id,
            alterId: v.aid == null || v.aid === '' ? 0 : +v.aid, cipher: v.scy || 'auto', udp: true };
        if (!Number.isInteger(node.alterId) || node.alterId < 0) fail('VMess alterId 无效');
        if (v.tls && !['tls', 'none'].includes(v.tls)) fail('尚未支持该 VMess TLS 模式');
        const q = { type: v.net || 'tcp', headerType: v.type || 'none', host: v.host || '', path: v.path || '',
            sni: v.sni || '', alpn: v.alpn || '', fp: v.fp || '' };
        if (q.type === 'grpc') { q.serviceName = q.path; q.path = ''; }
        if (v.allowInsecure != null && v.allowInsecure !== '') q.allowInsecure = String(v.allowInsecure);
        tls(node, q, v.tls === 'tls'); transport(node, q);
        return node;
    }
    function parse(uri) {
        const scheme = uri.slice(0, uri.indexOf('://')).toLowerCase();
        if (!['ss','vmess','vless','trojan','hysteria2','hy2','tuic','socks','socks5','http','https','anytls'].includes(scheme))
            fail('尚未支持该分享协议：' + scheme.replace(/[^a-z0-9]/g, '').slice(0, 20));
        let text = uri.slice(uri.indexOf('://') + 3), fragment = '';
        const hash = text.indexOf('#');
        if (hash >= 0) { fragment = decode(text.slice(hash + 1)); text = text.slice(0, hash); }
        if (scheme === 'vmess') {
            const node = vmess(text); if (fragment) node.name = fragment; return node;
        }
        const question = text.indexOf('?'), q = query(question < 0 ? '' : text.slice(question + 1));
        text = question < 0 ? text : text.slice(0, question);
        text = text.replace(/\/$/, '');
        const legacySS = scheme === 'ss' && !text.includes('@');
        if (legacySS) text = base64(text);
        const at = text.lastIndexOf('@');
        let user = at < 0 ? '' : text.slice(0, at), address = at < 0 ? text : text.slice(at + 1);
        const defaults = { trojan: 443, hysteria2: 443, hy2: 443, tuic: 443, anytls: 443, socks: 1080, socks5: 1080, http: 80, https: 443 };
        const node = Object.assign({ name: fragment, type: scheme }, endpoint(address, defaults[scheme]));
        const tlsKeys = ['sni','peer','servername','alpn','fp','insecure','allowInsecure'];
        if (scheme === 'ss') {
            known(q, ['plugin']);
            if (!legacySS) { user = decode(user); if (!user.includes(':')) user = base64(user); }
            const colon = user.indexOf(':');
            if (colon < 1 || colon === user.length - 1) fail('Shadowsocks 缺少加密方式或密码');
            node.cipher = user.slice(0, colon); node.password = user.slice(colon + 1); node.udp = true;
            if (q.plugin) {
                const parts = q.plugin.split(';'), plugin = parts.shift();
                if (!['obfs-local','simple-obfs','v2ray-plugin'].includes(plugin)) fail('尚未支持该 Shadowsocks 插件');
                node.plugin = plugin === 'obfs-local' || plugin === 'simple-obfs' ? 'obfs' : plugin;
                node['plugin-opts'] = {};
                for (const item of parts) {
                    const i = item.indexOf('='), key = i < 0 ? item : item.slice(0, i), value = i < 0 ? true : item.slice(i + 1);
                    const mapped = key === 'obfs' ? 'mode' : key === 'obfs-host' ? 'host' : key;
                    if (!['mode','host','path','tls','mux','skip-cert-verify'].includes(mapped)) fail('尚未支持该 Shadowsocks 插件参数');
                    node['plugin-opts'][mapped] = ['tls','mux','skip-cert-verify'].includes(mapped) ? (value === true ? true : boolean(value)) : value;
                }
            }
        } else if (scheme === 'vless' || scheme === 'trojan') {
            known(q, tlsKeys.concat(['security','type','encryption','flow','pbk','sid','spx','host','path','serviceName','mode','headerType','packetEncoding']));
            user = decode(user);
            if (!user) fail('链接缺少节点凭据');
            if (scheme === 'vless') {
                if (!/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(user)) fail('VLESS UUID 无效');
                node.uuid = user;
                if (q.encryption && q.encryption !== 'none') fail('尚未支持该 VLESS 加密方式');
            } else node.password = user;
            const security = q.security || (scheme === 'trojan' ? 'tls' : 'none');
            if (!['none','tls','reality'].includes(security) || (scheme === 'trojan' && security !== 'tls')) fail('尚未支持该安全模式');
            tls(node, q, security !== 'none'); transport(node, q); node.udp = true;
            if (q.flow) {
                if (scheme !== 'vless' || q.flow !== 'xtls-rprx-vision' || security === 'none' || (q.type && q.type !== 'tcp')) fail('尚未支持该 flow 或传输组合');
                node.flow = q.flow;
            }
            if (security === 'reality') {
                if (!/^[A-Za-z0-9_-]{43}$/.test(q.pbk || '') || q.spx) fail('REALITY 公钥无效或包含尚未支持的 spiderX');
                if (q.sid && !/^(?:[0-9a-fA-F]{2}){0,8}$/.test(q.sid)) fail('REALITY short-id 无效');
                node['reality-opts'] = { 'public-key': q.pbk, 'short-id': q.sid || '' };
                if (!node['client-fingerprint']) node['client-fingerprint'] = 'chrome';
            } else if (q.pbk || q.sid || q.spx) fail('REALITY 参数需要 security=reality');
            if (q.packetEncoding) {
                if (!['xudp','packetaddr'].includes(q.packetEncoding)) fail('尚未支持该 UDP 封装');
                node['packet-encoding'] = q.packetEncoding;
            }
        } else if (['hysteria2','hy2'].includes(scheme)) {
            known(q, tlsKeys.concat(['obfs','obfs-password','mport']));
            node.type = 'hysteria2'; node.password = decode(user);
            if (!node.password) fail('Hysteria2 缺少密码');
            tls(node, q, false);
            if (q.obfs) {
                if (q.obfs !== 'salamander' || !q['obfs-password']) fail('Hysteria2 混淆配置无效');
                node.obfs = q.obfs; node['obfs-password'] = q['obfs-password'];
            } else if (q['obfs-password']) fail('Hysteria2 缺少混淆方式');
            if (q.mport) {
                if (!/^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/.test(q.mport)) fail('端口跳跃范围无效');
                for (const range of q.mport.split(',')) { const ends = range.split('-'); port(ends[0]); if (ends[1] && port(ends[1]) < +ends[0]) fail('端口跳跃范围无效'); }
                node.ports = q.mport;
            }
        } else if (scheme === 'tuic') {
            known(q, tlsKeys.concat(['congestion_control','udp_relay_mode','disable_sni','reduce_rtt']));
            const colon = user.indexOf(':');
            if (colon < 1) fail('TUIC 缺少 UUID 或密码');
            node.uuid = decode(user.slice(0, colon)); node.password = decode(user.slice(colon + 1));
            if (!/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(node.uuid) || !node.password) fail('TUIC 凭据无效');
            tls(node, q, false);
            if (q.congestion_control) node['congestion-controller'] = q.congestion_control;
            if (q.udp_relay_mode) node['udp-relay-mode'] = q.udp_relay_mode;
            if (q.disable_sni != null) node['disable-sni'] = boolean(q.disable_sni);
            if (q.reduce_rtt != null) node['reduce-rtt'] = boolean(q.reduce_rtt);
        } else if (['socks','socks5','http','https'].includes(scheme)) {
            known(q, tlsKeys);
            node.type = scheme === 'socks' ? 'socks5' : scheme === 'https' ? 'http' : scheme;
            if (user) {
                const colon = user.indexOf(':');
                node.username = decode(colon < 0 ? user : user.slice(0, colon));
                node.password = colon < 0 ? '' : decode(user.slice(colon + 1));
            }
            if (node.type === 'socks5') node.udp = true;
            tls(node, q, scheme === 'https');
        } else if (scheme === 'anytls') {
            known(q, tlsKeys); node.password = decode(user);
            if (!node.password) fail('AnyTLS 缺少密码');
            tls(node, q, false); node.udp = true;
        } else fail('尚未支持该分享协议：' + scheme.replace(/[^a-z0-9]/g, '').slice(0, 20));
        return node;
    }
    function canonical(value) {
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => k !== 'name').sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
        return JSON.stringify(value);
    }
    let text = input && input.content;
    if (typeof text !== 'string' || !text.trim()) fail('请输入分享链接或 Base64 订阅内容');
    if (text.length > maxBytes) fail('订阅内容超过 4 MiB 上限');
    text = text.replace(/^\uFEFF/, '').trim();
    if (!text.includes('://')) text = base64(text).replace(/^\uFEFF/, '').trim();
    const links = text.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g) || [];
    const unique = new Set(), names = new Set(), nodes = [];
    if (!links.length) fail('未识别到分享链接，请使用 Clash YAML 或支持的节点分享格式');
    if (links.length > maxNodes) fail('单次最多导入 2048 条分享链接');
    for (let i = 0; i < links.length; i++) {
        // Ignore documentation/subscription URLs surrounding real node links.
        if (/^https?:\/\//i.test(links[i]) && !links[i].split(/[?#]/)[0].includes('@') && links.length > 1) continue;
        let node;
        try { node = parse(links[i]); }
        catch (error) { fail('第 ' + (i + 1) + ' 条分享链接：' + error.message); }
        const fingerprint = canonical(node);
        if (unique.has(fingerprint)) continue;
        unique.add(fingerprint);
        let name = String(node.name || node.type + ' · ' + node.server + ':' + node.port).replace(/[\x00-\x1f\x7f]/g, '').trim();
        if (!name) name = '节点';
        name = name.slice(0, 160);
        const root = name; let suffix = 2;
        while (names.has(name) || ['DIRECT','REJECT','GLOBAL','默认代理'].includes(name)) name = root + ' (' + suffix++ + ')';
        names.add(name); node.name = name; nodes.push(node);
    }
    if (!nodes.length) fail('没有可导入的节点');
    return { proxies: nodes, 'proxy-groups': [{ name: '默认代理', type: 'select', proxies: nodes.map(n => n.name).concat(['DIRECT']) }], rules: ['MATCH,默认代理'] };
}
