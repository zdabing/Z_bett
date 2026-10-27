'use strict';
// Exercise the real shared UI polling contract, with a virtual clock and RPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    let now = 0, status = {done:false},fail=false;
    const timers = [], calls = [];
    class Clock extends Date { static now() { return now; } }
    const rpc = {declare: spec => async id => {
        calls.push({method:spec.method,id});
        if(spec.method==='diagnostic_start')return {ok:true,id:'bettbox-job.diagnostic'};
        if(fail)throw new Error('rpcd reconnecting');
        return {...status};
    }};
    const UI = new Function('baseclass','ui','rpc','E','L','window','Date',source)(
        {extend:v=>v},{},rpc,()=>{}, {}, {setTimeout:fn=>timers.push(fn)},Clock);
    return {UI,calls,set: value=>{status=value;},fail:value=>{fail=value;},tick: async elapsed=>{
        now+=elapsed; const next=timers.shift(); assert.ok(next,'poll is scheduled'); next(); await flush();
    }};
}
(async()=>{
    let checks=0;
    {
        const f=fixture(); let done=false;
        const task=f.UI.operation({ok:true,id:'bettbox-job.service'}).then(()=>{done=true;});
        await flush(); assert.equal(done,false);
        await f.tick(60000); assert.equal(done,false,'55 seconds is not a service operation deadline');
        await f.tick(180000); assert.equal(done,false,'diagnostic deadline is not used for service operations');
        f.set({done:true,ok:true,code:0,text:'ready'}); await f.tick(1000); await task;
        assert.equal(done,true); assert.ok(f.calls.every(c=>c.method==='diagnostic_status')); checks++;
    }
    {
        const f=fixture();
        const task=f.UI.operation({ok:true,id:'bettbox-job.service'});
        const rejected=assert.rejects(task,/new config rejected/);
        await flush(); f.set({done:true,ok:false,code:1,text:'new config rejected; old core retained'});
        await f.tick(60000); await rejected; checks++;
    }
    {
        const f=fixture();
        assert.throws(()=>f.UI.operation({ok:false,error:'服务正在切换'}),/服务正在切换/);
        assert.equal(f.calls.length,0); checks++;
    }
    {
        const f=fixture();
        const task=f.UI.operation({ok:true,id:'bettbox-job.service'});
        const rejected=assert.rejects(task,/任务仍未完成/);
        await flush(); await f.tick(631000); await rejected; checks++;
    }
    {
        const f=fixture();
        const task=f.UI.job('exit',['direct']); const rejected=assert.rejects(task,/任务仍未完成/);
        await flush(); await f.tick(186000); await rejected;
        assert.equal(f.calls.filter(c=>c.method==='diagnostic_start').length,1); checks++;
    }
    {
        const f=fixture(); let done=false;
        const task=f.UI.operation({ok:true,id:'bettbox-job.core',timeout_ms:1230000}).then(()=>{done=true;});
        await flush(); await f.tick(900000);
        assert.equal(done,false,'core download/switch may outlive the service deadline');
        f.set({done:true,ok:true,code:0,text:'updated'}); await f.tick(1000); await task; checks++;
    }
    {
        const f=fixture();
        const task=f.UI.operation({ok:true,id:'bettbox-job.core',timeout_ms:99999999});
        const rejected=assert.rejects(task,/任务仍未完成/);
        await flush(); await f.tick(1231000); await rejected; checks++;
    }
    {
        const f=fixture();let done=false;
        const task=f.UI.operation({ok:true,id:'bettbox-job.package',timeout_ms:2430000,reconnect:true}).then(()=>{done=true;});
        await flush();await f.tick(1500000);assert.equal(done,false);
        f.fail(true);await f.tick(1000);await f.tick(30000);assert.equal(done,false,'short RPC outage is retried');
        f.fail(false);f.set({done:true,ok:true,code:0,text:'updated'});await f.tick(1000);await task;checks++;
    }
    {
        const f=fixture();f.fail(true);
        const task=f.UI.operation({ok:true,id:'bettbox-job.package',timeout_ms:2430000,reconnect:true});
        const rejected=assert.rejects(task,error=>error.unconfirmed===true&&/重新登录/.test(error.message));
        await flush();await f.tick(91000);await rejected;checks++;
    }
    {
        const f=fixture(), value={ok:true,text:'legacy synchronous result'};
        assert.equal(f.UI.operation(value),value); checks++;
    }
    console.log('PASS: '+checks+' service operation completion, failure, admission and timeout checks');
})().catch(error=>{console.error(error);process.exit(1);});
