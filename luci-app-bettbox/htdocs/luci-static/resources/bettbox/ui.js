'use strict';
'require baseclass';
'require ui';
'require rpc';

var startJob = rpc.declare({ object: 'bettbox', method: 'diagnostic_start', params: ['kind', 'args_json'] });
var getJob = rpc.declare({ object: 'bettbox', method: 'diagnostic_status', params: ['id'] });
var PAGES = [ ['overview','概览','grid'], ['proxies','代理','route'], ['connections','连接','link'], ['profiles','订阅','file'], ['scripts','脚本','code'], ['resources','资源','layers'], ['toolbox','工具箱','terminal'], ['logs','日志','list'], ['settings','设置','settings'] ];
var PATHS = {
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
	svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('class','ico');svg.setAttribute('aria-hidden','true');
	// Only static, application-owned SVG paths enter innerHTML.
	svg.innerHTML=PATHS[name]||PATHS.grid;return svg;
}
function error(err){ui.addNotification(null,E('p',{},String(err && err.message || err || '操作失败')),'error');}
function checked(res){if(!res || res.ok!==true)throw new Error(res && (res.error||res.text)||'操作失败');return res;}
function button(label,fn,kind,ico){
	var el=E('button',{type:'button','class':'btn '+(kind||'')},(ico?[icon(ico)]:[]).concat([E('span',{},label)]));
	if(fn)el.addEventListener('click',function(ev){ev.preventDefault();var result;try{result=fn(ev,el);}catch(e){error(e);return;}
		if(result && typeof result.then==='function'){el.disabled=true;return Promise.resolve(result).catch(error).finally(function(){el.disabled=false;});}});
	return el;
}
function mount(){
	document.body.classList.add('bb-page');
	if(!document.getElementById('bettbox-ui-css'))document.head.appendChild(E('link',{id:'bettbox-ui-css',rel:'stylesheet',href:L.resource('bettbox/ui.css')+'?v=20261027-2'}));
}
function page(id,title,actions,content){
	mount();var nav=E('nav',{'class':'main-nav','aria-label':'Bettbox 页面导航'},PAGES.map(function(p){return E('a',{'class':'nav-item'+(p[0]===id?' active':''),href:L.url('admin','services','bettbox',p[0]),'aria-current':p[0]===id?'page':null},[icon(p[2]),E('span',{},p[1])]);}));
	var heading=E('div',{'class':'page-heading'},[E('div',{'class':'heading-copy'},[E('h1',{},title)]),E('div',{'class':'heading-actions'},actions||[])]);
	return E('div',{'class':'bb-app','data-bb-page':id},[nav,E('main',{'class':'shell'},[heading,E('div',{'class':'bb-page-content'},content||[])])]);
}
function panel(title,ico,body,actions){return E('section',{'class':'panel'},[E('div',{'class':'panel-head'},[E('div',{},[E('h2',{},[icon(ico),document.createTextNode(title)])]),E('div',{'class':'button-row'},actions||[])]),E('div',{'class':'panel-body'},body||[])]);}
function tag(text,kind){return E('span',{'class':'tag '+(kind||'')},String(text));}
function bytes(n){if(n==null||!isFinite(n))return '—';var a=['B','KB','MB','GB','TB'],i=0;while(n>=1024&&i<a.length-1){n/=1024;i++;}return n.toFixed(i?2:0)+' '+a[i];}
function speed(n){if(n==null||!isFinite(n))return '—';var a=['B/s','KB/s','MB/s','GB/s'],i=0;while(n>=1000&&i<a.length-1){n/=1000;i++;}return n.toFixed(i?1:0)+' '+a[i];}
function empty(title,text,action){return E('div',{'class':'empty-state'},[E('div',{'class':'empty-icon'},icon('info')),E('h2',{},title),E('p',{},text||''),action||document.createTextNode('')]);}
function modal(title,body,actions){mount();return ui.showModal(title,[E('div',{'class':'bb-app bb-modal-content'},[E('div',{'class':'bb-dialog-body'},body),E('div',{'class':'button-row bb-dialog-actions'},actions||[button('关闭',ui.hideModal)])])]);}
function field(label,control){return E('label',{'class':'bb-form-field'},[E('span',{'class':'input-label'},label),control]);}
function search(placeholder,fn){var input=E('input',{type:'search','class':'field',placeholder:placeholder,'aria-label':placeholder});input.addEventListener('input',function(){fn(input.value);});return E('label',{'class':'search'},[icon('search'),input]);}
function copy(text){if(navigator.clipboard && window.isSecureContext)return navigator.clipboard.writeText(text).then(function(){ui.addNotification(null,E('p',{},'已复制'),'info');});modal('复制地址',[E('input',{'class':'field',value:text,readonly:true})]);}
function waitJob(id,budget,onProgress,reconnect){var until=Date.now()+budget,failedSince=null;return new Promise(function(resolve,reject){function check(){getJob(id).then(function(res){failedSince=null;if(res.error){reject(new Error(res.error));return;}if(onProgress)onProgress(res);if(res.done){if(res.ok)resolve(res);else reject(new Error(res.text||'后台任务失败'));}else if(Date.now()>until)reject(new Error('任务仍未完成，请刷新服务状态后确认结果'));else window.setTimeout(check,650);}).catch(function(err){if(!reconnect){reject(err);return;}if(failedSince===null)failedSince=Date.now();if(Date.now()>until||Date.now()-failedSince>=90000){var pending=new Error('连接中断，请刷新页面或重新登录后确认安装结果');pending.unconfirmed=true;reject(pending);}else window.setTimeout(check,1000);});}check();});}
function job(kind,args,onProgress){return startJob(kind,JSON.stringify(args||[])).then(checked).then(function(start){return waitJob(start.id,185000,onProgress);});}
function operation(result){checked(result);var budget=Number(result.timeout_ms)||630000;budget=Math.max(1000,Math.min(result.reconnect?2430000:1230000,budget));return result.id?waitJob(result.id,budget,null,result.reconnect===true):result;}
return baseclass.extend({icon:icon,page:page,panel:panel,button:button,tag:tag,error:error,checked:checked,operation:operation,bytes:bytes,speed:speed,empty:empty,modal:modal,field:field,search:search,copy:copy,job:job,mount:mount,pages:PAGES});
