'use strict';
'require view';
'require rpc';
'require uci';
'require ui';
'require bettbox.core as Core';
'require bettbox.ui as UI';
'require bettbox.qrcode as QRCode';

var getStatus = rpc.declare({ object: 'bettbox', method: 'get_status' });
var serviceAction = rpc.declare({ object: 'bettbox', method: 'service_action', params: ['action'] });
var importNodesRPC = rpc.declare({ object: 'bettbox', method: 'import_nodes', params: ['content'] });

function encode(value) {
	return encodeURIComponent(value).replace(/[!'()*]/g, function(c) {
		return '%' + c.charCodeAt(0).toString(16).toUpperCase();
	});
}
function stored(key, fallback) {
	try { return localStorage.getItem('bettbox-' + key) || fallback; }
	catch(e) { return fallback; }
}
function persist(key, value) {
	try { localStorage.setItem('bettbox-' + key, value); } catch(e) {}
}
// Region-name matching adapted from NaiLink (MIT), copyright NaiLink contributors.
// Qure artwork and original notices are bundled in bettbox/qure.
// These are name hints, independent of the actual server or exit IP location.
var regionDefinitions = [
  ['hk', '香港', '香港|香港特別行政區|Hong[ -]?Kong', 'HK|HKG'],
  ['tw', '台湾', '台湾|台灣|台北|Taiwan|Taipei', 'TW|TWN'],
  ['mo', '澳门', '澳门|澳門|Macau|Macao', 'MO|MAC'],
  ['cn', '中国大陆', '中国|中國|大陆|大陸|China|Mainland', 'CN|CHN'],
  ['jp', '日本', '日本|东京|東京|大阪|Japan|Tokyo|Osaka', 'JP|JPN'],
  ['sg', '新加坡', '新加坡|狮城|獅城|Singapore', 'SG|SGP'],
  ['us', '美国', '美国|美國|洛杉矶|洛杉磯|纽约|紐約|圣何塞|United States|America|Los Angeles|New York', 'US|USA'],
  ['gb', '英国', '英国|英國|伦敦|倫敦|United Kingdom|Britain|London', 'GB|GBR|UK'],
  ['de', '德国', '德国|德國|法兰克福|法蘭克福|Germany|Frankfurt', 'DE|DEU'],
  ['fr', '法国', '法国|法國|巴黎|France|Paris', 'FR|FRA'],
  ['kr', '韩国', '韩国|韓國|首尔|首爾|South Korea|Korea|Seoul', 'KR|KOR'],
  ['ca', '加拿大', '加拿大|多伦多|多倫多|温哥华|溫哥華|Canada|Toronto|Vancouver', 'CA|CAN'],
  ['au', '澳大利亚', '澳大利亚|澳大利亞|澳洲|悉尼|雪梨|Australia|Sydney', 'AU|AUS'],
  ['nz', '新西兰', '新西兰|新西蘭|纽西兰|紐西蘭|New Zealand', 'NZ|NZL'],
  ['ru', '俄罗斯', '俄罗斯|俄羅斯|莫斯科|Russia|Moscow', 'RU|RUS'],
  ['nl', '荷兰', '荷兰|荷蘭|阿姆斯特丹|Netherlands|Amsterdam', 'NL|NLD'],
  ['ch', '瑞士', '瑞士|苏黎世|蘇黎世|Switzerland|Zurich', 'CH|CHE'],
  ['se', '瑞典', '瑞典|Sweden', 'SE|SWE'],
  ['no', '挪威', '挪威|Norway', 'NO|NOR'],
  ['fi', '芬兰', '芬兰|芬蘭|Finland', 'FI|FIN'],
  ['dk', '丹麦', '丹麦|丹麥|Denmark', 'DK|DNK'],
  ['es', '西班牙', '西班牙|Spain', 'ES|ESP'],
  ['it', '意大利', '意大利|義大利|Italy', 'IT|ITA'],
  ['ie', '爱尔兰', '爱尔兰|愛爾蘭|Ireland', 'IE|IRL'],
  ['pl', '波兰', '波兰|波蘭|Poland', 'PL|POL'],
  ['tr', '土耳其', '土耳其|Turkey|Türkiye', 'TR|TUR'],
  ['ae', '阿联酋', '阿联酋|阿聯酋|迪拜|阿拉伯联合酋长国|United Arab Emirates|Dubai', 'AE|ARE|UAE'],
  ['my', '马来西亚', '马来西亚|馬來西亞|马来|馬來|大马|Malaysia', 'MY|MYS'],
  ['th', '泰国', '泰国|泰國|曼谷|Thailand|Bangkok', 'TH|THA'],
  ['vn', '越南', '越南|Vietnam', 'VN|VNM'],
  ['ph', '菲律宾', '菲律宾|菲律賓|Philippines', 'PH|PHL'],
  ['id', '印度尼西亚', '印度尼西亚|印度尼西亞|印尼|Indonesia', 'ID|IDN'],
  ['in', '印度', '印度(?!尼)|India', 'IN|IND'],
  ['za', '南非', '南非|South Africa', 'ZA|ZAF'],
  ['br', '巴西', '巴西|Brazil', 'BR|BRA'],
  ['mx', '墨西哥', '墨西哥|Mexico', 'MX|MEX'],
  ['ar', '阿根廷', '阿根廷|Argentina', 'AR|ARG'],
  ['ua', '乌克兰', '乌克兰|烏克蘭|Ukraine', 'UA|UKR'],
  ['il', '以色列', '以色列|Israel', 'IL|ISR'],
  ['is', '冰岛', '冰岛|冰島|Iceland', 'IS|ISL'],
  ['kz', '哈萨克斯坦', '哈萨克斯坦|哈薩克斯坦|Kazakhstan', 'KZ|KAZ'],
  ['sa', '沙特阿拉伯', '沙特|Saudi Arabia', 'SA|SAU'],
];
var regions = regionDefinitions.map(function(definition){
	var aliases = definition[2].split('|').map(function(alias){
		return /[a-z]/i.test(alias) ? '(?:^|[^a-z])(?:' + alias + ')(?![a-z])' : alias;
	}).join('|');
	return {
		code:definition[0], name:definition[1],
		label:new RegExp(aliases, 'i'),
		abbreviation:new RegExp('(?:^|[^a-z0-9])(' + definition[3] + ')(?=$|[^a-z])', 'gi')
	};
});
function nodeRegion(name){
	var normalized = String(name || '').normalize('NFKC');
	var flags = normalized.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu);
	if (flags) {
		var codes = new Set(flags.map(function(flag){
			return Array.from(flag, function(part){
				return String.fromCharCode(part.codePointAt(0) - 0x1F1E6 + 97);
			}).join('');
		}));
		if (codes.size !== 1) return null;
		return regions.find(function(region){ return region.code === Array.from(codes)[0]; }) || null;
	}
	var labels = normalized.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
		.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, ' ');
	var matches = regions.filter(function(region){
		if (region.label.test(labels)) return true;
		region.abbreviation.lastIndex = 0;
		var match;
		while ((match = region.abbreviation.exec(labels))) {
			if (!['in','it','no','is','id'].includes(match[1]) ||
				/\d/.test(labels[match.index + match[0].length] || '') || labels.trim() === match[1])
				return true;
		}
		return false;
	});
	return matches.length === 1 ? matches[0] : null;
}
var qureIcons = {
	'ai.svg':'AI.svg', 'abematv.svg':'AbemaTV.svg', 'adblock.svg':'AdBlock.svg', 'adobe.svg':'Adobe.svg',
	'airbnb.svg':'Airbnb.svg', 'airport.svg':'Airport.svg', 'alibaba.svg':'Alibaba.svg', 'amazon.svg':'Amazon.svg',
	'anthropic.svg':'Anthropic.svg', 'apple.svg':'Apple.svg', 'applemusic.svg':'AppleMusic.svg', 'applepodcasts.svg':'ApplePodcasts.svg',
	'appletv.svg':'AppleTV.svg', 'auto.svg':'Auto.svg', 'available.svg':'Available.svg', 'azure.svg':'Azure.svg',
	'bbc.svg':'BBC.svg', 'bahamut.svg':'Bahamut.svg', 'baidu.svg':'Baidu.svg', 'battlenet.svg':'BattleNet.svg',
	'bilibili.svg':'Bilibili.svg', 'binance.svg':'Binance.svg', 'bing.svg':'Bing.svg', 'bitcoin.svg':'Bitcoin.svg',
	'bluesky.svg':'Bluesky.svg', 'bybit.svg':'Bybit.svg', 'cdnjs.svg':'Cdnjs.svg', 'chatgpt.svg':'ChatGPT.svg',
	'china.svg':'China.svg', 'china_taiwan.svg':'China_Taiwan.svg', 'claude.svg':'Claude.svg', 'cloudflare.svg':'Cloudflare.svg',
	'coinbase.svg':'Coinbase.svg', 'crunchyroll.svg':'Crunchyroll.svg', 'cursor.svg':'Cursor.svg', 'dazn.svg':'DAZN.svg',
	'dailymotion.svg':'Dailymotion.svg', 'deepl.svg':'DeepL.svg', 'deezer.svg':'Deezer.svg', 'direct.svg':'Direct.svg',
	'discord.svg':'Discord.svg', 'disney.svg':'Disney.svg', 'docker.svg':'Docker.svg', 'dropbox.svg':'Dropbox.svg',
	'ea.svg':'EA.svg', 'ehentai.svg':'EHentai.svg', 'elevenlabs.svg':'ElevenLabs.svg', 'emby.svg':'Emby.svg',
	'epicgames.svg':'EpicGames.svg', 'fcm.svg':'FCM.svg', 'facebook.svg':'Facebook.svg', 'final.svg':'Final.svg',
	'game.svg':'Game.svg', 'gemini.svg':'Gemini.svg', 'github.svg':'GitHub.svg', 'githubcopilot.svg':'GitHubCopilot.svg',
	'gitlab.svg':'Gitlab.svg', 'global.svg':'Global.svg', 'google.svg':'Google.svg', 'googleplay.svg':'GooglePlay.svg',
	'googlescholar.svg':'GoogleScholar.svg', 'grok.svg':'Grok.svg', 'hbo.svg':'HBO.svg', 'hoytv.svg':'HOYTV.svg',
	'hong_kong.svg':'Hong_Kong.svg', 'huggingface.svg':'HuggingFace.svg', 'hulu.svg':'Hulu.svg', 'humblebundle.svg':'HumbleBundle.svg',
	'huobi.svg':'Huobi.svg', 'instagram.svg':'Instagram.svg', 'japan.svg':'Japan.svg', 'jetbrains.svg':'JetBrains.svg',
	'kkbox.svg':'KKBOX.svg', 'kakao.svg':'Kakao.svg', 'kick.svg':'Kick.svg', 'kraken.svg':'Kraken.svg',
	'kucoin.svg':'KuCoin.svg', 'line.svg':'Line.svg', 'linkedin.svg':'Linkedin.svg', 'mega.svg':'MEGA.svg',
	'malaysia.svg':'Malaysia.svg', 'manus.svg':'Manus.svg', 'medium.svg':'Medium.svg', 'messenger.svg':'Messenger.svg',
	'meta.svg':'Meta.svg', 'mihoyo.svg':'MiHoYo.svg', 'microsoft.svg':'Microsoft.svg', 'missav.svg':'MissAV.svg',
	'mytvsuper.svg':'MyTVSUPER.svg', 'npm.svg':'NPM.svg', 'nvidia.svg':'NVIDIA.svg', 'naver.svg':'Naver.svg',
	'neteasemusic.svg':'NeteaseMusic.svg', 'netflix.svg':'Netflix.svg', 'netherlands.svg':'Netherlands.svg', 'niconico.svg':'NicoNico.svg',
	'nintendo.svg':'Nintendo.svg', 'nodejs.svg':'NodeJs.svg', 'notion.svg':'Notion.svg', 'okx.svg':'OKX.svg',
	'oculus.svg':'Oculus.svg', 'onedrive.svg':'OneDrive.svg', 'onetrust.svg':'OneTrust.svg', 'opencode.svg':'OpenCode.svg',
	'openrouter.svg':'OpenRouter.svg', 'patreon.svg':'Patreon.svg', 'paypal.svg':'PayPal.svg', 'perplexity.svg':'Perplexity.svg',
	'phantom.svg':'Phantom.svg', 'pikpak.svg':'PikPak.svg', 'pinterest.svg':'Pinterest.svg', 'pixiv.svg':'Pixiv.svg',
	'playstation.svg':'PlayStation.svg', 'plex.svg':'Plex.svg', 'primevideo.svg':'PrimeVideo.svg', 'protonmail.svg':'ProtonMail.svg',
	'proxy.svg':'Proxy.svg', 'qq.svg':'QQ.svg', 'quora.svg':'Quora.svg', 'rthk.svg':'RTHK.svg',
	'rakuten.svg':'Rakuten.svg', 'reddit.svg':'Reddit.svg', 'reject.svg':'Reject.svg', 'riotgames.svg':'RiotGames.svg',
	'roblox.svg':'Roblox.svg', 'rockstargames.svg':'RockstarGames.svg', 'samsung.svg':'Samsung.svg', 'server.svg':'Server.svg',
	'shopee.svg':'Shopee.svg', 'signal.svg':'Signal.svg', 'singapore.svg':'Singapore.svg', 'slack.svg':'Slack.svg',
	'snapchat.svg':'Snapchat.svg', 'soundcloud.svg':'SoundCloud.svg', 'south_korea.svg':'South_Korea.svg', 'speedtest.svg':'Speedtest.svg',
	'spotify.svg':'Spotify.svg', 'stack.svg':'Stack.svg', 'stackoverflow.svg':'StackOverflow.svg', 'static.svg':'Static.svg',
	'steam.svg':'Steam.svg', 'stripe.svg':'Stripe.svg', 'suno.svg':'Suno.svg', 'supercell.svg':'Supercell.svg',
	'tvb.svg':'TVB.svg', 'telegram.svg':'Telegram.svg', 'threads.svg':'Threads.svg', 'tidal.svg':'Tidal.svg',
	'tiktok.svg':'TikTok.svg', 'turkey.svg':'Turkey.svg', 'twitch.svg':'Twitch.svg', 'twitter.svg':'Twitter.svg',
	'ubisoft.svg':'Ubisoft.svg', 'united_kingdom.svg':'United_Kingdom.svg', 'united_states.svg':'United_States.svg', 'unpkg.svg':'Unpkg.svg',
	'v2ex.svg':'V2EX.svg', 'vimeo.svg':'Vimeo.svg', 'viu.svg':'Viu.svg', 'viutv.svg':'ViuTV.svg',
	'whatsapp.svg':'WhatsApp.svg', 'wikipedia.svg':'Wikipedia.svg', 'windsurf.svg':'Windsurf.svg', 'wise.svg':'Wise.svg',
	'worldmap.svg':'WorldMap.svg', 'xbox.svg':'Xbox.svg', 'youtube.svg':'YouTube.svg', 'youtubemusic.svg':'YouTubeMusic.svg',
	'zoom.svg':'Zoom.svg', 'ebay.svg':'eBay.svg', 'icloud.svg':'iCloud.svg', 'iqiyi.svg':'iQIYI.svg'
};
var qureFlags = {
	'argentina.svg':'ar.svg', 'australia.svg':'au.svg', 'brazil.svg':'br.svg', 'canada.svg':'ca.svg',
	'china.svg':'cn.svg', 'china_taiwan.svg':'tw.svg', 'denmark.svg':'dk.svg', 'finland.svg':'fi.svg',
	'france.svg':'fr.svg', 'germany.svg':'de.svg', 'hong_kong.svg':'hk.svg', 'iceland.svg':'is.svg',
	'india.svg':'in.svg', 'indonesia.svg':'id.svg', 'ireland.svg':'ie.svg', 'israel.svg':'il.svg',
	'italy.svg':'it.svg', 'japan.svg':'jp.svg', 'kazakhstan.svg':'kz.svg', 'macau.svg':'mo.svg',
	'malaysia.svg':'my.svg', 'mexico.svg':'mx.svg', 'netherlands.svg':'nl.svg', 'new_zealand.svg':'nz.svg',
	'norway.svg':'no.svg', 'philippines.svg':'ph.svg', 'poland.svg':'pl.svg', 'russia.svg':'ru.svg',
	'saudi_arabia.svg':'sa.svg', 'singapore.svg':'sg.svg', 'south_africa.svg':'za.svg', 'south_korea.svg':'kr.svg',
	'spain.svg':'es.svg', 'sweden.svg':'se.svg', 'switzerland.svg':'ch.svg', 'thailand.svg':'th.svg',
	'turkey.svg':'tr.svg', 'ukraine.svg':'ua.svg', 'united_arab_emirates.svg':'ae.svg', 'united_kingdom.svg':'gb.svg',
	'united_states.svg':'us.svg', 'vietnam.svg':'vn.svg'
};
function localIconSrc(value) {
	var text = String(value || '').trim(), file, folder = '', match;
	if (!text) return null;
	if (/^(?:https?:)?\/\//i.test(text)) {
		match = text.match(/^(?:https?:)?\/\/[^/?#]+\/(?:gh\/)?(?:appshubcc|aaANDkk)\/Qure_Style_SVG(?:@[^/?#]+|\/(?:blob|raw)\/[^/?#]+|\/[^/?#]+)?\/icon\/svg\/(?:(common|flag)\/)?([^/?#]+\.svg)(?:[?#].*)?$/i);
	} else {
		match = text.match(/^(?:(common|flag)\/)?([^/?#]+\.svg)(?:[?#].*)?$/i);
	}
	if (!match) return null;
	try { file = decodeURIComponent(match[2]).toLowerCase(); } catch (e) { file = match[2].toLowerCase(); }
	folder = (match[1] || '').toLowerCase();
	if (folder === 'flag' && Object.prototype.hasOwnProperty.call(qureFlags, file))
		return L.resource('bettbox/flags/' + qureFlags[file]);
	if (Object.prototype.hasOwnProperty.call(qureIcons, file))
		return L.resource('bettbox/qure/' + qureIcons[file]);
	return null;
}
var policyArtwork = [
	['adblock',/adblock|广告拦截|去广告/i],
	['claude',/claude/i], ['gemini',/gemini/i], ['grok',/grok/i],
	['chatgpt',/chatgpt|openai/i], ['ai',/(?:^|[^a-z])ai(?:$|[^a-z])|人工智能/i],
	['netflix',/netflix|奈飞/i], ['disney',/disney/i], ['hbo',/(?:^|[^a-z])hbo(?:$|[^a-z])/i],
	['youtube',/youtube|油管/i], ['tiktok',/tiktok|抖音海外/i], ['spotify',/spotify/i],
	['bahamut',/bahamut|巴哈/i], ['emby',/emby/i], ['bilibili',/bilibili|哔哩/i],
	['twitch',/twitch/i], ['telegram',/telegram|电报/i], ['discord',/discord/i],
	['twitter',/twitter|推特/i], ['instagram',/instagram/i], ['facebook',/facebook/i],
	['whatsapp',/whatsapp/i], ['line',/(?:^|[^a-z])line(?:$|[^a-z])/i], ['reddit',/reddit/i],
	['github',/github/i], ['docker',/docker/i], ['cloudflare',/cloudflare/i],
	['google',/google|谷歌/i], ['baidu',/baidu|百度/i], ['onedrive',/onedrive/i],
	['apple',/apple|苹果/i], ['microsoft',/microsoft|微软/i], ['paypal',/paypal/i],
	['pikpak',/pikpak/i], ['crypto',/crypto|bitcoin|binance|okx/i],
	['steam',/steam/i], ['nintendo',/nintendo|switch/i], ['xbox',/xbox/i],
	['playstation',/playstation|psn/i], ['game',/游戏|gaming/i], ['speedtest',/speedtest|测速/i],
	['reject',/^(?:REJECT(?:-DROP)?|拦截|拒绝)$/i],
	['direct',/^(?:DIRECT|直连|绕过)(?:$|[\s\[（(])/i],
	['final',/^(?:FINAL|MATCH|漏网之鱼|兜底|其他流量)$/i],
	['global',/^(?:GLOBAL|全局)$/i], ['auto',/自动选择|自动测速|延迟优选|URLTest/i]
];
function regionOrIcon(proxy, fallback){
	var region = nodeRegion(proxy.name);
	if (!region) {
		var policy=policyArtwork.find(function(item){return item[1].test(proxy.name||'');});
		if(policy)return UI.artwork(policy[0],fallback);
		if(proxy.type==='Direct')return UI.artwork('direct',fallback);
		if(proxy.type==='Reject'||proxy.type==='RejectDrop')return UI.artwork('reject',fallback);
		if(Array.isArray(proxy.all))return UI.artwork(proxy.type==='URLTest'?'auto':'proxy',fallback);
		return UI.icon(fallback);
	}
	var flag = E('img', {
		'class':'bb-proxy-image bb-region-flag', src:L.resource('bettbox/flags/' + region.code + '.svg'),
		alt:'', title:region.name + ' · 按名称识别', width:24, height:24, decoding:'async',
		'data-region':region.code
	});
	flag.addEventListener('error', function(){ flag.replaceWith(UI.icon(fallback)); }, {once:true});
	return flag;
}
function displayName(proxy){
	var name = proxy.name;
	return nodeRegion(name) ? name.replace(/^(?:\s*[\u{1F1E6}-\u{1F1FF}]{2})+\s*/u, '') || name : name;
}
function iconFor(proxy) {
	proxy = proxy || {};
	var fallback = Array.isArray(proxy.all) ? 'route' : 'globe';
	var value = typeof proxy.icon === 'string' ? proxy.icon.trim() : '';
	var localSrc = localIconSrc(value);
	var valid = localSrc || /^(https?:\/\/|\/\/|data:image\/|\.?\.?\/)/i.test(value) ||
		(!/^[a-z][a-z0-9+.-]*:/i.test(value) && /^[A-Za-z0-9_-]+\//.test(value));
	if (!value || !valid) return regionOrIcon(proxy, fallback);
	var remotePending = !!localSrc && /^https?:\/\//i.test(value);
	var image = E('img', {
		'class': 'bb-proxy-image', src: localSrc || value, alt: '', width: 24, height: 24,
		loading: 'lazy', decoding: 'async'
	});
	image.addEventListener('error', function handler() {
		if (remotePending) {
			remotePending = false;
			image.src = value;
			return;
		}
		image.removeEventListener('error', handler);
		image.replaceWith(regionOrIcon(proxy, fallback));
	});
	return image;
}

return view.extend({
	load: function() { return uci.load('bettbox'); },
	render: function() {
		var proxies = new Map(), groups = [], expanded = new Set(), columns = new Map();
		var results = new Map(), requests = new Map(), queue = [], active = 0, enqueueDepth = 0;
		var testBatch = 0, disposed = false, runtimeKey = '', visibleCounts = new Map(), gridObserver = null;
		var reuseSeconds = Number(stored('proxy-test-reuse', '60'));
		if ([0,30,60,300].indexOf(reuseSeconds) < 0) reuseSeconds = 60;
		var cacheKey = 'bettbox-proxy-results-v1', cacheLoaded = false;
		var groupTests = new Map(), selecting = new Set(), allTesting = false;
		var filter = '', snapshot = false, offline = false, refreshPromise = null;
		var serviceState = 'checking', serviceInfo = null, startError = '', dataGeneration = 0;
		var lastAttempt = 0, lastSuccess = 0, layoutKey = '', expansionLoaded = false;
		var profileKey = 'proxy-expanded-v4:' + (uci.get('bettbox', 'config', 'profile') || 'default');
		var viewMode = stored('proxy-view', 'cards'), sortMode = stored('proxy-sort', 'default');
		if (['cards', 'list'].indexOf(viewMode) < 0) viewMode = 'cards';
		if (['default', 'delay', 'name'].indexOf(sortMode) < 0) sortMode = 'default';
		var testURL = stored('test-url', uci.get('bettbox', 'config', 'test_url') || 'https://www.gstatic.com/generate_204');
		if (!document.getElementById('bettbox-proxy-state-css'))
			document.head.appendChild(E('link', { id: 'bettbox-proxy-state-css', rel: 'stylesheet', href: L.resource('bettbox/proxy-state.css') + '?v=20261123-1' }));
		var host = E('div', { 'class': 'v4-groups', 'aria-live': 'off' });
		var banner = E('div', { 'class': 'v4-connection-state', role: 'status', hidden: true });
		var count = E('span', { 'class': 'v4-group-count' }, '—');
		var refreshButton = UI.button('刷新', refresh, '', 'refresh');
		var allButton = UI.button('全部测速', function() { testAll(); }, 'primary', 'activity');
		var cancelButton = UI.button('取消测速', cancelTests, '', 'close'); cancelButton.hidden = true;
		var viewButton = UI.button('切换视图', function() {
			viewMode = viewMode === 'cards' ? 'list' : 'cards';
			persist('proxy-view', viewMode); draw();
		}, 'bb-icon-only v4-view-button', viewMode === 'cards' ? 'list' : 'grid');
		viewButton.setAttribute('aria-label', '切换节点卡片/列表视图');
		var collapseButton = UI.button('全部收起', toggleAll, 'bb-icon-only', 'layers');
		var settingsButton = UI.button('测试设置', settings, 'bb-icon-only', 'settings');
		settingsButton.setAttribute('aria-label', '测试设置');
		var search = UI.search('搜索策略组或节点', function(value) { filter = value.trim().toLowerCase(); visibleCounts.clear(); draw(); });
		var sort = E('select', { 'class': 'field', 'aria-label': '节点排序' }, [
			E('option', { value: 'default' }, '默认排序'),
			E('option', { value: 'delay' }, '延迟优先'),
			E('option', { value: 'name' }, '名称排序')
		]);
		sort.value = sortMode;
		sort.addEventListener('change', function() { sortMode = sort.value; persist('proxy-sort', sortMode); visibleCounts.clear(); draw(); });

		function get(name) { return proxies.get(name) || { name: name || '—', type: 'Unknown' }; }
		function children(group) { return (group.all || []).map(get); }
		function chain(proxy) {
			var list = [], seen = new Set(), current = proxy;
			while (current) {
				if (seen.has(current.name)) return null;
				seen.add(current.name); list.push(current);
				if (!current.now) return list;
				current = get(current.now);
			}
			return list;
		}
		function target(proxy) { var list = chain(proxy); return list && list[list.length - 1]; }
		function testable(proxy) {
			var last = target(proxy);
			return last && !/^(REJECT|REJECT-DROP|PASS)$/i.test(last.name) &&
				!/^(Reject|RejectDrop|Pass|Rematch)$/i.test(last.type || '');
		}
		function requestKey(proxy, url) { return JSON.stringify([runtimeKey, url || testURL, proxy.name]); }
		function saveResults() {
			var entries = Array.from(results.entries()).filter(function(item) { return item[1].status === 'success' && Date.now() - item[1].time <= 300000; }).slice(-512);
			try { sessionStorage.setItem(cacheKey, JSON.stringify(entries)); } catch(e) {}
		}
		function loadResults() {
			if (cacheLoaded) return; cacheLoaded = true;
			try { var data = JSON.parse(sessionStorage.getItem(cacheKey) || '[]');
				if (Array.isArray(data)) data.slice(-512).forEach(function(item) {
					if (Array.isArray(item) && typeof item[0] === 'string' && item[1] && item[1].status === 'success' && item[1].delay > 0 && item[1].time <= Date.now() && Date.now() - item[1].time <= 300000) results.set(item[0], item[1]);
				});
			} catch(e) {}
		}
		function stateFor(proxy) {
			var last = target(proxy);
			if (!last) return { status: 'error', error: '策略组出口形成循环' };
			var key = requestKey(last), pending = requests.get(key);
			if (pending && pending.aliases.has(proxy.name)) return { status: pending.running ? 'testing' : 'queued' };
			if (results.has(key)) return results.get(key);
			var history = last.history || [], item = history[history.length - 1];
			return !item ? { status: 'idle' } : item.delay > 0 ?
				{ status: 'success', delay: item.delay } : { status: 'timeout' };
		}
		function saveExpanded() { persist(profileKey, JSON.stringify(Array.from(expanded))); }
		function initializeLayout() {
			if (!expansionLoaded) {
				expansionLoaded = true;
				var saved = null;
				try { saved = JSON.parse(stored(profileKey, 'null')); } catch(e) {}
				if (Array.isArray(saved)) saved.forEach(function(name) { if (typeof name === 'string') expanded.add(name); });
				else groups.slice(0, 2).forEach(function(group) { expanded.add(group.name); });
			}
			var key = JSON.stringify(groups.map(function(group) { return group.name; }));
			if (key === layoutKey) return;
			layoutKey = key; columns.clear();
			var weights = [0, 0];
			groups.forEach(function(group) {
				var column = weights[0] <= weights[1] ? 0 : 1;
				columns.set(group.name, column);
				weights[column] += expanded.has(group.name) ?
					96 + Math.ceil(group.all.length / (group.all.length === 4 ? 4 : 3)) * 94 : 90;
			});
		}
		function filteredNodes(group) {
			var matchesGroup = group.name.toLowerCase().indexOf(filter) >= 0;
			var list = children(group).filter(function(proxy) {
				return !filter || matchesGroup || (proxy.name + ' ' + proxy.type).toLowerCase().indexOf(filter) >= 0;
			});
			if (sortMode === 'delay') list.sort(function(a, b) {
				var x = stateFor(a), y = stateFor(b);
				return (x.status === 'success' ? x.delay : Infinity) - (y.status === 'success' ? y.delay : Infinity);
			});
			if (sortMode === 'name') list.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }); });
			return list;
		}
		function latency(proxy) {
			if (!testable(proxy)) return E('span', { 'class': 'v4-untestable', title: '此出口不支持连通性测试' }, '—');
			var state = stateFor(proxy);
			var label = state.status === 'testing' ? '检测中' : state.status === 'queued' ? '排队中' :
				state.status === 'success' ? state.delay + ' ms' : state.status === 'timeout' ? '超时' :
				state.status === 'error' ? '失败' : '测试';
			var button = E('button', {
				type: 'button', 'class': 'proxy-latency v4-latency ' + state.status,
				'data-test-node': proxy.name, 'aria-label': '单独测试 ' + proxy.name + ' 的连通性',
				title: state.error || '单独测试此出口'
			}, [UI.icon(state.status === 'testing' || state.status === 'queued' || state.status === 'timeout' ? 'refresh' : 'bolt'), E('span', {}, label)]);
			button.disabled = offline || state.status === 'testing' || state.status === 'queued';
			button.addEventListener('click', function(event) { event.stopPropagation(); testOne(proxy); });
			return button;
		}
		function shareable(proxy) {
			return proxy && !Array.isArray(proxy.all) &&
				!/^(Direct|Reject|RejectDrop|Pass|Compatible|Unknown|Selector|URLTest|Fallback|LoadBalance|Relay)$/i.test(proxy.type || '');
		}
		function showProxyConfig(proxy) {
			var body = E('div', { 'class': 'bb-proxy-share' }, [
				E('div', { 'class': 'v4-loading', role: 'status' }, [UI.icon('refresh'), document.createTextNode('正在读取节点配置…')])
			]);
			var actions = E('div', { 'class': 'button-row bb-proxy-share-actions' }, [UI.button('关闭', ui.hideModal)]);
			UI.modal('配置信息 · ' + (proxy.name || ''), [body, actions]);
			Core.get('/bettbox/proxy-config?name=' + encode(proxy.name)).then(function(res) {
				var data = res && res.data;
				if (!data || !data.yaml) throw new Error('未能读取节点配置');
				var nodes = [];
				if (data.dialer) {
					nodes.push(E('div', { 'class': 'bb-proxy-share-meta' }, [
						UI.tag('前置代理: ' + data.dialer, 'neutral')
					]));
				}
				if (data.uri) {
					var qrSvg = QRCode.svg(data.uri, { size: 184, label: (proxy.name || '') + ' 二维码' });
					if (qrSvg) nodes.push(E('div', { 'class': 'bb-qr-card' }, [qrSvg]));
					var uriInput = E('input', { 'class': 'field mono', type: 'text', value: data.uri, readonly: true, 'aria-label': '分享链接' });
					nodes.push(UI.field('分享链接', E('div', { 'class': 'bb-proxy-share-row' }, [
						uriInput,
						UI.button('复制 URI', function() { return UI.copy(data.uri); }, 'soft', 'copy')
					])));
				} else {
					nodes.push(E('p', { 'class': 'small muted', style: 'margin:0' }, '此协议暂不支持生成 URI 分享链接，可使用下方 YAML 片段。'));
				}
				var yamlEl = E('pre', { 'class': 'bb-proxy-yaml mono' }, data.yaml);
				nodes.push(UI.field('YAML 配置', yamlEl));
				body.replaceChildren.apply(body, nodes);
				var saveBtn = UI.button('保存到节点库', function() {
					return importNodesRPC(data.yaml).then(UI.checked).then(function() {
						ui.addNotification(null, E('p', {}, '已将节点“' + proxy.name + '”保存到节点库'), 'info');
					});
				}, '', 'plus');
				actions.replaceChildren(
					UI.button('复制 YAML', function() { return UI.copy(data.yaml); }, 'soft', 'copy'),
					saveBtn,
					UI.button('关闭', ui.hideModal)
				);
			}).catch(function(err) {
				body.replaceChildren(E('p', { 'class': 'v4-state-error', style: 'margin:0' }, '读取失败：' + (err.message || err)));
			});
		}
		function nodeFooter(proxy) {
			var parts = [E('span', { 'class': 'v4-protocol' }, proxy.type || '—')];
			if (shareable(proxy)) {
				var infoBtn = UI.button('', function(event) { event.stopPropagation(); showProxyConfig(proxy); }, 'bb-icon-only v4-node-info', 'code');
				infoBtn.setAttribute('aria-label', '查看 ' + proxy.name + ' 配置与分享');
				infoBtn.setAttribute('title', '配置信息 / 分享');
				parts.push(infoBtn);
			}
			parts.push(latency(proxy));
			return parts;
		}
		function nodeCard(group, proxy) {
			var selected = group.now === proxy.name;
			var choose = E('button', {
				type: 'button', 'class': 'node-select v4-node-select', 'data-node': proxy.name,
				'data-select-group': group.name, 'aria-pressed': String(selected), title: proxy.name, 'aria-label':proxy.name
			}, [E('span', { 'class': 'v4-node-icon' }, iconFor(proxy)), E('span', { 'class': 'v4-node-name' }, displayName(proxy))]);
			if (selected) choose.appendChild(E('span', { 'class': 'v4-selected-mark' }, UI.icon('check')));
			choose.disabled = offline || selecting.has(group.name);
			choose.addEventListener('click', function() { selectNode(group, proxy); });
			var card = E('article', { 'class': 'v4-node' + (selected ? ' selected' : ''), 'data-proxy-name': proxy.name }, [
				choose, E('div', { 'class': 'v4-node-footer' }, nodeFooter(proxy))
			]);
			card.addEventListener('contextmenu', function(event) { event.preventDefault(); if (!offline) testOne(proxy); });
			return card;
		}
		function nodeGrid(group, list) {
			var limit = Math.min(list.length, visibleCounts.get(group.name) || 48);
			var grid = E('div', {
				'class': 'proxy-node-grid v4-node-grid' + (viewMode === 'list' ? ' list-view' : ''), 'data-count': String(list.length)
			}, list.length ? list.slice(0, limit).map(function(proxy) { return nodeCard(group, proxy); }) : [E('div', { 'class': 'v4-no-nodes' }, '暂无节点')]);
			if (limit < list.length) {
				var more = E('button', { type: 'button', 'class': 'btn v4-load-more', 'aria-label': '加载更多 ' + group.name + ' 节点' }, '加载更多 · ' + limit + '/' + list.length);
				function append() {
					if (!grid.isConnected || disposed) return;
					var end = Math.min(list.length, limit + 48), fragment = document.createDocumentFragment();
					list.slice(limit, end).forEach(function(proxy) { fragment.appendChild(nodeCard(group, proxy)); });
					grid.insertBefore(fragment, more); limit = end; visibleCounts.set(group.name, limit);
					if (limit === list.length) { if (gridObserver) gridObserver.unobserve(more); more.remove(); }
					else more.textContent = '加载更多 · ' + limit + '/' + list.length;
				}
				more.addEventListener('click', append); more.loadNodes = append; grid.appendChild(more);
				if (gridObserver) gridObserver.observe(more);
			}
			return grid;
		}
		function currentChain(group) {
			var list = chain(group), selected = group.now ? get(group.now) : null;
			var row = E('span', { 'class': 'v4-current', title: list ? list.slice(1).map(function(p) { return p.name; }).join(' → ') : '策略组出口形成循环' }, UI.icon('arrow'));
			if (!selected) { row.appendChild(E('span', {}, '—')); return row; }
			function item(proxy, final) {
				return E('span', { 'class': 'v4-current-item' + (final ? ' final' : '') }, [
					E('span', { 'class': 'v4-current-icon' }, iconFor(proxy)), E('span', { 'class': 'v4-current-name', title:proxy.name }, displayName(proxy))
				]);
			}
			row.appendChild(item(selected, false));
			var last = list && list[list.length - 1];
			if (last && last.name !== selected.name) { row.appendChild(E('span', { 'class': 'v4-chain-arrow' }, '›')); row.appendChild(item(last, true)); }
			return row;
		}
		function groupCard(group, list, index) {
			var open = !!filter || expanded.has(group.name);
			var toggle = E('button', {
				type: 'button', 'class': 'v4-group-toggle', 'data-expand-group': group.name,
				'aria-expanded': String(open), 'aria-label': group.name
			}, [E('span', { 'class': 'v4-disclosure' }, UI.icon('chevron')),
				E('span', { 'class': 'v4-group-icon' }, iconFor(group)), E('span', { 'class': 'v4-group-copy' }, [
					E('span', { 'class': 'v4-group-title-row' }, [E('strong', { 'class': 'v4-group-title' }, displayName(group)),
						E('span', { 'class': 'v4-group-type' }, group.type || ''),
						E('span', { 'class': 'v4-node-count' }, String(list.length === group.all.length ? list.length : list.length + '/' + group.all.length))]), currentChain(group)
				])]);
			toggle.addEventListener('click', function() {
				if (expanded.has(group.name)) expanded.delete(group.name); else expanded.add(group.name);
				saveExpanded(); draw();
			});
			var test = UI.button('测试 ' + group.name + ' 组', function() { testGroup(group); }, 'bb-icon-only v4-group-test', 'bolt');
			test.setAttribute('data-test-group', group.name); test.setAttribute('aria-label', '测试 ' + group.name + ' 组');
			test.disabled = offline || groupTests.has(group.name) || !children(group).some(testable);
			test.classList.toggle('testing', groupTests.has(group.name));
			return E('section', {
				'class': 'panel v4-group' + (open ? ' open' : ''), 'data-group-name': group.name, style: '--group-order:' + index
			}, [E('div', { 'class': 'v4-group-head' }, [toggle, test]), open ? nodeGrid(group, list) : document.createTextNode('')]);
		}
		function inactive() { return serviceState === 'stopped' || serviceState === 'idle' || serviceState === 'starting'; }
		function inactiveCard() {
			var starting = serviceState === 'starting';
			var id = serviceInfo && serviceInfo.profile || uci.get('bettbox', 'config', 'profile') || '';
			var name = id ? uci.get('bettbox', id, 'label') || '已选择订阅' : '未选择订阅';
			var primary = id ? UI.button(starting ? '正在启动…' : startError ? '重试启动' : '启动服务', startService, 'primary', starting ? 'refresh' : 'power') :
				E('a', { 'class': 'btn primary', href: L.url('admin', 'services', 'bettbox', 'profiles') }, '添加订阅');
			primary.disabled = starting;
			return E('section', { 'class': 'panel v4-state-card' + (starting ? ' starting' : ''), 'aria-labelledby': 'bettbox-proxy-state-title' }, [
				E('div', { 'class': 'v4-state-symbol' }, UI.icon(starting ? 'refresh' : 'power')),
				E('h2', { id: 'bettbox-proxy-state-title' }, starting ? '正在启动服务' : serviceState === 'idle' ? '服务未运行' : '服务未启动'),
				E('div', { 'class': 'v4-state-profile' }, id ? [E('span', {}, '当前订阅'), E('strong', {}, name)] : E('span', {}, name)),
				startError ? E('p', { 'class': 'v4-state-error', role: 'alert' }, startError) : document.createTextNode(''),
				E('div', { 'class': 'v4-state-actions' }, [primary, id ? E('a', { 'class': 'btn text', href: L.url('admin', 'services', 'bettbox', 'profiles') }, '管理订阅') : document.createTextNode('')])
			]);
		}
		function stopped(status) {
			if (snapshot || groups.length || requests.size) {
				dataGeneration++; cancelTests(); results.clear(); saveResults();
				proxies.clear(); groups = []; snapshot = false; layoutKey = '';
			}
			serviceInfo = status; serviceState = status.enabled ? 'idle' : 'stopped'; offline = true; banner.hidden = true; draw();
		}
		function startService() {
			if (serviceState === 'starting') return Promise.resolve();
			dataGeneration++; startError = ''; serviceState = 'starting'; draw();
			return serviceAction('start').then(UI.operation).then(function() {
				return Promise.resolve(refreshPromise).then(function() { serviceState = 'checking'; return refresh(); });
			}).catch(function(error) {
				startError = error.message || String(error);
				return getStatus().then(function(status) {
					if (status && status.service_known !== false && status.running === false) { stopped(status); return; }
					serviceState = 'unknown'; offline = true; connectionError(error, '启动服务失败'); draw();
				}, function() { serviceState = 'unknown'; offline = true; connectionError(error, '启动服务失败'); draw(); });
			});
		}
		function draw() {
			if (disposed) return;
			if (gridObserver) gridObserver.disconnect();
			var quiet = inactive() || serviceState === 'checking';
			controls.hidden = quiet; refreshButton.hidden = quiet; allButton.hidden = quiet; count.hidden = !snapshot || quiet;
			cancelButton.hidden = quiet || !requests.size;
			host.classList.toggle('v4-inactive', inactive());
			if (inactive()) { banner.hidden = true; host.classList.remove('stale'); host.replaceChildren(inactiveCard()); return; }
			count.textContent = snapshot ? groups.length + ' 个策略组' : '—';
			allButton.disabled = !groups.length || offline || allTesting;
			collapseButton.disabled = !groups.length || !!filter;
			var closed = groups.every(function(group) { return !expanded.has(group.name); });
			collapseButton.setAttribute('aria-label', closed ? '全部展开' : '全部收起');
			collapseButton.setAttribute('title', closed ? '全部展开' : '全部收起');
			viewButton.replaceChildren(UI.icon(viewMode === 'cards' ? 'list' : 'grid'), E('span', {}, '切换视图'));
			if (!snapshot) return;
			if (!groups.length) {
				host.replaceChildren(E('div', { 'class': 'v4-no-data' }, [UI.icon('info'), E('strong', {}, '暂无策略组'),
					E('a', { 'class': 'btn', href: L.url('admin', 'services', 'bettbox', 'profiles') }, '管理订阅')])); return;
			}
			var cols = [E('div', { 'class': 'v4-group-column' }), E('div', { 'class': 'v4-group-column' })], matches = 0;
			groups.forEach(function(group, index) {
				var list = filteredNodes(group);
				if (filter && !list.length && group.name.toLowerCase().indexOf(filter) < 0) return;
				cols[columns.get(group.name) || 0].appendChild(groupCard(group, list, index)); matches++;
			});
			host.replaceChildren.apply(host, matches ? cols : [E('div', { 'class': 'v4-no-data' }, '没有匹配的策略组或节点')]);
		}
		function toggleAll() {
			var open = groups.every(function(group) { return !expanded.has(group.name); });
			groups.forEach(function(group) { if (open) expanded.add(group.name); else expanded.delete(group.name); });
			saveExpanded(); draw();
		}
		function updateTests() {
			if (disposed) return;
			Array.from(host.querySelectorAll('[data-proxy-name]')).forEach(function(card) {
				var proxy = get(card.dataset.proxyName), footer = card.querySelector('.v4-node-footer');
				footer.replaceChildren.apply(footer, nodeFooter(proxy));
			});
			Array.from(host.querySelectorAll('[data-test-group]')).forEach(function(button) {
				var group = get(button.dataset.testGroup), testing = groupTests.has(group.name);
				button.disabled = offline || testing || !children(group).some(testable); button.classList.toggle('testing', testing);
			});
			allButton.disabled = !groups.length || offline || allTesting;
			cancelButton.hidden = !requests.size || inactive();
		}
		function cancelTests() {
			testBatch++;
			requests.forEach(function(entry) { entry.cancelled = true; entry.resolve(); });
			requests.clear(); queue = []; groupTests.clear(); allTesting = false;
			allButton.querySelector('span').textContent = '全部测速'; updateTests();
		}
		function pump() {
			if (offline || disposed) return;
			while (active < 2 && queue.length) run(queue.shift());
		}
		function run(entry) {
			var generation = dataGeneration;
			active++; entry.running = true; updateTests();
			Promise.resolve().then(function() {
				if (!disposed && !entry.cancelled && generation === dataGeneration) return UI.job('delay', [encode(entry.target.name), encode(entry.url)]);
			}).then(function(response) {
				if (disposed || entry.cancelled || generation !== dataGeneration) return;
				var data = JSON.parse(response.text); if (!(data.delay > 0)) throw new Error('未获得有效延迟');
				results.delete(entry.key); results.set(entry.key, { status: 'success', delay: data.delay, time: Date.now() });
				while (results.size > 512) results.delete(results.keys().next().value);
				saveResults();
			}).catch(function(error) {
				if (disposed || entry.cancelled || generation !== dataGeneration) return;
				results.set(entry.key, { status: /504|timeout|timed out|超时/i.test(error.message) ? 'timeout' : 'error', error: String(error.message || error).slice(0,300) });
				while (results.size > 512) results.delete(results.keys().next().value);
			}).finally(function() {
				active--; if (requests.get(entry.key) === entry) requests.delete(entry.key); entry.resolve(); pump();
				if (sortMode === 'delay') draw(); else updateTests();
			});
		}
		function testOne(proxy, reuse) {
			if (offline || disposed || !testable(proxy)) return Promise.resolve();
			var last = target(proxy), key = requestKey(last), entry = requests.get(key);
			if (entry) { entry.aliases.add(proxy.name); if (!enqueueDepth) updateTests(); return entry.promise; }
			var cached = results.get(key);
			if (reuse === true && reuseSeconds > 0 && cached && cached.status === 'success' && cached.time <= Date.now() && Date.now() - cached.time < reuseSeconds * 1000) return Promise.resolve();
			entry = { key: key, target: last, url: testURL, aliases: new Set([proxy.name]), running: false };
			entry.promise = new Promise(function(resolve) { entry.resolve = resolve; });
			requests.set(key, entry); queue.push(entry);
			if (!enqueueDepth) { updateTests(); pump(); }
			return entry.promise;
		}
		function testGroup(group) {
			if (offline) return Promise.resolve();
			if (groupTests.has(group.name)) return groupTests.get(group.name);
			var tasks;
			enqueueDepth++;
			try { tasks = children(group).map(function(proxy) { return testOne(proxy, true); }); }
			finally { enqueueDepth--; }
			var pending = Promise.all(tasks).finally(function() {
				if (groupTests.get(group.name) === pending) groupTests.delete(group.name); updateTests();
			});
			groupTests.set(group.name, pending); updateTests(); pump(); return pending;
		}
		function testAll() {
			if (offline || allTesting) return Promise.resolve();
			var batch = testBatch;
			allTesting = true; allButton.querySelector('span').textContent = '检测中…';
			return Promise.all(groups.map(testGroup)).finally(function() {
				if (batch !== testBatch) return;
				allTesting = false; allButton.querySelector('span').textContent = '全部测速'; updateTests();
			});
		}
		function selectNode(group, proxy) {
			if (offline || selecting.has(group.name) || group.now === proxy.name) return;
			var generation = dataGeneration;
			selecting.add(group.name);
			Array.from(host.querySelectorAll('[data-select-group]')).forEach(function(button) {
				if (button.dataset.selectGroup === group.name) button.disabled = true;
			});
			Core.put('/proxies/' + encode(group.name), { name: proxy.name }).then(function() {
				// Keep the confirmed selection even if the subsequent snapshot fails.
				return Promise.resolve(refreshPromise).then(function() {
					if (generation !== dataGeneration) return;
					get(group.name).now = proxy.name; draw(); return refresh();
				});
			}).catch(function(error) { if (generation === dataGeneration) UI.error(error); }).finally(function() { selecting.delete(group.name); draw(); });
		}
		function settings() {
			var input = E('input', { 'class': 'field', type: 'url', value: testURL, 'aria-label': '测试地址' });
			var reuse = E('select', { 'class': 'field', 'aria-label': '批量结果复用' }, [0,30,60,300].map(function(n) { return E('option', { value: String(n) }, n ? n + ' 秒' : '每次重新检测'); })); reuse.value = String(reuseSeconds);
			UI.modal('测试设置', [UI.field('测试地址', input), UI.field('批量结果复用', reuse)], [UI.button('保存', function() {
				var address = input.value.trim();
				try { if (!/^https?:$/.test(new URL(address).protocol)) throw new Error(); }
				catch(e) { throw new Error('请输入有效的 http(s) 测试地址'); }
				if (address !== testURL) cancelTests();
				testURL = address; reuseSeconds = Number(reuse.value); persist('proxy-test-reuse', String(reuseSeconds)); persist('test-url', address); ui.hideModal(); draw();
			}, 'primary', 'save'), UI.button('取消', ui.hideModal)]);
		}
		function connectionError(error, message) {
			var code = error && error.httpStatus;
			var title = message || (code === 401 || code === 403 ? '控制器认证失败' : code === 408 || code === 504 ? '控制器连接超时' : serviceState === 'unknown' ? '暂时无法确认服务状态' : '控制器连接中断');
			banner.hidden = false; banner.title = error.message || String(error);
			banner.replaceChildren(UI.icon('info'), E('div', {}, [E('strong', {}, title),
				snapshot ? E('time', {}, '上次数据 · ' + new Date(lastSuccess).toLocaleTimeString()) : document.createTextNode('')]),
				UI.button('重试', refresh, 'small', 'refresh'));
			if (!snapshot) host.replaceChildren(E('div', { 'class': 'v4-no-data' },
				E('a', { 'class': 'btn', href: L.url('admin', 'services', 'bettbox', 'overview') }, '查看概览')));
		}
		function refresh() {
			if (disposed) return Promise.resolve();
			if (serviceState === 'starting') return Promise.resolve();
			if (refreshPromise) return refreshPromise;
			var generation = dataGeneration;
			lastAttempt = Date.now();
			refreshPromise = getStatus().catch(function() { return { service_known: false }; }).then(function(status) {
				if (generation !== dataGeneration) return null;
				serviceInfo = status;
				var nextProfileKey = 'proxy-expanded-v4:' + (status && status.profile || 'default');
				if (nextProfileKey !== profileKey) { profileKey = nextProfileKey; expansionLoaded = false; expanded.clear(); layoutKey = ''; }
				var nextKey = JSON.stringify([status && status.profile || '', status && status.controller || '', status && status.pid || 0, status && status.config_stamp || 0]);
				if (runtimeKey && runtimeKey !== nextKey) { cancelTests(); results.clear(); visibleCounts.clear(); dataGeneration++; generation = dataGeneration; }
				runtimeKey = nextKey; loadResults();
				if (status && status.service_known !== false && status.running === false && typeof status.enabled === 'boolean') { stopped(status); return null; }
				serviceState = status && status.running === true ? 'live' : 'unknown';
				return Core.get('/proxies');
			}).then(function(response) {
				if (!response || generation !== dataGeneration) return;
				var data = response.data && response.data.proxies;
				if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('控制器未返回节点数据');
				var next = new Map();
				Object.keys(data).forEach(function(name) {
					if (data[name] && typeof data[name] === 'object') next.set(name, Object.assign({}, data[name], { name: name }));
				});
				var global = next.get('GLOBAL'), order = global && Array.isArray(global.all) ? global.all.slice() : [];
				var seen = new Set(); order = order.concat(Array.from(next.keys()));
				groups = order.filter(function(name) { if (seen.has(name)) return false; seen.add(name); return true; }).map(function(name) { return next.get(name); }).filter(function(proxy) {
					return proxy && proxy.name !== 'GLOBAL' && !proxy.hidden && Array.isArray(proxy.all);
				});
				serviceState = 'live'; startError = ''; proxies = next; snapshot = true; offline = false; lastSuccess = Date.now(); banner.hidden = true;
				initializeLayout(); host.classList.remove('stale'); draw(); pump();
			}).catch(function(error) {
				if (generation !== dataGeneration) return;
				offline = true; connectionError(error);
				if (snapshot) host.classList.add('stale');
				draw();
			}).finally(function() { refreshPromise = null; });
			return refreshPromise;
		}

		refreshButton.classList.add('v4-action-btn');
		cancelButton.classList.add('v4-action-btn');
		allButton.classList.add('v4-action-btn');
		var controls = E('div', { 'class': 'v4-controls' }, [search, E('div', { 'class': 'v4-control-actions' }, [count, sort, viewButton, collapseButton, settingsButton, refreshButton, cancelButton, allButton])]);
		if (typeof IntersectionObserver !== 'undefined') gridObserver = new IntersectionObserver(function(entries) { entries.forEach(function(entry) { if (entry.isIntersecting && entry.target.loadNodes) entry.target.loadNodes(); }); }, { rootMargin: '480px' });
		var root = UI.page('proxies', '代理', [], [controls, banner, host]);
		function dispose() { if (disposed) return; disposed = true; dataGeneration++; cancelTests(); if (gridObserver) gridObserver.disconnect(); lifecycle.disconnect(); window.removeEventListener('pagehide', dispose); }
		// LuCI may attach the returned view after other body mutations. A view
		// which has not mounted yet must not be mistaken for a removed view.
		var mounted = root.isConnected;
		var lifecycle = new MutationObserver(function(records) {
			if (root.isConnected) { mounted = true; return; }
			var removed = records.some(function(record) {
				return Array.from(record.removedNodes).some(function(node) { return node === root || (node.contains && node.contains(root)); });
			});
			if (mounted || removed) dispose();
		}); lifecycle.observe(document.body, { childList: true, subtree: true });
		window.addEventListener('pagehide', dispose);
		root.classList.add('v4-proxies');
		host.appendChild(E('div', { 'class': 'v4-loading', role: 'status' }, [UI.icon('refresh'), document.createTextNode('正在读取服务状态…')]));
		UI.poll(root, function() {
			if (disposed || !root.isConnected) return Promise.resolve();
			if (Date.now() - lastAttempt < (inactive() ? 5000 : 15000)) return Promise.resolve();
			return refresh();
		}, 5);
		draw(); refresh(); return root;
	},
	handleSaveApply: null, handleSave: null, handleReset: null
});
