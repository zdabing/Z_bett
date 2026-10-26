// Opt-in integration test against an authenticated router. Never changes its selected
// nodes, service state, UCI config, subscriptions, or scripts.
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.BETTBOX_URL||'http://10.0.0.1';
const state=process.env.BETTBOX_STORAGE_STATE;
if(!state)throw new Error('Set BETTBOX_STORAGE_STATE to a private Playwright storage-state file');
const out=process.env.BETTBOX_SCREENSHOTS||path.join(__dirname,'../dist/implementation');
const pages=['overview','proxies','connections','profiles','scripts','resources','toolbox','logs','settings'];
const widths=[320,360,390,430,768,1024,1600];
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({headless:true,...(process.env.BETTBOX_BROWSER?{executablePath:process.env.BETTBOX_BROWSER}:{})});
 const context=await browser.newContext({storageState:state,ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
 const results=[];
 try{
  for(const name of pages){
   const page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/cgi-bin/luci/admin/services/bettbox/'+name,{waitUntil:'domcontentloaded'});
   await page.waitForSelector('.bb-app[data-bb-page="'+name+'"]',{timeout:20000});
   if(name==='proxies')await page.waitForSelector('[data-test-node]',{timeout:15000});
   if(name==='connections')await page.waitForSelector('.connection-summary strong',{timeout:15000});
   await page.locator('#bettbox-ui-css').waitFor({state:'attached'});
   await page.waitForFunction(()=>[...document.styleSheets].some(s=>s.href&&s.href.includes('bettbox/ui.css')));
   for(const width of widths){
    await page.setViewportSize({width,height:1000});
    await page.waitForTimeout(80);
    const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,nav:[...document.querySelectorAll('.main-nav .nav-item')].map(e=>{const r=e.getBoundingClientRect();return{left:r.left,right:r.right,height:r.height,whiteSpace:getComputedStyle(e).whiteSpace};}),gutter:document.querySelector('.bb-app .shell').getBoundingClientRect().left+parseFloat(getComputedStyle(document.querySelector('.bb-app .shell')).paddingLeft)}));
    assert.ok(size.scroll<=width+1,name+' overflow at '+width+': '+size.scroll);
    assert.equal(size.nav.length,9);
    assert.ok(size.nav.every(n=>n.left>=0&&n.right<=width+1),'all app navigation is on screen');
    if(width<600){assert.ok(size.nav.every(n=>n.height>=44),'mobile nav touch target');assert.ok(size.gutter<=13,'single mobile gutter');}
    if(width===390||width===1600)await page.screenshot({path:path.join(out,name+(width===390?'-mobile':'-desktop')+'.png'),fullPage:true});
    results.push({page:name,width,passed:true});
   }
   await page.setViewportSize({width:390,height:844});
   if(name==='settings'){
    for(const category of ['网络','TUN','DNS','备份','其他','常规']){
     await page.getByRole('button',{name:category,exact:true}).click();
     assert.ok(await page.locator('.settings-panel:visible').count());
     assert.equal(await page.locator('.settings-panel:visible').evaluateAll(els=>els.some(e=>e.getBoundingClientRect().right>innerWidth+1)),false);
    }
    await page.getByRole('button',{name:'网络',exact:true}).click();
    await page.screenshot({path:path.join(out,'settings-network-mobile.png'),fullPage:true});
   }
   if(name==='profiles'&&await page.getByRole('button',{name:'编辑',exact:true}).count()){
    await page.getByRole('button',{name:'编辑',exact:true}).first().click();
    await page.waitForSelector('.bb-modal-content');
    assert.ok(await page.locator('.bb-modal-content input').count());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    // Do not save the owner's subscription.
    await page.getByRole('button',{name:'取消',exact:true}).click();
   }
   if(name==='proxies'){
    // Exercise the independent test control without changing live routing or
    // relying on an upstream node to time out during a regression run.
    const selections=()=>page.locator('.node-select[aria-pressed="true"]').evaluateAll(nodes=>nodes.map(n=>[n.dataset.selectGroup,n.dataset.node]));
    const selectedBefore=await selections();
    const testButton=page.locator('[data-test-node]').first();
    assert.ok(await testButton.isEnabled(),'LuCI E must omit disabled, not serialize disabled=false');
    await page.evaluate(async()=>{const UI=await L.require('bettbox.ui');UI.job=()=>new Promise((resolve,reject)=>setTimeout(()=>reject(new Error('504 timeout')),800));});
    const testedName=await testButton.getAttribute('data-test-node');
    await testButton.click();
    assert.ok(await page.locator('.proxy-latency.testing').count()>0);
    assert.equal(await page.locator('.proxy-latency.testing').evaluateAll((nodes,name)=>nodes.every(n=>n.dataset.testNode===name),testedName),true);
    await page.waitForSelector('.proxy-latency.timeout');
    assert.deepEqual(await selections(),selectedBefore);
    await page.locator('.proxy-latency.timeout').first().click();
    await page.waitForSelector('.proxy-latency.testing');
    await page.waitForSelector('.proxy-latency.timeout');
    await page.getByRole('button',{name:'切换节点卡片/列表视图',exact:true}).click();
    await page.waitForSelector('.proxy-node-grid.list-view');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.getByRole('button',{name:'切换节点卡片/列表视图',exact:true}).click();
   }
   if(name==='scripts'){
    assert.ok((await page.locator('textarea.code-editor').inputValue()).length>0);
    await page.getByRole('button',{name:'脚本选项',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.script-layout').textContent.includes('正在提取'));
   }
   if(name==='logs'){
    await page.getByRole('button',{name:'警告',exact:true}).click();
    assert.equal(await page.locator('.log-entry:not(.warning)').count(),0);
    await page.getByRole('button',{name:'错误',exact:true}).click();
    assert.equal(await page.locator('.log-entry:not(.error)').count(),0);
   }
   if(['overview','proxies','settings'].includes(name)){
    await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
    await page.waitForTimeout(350);
    await page.screenshot({path:path.join(out,name+'-dark-mobile.png'),fullPage:true});
   }
   assert.deepEqual(errors,[],name+' browser errors');
   console.log('PASS '+name+' x '+widths.length+' widths + interactions');
   await page.close();
  }
  fs.writeFileSync(path.join(out,'responsive-results.json'),JSON.stringify(results,null,2));
  console.log('PASS '+results.length+' real-router responsive checks');
 }finally{await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
