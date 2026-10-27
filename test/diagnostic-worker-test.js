'use strict';
// Run the production ucode dispatch/output logic with filesystem/process stubs.
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../bettbox/files/usr/libexec/bettbox/diagnostic.uc'),'utf8')
    .replace(/^#!.*\n/,'').replace(/^import .*$/gm,'')
    .replace(/([\w.\[\]]+) in (\[[^\]\n]+\])/g,'$2.includes($1)');
function run(kind,args,options={}) {
    const commands=[], output=[], chunks=options.chunks||['finished\n',''];let index=0;
    const env={ARGV:['/tmp/bettbox-job.TEST'],readfile:()=>JSON.stringify({kind,args}),
        json:JSON.parse,match:(s,re)=>s.match(re),length:s=>s==null?0:s.length,
        replace:(s,re,value)=>s.replace(re,value),sprintf:(fmt,s)=>fmt.replace('%s',s),
        substr:(s,start)=>s.substr(start),writefile:()=>1,
        popen:command=>{commands.push(command);return {read:size=>{assert.equal(size,4096);return index<chunks.length?chunks[index++]:'';},close:()=>options.code||0};},
        print:s=>output.push(s),exit:code=>{throw {workerExit:true,code};},die:message=>{throw new Error(message);}};
    let code;
    try{new Function(...Object.keys(env),source)(...Object.values(env));}
    catch(error){if(!error.workerExit)throw error;code=error.code;}
    return {commands,output:output.join(''),code};
}
let checks=0;
for(const action of ['start','stop','restart','apply']) {
    const result=run('service',[action]);assert.equal(result.code,0);assert.equal(result.commands.length,1);
    const command=result.commands[0];
    if(action==='apply')assert.match(command,/bettbox apply-service/);
    else assert.ok(command.includes('/etc/init.d/bettbox '+action));
    if(action==='start'||action==='stop')assert.ok(command.includes("uci set bettbox.config.enabled='"+(action==='start'?'1':'0')+"' && uci commit bettbox"));
    if(action==='start'||action==='restart')assert.ok(command.startsWith('/etc/init.d/bettbox enable && '));
    checks++;
}
assert.throws(()=>run('service',['stop; reboot']),/bad service action/);checks++;
assert.throws(()=>run('service',['stop','extra']),/bad service action/);checks++;
for(const action of ['update','rollback']){
    const result=run('core',[action]);assert.equal(result.code,0);
    assert.equal(result.commands[0],'/usr/bin/bettbox core '+action+' 2>&1');checks++;
}
assert.equal(run('core-check',[]).commands[0],'/usr/bin/bettbox core check 2>&1');checks++;
assert.throws(()=>run('core',['update; reboot']),/bad core action/);checks++;
assert.throws(()=>run('core',['update','extra']),/bad core action/);checks++;
assert.throws(()=>run('core-check',['update']),/bad core action/);checks++;
assert.equal(run('core',['update'],{code:7}).code,1);checks++;
assert.equal(run('package',['update']).commands[0],'/usr/bin/bettbox package update 2>&1');checks++;
assert.equal(run('package-check',[]).commands[0],'/usr/bin/bettbox package check 2>&1');checks++;
assert.throws(()=>run('package',['rollback']),/bad package action/);checks++;
assert.throws(()=>run('package-check',['update']),/bad package action/);checks++;
assert.equal(run('service',['start'],{code:7}).code,1);checks++;
assert.throws(()=>run('service',['start'],{chunks:[null]}),/could not read/);checks++;
{
    const result=run('service',['apply'],{chunks:Array.from({length:300},()=> 'x'.repeat(4096)).concat(['final-error\n',''])});
    assert.equal(result.output.length,1048576);assert.ok(result.output.endsWith('final-error\n'));checks++;
}
assert.equal(run('delay',['DIRECT','https%3A%2F%2Fexample.test']).code,0);checks++;
assert.throws(()=>run('toolbox',['age','encrypt','public-key','input'],{chunks:Array.from({length:300},()=> 'x'.repeat(4096))}),/exceeded 1MB/);checks++;
console.log('PASS: '+checks+' service/diagnostic dispatch, command status and bounded output checks');
