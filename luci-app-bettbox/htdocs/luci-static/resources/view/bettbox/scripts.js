'use strict';
'require view';
'require rpc';
'require ui';
'require bettbox.ui as UI';

var listScripts=rpc.declare({object:'bettbox',method:'get_scripts'}),getScript=rpc.declare({object:'bettbox',method:'get_script',params:['name']}),saveScript=rpc.declare({object:'bettbox',method:'save_script',params:['name','content']}),delScript=rpc.declare({object:'bettbox',method:'del_script',params:['name']}),scriptOptions=rpc.declare({object:'bettbox',method:'script_options',params:['name']}),importURL=rpc.declare({object:'bettbox',method:'import_script_url',params:['url','name']});
var TEMPLATE='// const Compatible_With_Bettbox = { ruleOptionsEnable: true };\nfunction main(config) {\n  return config;\n}\n';
function validName(name){return /^[A-Za-z0-9_-]{1,64}$/.test(name);}
return view.extend({
	load:function(){return listScripts();},
	render:function(data){var scripts=data.scripts||[],current='',tab='code',dirty=false,host=E('div'),body=E('textarea',{'class':'code-editor',rows:16,spellcheck:'false','aria-label':'脚本代码'}),filename=E('input',{'class':'field',placeholder:'my-script',value:''}),status=E('div',{'class':'bb-operation-state','role':'status'}),optionsHost=E('div',{'class':'panel-body'});body.value=TEMPLATE;body.addEventListener('input',function(){dirty=true;status.textContent='有未保存的修改';});
		function save(){var name=filename.value.trim().replace(/\.js$/,'');if(!validName(name))throw new Error('文件名仅支持字母、数字、下划线和短横线');return saveScript(name,body.value).then(UI.checked).then(function(){dirty=false;current=name;status.textContent='脚本已保存；可在订阅中选用';if(!scripts.some(function(s){return s.name===name;})){scripts.push({name:name,size:body.value.length});draw();}});}
		function load(name){if(dirty&&!window.confirm('有未保存的修改，确定切换脚本？'))return;return getScript(name).then(function(result){if(result.error)throw new Error(result.error);current=name;filename.value=name;body.value=result.content||'';dirty=false;status.textContent='';tab='code';draw();}).catch(UI.error);}
		function extract(){if(dirty||!current){optionsHost.replaceChildren(E('p',{'class':'small muted'},'先保存脚本，再提取其可视化选项。'));return Promise.resolve();}optionsHost.replaceChildren(E('p',{'class':'small muted'},'正在提取…'));return scriptOptions(current).then(UI.checked).then(function(result){var opts=result.options||{},values=opts.options||opts.ruleOptionsEnable||{},keys=Object.keys(values);optionsHost.replaceChildren();if(!keys.length){optionsHost.appendChild(E('p',{},'此脚本未声明可视化开关。'));return;}keys.forEach(function(k){optionsHost.appendChild(E('div',{'class':'toggle-line'},[E('div',{},[E('strong',{},k),E('p',{},'默认值：'+String(values[k]))]),UI.tag(values[k]?'启用':'关闭',values[k]?'':'neutral')]));});}).catch(function(err){optionsHost.replaceChildren(E('p',{'class':'small'},'提取失败：'+err.message));});}
		function remove(name){UI.modal('删除脚本',[E('p',{},'确定删除 '+name+'.js？引用该文件的订阅将无法使用此覆写。')],[UI.button('删除',function(){return delScript(name).then(UI.checked).then(function(){window.location.reload();});},'danger'),UI.button('取消',ui.hideModal)]);}
		function draw(){var rail=E('aside',{'class':'panel rail script-rail'},[E('div',{'class':'rail-title'},'脚本文件 · '+scripts.length)]);scripts.forEach(function(s){var b=UI.button(s.name+'.js',function(){return load(s.name);},'rail-button'+(current===s.name?' active':''),'code');rail.appendChild(b);});
			var tabs=E('div',{'class':'editor-tabs'});[['code','代码编辑'],['options','脚本选项']].forEach(function(t){var b=E('button',{type:'button','class':tab===t[0]?'active':''},t[1]);b.addEventListener('click',function(){tab=t[0];draw();if(tab==='options')extract();});tabs.appendChild(b);});
			var actions=[UI.button('保存',save,'primary','save')];if(current)actions.push(UI.button('删除',function(){remove(current);},'text bb-delete','close'));
			var editor=E('section',{'class':'panel'},[E('div',{'class':'panel-head'},[E('div',{},[E('h2',{},[UI.icon('code'),document.createTextNode(current?current+'.js':'新建脚本')])]),E('div',{'class':'button-row'},actions)]),E('div',{'class':'panel-body'},UI.field('文件名（不含 .js）',filename)),tabs,tab==='code'?body:optionsHost,status]);host.replaceChildren(E('div',{'class':'split script-layout'},[rail,editor]));
		}
		function create(name){if(dirty&&!window.confirm('放弃未保存的修改并新建脚本？'))return false;current='';filename.value=name||'';body.value=TEMPLATE;dirty=false;tab='code';status.textContent='';draw();return true;}
		function addDialog(){
			var mode='new',name=E('input',{'class':'field',placeholder:'my-script','aria-label':'文件名'}),url=E('input',{'class':'field',type:'url',placeholder:'https://…/script.js','aria-label':'脚本链接'}),file=E('input',{'class':'field',type:'file',accept:'.js,text/javascript','aria-label':'脚本文件'}),form=E('div',{'class':'bb-script-source-form'});
			var confirm=UI.button('创建并编辑',function(){
				var n=name.value.trim().replace(/\.js$/,'');
				if(mode==='new'){
					if(!validName(n))throw new Error('请输入有效的文件名');
					if(scripts.some(function(s){return s.name===n;}))throw new Error('已存在同名脚本');
					if(create(n))ui.hideModal();return;
				}
				if(mode==='file'){
					var f=file.files&&file.files[0];if(!f)throw new Error('请选择脚本文件');
					n=n||f.name.replace(/\.js$/,'');if(!validName(n))throw new Error('请输入有效的文件名');if(f.size>512*1024)throw new Error('文件不能超过 512KB');
					return f.text().then(function(text){return saveScript(n,text);}).then(UI.checked).then(function(){window.location.reload();});
				}
				var address=url.value.trim();if(!/^https?:\/\//.test(address))throw new Error('请输入 http(s) 链接');
				if(!n){try{n=new URL(address).pathname.split('/').pop().replace(/\.js$/,'');}catch(e){}}
				if(!validName(n))throw new Error('请输入有效的文件名');
				return importURL(address,n).then(UI.checked).then(function(){window.location.reload();});
			},'primary','plus');
			var sources=E('div',{'class':'bb-script-source',role:'tablist','aria-label':'添加方式'},[['new','新建'],['url','链接导入'],['file','文件导入']].map(function(item){
				var button=E('button',{type:'button',role:'tab','class':item[0]===mode?'active':'','aria-selected':String(item[0]===mode)},item[1]);
				button.addEventListener('click',function(){mode=item[0];drawSource();});return button;
			}));
			function drawSource(){
				Array.from(sources.children).forEach(function(button,i){var active=['new','url','file'][i]===mode;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});
				form.replaceChildren.apply(form,(mode==='url'?[UI.field('脚本链接',url)]:mode==='file'?[UI.field('脚本文件',file)]:[]).concat([UI.field(mode==='new'?'文件名':'文件名（可选）',name)]));
				confirm.querySelector('span').textContent=mode==='new'?'创建并编辑':'导入';
			}
			drawSource();UI.modal('添加脚本',[sources,form],[confirm,UI.button('取消',ui.hideModal)]);
		}
		var root=UI.page('scripts','脚本',[UI.button('添加脚本',addDialog,'primary','plus')],[host]);draw();if(scripts.length)load(scripts[0].name);return root;
	},handleSaveApply:null,handleSave:null,handleReset:null
});
