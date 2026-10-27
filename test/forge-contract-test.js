'use strict';
// Execute the actual JavaScript wrappers from the Rust source under Node.
// This checks the script contract only, not native QuickJS/Rust integration.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../bettbox/forge');
const source=fs.readFileSync(path.join(root,'src/script/mod.rs'),'utf8');
const entry=source.match(/let source = format!\(\s*"((?:[^"\\]|\\.)*)"\s*\);/)[1];
const options=source.match(/const EXTRACT_OPTIONS: &str = r#"([\s\S]*?)"#;/)[1];
function format(template,values){return template.replace(/\{\{|\}\}|\{(script|ENTRY|EXTRACT_OPTIONS)\}|\\n/g,(m,key)=>m==='{{'?'{':m==='}}'?'}':m==='\\n'?'\n':values[key]);}
function context(){const logs=[];return {sandbox:vm.createContext({console:{log:(...args)=>logs.push(args)}}),logs};}
async function run(script,input={},custom=null){
    const normalized=JSON.parse(JSON.stringify(input));
    if(Object.hasOwn(normalized,'rule')){normalized.rules=normalized.rule;delete normalized.rule;}
    normalized['proxy-providers']??={};
    const {sandbox,logs}=context();
    const fn=vm.runInContext(format(entry,{script,ENTRY:'main'}),sandbox,{timeout:1000});
    sandbox.entry=fn;sandbox.config=JSON.parse(JSON.stringify(normalized));sandbox.options=custom;
    const result=await vm.runInContext('entry(config,options)',sandbox,{timeout:1000});
    return {result:JSON.parse(JSON.stringify(result&&typeof result==='object'&&!Array.isArray(result)?result:normalized)),logs};
}
function extract(script){const {sandbox}=context();return JSON.parse(vm.runInContext(format('(function() {{ {script}\n{EXTRACT_OPTIONS} }})()',{script,EXTRACT_OPTIONS:options}),sandbox,{timeout:1000}));}
(async()=>{
    let checks=0;
    assert.equal((await run('function main(c){c.mode="direct";return c}')).result.mode,'direct');checks++;
    assert.equal((await run('const main=c=>c',{rule:['MATCH,DIRECT']})).result.rules[0],'MATCH,DIRECT');checks++;
    for(const value of ['null','undefined','false','1','[]']){
        assert.equal((await run('function main(c){c.mode="global";return '+value+'}',{mode:'rule'})).result.mode,'rule');checks++;
    }
    const merged=await run('const ruleOptionsEnable={ads:true}; function main(c,o){c.flags=ruleOptionsEnable;c.arg=o.ads;return c}',{}, {ads:false});
    assert.deepEqual(merged.result.flags,{ads:false});assert.equal(merged.result.arg,false);checks++;
    assert.equal((await run('async function main(c){c.mode=await Promise.resolve("direct");return c}')).result.mode,'direct');checks++;
    assert.equal((await run('var local=1;function main(c){c.local=typeof local;c.global=typeof globalThis.local;return c}')).result.global,'undefined');checks++;
    await assert.rejects(run('function main(){throw new Error("bad config")}'),/bad config/);checks++;
    await assert.rejects(run('function main( {'),/./);checks++;
    await assert.rejects(run('function main(){while(true){}}'),/timed out/);checks++;
    const script=fs.readFileSync(path.join(root,'tests/fixtures/profile_script.js'),'utf8');
    const profile=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/profile_config.json'),'utf8'));
    const result=(await run(script,profile,{streaming:false})).result;
    assert.deepEqual(result['proxy-groups'].map(g=>g.name),['Main','AI']);
    assert.deepEqual(result.rules,['DOMAIN-SUFFIX,ai.example,AI','GEOIP,CN,DIRECT','MATCH,Main']);checks++;
    assert.deepEqual(extract(script),{options:{ai:true,streaming:true,ads:false},icons:{AI:'ai.png',Streaming:'tv.png'},policyGroupOptions:['AI','Streaming']});checks++;
    assert.deepEqual(extract('function main(c){return c}'),{options:{},icons:{},policyGroupOptions:[]});checks++;
    assert.throws(()=>extract('while(true){}'),/timed out/);checks++;
    console.log('PASS: '+checks+' production forge JS wrapper/option contract checks (Node, not native QuickJS)');
})().catch(error=>{console.error(error);process.exit(1);});
