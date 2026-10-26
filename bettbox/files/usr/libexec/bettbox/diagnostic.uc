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
} else die('bad diagnostic kind');
let fd = popen(command + ' 2>&1', 'r');
if (!fd) die('could not start diagnostic');
let output = fd.read('all') ?? '';
let code = fd.close();
print(output);
exit(code == 0 ? 0 : 1);
