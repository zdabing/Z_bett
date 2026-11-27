'use strict';
'require baseclass';
'require rpc';
'require bettbox.ui as UI';

var hostHints=rpc.declare({object:'luci-rpc',method:'getHostHints',expect:{'':{}}}),sequence=0;

var LINK_LOCAL6_RE=/^fe[89ab][0-9a-f]:/i;
function isLinkLocal6(ip){return LINK_LOCAL6_RE.test(ip);}

function create(value,validate,matchMac,legacy){
	function entries(values){
		return Array.from(new Set(values.map(function(s){return matchMac?s.trim().toLowerCase():s.trim();}).filter(Boolean)));
	}
	var byDevice=legacy!=null;
	var selected=entries(Array.isArray(value)?value:String(value||'').split(/\s+/));
	var oldAddresses=byDevice?entries(Array.isArray(legacy)?legacy:String(legacy).split(/\s+/)):[];
	var format=matchMac?'MAC':'IP / CIDR',prompt=byDevice?'搜索设备名称或 IP':'搜索设备或输入 '+format;
	var hosts=[],loaded=false,loading=false,failed=false,open=false,active=-1,options=[],uid='bettbox-device-options-'+(++sequence);
	var chips=E('div',{'class':'device-picker-chips'}),list=E('div',{'class':'device-picker-options',id:uid,role:'listbox','aria-label':'可选设备','aria-multiselectable':'true'});
	var message=E('div',{'class':'device-picker-message',role:'status',hidden:true}),error=E('div',{'class':'device-picker-error',role:'alert',hidden:true});
	var input=E('input',{type:'text','class':'device-picker-search',role:'combobox',autocomplete:'off',placeholder:prompt,'aria-label':prompt,'aria-expanded':'false','aria-controls':uid,'aria-autocomplete':'list'});
	var toggle=E('button',{type:'button','class':'device-picker-toggle','aria-label':'展开设备列表','aria-expanded':'false','aria-controls':uid},UI.icon('chevron'));
	var popup=E('div',{'class':'device-picker-popup',hidden:true},[list,message]);
	var main=E('div',{'class':'device-picker-main'},[chips,input]);
	var control=E('div',{'class':'device-picker-control'},[main,toggle]);
	var root=E('fieldset',{'class':'device-picker'},[control,error,popup]);
	function notify(){root.dispatchEvent(new Event('change',{bubbles:true}));}
	function invalid(text){error.textContent=text||'';error.hidden=!text;input.setAttribute('aria-invalid',String(!!text));}
	function nameFor(value){var host=hosts.find(function(h){return h.value===value;});return host&&host.name;}
	function paintChips(){
		chips.hidden=selected.length===0&&oldAddresses.length===0;
		chips.replaceChildren.apply(chips,selected.concat(oldAddresses).map(function(ip,index){
			var old=index>=selected.length,host=byDevice&&!old?hosts.find(function(h){return h.value===ip;}):null;
			var address=host&&host.ips[0],name=host&&host.name;
			var remove=E('button',{type:'button','class':'device-picker-remove','aria-label':'移除 '+[name,address||ip].filter(Boolean).join(' ')},UI.icon('close'));
			remove.addEventListener('click',function(){
				if(old)oldAddresses=oldAddresses.filter(function(x){return x!==ip;});
				else selected=selected.filter(function(x){return x!==ip;});
				invalid('');paintChips();paintOptions();notify();input.focus();
			});
			var copy=[];
			if(name)copy.push(E('span',{'class':'device-picker-name'},name));
			copy.push(E('span',{'class':'mono'},address||ip));
			if(old)copy.push(E('span',{'class':'device-picker-kind'},'旧 IP 规则'));
			else if(byDevice&&!address)copy.push(E('span',{'class':'device-picker-kind'},'暂无 IP'));
			return E('span',{'class':'device-picker-chip',title:host&&host.addresses?ip+' · '+host.addresses:nameFor(ip)||ip},copy.concat(remove));
		}));
	}
	function setOpen(on){
		open=on;popup.hidden=!on;input.setAttribute('aria-expanded',String(on));toggle.setAttribute('aria-expanded',String(on));toggle.setAttribute('aria-label',on?'收起设备列表':'展开设备列表');
		if(!on){active=-1;input.removeAttribute('aria-activedescendant');}
	}
	function coveredBy(host){
		return oldAddresses.filter(function(ip){
			return host.ips.includes(ip)&&hosts.filter(function(h){return h.ips.includes(ip);}).length===1;
		});
	}
	function choose(values,replaced){
		var next=entries(selected.concat(values));
		try{validate(next);}catch(e){invalid(e.message);return;}
		var changed=next.length!==selected.length||!!replaced?.length;
		if(replaced)oldAddresses=oldAddresses.filter(function(ip){return !replaced.includes(ip);});
		selected=next;input.value='';invalid('');paintChips();paintOptions();if(changed)notify();input.focus();
	}
	function chooseTyped(values){
		if(!byDevice)return choose(values);
		var macs=[],replaced=[];
		for(var value of values){
			var matches=hosts.filter(function(h){return h.ips.includes(value);});
			if(matches.length>1){invalid('此 IP 对应多个设备，请在列表中选择。');return;}
			if(matches.length){
				macs.push(matches[0].value);
				replaced=replaced.concat(coveredBy(matches[0]));
			}else{
				try{validate([value]);}catch(e){invalid('找不到这个 IP 对应的设备，请从列表选择，或输入已知的 MAC。');return;}
				macs.push(value);
			}
		}
		choose(macs,replaced);
	}
	function custom(){return entries(input.value.split(/[\s,，;；]+/));}
	function matchesQuery(host,query){return (host.name+' '+host.addresses+' '+host.mac).toLowerCase().indexOf(query)>=0;}
	function paintOptions(){
		var query=input.value.trim().toLowerCase(),matches=hosts.filter(function(h){return matchesQuery(h,query);}).sort(function(a,b){return Number(selected.includes(b.value))-Number(selected.includes(a.value));}).slice(0,80);
		options=[];active=-1;input.removeAttribute('aria-activedescendant');list.replaceChildren();
		function option(label,detail,checked,fn){
			var b=E('button',{type:'button','class':'device-picker-option'+(checked?' selected':''),role:'option','aria-selected':String(checked),id:uid+'-'+options.length,tabindex:'-1'},[
				E('span',{'class':'device-picker-option-copy'},[E('span',{},label)].concat(detail?[E('span',{'class':'mono muted'},detail)]:[])),UI.icon(checked?'check':'plus')]);
			b.addEventListener('click',fn);list.appendChild(b);options.push(b);
		}
		matches.forEach(function(h){
			var checked=selected.includes(h.value),detail=h.name?h.value:'';
			if(matchMac&&h.addresses)detail+=(detail?' · ':'')+h.addresses;
			var replaced=byDevice?coveredBy(h):[],label=h.name||h.value;
			if(byDevice){
				label=h.name||h.ips[0]||h.value;
				detail=(h.name?h.addresses:h.ips.slice(1).join(' · '))||(!h.ips.length&&h.name?h.value:'');
				if(replaced.length)detail+=(detail?' · ':'')+'替换旧 IP';
			}
			option(label,detail,checked&&!replaced.length,function(){if(checked&&!replaced.length){selected=selected.filter(function(x){return x!==h.value;});paintChips();paintOptions();notify();input.focus();}else choose([h.value],replaced);});
		});
		var values=custom(),valid=false;
		try{validate(values);valid=values.length>0;}catch(e){}
		if(valid&&values.some(function(value){return !selected.includes(value);})&&!matches.some(function(h){return values.length===1&&h.value===values[0];}))option('添加自定义地址',values.join('、'),false,function(){choose(values);});
		message.hidden=options.length>0;
		message.textContent=loading?'正在读取设备…':failed?'设备列表读取失败，可直接输入 '+format:query?'未找到设备，可输入 '+(matchMac?'MAC':'IPv4、IPv6 或 CIDR'):'暂无可选设备，可直接输入 '+format;
	}
	function load(){
		if(loaded||loading)return;loading=true;failed=false;paintOptions();
		Promise.resolve().then(hostHints).then(function(data){
			var known=new Map();Object.keys(data||{}).forEach(function(key){
				var h=data[key]||{},mac=key.toLowerCase(),name=String(h.name||'');
				var ips=(h.ipaddrs||[]).concat(h.ip6addrs||[]).filter(function(ip){
					return typeof ip==='string'&&ip.trim()&&!isLinkLocal6(ip.trim());
				}).map(function(ip){return ip.trim();});
				(matchMac?[mac]:ips).forEach(function(value){
					try{validate([value]);}catch(e){return;}
					if(!known.has(value)||(!known.get(value).name&&name))known.set(value,{value:value,name:name,mac:mac,ips:ips,addresses:matchMac?ips.join(' · '):value});
				});
			});hosts=Array.from(known.values()).sort(function(a,b){return (matchMac?0:Number(a.value.includes(':'))-Number(b.value.includes(':')))||(a.name||a.value).localeCompare(b.name||b.value,undefined,{numeric:true});});loaded=true;
		}).catch(function(){failed=true;}).finally(function(){loading=false;paintChips();paintOptions();});
	}
	input.addEventListener('focus',function(){setOpen(true);paintOptions();load();});
	input.addEventListener('input',function(e){e.stopPropagation();invalid('');setOpen(true);paintOptions();load();});
	input.addEventListener('paste',function(e){
		var text=e.clipboardData&&e.clipboardData.getData('text/plain'),values=String(text||'').trim().split(/[\s,，;；]+/).filter(Boolean);
		if(values.length>1){e.preventDefault();chooseTyped(values);}
	});
	input.addEventListener('keydown',function(e){
		if(e.key==='Escape'){e.preventDefault();setOpen(false);return;}
		if(e.key==='ArrowDown'||e.key==='ArrowUp'){
			e.preventDefault();setOpen(true);load();if(!options.length)return;active=(active+(e.key==='ArrowDown'?1:active<0?0:-1)+options.length)%options.length;
			options.forEach(function(b,i){b.classList.toggle('highlighted',i===active);});input.setAttribute('aria-activedescendant',options[active].id);options[active].scrollIntoView({block:'nearest'});return;
		}
		if(e.key==='Enter'){e.preventDefault();if(open&&active>=0&&options[active])options[active].click();else if(custom().length)chooseTyped(custom());else{setOpen(!open);load();}}
	});
	control.addEventListener('mousedown',function(e){if(e.target===control||e.target===main){e.preventDefault();input.focus();}});
	toggle.addEventListener('click',function(){var on=!open;input.focus();setOpen(on);if(on)load();});
	root.addEventListener('focusout',function(e){if(!root.contains(e.relatedTarget))setOpen(false);});
	// Keep the settings view's value/list contract and native fieldset disabling.
	Object.defineProperty(root,'value',{get:function(){return selected.join('\n');},set:function(v){selected=entries(String(v||'').split('\n'));paintChips();paintOptions();}});
	root.validate=function(){
		var values=custom(),query=input.value.trim().toLowerCase(),valid=true;
		if(byDevice){
			if(!error.hidden)throw new Error(error.textContent);
			validate(selected);return;
		}
		try{validate(values);}catch(e){valid=false;}
		// A search for an existing device is not a new address to save.
		if(values.length&&(valid||!hosts.some(function(h){return matchesQuery(h,query);})))choose(values);
		if(!error.hidden)throw new Error(error.textContent);validate(selected);
	};
	root.input=input;
	if(byDevice){root.loadDevices=load;root.legacyAddresses=function(){return oldAddresses.slice();};}
	paintChips();return root;
}
return baseclass.extend({create:create});
