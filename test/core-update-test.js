'use strict';
// Production ucode with an in-memory filesystem and controlled child processes.
// Real gzip/CRC and SHA-256 fixtures; no network or executable download is used.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const yaml=require('js-yaml');
const source=fs.readFileSync(path.join(__dirname,'../bettbox/files/usr/libexec/bettbox/core-update.uc'),'utf8')
    .replace(/^#!.*\n/,'').replace(/^import .*$/gm,'')
    .replace(/for\s*\((let \w+) in /g,'for ($1 of ')
    .replace(/([\w.\[\]]+) in (\[[^\]\n]+\])/g,'$2.includes($1)');
const ROOT='/etc/bettbox/core',PACKAGE='/usr/bin/mihomo',API='https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function elf(version,arch='arm64') {
    const bytes=Buffer.alloc(1000,65);bytes.write('\x7fELF',0,'latin1');bytes[4]=['arm64','amd64-compatible'].includes(arch)?2:1;bytes[5]=1;
    bytes.writeUInt16LE(arch==='arm64'?183:arch==='amd64-compatible'?62:40,18);bytes.write('Mihomo Meta '+version+'\n',32);return bytes;
}
function fixture(options={}) {
    const files=new Map([[PACKAGE,elf(options.installed||'v1.19.30',options.arch||'arm64')],['/var/run/bettbox/config.yaml','mode: direct\n']]);
    const dirs=new Set(['/','/etc','/etc/bettbox','/etc/bettbox/state','/usr','/usr/bin','/var','/var/run','/var/run/bettbox','/tmp']);
    const links=new Map(),commands=[],switches=[],modes=new Map();let serial=0,locked=!!options.lockBusy;
    const platform=options.arch||'arm64',latest=options.latest||'v1.19.33',raw=elf(latest,options.wrongArch?'amd64-compatible':platform);
    const archive=zlib.gzipSync(raw),asset='mihomo-linux-'+platform+'-'+latest+'.gz';
    const release={tag_name:latest,draft:false,prerelease:false,assets:[{name:asset,size:archive.length,digest:'sha256:'+hash(archive),browser_download_url:'https://github.com/MetaCubeX/mihomo/releases/download/'+latest+'/'+asset}]};
    if(options.metadata)options.metadata(release);
    function resolve(p) {
        for(let n=0;n<10;n++) {
            const parts=p.split('/').filter(Boolean);let changed=false;
            for(let i=1;i<=parts.length;i++) {
                const prefix='/'+parts.slice(0,i).join('/');
                if(links.has(prefix)){p=path.posix.resolve(path.posix.dirname(prefix),links.get(prefix),...parts.slice(i));changed=true;break;}
            }
            if(!changed)return p;
        }
        throw new Error('fixture symlink cycle');
    }
    const bytes=p=>{const value=files.get(resolve(p));return Buffer.isBuffer(value)?value:Buffer.from(value||'');};
    const mkdir=p=>{const parts=p.split('/').filter(Boolean);for(let i=1;i<=parts.length;i++)dirs.add('/'+parts.slice(0,i).join('/'));};
    const stat=p=>{p=resolve(p);return files.has(p)?{size:bytes(p).length,type:'file'}:dirs.has(p)?{type:'directory'}:null;};
    function fsrename(a,b) {
        if(options.renameFail && b===ROOT+'/current')return null;
        if(links.has(a)){links.set(b,links.get(a));links.delete(a);return true;}
        if(files.has(a)){files.set(b,files.get(a));files.delete(a);return true;}
        if(dirs.has(a)){
            for(const p of [...dirs])if(p===a||p.startsWith(a+'/')){dirs.add(b+p.slice(a.length));dirs.delete(p);}
            for(const [p,v] of [...files])if(p.startsWith(a+'/')){files.set(b+p.slice(a.length),v);files.delete(p);}
            return true;
        }
        return null;
    }
    function exec(cmd) {
        commands.push(cmd);let text='',code=0;
        const quoted=[...cmd.matchAll(/'([^']*)'/g)].map(m=>m[1]);
        if(cmd.startsWith('uname -m'))text=options.machine||({'arm64':'aarch64','amd64-compatible':'x86_64',armv7:'armv7l',armv6:'armv6l'})[platform];
        else if(cmd.startsWith('mkdir -p'))quoted.forEach(mkdir);
        else if(cmd.startsWith('df -Pk'))text=String(options.noSpace?0:1000000);
        else if(cmd.startsWith('curl ')){
            const dest=cmd.match(/ -o '([^']+)'/)[1],url=quoted.at(-1);
            if(options.downloadFail && url!==API){code=22;text='download failed';}
            else if(options.apiFail && url===API){code=22;text='HTTP 403';}
            else if(url===API)files.set(dest,JSON.stringify(release));
            else {assert.equal(url,release.assets[0].browser_download_url);files.set(dest,options.corrupt?Buffer.concat([archive,Buffer.from('bad')]):archive);}
        } else if(cmd.startsWith('sha256sum '))text=hash(bytes(quoted[0]))+'  '+quoted[0];
        else if(cmd.includes('gzip -dc ')){
            if(options.gzipFail){code=1;text='invalid gzip';}
            else files.set(quoted.at(-1),zlib.gunzipSync(bytes(quoted[0])));
        } else if(cmd.startsWith('timeout 5 ')){
            const payload=bytes(quoted[0]).toString('latin1'),v=payload.match(/Mihomo Meta (v[0-9.]+)/);
            if(options.execFail && quoted[0]!==PACKAGE){code=126;text='Exec format error';}
            else {text=v?'Mihomo Meta '+(options.versionMismatch && quoted[0]!==PACKAGE?'v1.19.1':v[1]):'';code=text?0:1;}
        } else if(cmd.startsWith('timeout 120 ')){
            const config=cmd.match(/ -f '([^']+)'/)[1];
            const parsed=yaml.load(bytes(config).toString());
            if(config.startsWith('/tmp/'))assert.deepEqual(parsed.rules,['MATCH,DIRECT'],'minimal validation config must contain one valid rule');
            if(options.invalidConfig && resolve(quoted[0])!==PACKAGE){code=1;text='unsupported config';}
        } else if(cmd.startsWith('/etc/init.d/bettbox core_switch ')) {
            const target=quoted[0],old=links.get(ROOT+'/current')||'package',previous=links.get(ROOT+'/previous')||'none';
            switches.push(target);
            try {
                run('validate',target);run('select',target);
                if(options.startFail){run('restore',old,previous);throw new Error('startup failed; previous core restored');}
            } catch(error){code=1;text=error.message;}
        } else throw new Error('Unexpected process: '+cmd);
        let offset=0;
        return {read:size=>{const part=text.slice(offset,offset+size);offset+=part.length;return part;},close:()=>code};
    }
    function run(...args) {
        const output=[];
        const env={ARGV:args,access:p=>!!stat(p),stat,lstat:p=>links.has(p)?{type:'link'}:stat(p),readlink:p=>links.get(p)??null,
            readfile:p=>files.has(resolve(p))?(Buffer.isBuffer(files.get(resolve(p)))?bytes(p).toString('latin1'):files.get(resolve(p))):null,
            writefile:(p,v)=>{files.set(p,v);return v.length;},mkdir:p=>{dirs.add(p);return true;},
            mkdtemp:template=>{const p=template.replace('XXXXXX','T'+(++serial));mkdir(p);return p;},
            rename:fsrename,symlink:(target,p)=>{links.set(p,target);return true;},
            unlink:p=>{files.delete(p);links.delete(p);return true;},rmdir:p=>{
                if([...files.keys(),...dirs].some(name=>name.startsWith(p+'/')))return null;dirs.delete(p);return true;},
            lsdir:p=>[...new Set([...dirs,...files.keys(),...links.keys()].filter(name=>name.startsWith(p+'/')).map(name=>name.slice(p.length+1).split('/')[0]))],
            chmod:(p,mode)=>{modes.set(p,mode);return true;},
            open:p=>{if(!files.has(resolve(p)) && !p.endsWith('/update.lock'))return null;
                if(p.endsWith('/update.lock'))files.set(p,files.get(p)||'');
                let offset=0,owned=false;return {read:size=>{const value=bytes(p).subarray(offset,offset+size);offset+=value.length;return value.toString('latin1');},
                    seek:(at,where)=>{offset=(where===2?bytes(p).length:where===1?offset:0)+at;return true;},
                    lock:()=>{if(locked)return null;locked=owned=true;return true;},close:()=>{if(owned)locked=false;return true;}};
            },popen:exec,json:JSON.parse,type:v=>v==null?'null':Array.isArray(v)?'array':typeof v==='boolean'?'bool':Number.isInteger(v)?'int':typeof v,
            length:v=>v==null?0:v.length,match:(s,re)=>s.match(re),ord:(s,i)=>s.charCodeAt(i),substr:(s,a,b)=>s.substr(a,b),
            split:(s,sep)=>s.split(sep),int:v=>Number.parseInt(v,10),replace:(s,re,v)=>s.replace(re,v),trim:s=>s.trim(),time:()=>10000,
            sprintf:(fmt,...args)=>{let i=0;return fmt.replace(/%([sJ])/g,(_,k)=>k==='J'?JSON.stringify(args[i++]):String(args[i++]));},
            print:s=>output.push(s),die:message=>{throw new Error(message);}};
        new Function(...Object.keys(env),source)(...Object.values(env));return output.join('');
    }
    return {run,files,dirs,links,switches,commands,modes,release};
}

