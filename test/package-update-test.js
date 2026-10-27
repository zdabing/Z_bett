'use strict';
// Run the production ucode with controlled processes and an in-memory FS.
// Real SHA-256 is used; no actual APK, router, network or installation is used.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../bettbox/files/usr/libexec/bettbox/package-update.uc'),'utf8')
    .replace(/^#!.*\n/,'').replace(/^import .*$/gm,'').replace(/for\s*\((let \w+) in /g,'for ($1 of ')
    .replace(/([\w.]+) in NAMES/g,'NAMES.includes($1)').replace(/([\w.]+) in (\[[^\]\n]+\])/g,'$2.includes($1)');
const REPO='https://github.com/zdabing/Z_bett',API='https://api.github.com/repos/zdabing/Z_bett/releases/latest';
const STATE='/etc/bettbox/state',NAMES=['bettbox','luci-app-bettbox'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(options={}){
    const arch=options.arch||'aarch64_generic',tag='v2026.10.27',commands=[],files=new Map(),locks=new Set(),migrations=[];
    let serial=0,active=options.running!==false,installs=0;
    files.set('/usr/bin/apk','binary');files.set('/etc/apk/arch',arch+'\nnoarch\n');
    files.set('/etc/openwrt_release',"DISTRIB_RELEASE='"+(options.openwrt||'25.12-SNAPSHOT')+"'\n");
    const versions=options.installed||['1.19.33-r3','1.19.7-r3'],newVersions=options.latest||['1.19.33-r4','1.19.7-r4'];
    const installed=NAMES.map((name,i)=>({name,version:versions[i],arch:i===0?arch:'noarch',status:['installed']}));
    const packages=NAMES.map((name,i)=>{
        const bytes=Buffer.from('APK fixture for '+name),filename=name+'-'+newVersions[i]+'-'+arch+'.apk';
        files.set('/remote/'+filename,bytes);
        return {name,version:newVersions[i],arch:i===0?arch:'noarch',filename,size:bytes.length,installed_size:1000000,sha256:sha(bytes)};
    });
    const manifest={schema:1,tag,openwrt:'25.12',targets:{[arch]:{packages}}};
    if(options.manifest)options.manifest(manifest);
    const manifestBytes=JSON.stringify(manifest);
    files.set('/remote/bettbox-update.json',manifestBytes);
    const release={tag_name:tag,html_url:REPO+'/releases/tag/'+tag,draft:false,prerelease:false,assets:packages.concat([{filename:'bettbox-update.json',size:Buffer.byteLength(manifestBytes),sha256:sha(manifestBytes)}]).map(p=>({name:p.filename,size:p.size,digest:'sha256:'+p.sha256,browser_download_url:REPO+'/releases/download/'+tag+'/'+p.filename}))};
    if(options.release)options.release(release);
    const data=p=>{const value=files.get(p);return Buffer.isBuffer(value)?value:Buffer.from(value||'');};
    function process(command){
        commands.push(command);let text='',code=0;
        const quoted=[...command.matchAll(/'([^']*)'/g)].map(m=>m[1]);
        if(command.startsWith('timeout 5 uname'))text=arch==='x86_64'?'x86_64':'aarch64';
        else if(command.startsWith('mkdir -p')){}
        else if(command.startsWith('timeout 10 apk query'))text=JSON.stringify(installed);
        else if(command.startsWith('timeout 5 apk version')){
            const v=s=>s.split(/[.r-]+/).filter(Boolean).map(Number),a=v(quoted[0]),b=v(quoted[1]);
            text='=';for(let i=0;i<4;i++)if(a[i]!==b[i]){text=a[i]<b[i]?'<':'>';break;}
        }else if(command.startsWith('curl ')){
            const output=command.match(/ -o '([^']+)'/)[1],url=quoted.at(-1);
            if(options.networkFail){code=22;text='HTTP 403';}
            else if(url===API)files.set(output,JSON.stringify(release));
            else {
                const name=url.split('/').at(-1);assert.ok(url.startsWith(REPO+'/releases/download/'+tag+'/'));
                const bytes=data('/remote/'+name);
                files.set(output,options.corrupt&&name.endsWith('.apk')?Buffer.from('corrupt'):bytes);
            }
        }else if(command.startsWith('sha256sum '))text=sha(data(quoted[0]));
        else if(command.startsWith('df -Pk '))text=options.noSpace?'0':'9999999';
        else if(command.startsWith('timeout 60 apk --allow-untrusted verify')){if(options.verifyFail){code=1;text='bad APK';}}
        else if(command.includes('apk adbdump --format json')){
            const index=Number(quoted[0].match(/\/([01])\.apk$/)[1]),entry=packages[index];
            const info={name:entry.name,version:entry.version,arch:entry.arch,'installed-size':entry.installed_size};
            if(index===0){info.provides=['bettbox-forge='+entry.version];info.replaces=['bettbox-forge'];}
            if(options.metadata)options.metadata(info,index);
            files.set(quoted[1],JSON.stringify(options.arrayMetadata?[{info}]:{info}));
        }else if(command.startsWith('timeout 120 apk ')){
            text=options.plan||'(1/3) Upgrading bettbox (1.19.33-r3 -> 1.19.33-r4)\n(2/3) Upgrading luci-app-bettbox (1.19.7-r3 -> 1.19.7-r4)\n(3/3) Purging bettbox-forge (1.19.7-r1)\nOK';
            if(options.planFail){code=1;text='unsatisfied dependencies';}
        }else if(command.startsWith('ubus '))text=JSON.stringify({bettbox:{instances:{core:{running:active}}}});
        else if(command.startsWith('uci '))text=options.disabled?'0':'1';
        else if(command.startsWith('timeout 120 /usr/bin/bettbox backup create')){
            if(options.backupFail){code=1;text='backup failed';}else files.set(quoted[0],'private tar');
        }else if(command.startsWith('env -i ')){
            assert.ok(command.includes('BETTBOX_SELF_UPDATE=1')&&command.includes('--preserve-env'));
            assert.ok(files.has(STATE+'/before-package-update.tar'),'backup exists before install');
            installs++;active=false;
            if(options.installFail){installed[0].version=newVersions[0];code=1;text='APK transaction failed';}
            else installed.forEach((p,i)=>{p.version=options.wrongInstalledVersion?versions[i]:newVersions[i];if(options.broken)p.status=['broken-scripts'];});
        }else if(command.startsWith('timeout 600 /etc/init.d/bettbox restart')){
            migrations.push('restart');if(options.restartFail){code=1;text='core not ready';}else active=true;
        }else if(command.startsWith('timeout 60 /etc/init.d/bettbox stop')){migrations.push('stop');active=false;}
        else if(command.startsWith('timeout 30 /etc/init.d/rpcd restart'))migrations.push('rpcd');
        else throw new Error('Unexpected command '+command);
        let offset=0;return {read:n=>{const part=text.slice(offset,offset+n);offset+=part.length;return part;},close:()=>code};
    }
    function run(action){
        const output=[];
        const env={ARGV:[action],popen:process,access:p=>files.has(p),readfile:p=>files.has(p)?data(p).toString():null,
            stat:p=>files.has(p)?{size:data(p).length}:null,mkdtemp:t=>t.replace('XXXXXX','T'+(++serial)),
            writefile:(p,v)=>{files.set(p,v);return v.length;},unlink:p=>files.delete(p),rmdir:()=>true,
            rename:(a,b)=>{if(!files.has(a))return null;files.set(b,files.get(a));files.delete(a);return true;},
            open:p=>{let held=false;return {lock:()=>{if(locks.has(p)||(options.busy&&p.includes('package-update.lock'))||(options.coreBusy&&p.includes('/core/')))return null;locks.add(p);held=true;return true;},close:()=>{if(held)locks.delete(p);}};},
            type:v=>v==null?'null':Array.isArray(v)?'array':typeof v==='boolean'?'bool':Number.isInteger(v)?'int':typeof v,
            json:JSON.parse,length:v=>v==null?0:v.length,match:(s,re)=>s.match(re),substr:(s,a,b)=>s.substr(a,b),split:(s,sep)=>s.split(sep),trim:s=>s.trim(),
            int:v=>Number.parseInt(v,10),push:(a,v)=>a.push(v),time:()=>10000,replace:(s,re,v)=>s.replace(re,v),
            sprintf:(fmt,v)=>fmt.replace(/%[sJ]/,m=>m==='%J'?JSON.stringify(v):String(v)),print:s=>output.push(s),die:s=>{throw new Error(s);}};
        new Function(...Object.keys(env),source)(...Object.values(env));return output.join('');
    }
    return {run,files,commands,migrations,installed,get installs(){return installs;},get active(){return active;}};
}
let checks=0;
for(const arch of ['x86_64','aarch64_generic']){
    const f=fixture({arch});assert.equal(JSON.parse(f.run('check')).available,true);assert.equal(f.installs,0);
    assert.equal(JSON.parse(f.run('update')).changed,true);assert.equal(f.installs,1);
    assert.deepEqual(f.migrations,['restart','rpcd']);assert.equal(f.active,true);
    assert.ok(f.commands.findIndex(c=>c.includes('--simulate add'))<f.commands.findIndex(c=>c.startsWith('env -i')));checks++;
}
for(const options of [{networkFail:true},{corrupt:true},{noSpace:true},{verifyFail:true},{planFail:true},{backupFail:true},{busy:true},{coreBusy:true},{disabled:true},
    {manifest:m=>m.schema=99},{manifest:m=>m.targets.aarch64_generic.packages[0].arch='x86_64'},
    {release:r=>r.prerelease=true},{release:r=>r.assets[0].digest=null},{release:r=>r.assets[0].browser_download_url='https://evil.test/a.apk'},
    {metadata:m=>m.name='other'},{metadata:m=>m.version='9.0.0-r1'},{metadata:m=>m.arch='x86_64'},{metadata:m=>m['installed-size']=5},
    {metadata:m=>m.provides=[]},{metadata:m=>m.replaces=[]},
    {plan:'(1/2) Purging uhttpd (1.0-r1)\n(2/2) Upgrading bettbox (1 -> 2)'},
    {plan:'(1/2) Upgrading libc (1 -> 2)\n(2/2) Upgrading bettbox (1 -> 2)'},
    {plan:'(1/1) Downgrading bettbox (2 -> 1)'},{plan:'OK'},
    {latest:['1.19.33-r2','1.19.7-r4']}]){
    const f=fixture(options);assert.throws(()=>f.run('update'),JSON.stringify(options));assert.equal(f.installs,0);checks++;
}
{
    const f=fixture({running:false,arrayMetadata:true});f.run('update');assert.equal(f.active,false);assert.deepEqual(f.migrations,['rpcd']);checks++;
}
for(const options of [{installFail:true},{restartFail:true},{wrongInstalledVersion:true},{broken:true}]){
    const f=fixture(options);assert.throws(()=>f.run('update'),/安装可能已部分完成/);assert.equal(f.installs,1);
    assert.equal(JSON.parse(f.files.get(STATE+'/package-update-result.json')).phase,'failed');assert.ok(f.files.has(STATE+'/before-package-update.tar'));checks++;
}
{
    const f=fixture({installed:['1.19.33-r4','1.19.7-r4']});assert.equal(JSON.parse(f.run('update')).changed,false);assert.equal(f.installs,0);checks++;
}
for(const options of [{arch:'aarch64_cortex-a53'},{openwrt:'24.10.3'}]){
    const f=fixture(options);assert.equal(JSON.parse(f.run('status')).supported,false);assert.throws(()=>f.run('update'));assert.equal(f.installs,0);checks++;
}
console.log('PASS: '+checks+' APK updater architecture/manifest/hash/metadata/preflight/backup/service/failure checks (controlled processes)');
