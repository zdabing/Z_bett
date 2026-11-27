'use strict';
'require view';
'require rpc';
'require bettbox.ui as UI';

var callLogs = rpc.declare({ object: 'bettbox', method: 'get_logs' });
var CLEAR_KEY = 'bettbox.logs.cleared.v1';

function loadCleared() {
	try {
		var raw = window.sessionStorage && window.sessionStorage.getItem(CLEAR_KEY);
		var parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch (_) {
		return [];
	}
}

function saveCleared(anchor) {
	try {
		if (!window.sessionStorage) return;
		if (anchor && anchor.length)
			window.sessionStorage.setItem(CLEAR_KEY, JSON.stringify(anchor));
		else
			window.sessionStorage.removeItem(CLEAR_KEY);
	} catch (_) {}
}

var ROUTINE_CRON_RE = /\bcrond(?:\[\d+\])?:\s+USER\b.*\bcmd \/usr\/bin\/bettbox (?:subscription )?cron\b/i;

function isRoutineCron(line) {
	return ROUTINE_CRON_RE.test(line);
}

function sliceAfterCleared(clean, anchor) {
	if (!anchor.length || !clean.length) return { lines: clean, reset: false };
	var len = anchor.length;
	for (var i = clean.length - len; i >= 0; i--) {
		var ok = true;
		for (var j = 0; j < len; j++) {
			if (clean[i + j] !== anchor[j]) { ok = false; break; }
		}
		if (ok) return { lines: clean.slice(i + len), reset: false };
	}
	var minKeep = len >= 3 ? 2 : 1;
	for (var keep = Math.min(len - 1, clean.length); keep >= minKeep; keep--) {
		var start = len - keep, match = true;
		for (var k = 0; k < keep; k++) {
			if (clean[k] !== anchor[start + k]) { match = false; break; }
		}
		if (match) return { lines: clean.slice(keep), reset: false };
	}
	return { lines: clean, reset: true };
}

function logLevel(line) {
	if (/\bcrond(?:\[\d+\])?:\s+USER\b/i.test(line))
		return 'info';
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
function logRecord(line) {
	var time = line.match(/\b\d\d:\d\d:\d\d\b/);
	var body = line.replace(/^(?:[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4}\s+)?(?:kern|user|daemon|cron|auth|authpriv|syslog|lpr|mail|news|uucp|ftp|local[0-7])\.[a-z]+\s+[^:]+:\s*/i, '');
	var message = body.match(/^time=(?:"[^"]*"|\S+)\s+level=(?:"[a-z]+"|[a-z]+)\s+msg=("(?:\\.|[^"\\])*")(.*)$/i);
	if (message) {
		try { body = JSON.parse(message[1]) + message[2]; } catch (_) {}
	}
	return {time:time ? time[0] : '—', level:logLevel(line), body:body};
}

return view.extend({
 render:function(){var lines=[],cleared=loadCleared(),filter='',level='',paused=false,busy=false,shown=[],list=E('div',{'class':'panel bb-log-list'}),state=E('span',{'class':'small muted'}),notice=E('p',{'class':'bb-update-note',role:'status'});
 function cleanLines(){return lines.filter(function(line){return line.trim()&&!isRoutineCron(line);});}
 function visibleBase(){var clean=cleanLines(),sliced=sliceAfterCleared(clean,cleared);if(sliced.reset&&cleared.length){cleared=[];saveCleared(cleared);}return sliced.lines;}
 function draw(){
	 var base=visibleBase();
	 shown=base.filter(function(line){return (!level||logLevel(line)===level)&&(!filter||line.toLowerCase().indexOf(filter)>=0);});
	 var entries=shown.map(function(line){
		 var record=logRecord(line);
		 return E('div',{'class':'log-entry','data-level':record.level},[
			 E('time',{'class':'log-time'},record.time),
			 E('span',{'class':'bb-log-level'},record.level ? record.level.toUpperCase() : '未分类'),
			 E('div',{'class':'log-body',title:line},record.body)
		 ]);
	 });
	 var empty=cleared.length&&!base.length?UI.empty('暂无新日志','已清空当前视图，后续新产生的日志会自动显示。'):UI.empty('没有匹配日志','可切换级别或清除搜索条件。');
	 list.replaceChildren.apply(list,entries.length?entries:[empty]);
	 state.textContent=(paused?'已暂停 · ':'实时刷新 · ')+shown.length+' 条 / 最近 300 条';
 }
 function refresh(){if(busy)return Promise.resolve();busy=true;return callLogs().then(function(res){if(res.error)throw new Error(res.error);lines=(res.text||'').split('\n');notice.textContent='';draw();}).catch(function(err){notice.textContent='日志获取失败：'+err.message;}).finally(function(){busy=false;});}
 function clearView(){var clean=cleanLines();if(!clean.length)return;cleared=clean.slice(-20);saveCleared(cleared);draw();}
 var chips=E('div',{'class':'chips'},[['','全部'],['info','信息'],['warning','警告'],['error','错误'],['debug','调试']].map(function(v){var b=E('button',{type:'button','class':'chip'+(!v[0]?' active':''),'aria-pressed':String(!v[0])},v[1]);b.addEventListener('click',function(){level=v[0];Array.from(chips.children).forEach(function(c){c.classList.toggle('active',c===b);c.setAttribute('aria-pressed',String(c===b));});draw();});return b;}));
 var pause=UI.button('暂停',function(){paused=!paused;pause.replaceChildren(UI.icon(paused?'refresh':'pause'),E('span',{},paused?'继续':'暂停'));draw();if(!paused)return refresh();},'','pause');
 function download(){var blob=new Blob([shown.join('\n')+'\n'],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=E('a',{href:url,download:'bettbox-'+new Date().toISOString().slice(0,10)+'.log'});document.body.appendChild(a);a.click();a.remove();window.setTimeout(function(){URL.revokeObjectURL(url);},5000);}
 var toolbar=E('div',{'class':'log-toolbar'},[UI.search('搜索域名、IP 或日志内容…',function(v){filter=v.toLowerCase();draw();}),chips,E('div',{'class':'button-row'},[pause,UI.button('清空',clearView,'','close'),UI.button('导出',download,'','download')])]);
 var root=UI.page('logs','日志',[],[toolbar,E('div',{'class':'bb-log-state'},state),notice,list]);
 UI.poll(root,function(){if(!paused)return refresh();},3);refresh();return root;
 },handleSaveApply:null,handleSave:null,handleReset:null
});
