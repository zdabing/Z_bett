#!/usr/bin/ucode
// Private, bounded background diagnostics; rpcd only starts/polls this worker.
import { readfile, popen, writefile } from 'fs';
let dir = ARGV[0];
if (!match(dir ?? '', /^\/tmp\/bettbox-job\.[A-Za-z0-9]+$/)) die('invalid diagnostic workspace');
let request = json(readfile(dir + '/request'));
function q(s) { return sprintf("'%s'", replace('' + s, /'/g, "'\\''")); }
let args = request.args ?? [];
let command;
if (request.kind == 'exit') {
	if (!(args[0] in ['direct', 'proxy'])) die('bad exit mode');
	command = '/usr/libexec/bettbox/network-check.sh exit ' + q(args[0]);
} else if (request.kind == 'connectivity') {
	command = '/usr/libexec/bettbox/network-check.sh connectivity';
} else if (request.kind == 'delay') {
	if(length(args)!=2 || !match(args[0],/^[A-Za-z0-9_.~%\/-]+$/) || !match(args[1],/^[A-Za-z0-9_.~%\/-]+$/))die('bad delay target');
	command='/usr/libexec/bettbox/network-check.sh delay '+q(args[0])+' '+q(args[1]);
} else if (request.kind == 'toolbox') {
	let tool = args[0];
	if (!(tool in ['dns','ip','ping','speedtest','media','trace','mrs','nat','age','iperf'])) die('bad diagnostic tool');
	command = '/usr/libexec/bettbox/toolbox.sh ' + q(tool);
	for (let i = 1; i < length(args); i++) {
		if (tool == 'age' && i == 3) {
			writefile(dir + '/input', args[i]);
			continue;
		}
		command += ' ' + q(args[i]);
	}
	if (tool == 'age') command += ' < ' + q(dir + '/input');
} else if (request.kind == 'service') {
	if(length(args)!=1 || !(args[0] in ['start','stop','restart','apply']))die('bad service action');
	command=args[0]=='apply'?'/usr/bin/bettbox apply-service':'/etc/init.d/bettbox '+args[0];
	if(args[0]=='start'||args[0]=='stop')command='uci set bettbox.config.enabled='+q(args[0]=='start'?'1':'0')+' && uci commit bettbox && '+command;
	if(args[0]=='start'||args[0]=='restart')command='/etc/init.d/bettbox enable && '+command;
} else if(request.kind=='package' || request.kind=='package-check') {
	if((request.kind=='package' && (length(args)!=1 || args[0]!='update')) || (request.kind=='package-check' && length(args)!=0))die('bad package action');
	command='/usr/bin/bettbox package '+(request.kind=='package'?'update':'check');
} else if(request.kind=='core' || request.kind=='core-check') {
	let action=request.kind=='core-check'?'check':args[0];
	if((request.kind=='core-check' && length(args)!=0) || (request.kind=='core' && (length(args)!=1 || !(action in ['update','rollback']))))die('bad core action');
	command='/usr/bin/bettbox core '+action;
} else die('bad diagnostic kind');
let fd = popen(command + ' 2>&1', 'r');
if (!fd) die('could not start diagnostic');
let output = '', chunk, truncated=false;
while ((chunk=fd.read(4096)) != null && length(chunk)) {
	output += chunk;
	if(length(output)>1048576){output=substr(output,length(output)-1048576);truncated=true;}
}
let code = fd.close();
if(chunk==null)die('could not read worker output');
if(truncated && !(request.kind in ['service','core','package']))die('diagnostic output exceeded 1MB limit');
print(output);
exit(code == 0 ? 0 : 1);