let checks=0;
for(const arch of ['arm64','amd64-compatible','armv7','armv6']) {
    const f=fixture({arch});const checked=JSON.parse(f.run('check'));assert.equal(checked.available,true);assert.equal(f.switches.length,0);
    f.run('update');assert.equal(JSON.parse(f.run('status')).current,'v1.19.33');
    assert.equal(f.links.get(ROOT+'/previous'),'package');assert.equal(f.switches.length,1);checks++;
}
{
    const f=fixture();f.run('update');f.run('rollback');
    assert.equal(JSON.parse(f.run('status')).current,'v1.19.30');assert.equal(JSON.parse(f.run('status')).previous,'v1.19.33');
    assert.ok(f.files.has(PACKAGE));assert.deepEqual(f.files.get(PACKAGE),elf('v1.19.30'));checks++;
}
for(const options of [{corrupt:true},{wrongArch:true},{execFail:true},{versionMismatch:true},{gzipFail:true},{noSpace:true},{downloadFail:true},{apiFail:true},{invalidConfig:true},{lockBusy:true}]) {
    const f=fixture(options);assert.throws(()=>f.run('update'));
    assert.equal(f.links.get(ROOT+'/current'),undefined,'failure before activation leaves package selected');
    if(!options.invalidConfig)assert.equal(f.switches.length,0,'invalid download must never enter service transition');
    assert.equal(JSON.parse(f.run('status')).current,'v1.19.30');checks++;
}
for(const mutate of [j=>j.assets[0].digest=null,j=>j.assets[0].browser_download_url='https://evil.test/core.gz',j=>j.prerelease=true,j=>j.tag_name='../../bad',j=>j.assets[0].size=999999999]) {
    const f=fixture({metadata:mutate});assert.throws(()=>f.run('update'));assert.equal(f.switches.length,0);checks++;
}
{
    const f=fixture({startFail:true});assert.throws(()=>f.run('update'),/startup failed/);
    assert.equal(JSON.parse(f.run('status')).current,'v1.19.30');assert.equal(f.links.has(ROOT+'/previous'),false);checks++;
}
{
    const f=fixture({installed:'v1.19.33'});f.run('update');assert.equal(f.switches.length,0);checks++;
}
{
    const f=fixture({installed:'v1.20.0'});f.run('update');assert.equal(f.switches.length,0,'stable updater must not downgrade');checks++;
}
{
    const f=fixture({machine:'mipsel'});assert.equal(JSON.parse(f.run('status')).supported,false);
    assert.throws(()=>f.run('update'),/架构/);assert.equal(f.switches.length,0);checks++;
}
{
    const f=fixture();assert.throws(()=>f.run('rollback'),/没有可回退/);checks++;
}
{
    const f=fixture();f.links.set(ROOT+'/current','../../etc');assert.throws(()=>f.run('status'),/无效路径/);checks++;
}
{
    const f=fixture();f.files.delete('/var/run/bettbox/config.yaml');f.run('update');
    assert.equal(JSON.parse(f.run('status')).current,'v1.19.33');
    assert.ok(![...f.dirs].some(p=>p.startsWith('/tmp/bettbox-core-config.')),'minimal validation config is cleaned');checks++;
}
{
    const f=fixture({lockBusy:true}),target='releases/v1.19.33-arm64-'+ 'a'.repeat(64);
    f.dirs.add(ROOT+'/'+target);f.files.set(ROOT+'/'+target+'/mihomo',elf('v1.19.33'));
    assert.throws(()=>f.run('update'),/已有核心/);
    assert.ok(f.files.has(ROOT+'/'+target+'/mihomo'),'failed lock acquisition cannot prune another updater candidate');checks++;
}
{
    const f=fixture();f.run('update');const target=f.links.get(ROOT+'/current');f.files.set(ROOT+'/'+target+'/mihomo',elf('v1.19.1'));
    assert.throws(()=>f.run('validate',target),/校验失败/);checks++;
}
console.log('PASS: '+checks+' core update architecture, official metadata, checksum/ELF, compatibility, state and rollback checks');
