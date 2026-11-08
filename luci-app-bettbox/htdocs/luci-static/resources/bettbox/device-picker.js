'use strict';
'require baseclass';
'require rpc';
'require bettbox.ui as UI';

var hostHints=rpc.declare({object:'luci-rpc',method:'getHostHints',expect:{'':{}}}),sequence=0;

function create(value,validate){
	var selected=Array.from(new Set((Array.isArray(value)?value:String(value||'').split('\n')).map(function(s){return s.trim();}).filter(Boolean)));
	var hosts=[],loaded=false,loading=false,failed=false,open=false,active=-1,options=[],uid='bettbox-device-options-'+(++sequence);
	var chips=E('div',{'class':'device-picker-chips'}),list=E('div',{'class':'device-picker-options',id:uid,role:'listbox','aria-label':'可选设备','aria-multiselectable':'true'});
	var message=E('div',{'class':'device-picker-message',role:'status',hidden:true}),error=E('div',{'class':'device-picker-error',role:'alert',hidden:true});
	var input=E('input',{type:'text','class':'device-picker-search',role:'combobox',autocomplete:'off',placeholder:'搜索设备或输入 IP / CIDR','aria-label':'搜索设备或输入 IP / CIDR','aria-expanded':'false','aria-controls':uid,'aria-autocomplete':'list'});
	var toggle=E('button',{type:'button','class':'device-picker-toggle','aria-label':'展开设备列表','aria-expanded':'false','aria-controls':uid},UI.icon('down'));
	var popup=E('div',{'class':'device-picker-popup',hidden:true},[list,message]);
	var root=E('fieldset',{'class':'device-picker'},[chips,E('div',{'class':'device-picker-input'},[input,toggle]),error,popup]);
	function notify(){root.dispatchEvent(new Event('change',{bubbles:true}));}
	function invalid(text){error.textContent=text||'';error.hidden=!text;input.setAttribute('aria-invalid',String(!!text));}
	function nameFor(ip){var host=hosts.find(function(h){return h.ip===ip;});return host&&host.name;}
	function paintChips(){
		chips.hidden=selected.length===0;
		chips.replaceChildren.apply(chips,selected.map(function(ip){
			var remove=E('button',{type:'button','class':'device-picker-remove','aria-label':'移除 '+ip},UI.icon('close'));
			remove.addEventListener('click',function(){selected=selected.filter(function(x){return x!==ip;});invalid('');paintChips();paintOptions();notify();input.focus();});
			return E('span',{'class':'device-picker-chip',title:nameFor(ip)||ip},[E('span',{'class':'mono'},ip),remove]);
		}));
	}
	function setOpen(on){
		open=on;popup.hidden=!on;input.setAttribute('aria-expanded',String(on));toggle.setAttribute('aria-expanded',String(on));toggle.setAttribute('aria-label',on?'收起设备列表':'展开设备列表');
		if(!on){active=-1;input.removeAttribute('aria-activedescendant');}
	}
	function choose(values){
		var next=Array.from(new Set(selected.concat(values)));
		try{validate(next);}catch(e){invalid(e.message);return;}
		var changed=next.length!==selected.length;selected=next;input.value='';invalid('');paintChips();paintOptions();if(changed)notify();input.focus();
	}
	function custom(){return input.value.trim().split(/[\s,，;；]+/).filter(Boolean);}
	function paintOptions(){
		var query=input.value.trim().toLowerCase(),matches=hosts.filter(function(h){return(h.name+' '+h.ip+' '+h.mac).toLowerCase().indexOf(query)>=0;}).sort(function(a,b){return Number(selected.indexOf(b.ip)>=0)-Number(selected.indexOf(a.ip)>=0);}).slice(0,80);
		options=[];active=-1;input.removeAttribute('aria-activedescendant');list.replaceChildren();
		function option(label,detail,checked,fn){
			var b=E('button',{type:'button','class':'device-picker-option'+(checked?' selected':''),role:'option','aria-selected':String(checked),id:uid+'-'+options.length,tabindex:'-1'},[
				E('span',{'class':'device-picker-option-copy'},[E('span',{},label)].concat(detail?[E('span',{'class':'mono muted'},detail)]:[])),UI.icon(checked?'check':'plus')]);
			b.addEventListener('click',fn);list.appendChild(b);options.push(b);
		}
		matches.forEach(function(h){var checked=selected.indexOf(h.ip)>=0;option(h.name||h.ip,h.name?h.ip:'',checked,function(){if(checked){selected=selected.filter(function(x){return x!==h.ip;});paintChips();paintOptions();notify();input.focus();}else choose([h.ip]);});});
		var values=custom(),valid=false;
		try{validate(values);valid=values.length>0;}catch(e){}
		if(valid&&values.some(function(ip){return selected.indexOf(ip)<0;})&&!matches.some(function(h){return values.length===1&&h.ip===values[0];}))option('添加自定义地址',values.join('、'),false,function(){choose(values);});
		message.hidden=options.length>0;
		message.textContent=loading?'正在读取设备…':failed?'设备列表读取失败，可直接输入 IP / CIDR':query?'未找到设备，可输入 IPv4、IPv6 或 CIDR':'暂无可选设备，可直接输入 IP / CIDR';
	}
	function load(){
		if(loaded||loading)return;loading=true;failed=false;paintOptions();
		Promise.resolve().then(hostHints).then(function(data){
			var known=new Map();Object.keys(data||{}).forEach(function(mac){var h=data[mac]||{};
				(h.ipaddrs||[]).concat(h.ip6addrs||[]).forEach(function(ip){
					if(typeof ip!=='string')return;try{validate([ip]);}catch(e){return;}
					var name=String(h.name||'');if(!known.has(ip)||(!known.get(ip).name&&name))known.set(ip,{ip:ip,name:name,mac:mac});
				});
			});hosts=Array.from(known.values()).sort(function(a,b){return Number(a.ip.indexOf(':')>=0)-Number(b.ip.indexOf(':')>=0)||(a.name||a.ip).localeCompare(b.name||b.ip,undefined,{numeric:true});});loaded=true;
		}).catch(function(){failed=true;}).finally(function(){loading=false;paintChips();paintOptions();});
	}
	input.addEventListener('focus',function(){setOpen(true);paintOptions();load();});
	input.addEventListener('input',function(e){e.stopPropagation();invalid('');setOpen(true);paintOptions();});
	input.addEventListener('paste',function(e){
		var text=e.clipboardData&&e.clipboardData.getData('text/plain'),values=String(text||'').trim().split(/[\s,，;；]+/).filter(Boolean);
		if(values.length>1){e.preventDefault();choose(values);}
	});
	input.addEventListener('keydown',function(e){
		if(e.key==='Escape'){e.preventDefault();setOpen(false);return;}
		if(e.key==='ArrowDown'||e.key==='ArrowUp'){
			e.preventDefault();setOpen(true);load();if(!options.length)return;active=(active+(e.key==='ArrowDown'?1:active<0?0:-1)+options.length)%options.length;
			options.forEach(function(b,i){b.classList.toggle('highlighted',i===active);});input.setAttribute('aria-activedescendant',options[active].id);options[active].scrollIntoView({block:'nearest'});return;
		}
		if(e.key==='Enter'){e.preventDefault();if(open&&active>=0&&options[active])options[active].click();else if(custom().length)choose(custom());else{setOpen(!open);load();}}
	});
	toggle.addEventListener('click',function(){var on=!open;input.focus();setOpen(on);if(on)load();});
	root.addEventListener('focusout',function(e){if(!root.contains(e.relatedTarget))setOpen(false);});
	// Keep the settings view's value/list contract and native fieldset disabling.
	Object.defineProperty(root,'value',{get:function(){return selected.join('\n');},set:function(v){selected=Array.from(new Set(String(v||'').split('\n').map(function(s){return s.trim();}).filter(Boolean)));paintChips();paintOptions();}});
	root.validate=function(){
		var values=custom(),query=input.value.trim().toLowerCase(),valid=true;
		try{validate(values);}catch(e){valid=false;}
		// A device-name/partial-IP search is not a new address to save.
		if(values.length&&(valid||!hosts.some(function(h){return(h.name+' '+h.ip+' '+h.mac).toLowerCase().indexOf(query)>=0;})))choose(values);
		if(!error.hidden)throw new Error(error.textContent);validate(selected);
	};
	root.input=input;paintChips();return root;
}
return baseclass.extend({create:create});
