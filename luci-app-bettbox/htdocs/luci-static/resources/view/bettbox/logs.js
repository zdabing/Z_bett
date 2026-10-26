'use strict';
'require view';
'require rpc';
'require poll';
'require bettbox.ui as UI';

var callLogs = rpc.declare({ object: 'bettbox', method: 'get_logs' });

function logLevel(line) {
	// procd wraps core stdout as daemon.info; the core's level is authoritative.
	var match = line.match(/\blevel=(?:"([a-z]+)"|([a-z]+))/i);
	if (!match)
		match = line.match(/\b(?:kern|user|daemon|cron|auth|authpriv|syslog|lpr|mail|news|uucp|ftp|local[0-7])\.([a-z]+)\b/i);
	var level = match ? (match[1] || match[2]).toLowerCase() : '';
	if (level === 'warn') return 'warning';
	if (['err', 'crit', 'alert', 'emerg', 'fatal', 'panic'].indexOf(level) >= 0) return 'error';
	if (level === 'notice') return 'info';
	return level;
}

return view.extend({
 render:function(){var lines=[],filter='',level='',paused=false,busy=false,shown=[],list=E('div',{'class':'panel bb-log-list'}),state=E('span',{'class':'small muted'}),notice=E('p',{'class':'bb-update-note',role:'status'});
 function draw(){shown=lines.filter(function(l){return l.trim()&&(!level||logLevel(l)===level)&&(!filter||l.toLowerCase().indexOf(filter)>=0);});list.replaceChildren.apply(list,shown.length?shown.map(function(line){var sev=logLevel(line),time=line.match(/\b\d\d:\d\d:\d\d\b/),body=line;return E('div',{'class':'log-entry '+sev},[E('time',{'class':'log-time'},time?time[0]:'—'),UI.tag(sev||'未分类',sev==='error'?'danger':sev==='warning'?'warn':'neutral'),E('div',{'class':'log-body'},body)]);}):[UI.empty('没有匹配日志','可切换级别或清除搜索条件。')]);state.textContent=(paused?'已暂停 · ':'实时刷新 · ')+shown.length+' 条 / 最近 300 条';}
 function refresh(){if(busy)return Promise.resolve();busy=true;return callLogs().then(function(res){if(res.error)throw new Error(res.error);lines=(res.text||'').split('\n');notice.textContent='';draw();}).catch(function(err){notice.textContent='日志获取失败：'+err.message;}).finally(function(){busy=false;});}
 var chips=E('div',{'class':'chips'},[['','全部'],['info','信息'],['warning','警告'],['error','错误'],['debug','调试']].map(function(v){var b=E('button',{type:'button','class':'chip'+(!v[0]?' active':''),'aria-pressed':String(!v[0])},v[1]);b.addEventListener('click',function(){level=v[0];Array.from(chips.children).forEach(function(c){c.classList.toggle('active',c===b);c.setAttribute('aria-pressed',String(c===b));});draw();});return b;}));
 var pause=UI.button('暂停',function(){paused=!paused;pause.replaceChildren(UI.icon(paused?'refresh':'pause'),E('span',{},paused?'继续':'暂停'));draw();if(!paused)return refresh();},'','pause');
 function download(){var blob=new Blob([shown.join('\n')+'\n'],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=E('a',{href:url,download:'bettbox-'+new Date().toISOString().slice(0,10)+'.log'});document.body.appendChild(a);a.click();a.remove();window.setTimeout(function(){URL.revokeObjectURL(url);},5000);}
 var toolbar=E('div',{'class':'log-toolbar'},[UI.search('搜索域名、IP 或日志内容…',function(v){filter=v.toLowerCase();draw();}),chips,E('div',{'class':'button-row'},[pause,UI.button('导出',download,'','download')])]);
 poll.add(function(){if(!paused)return refresh();},3);refresh();return UI.page('logs','日志',[],[toolbar,E('div',{'class':'bb-log-state'},state),notice,list]);
 },handleSaveApply:null,handleSave:null,handleReset:null
});
