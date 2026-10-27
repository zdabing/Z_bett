'use strict';
// Real resources view/shared UI/CSS with asynchronous RPC fixtures, no router.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..'),base=path.join(root,'luci-app-bettbox/htdocs/luci-static/resources');
const source=fs.readFileSync(path.join(base,'view/bettbox/resources.js'),'utf8'),shared=fs.readFileSync(path.join(base,'bettbox/ui.js'),'utf8'),css=fs.readFileSync(path.join(base,'bettbox/ui.css'),'utf8');
(async()=>{
    const browser=await chromium.launch({headless:true,...(process.env.BETTBOX_BROWSER?{executablePath:process.env.BETTBOX_BROWSER}:{})});
    const page=await browser.newPage({viewport:{width:1600,height:950}}),errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="view"></div></body></html>'}));
    try{
        await page.goto('http://fixture.test/');
        if(process.env.BETTBOX_THEME_CSS)await page.addStyleTag({path:process.env.BETTBOX_THEME_CSS});
        await page.addStyleTag({content:'body{margin:0;font:14px "Microsoft YaHei",sans-serif}.panel{padding:28px}'});
        await page.addStyleTag({content:css});
        await page.evaluate(({source,shared})=>{
            function E(tag,attrs={},children=[]){const el=document.createElement(tag);for(const [k,v]of Object.entries(attrs)){if(v==null)continue;if(typeof v==='function')el.addEventListener(k,v);else el.setAttribute(k,String(v));}for(const child of [children].flat(Infinity))if(child!=null)el.append(child instanceof Node?child:document.createTextNode(String(child)));return el;}
            let state;
            const ui={addNotification:(_,el)=>state.errors.push(el.textContent),showModal(){},hideModal(){}};
            const rpc={declare:spec=>async(...args)=>{
                if(spec.method==='get_resources')return {files:[{name:'GeoSite',file:'geosite.dat',installed:true,info:{size:1048576}}],dashboard:false};
                if(spec.method==='get_status')return {running:state.running};
                if(spec.method==='core_info'){state.reads++;if(state.readFailure)throw new Error('核心信息获取失败');return structuredClone(state.info);}
                if(spec.method==='package_info'){if(state.packageReadFailure)throw new Error('APK 信息获取失败');return structuredClone(state.packages);}
                if(spec.method==='diagnostic_status'){if(state.pollFailures>0){state.pollFailures--;throw new Error('rpcd restarting');}return state.jobs[args[0]];}
                if(spec.method==='package_check'||spec.method==='package_update'){
                    const action=spec.method==='package_check'?'package-check':'package-update',id='bettbox-job.T'+(++state.counter);
                    state.actions.push(action);state.jobs[id]={done:false};return {ok:true,id,timeout_ms:action==='package-check'?190000:2430000,reconnect:action==='package-update'};
                }
                if(spec.method==='core_check'||spec.method==='core_update'){
                    const action=spec.method==='core_check'?'check':args[0],id='bettbox-job.T'+(++state.counter);
                    state.actions.push(action);state.jobs[id]={done:false};return {ok:true,id,timeout_ms:action==='check'?190000:1230000};
                }
                return {ok:true};
            }};
            const L={url:(...a)=>'/'+a.join('/'),resource:()=> 'data:text/css,/*fixture*/',env:{}};
            const UI=new Function('baseclass','ui','rpc','E','L',shared)({extend:v=>v},ui,rpc,E,L);
            const view=new Function('view','rpc','ui','UI','E','L',source)({extend:v=>v},rpc,ui,UI,E,L);
            window.resetCoreFixture=async(options={})=>{
                state=window.state={running:options.running!==false,reads:0,readFailure:!!options.readFailure,packageReadFailure:!!options.packageReadFailure,pollFailures:0,counter:0,jobs:{},actions:[],errors:[],
                    packages:{ok:true,current:{bettbox:{version:'1.19.33-r3'},'luci-app-bettbox':{version:'1.19.7-r3'}},supported:true,architecture:'aarch64_generic',available:false,latest:null,...options.packages},
                    info:{ok:true,current:'v1.19.30',source:'package',architecture:'arm64',supported:true,latest:null,available:false,rollback:false,previous:null,...options.info}};
                const data=await view.load();document.querySelector('#view').replaceChildren(view.render(data));
            };
            window.completeCore=(action,error)=>{
                const id='bettbox-job.T'+state.counter;
                if(error){state.jobs[id]={done:true,ok:false,code:1,text:error};return;}
                if(action==='check'){state.info.latest='v1.19.33';state.info.available=state.info.current!=='v1.19.33';}
                if(action==='update')Object.assign(state.info,{current:'v1.19.33',latest:'v1.19.33',available:false,source:'managed',rollback:true,previous:'v1.19.30',previous_source:'package'});
                if(action==='rollback')Object.assign(state.info,{current:'v1.19.30',available:true,source:'package',rollback:true,previous:'v1.19.33',previous_source:'managed'});
                state.jobs[id]={done:true,ok:true,code:0,text:action==='check'?JSON.stringify(state.info):'done'};
            };
            window.completePackage=(action,error)=>{
                const id='bettbox-job.T'+state.counter;
                if(error){state.jobs[id]={done:true,ok:false,code:1,text:error};return;}
                if(action==='check')Object.assign(state.packages,{available:true,latest:{tag:'v2026.10.27',packages:[{name:'bettbox',version:'1.19.33-r4'},{name:'luci-app-bettbox',version:'1.19.7-r4'}]}});
                else {state.packages.current.bettbox.version='1.19.33-r4';state.packages.current['luci-app-bettbox'].version='1.19.7-r4';state.packages.available=false;}
                state.jobs[id]={done:true,ok:true,code:0,text:JSON.stringify(action==='check'?state.packages:{ok:true,changed:true,text:'APK 已更新，请刷新页面'})};
            };
        },{source,shared});
        const reset=options=>page.evaluate(options=>window.resetCoreFixture(options),options||{});
        const core=()=>page.locator('.panel').filter({has:page.getByRole('heading',{name:'Mihomo 核心',exact:true})});
        const button=name=>core().getByRole('button',{name,exact:true});
        await reset();
        for(const width of [320,360,390,430,768,1024,1600]){
            await page.setViewportSize({width,height:950});
            assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow '+width);
            const box=await core().boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
            assert.ok(box.height<360,'core card remains compact at '+width);
            if([390,1600].includes(width)){
                fs.mkdirSync(path.join(root,'dist/implementation'),{recursive:true});
                await page.screenshot({path:path.join(root,'dist/implementation/resources-core-'+(width===390?'mobile':'desktop')+'.png'),fullPage:true});
            }
        }
        await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
        await page.setViewportSize({width:390,height:950});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await page.screenshot({path:path.join(root,'dist/implementation/resources-core-dark-mobile.png'),fullPage:true});
        await page.evaluate(()=>document.documentElement.removeAttribute('data-theme'));
        await page.setViewportSize({width:1600,height:950});
        assert.equal(await button('更新并重启').isEnabled(),true,'update can perform its own check');
        assert.equal(await button('回退并重启').isDisabled(),true);
        await button('检查更新').click();
        assert.equal(await core().locator('button:enabled').count(),0);
        await button('检查更新').dispatchEvent('click');
        assert.deepEqual(await page.evaluate(()=>state.actions),['check'],'busy UI does not create duplicate jobs');
        await page.evaluate(()=>window.completeCore('check'));
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('发现新版本'));
        assert.equal(await button('更新并重启').isEnabled(),true);
        await button('更新并重启').click();
        assert.match(await core().textContent(),/v1.19.30/);
        assert.equal(await core().locator('button:enabled').count(),0);
        await page.evaluate(()=>window.completeCore('update'));
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('核心更新完成'));
        assert.equal(await button('更新并重启').isDisabled(),true,'button helper must not override the latest-version state');
        assert.match(await core().textContent(),/独立更新/);
        await button('恢复随包并重启').click();
        await page.evaluate(()=>window.completeCore('rollback'));
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('核心已回退'));
        assert.equal(await button('回退并重启').isEnabled(),true);
        assert.deepEqual(await page.evaluate(()=>state.actions),['check','update','rollback']);

        await button('更新并重启').click();
        await page.evaluate(()=>window.completeCore('update','SHA-256 校验失败，旧核心未切换'));
        await page.waitForFunction(()=>state.errors.length===1);
        assert.match(await core().textContent(),/操作失败.*校验失败/);
        assert.match(await core().textContent(),/v1.19.30/);
        assert.equal(await button('更新并重启').isEnabled(),true);

        await reset({running:false});
        await button('更新核心').click();await page.evaluate(()=>window.completeCore('update'));
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('核心更新完成'));
        assert.equal(await page.evaluate(()=>state.running),false);
        assert.equal(await button('恢复随包核心').isEnabled(),true);

        await reset({info:{supported:false,architecture:'mipsel'}});
        assert.equal(await button('更新并重启').isDisabled(),true);
        assert.match(await core().textContent(),/暂不支持/);
        await reset({readFailure:true});
        assert.match(await core().textContent(),/核心信息获取失败/);
        assert.equal(await page.getByRole('heading',{name:'Geo 数据',exact:true}).count(),1);
        assert.equal(await button('检查更新').isEnabled(),true);
        await page.evaluate(()=>{state.readFailure=false;});
        await button('检查更新').click();await page.evaluate(()=>window.completeCore('check'));
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('发现新版本'));
        assert.equal(await button('更新并重启').isEnabled(),true);
        const pkg=()=>page.locator('.panel').filter({has:page.getByRole('heading',{name:'Bettbox 更新',exact:true})});
        const pkgButton=name=>pkg().getByRole('button',{name,exact:true});
        await reset();assert.equal(await pkgButton('刷新页面').isVisible(),false);
        await pkgButton('检查更新').click();
        assert.equal(await core().locator('button:enabled').count(),0,'APK operation blocks concurrent core UI actions');
        await page.evaluate(()=>window.completePackage('check'));
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('发现 APK 更新'));
        assert.match(await pkg().textContent(),/1\.19\.33-r3 → 1\.19\.33-r4/);
        assert.match(await pkg().textContent(),/1\.19\.7-r3 → 1\.19\.7-r4/);
        await pkgButton('更新并重启服务').click();
        await page.evaluate(()=>{state.pollFailures=2;window.completePackage('update');});
        await page.waitForFunction(()=>document.querySelector('#view').textContent.includes('APK 已更新，请刷新页面'));
        assert.equal(await pkgButton('刷新页面').isVisible(),true);
        assert.equal(await pkgButton('更新并重启服务').isDisabled(),true);
        assert.equal(await page.evaluate(()=>state.errors.length),0,'RPC restart is retried without a false update failure');

        await reset({running:false});
        await pkgButton('更新 APK').click();await page.evaluate(()=>window.completePackage('update','安装可能已部分完成：服务恢复失败'));
        await page.waitForFunction(()=>state.errors.length===1);
        assert.match(await pkg().textContent(),/APK 更新失败.*部分完成/);
        assert.equal(await pkgButton('刷新页面').isVisible(),true);
        assert.equal(await page.evaluate(()=>state.running),false);
        await reset({packages:{supported:false,error:'没有匹配当前 APK 架构的软件包'}});
        assert.equal(await pkgButton('更新并重启服务').isDisabled(),true);
        assert.match(await pkg().textContent(),/没有匹配/);
        await reset({packages:{updating:true}});
        assert.equal(await pkgButton('刷新页面').isVisible(),true);
        assert.equal(await core().locator('button:enabled').count(),0);
        await reset({packageReadFailure:true});
        assert.match(await pkg().textContent(),/APK 信息获取失败/);
        assert.equal(await page.getByRole('heading',{name:'Geo 数据',exact:true}).count(),1);
        assert.deepEqual(errors,[]);
        console.log('PASS: resources core/APK update UI, 7 widths, real async completion, RPC reconnect, rollback/error recovery and stopped/unsupported/busy states');
    }finally{await browser.close();}
})().catch(err=>{console.error(err);process.exit(1);});
