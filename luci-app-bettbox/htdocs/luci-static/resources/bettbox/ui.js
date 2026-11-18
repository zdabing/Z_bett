'use strict';
'require baseclass';
'require ui';
'require rpc';
'require poll';
'require uci';

var startJob = rpc.declare({ object: 'bettbox', method: 'diagnostic_start', params: ['kind', 'args_json'] });
var getJob = rpc.declare({ object: 'bettbox', method: 'diagnostic_status', params: ['id'] });
var PAGES = [ ['overview','概览','grid','blue'], ['proxies','代理','route','green'], ['connections','连接','link','purple'], ['profiles','订阅','file','orange'], ['resources','资源','layers','teal'], ['toolbox','工具箱','terminal','blue'], ['logs','日志','list','orange'], ['settings','设置','settings','teal'] ];
var TINTS = {
	grid:'blue', activity:'blue', globe:'blue', down:'blue', terminal:'blue', search:'blue',
	route:'green', chip:'green', shield:'green', power:'green', check:'green',
	up:'orange', file:'orange', list:'orange', clock:'orange', bolt:'orange', tune:'orange',
	traffic:'purple', link:'purple', palette:'purple',
	layers:'teal', lan:'teal', settings:'teal', download:'teal'
};
var PATHS = {
	palette:'<path d="M21 12a9 9 0 1 0-9 9h1a2 2 0 0 0 1.5-3.3 1.8 1.8 0 0 1 1.4-3H18a3 3 0 0 0 3-2.7Z"/><circle cx="7.5" cy="11" r=".8"/><circle cx="11" cy="7" r=".8"/><circle cx="16" cy="8.5" r=".8"/>',
	eye:'<path d="M2 12c5-9 15-9 20 0-5 9-15 9-20 0Z"/><circle cx="12" cy="12" r="3"/>',
	grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
	route:'<path d="M4 6h15m-5-4 5 4-5 4M20 18H5m5-4-5 4 5 4"/>',link:'<path d="m10 8 3-3a5 5 0 0 1 7 7l-3 3m-3 1-3 3a5 5 0 0 1-7-7l3-3m1 7 8-8"/>',
	file:'<path d="M6 3h9l4 4v14H6Z"/><path d="M14 3v5h5M9 13h7m-7 4h5"/>',code:'<path d="m8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18"/>',layers:'<path d="m3 7 9-5 9 5-9 5Z"/><path d="m3 12 9 5 9-5m-18 5 9 5 9-5"/>',
	terminal:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 4 3-4 3m7 0h5"/>',list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',settings:'<path d="M3 7h11m5 0h2M3 17h4m5 0h9"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
	refresh:'<path d="M20 8A8 8 0 0 0 6 6L3 9m0-5v5h5m-4 7a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',plus:'<path d="M12 4v16M4 12h16"/>',search:'<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',chevron:'<path d="m8 4 8 8-8 8"/>',
	down:'<path d="M12 3v17m-6-6 6 6 6-6"/>',up:'<path d="M12 21V4m-6 6 6-6 6 6"/>',power:'<path d="M12 3v9m-6-6a9 9 0 1 0 12 0"/>',globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
	lan:'<rect x="8" y="3" width="8" height="6" rx="1"/><path d="M12 9v5M5 14h14v3M5 14v3"/><rect x="2" y="17" width="6" height="4" rx="1"/><rect x="16" y="17" width="6" height="4" rx="1"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H4v13h4"/>',chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',
	arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',pause:'<path d="M8 4v16M16 4v16"/>',save:'<path d="M4 3h14l3 3v15H3V3Zm3 0v6h10V3M7 21v-8h10v8"/>',edit:'<path d="m15 3 6 6L9 21H3v-6ZM12 6l6 6"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',shield:'<path d="m12 2 9 4v7c0 5-9 9-9 9s-9-4-9-9V6Z"/>',traffic:'<path d="M12 3a9 9 0 1 0 9 9h-9Z"/><path d="M15 2v7h7a9 9 0 0 0-7-7Z"/>',bolt:'<path d="m13 2-8 11h6l-1 9 9-12h-6Z"/>'
};
function icon(name) {
	var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
	svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','19');svg.setAttribute('height','19');
	svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');
	svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
	svg.setAttribute('class','ico');svg.setAttribute('aria-hidden','true');
	// Only static, application-owned SVG paths enter innerHTML.
	svg.innerHTML=PATHS[name]||PATHS.grid;return svg;
}
function badge(name, extra, tint) {
	return E('span', {
		'class': 'bb-icon-badge bb-tint-' + (tint || TINTS[name] || 'blue') + (extra ? ' ' + extra : ''),
		'aria-hidden': 'true'
	}, icon(name));
}
var ARTWORK = {
	proxy:'Proxy', auto:'Auto', direct:'Direct', reject:'Reject', final:'Final', global:'Global',
	adblock:'AdBlock', claude:'Claude', gemini:'Gemini', grok:'Grok', chatgpt:'ChatGPT', ai:'AI',
	netflix:'Netflix', disney:'Disney', hbo:'HBO', youtube:'YouTube', tiktok:'TikTok', spotify:'Spotify',
	bahamut:'Bahamut', emby:'Emby', bilibili:'Bilibili', telegram:'Telegram', discord:'Discord',
	twitter:'Twitter', instagram:'Instagram', facebook:'Facebook', whatsapp:'WhatsApp', line:'Line',
	reddit:'Reddit', github:'GitHub', docker:'Docker', cloudflare:'Cloudflare', google:'Google',
	baidu:'Baidu', onedrive:'OneDrive', apple:'Apple', microsoft:'Microsoft', paypal:'PayPal',
	pikpak:'PikPak', crypto:'Bitcoin', steam:'Steam', nintendo:'Nintendo', xbox:'Xbox',
	playstation:'PlayStation', game:'Game', twitch:'Twitch', speedtest:'Speedtest'
};
function artwork(name, fallback){
	var file=ARTWORK[name];
	if(!file)return icon(fallback||'globe');
	var image=E('img', {
		'class':'bb-proxy-image bb-artwork',src:L.resource('bettbox/qure/'+file+'.svg'),
		alt:'',width:24,height:24,decoding:'async'
	});
	image.addEventListener('error',function(){image.replaceWith(icon(fallback||'globe'));},{once:true});
	return image;
}
function error(err){ui.addNotification(null,E('p',{},String(err && err.message || err || '操作失败')),'error');}
function checked(res){if(!res || res.ok!==true)throw new Error(res && (res.error||res.text)||'操作失败');return res;}
function button(label,fn,kind,ico){
	var el=E('button',{type:'button','class':'btn '+(kind||'')},(ico?[icon(ico)]:[]).concat([E('span',{},label)]));
	if(fn)el.addEventListener('click',function(ev){ev.preventDefault();var result;try{result=fn(ev,el);}catch(e){error(e);return;}
		if(result && typeof result.then==='function'){el.disabled=true;return Promise.resolve(result).catch(error).finally(function(){el.disabled=false;});}});
	return el;
}
var styles = { meridian:'Meridian 橙彩', apple:'Apple 卡片', host:'跟随宿主主题' };
var styleLabels = { meridian:'Meridian', apple:'Apple', host:'跟随宿主' };
var styleOrder = ['meridian', 'apple', 'host'];
var modes = { system:'跟随系统', light:'浅色', dark:'深色' };
var appearanceKey = 'bettbox.appearance.v1';
var appearance, systemScheme, appearanceListeners = [];
function readAppearance(){
	var saved;
	try { saved = JSON.parse(localStorage.getItem(appearanceKey)); } catch (_) {}
	var style = saved && Object.hasOwn(styles, saved.style) ? saved.style : 'meridian';
	var mode = saved && Object.hasOwn(modes, saved.mode) ? saved.mode : 'system';
	return { style: style, mode: mode };
}
function notifyAppearance(){
	appearanceListeners = appearanceListeners.filter(function(fn){ return fn() !== false; });
}
function paintAppearance(){
	document.body.dataset.bbStyle = appearance.style;
	document.body.dataset.bbScheme = appearance.mode === 'system' ? (systemScheme.matches ? 'dark' : 'light') : appearance.mode;
	notifyAppearance();
}
function setAppearance(patch){
	if (!appearance) mountAppearance();
	if (patch.style && Object.hasOwn(styles, patch.style)) appearance.style = patch.style;
	if (patch.mode && Object.hasOwn(modes, patch.mode)) appearance.mode = patch.mode;
	paintAppearance();
	try { localStorage.setItem(appearanceKey, JSON.stringify(appearance)); } catch (_) {}
}
function mountAppearance(){
	if (!appearance) {
		appearance = readAppearance();
		systemScheme = window.matchMedia('(prefers-color-scheme: dark)');
		systemScheme.addEventListener('change', paintAppearance);
		window.addEventListener('storage', function(event){
			if (event.key !== appearanceKey && event.key !== null) return;
			appearance = readAppearance(); paintAppearance();
		});
	}
	paintAppearance();
}
function appearanceControls(compact){
	mountAppearance();
	var wrap = E('div', {'class':'bb-appearance-controls'});
	var styleRow = E('div', {'class':'bb-style-grid', role:'radiogroup', 'aria-label':'界面风格'}, Object.keys(styles).map(function(key){
		var radio = E('input', {type:'radio', name:'bb-style-'+(compact?'modal':'page'), value:key});
		radio.checked = appearance.style === key;
		radio.addEventListener('change', function(){ setAppearance({style:key}); });
		return E('label', {'class':'bb-style-card'+(appearance.style===key?' active':''), 'data-style':key}, [
			radio,
			E('span', {'class':'bb-style-radio', 'aria-hidden':'true'}),
			E('span', {'class':'bb-style-name'}, styles[key])
		]);
	}));
	var modeRow = E('div', {'class':'bb-mode-segmented', role:'radiogroup', 'aria-label':'外观模式'}, Object.keys(modes).map(function(key){
		var b = E('button', {type:'button', 'class':'bb-mode-btn'+(appearance.mode===key?' active':''), 'data-mode':key, 'aria-pressed':String(appearance.mode===key)}, modes[key]);
		b.addEventListener('click', function(){ setAppearance({mode:key}); });
		return b;
	}));
	function sync(){
		if (!wrap.isConnected && wrap._mounted) return false;
		if (wrap.isConnected) wrap._mounted = true;
		Array.from(styleRow.children).forEach(function(card){
			var on = card.dataset.style === appearance.style;
			card.classList.toggle('active', on);
			card.querySelector('input').checked = on;
		});
		Array.from(modeRow.children).forEach(function(b){
			var on = b.dataset.mode === appearance.mode;
			b.classList.toggle('active', on);
			b.setAttribute('aria-pressed', String(on));
		});
	}
	appearanceListeners.push(sync);
	wrap.appendChild(E('div', {'class':'bb-appearance-group'}, [E('div', {'class':'bb-appearance-label'}, '界面风格'), styleRow]));
	wrap.appendChild(E('div', {'class':'bb-appearance-group'}, [E('div', {'class':'bb-appearance-label'}, '明暗模式'), modeRow]));
	return wrap;
}
function themePicker(){
	modal('主题与风格', [appearanceControls(true)]);
}
function mount(){
	document.body.classList.add('bb-page');
	mountAppearance();
	var link=document.getElementById('bettbox-ui-css');
	if(!link){
		var guard=E('style',{id:'bettbox-fouc-guard'},'.bb-app{visibility:hidden}');
		var reveal=function(){if(guard.parentNode)guard.remove();};
		link=E('link',{id:'bettbox-ui-css',rel:'stylesheet',href:L.resource('bettbox/ui.css')+'?v=20261118-3'});
		link.addEventListener('load',reveal,{once:true});
		link.addEventListener('error',reveal,{once:true});
		document.head.appendChild(guard);
		document.head.appendChild(link);
		if(link.sheet)reveal();
		else window.setTimeout(reveal,250);
	}
}
var navSeq = 0, popstateWired = false;
function trackPoll(root, fn, interval){
	var mounted = false;
	function wrapped(){
		if (root && root.isConnected) mounted = true;
		if (!root || (mounted && !root.isConnected)) {
			if (poll && typeof poll.remove === 'function') poll.remove(wrapped);
			return Promise.resolve();
		}
		return fn();
	}
	poll.add(wrapped, interval);
	return wrapped;
}
function navigateTo(pageId, href, fromPopstate){
	var activeRoot = document.querySelector('.bb-app[data-bb-page]');
	if (!activeRoot || !window.L || typeof L.require !== 'function') {
		window.location.assign(href);
		return Promise.resolve();
	}
	var seq = ++navSeq;
	Array.from(activeRoot.querySelectorAll('.bb-nav-links .nav-item')).forEach(function(a){
		var on = a.dataset.bbPage === pageId;
		a.classList.toggle('active', on);
		if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
	});
	activeRoot.classList.add('bb-nav-loading');
	return L.require('view.bettbox.' + pageId).then(function(mod){
		if (seq !== navSeq) return null;
		if (!mod || typeof mod.render !== 'function') throw new Error('missing view');
		if (uci && typeof uci.unload === 'function') uci.unload('bettbox');
		return (typeof mod.load === 'function' ? Promise.resolve(mod.load()) : Promise.resolve()).then(function(data){
			if (seq !== navSeq) return null;
			if (!fromPopstate && window.history && window.history.pushState) {
				window.history.pushState({ bettboxPage: pageId }, '', href);
			}
			return mod.render(data);
		});
	}).then(function(nextRoot){
		if (seq !== navSeq || !nextRoot) return;
		var current = document.querySelector('.bb-app[data-bb-page]');
		if (!current || !current.parentNode) {
			window.location.assign(href);
			return;
		}
		current.replaceWith(nextRoot);
		var pageMeta = PAGES.find(function(item){ return item[0] === pageId; });
		if (pageMeta && document.title) {
			var host = document.title.split('|')[0].trim();
			document.title = (host ? host + ' | ' : '') + pageMeta[1];
		}
		window.scrollTo(0, 0);
	}).catch(function(){
		if (seq !== navSeq) return;
		window.location.assign(href);
	});
}
function wirePopstate(){
	if (popstateWired || typeof window === 'undefined') return;
	popstateWired = true;
	window.addEventListener('popstate', function(){
		if (!document.querySelector('.bb-app[data-bb-page]')) return;
		var m = window.location.pathname.match(/\/admin\/services\/bettbox(?:\/([a-z0-9_-]+))?\/?$/);
		var pageId = m ? (m[1] || 'overview') : '';
		if (pageId && PAGES.some(function(p){ return p[0] === pageId; })) {
			navigateTo(pageId, window.location.href, true);
		} else {
			window.location.reload();
		}
	});
}
function page(id,title,actions,content){
	mount();
	wirePopstate();
	var links=E('div',{'class':'bb-nav-links'},PAGES.map(function(p){
		var a=E('a',{'class':'nav-item'+(p[0]===id?' active':''),href:L.url('admin','services','bettbox',p[0]),'data-bb-page':p[0],'aria-current':p[0]===id?'page':null},[badge(p[2],'bb-nav-icon',p[3]),E('span',{},p[1])]);
		a.addEventListener('click',function(ev){
			if(ev.defaultPrevented||ev.button!==0||ev.metaKey||ev.ctrlKey||ev.shiftKey||ev.altKey)return;
			ev.preventDefault();
			var currentRoot=document.querySelector('.bb-app[data-bb-page]');
			if(currentRoot && currentRoot.dataset.bbPage===p[0] && a.href===window.location.href)return;
			navigateTo(p[0],a.href,false);
		});
		return a;
	}));
	var styleBtn=E('button',{type:'button','class':'bb-nav-chip',title:'切换界面风格 (Meridian / Apple / 跟随宿主)'},[icon('palette'),E('span',{},styleLabels[appearance.style]||'Meridian')]);
	styleBtn.addEventListener('click',function(){
		var idx=styleOrder.indexOf(appearance.style);
		setAppearance({style:styleOrder[(idx+1)%styleOrder.length]});
	});
	var schemeBtn=E('button',{type:'button','class':'bb-nav-chip',title:'切换浅色/深色模式'},[icon('eye'),E('span',{},modes[appearance.mode])]);
	schemeBtn.addEventListener('click',function(){
		var resolved=document.body.dataset.bbScheme;
		setAppearance({mode:resolved==='dark'?'light':'dark'});
	});
	var quick=E('div',{'class':'bb-nav-appearance'},[styleBtn,schemeBtn]);
	function syncNav(){
		if (!quick.isConnected && quick._mounted) return false;
		if (quick.isConnected) quick._mounted = true;
		styleBtn.querySelector('span').textContent=styleLabels[appearance.style]||'Meridian';
		var resolved=document.body.dataset.bbScheme;
		schemeBtn.querySelector('span').textContent=appearance.mode==='system'?(resolved==='dark'?'深色(系统)':'浅色(系统)'):modes[appearance.mode];
	}
	appearanceListeners.push(syncNav); syncNav();
	var nav=E('nav',{'class':'main-nav','aria-label':'Bettbox 页面导航'},[links,quick]);
	var toolbar=E('div',{'class':'heading-actions'},actions||[]);
	return E('div',{'class':'bb-app','data-bb-page':id},[nav,E('main',{'class':'shell','aria-label':title},[toolbar,E('div',{'class':'bb-page-content'},content||[])])]);
}
function panel(title,ico,body,actions){return E('section',{'class':'panel'},[E('div',{'class':'panel-head'},[E('div',{},[E('h2',{},[badge(ico,'bb-section-icon'),document.createTextNode(title)])]),E('div',{'class':'button-row'},actions||[])]),E('div',{'class':'panel-body'},body||[])]);}
function tag(text,kind){return E('span',{'class':'tag '+(kind||'')},String(text));}
function bytes(n){if(n==null||!isFinite(n))return '—';var a=['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<a.length-1){n/=1024;i++;}return n.toFixed(i?2:0)+' '+a[i];}
function speed(n){if(n==null||!isFinite(n))return '—';var a=['B/s','KB/s','MB/s','GB/s'],i=0;while(n>=1000&&i<a.length-1){n/=1000;i++;}return n.toFixed(i?1:0)+' '+a[i];}
function empty(title,text,action){return E('div',{'class':'empty-state'},[E('div',{'class':'empty-icon bb-icon-badge bb-tint-blue'},icon('info')),E('h2',{},title),E('p',{},text||''),action||document.createTextNode('')]);}
function modal(title,body,actions){mount();return ui.showModal(title,[E('div',{'class':'bb-app bb-modal-content'},[E('div',{'class':'bb-dialog-body'},body),E('div',{'class':'button-row bb-dialog-actions'},actions||[button('关闭',ui.hideModal)])])]);}
function field(label,control){return E('label',{'class':'bb-form-field'},[E('span',{'class':'input-label'},label),control]);}
function search(placeholder,fn){var input=E('input',{type:'search','class':'field',placeholder:placeholder,'aria-label':placeholder});input.addEventListener('input',function(){fn(input.value);});return E('label',{'class':'search'},[icon('search'),input]);}
function copy(text){if(navigator.clipboard && window.isSecureContext)return navigator.clipboard.writeText(text).then(function(){ui.addNotification(null,E('p',{},'已复制'),'info');});modal('复制地址',[E('input',{'class':'field',value:text,readonly:true})]);}
function waitJob(id,budget,onProgress,reconnect){var until=Date.now()+budget,failedSince=null;return new Promise(function(resolve,reject){function check(){getJob(id).then(function(res){failedSince=null;if(res.error){reject(new Error(res.error));return;}if(onProgress)onProgress(res);if(res.done){if(res.ok)resolve(res);else reject(new Error(res.text||'后台任务失败'));}else if(Date.now()>until)reject(new Error('任务仍未完成，请刷新服务状态后确认结果'));else window.setTimeout(check,650);}).catch(function(err){if(!reconnect){reject(err);return;}if(failedSince===null)failedSince=Date.now();if(Date.now()>until||Date.now()-failedSince>=90000){var pending=new Error('连接中断，请刷新页面或重新登录后确认安装结果');pending.unconfirmed=true;reject(pending);}else window.setTimeout(check,1000);});}check();});}
function job(kind,args,onProgress){return startJob(kind,JSON.stringify(args||[])).then(checked).then(function(start){return waitJob(start.id,185000,onProgress);});}
function operation(result){checked(result);var budget=Number(result.timeout_ms)||630000;budget=Math.max(1000,Math.min(result.reconnect?2430000:1230000,budget));return result.id?waitJob(result.id,budget,null,result.reconnect===true):result;}
if (typeof document !== 'undefined' && document.head && document.body) mount();
return baseclass.extend({icon:icon,badge:badge,artwork:artwork,page:page,panel:panel,button:button,tag:tag,error:error,checked:checked,operation:operation,bytes:bytes,speed:speed,empty:empty,modal:modal,field:field,search:search,copy:copy,job:job,poll:trackPoll,mount:mount,themePicker:themePicker,appearanceControls:appearanceControls,pages:PAGES});
