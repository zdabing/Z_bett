// SPDX-License-Identifier: GPL-3.0
import { stat, unlink } from 'fs';

export function fetch_release(run, quote, url, path, maximum) {
	let seconds = maximum <= 2097152 ? 35 : 120;
	let args = ' --proto '+quote('=https')+' --proto-redir '+quote('=https')+
		' --connect-timeout 10 --max-time '+seconds+' --max-filesize '+maximum+
		' -H '+quote('User-Agent: Bettbox-OpenWrt');
	if (index(url, 'https://api.github.com/') == 0)
		args += ' -H '+quote('Accept: application/vnd.github+json');
	args += ' -o '+quote(path)+' '+quote(url);

	let result = run('curl -q -fLsS'+args, false);
	if (result.code != 0) {
		// Use the rendered listener so unapplied UCI edits cannot change the proxy.
		let port = run('timeout 3 yq -r '+quote('."mixed-port" // 0')+' /var/run/bettbox/config.yaml', false);
		if (port.code != 0 || !match(port.text, /^[0-9]{1,5}$/) || int(port.text) < 1 || int(port.text) > 65535)
			die(result.text || 'GitHub 下载失败');
		unlink(path);
		let retry = run('curl -q -fLsS --proxy '+quote('http://127.0.0.1:'+port.text)+
			' --noproxy '+quote('')+args, false);
		if (retry.code != 0)
			die('GitHub 下载失败：'+result.text+'。经本机 Mixed 代理重试也失败：'+retry.text);
	}

	let size = stat(path)?.size;
	if (!size || size > maximum) die('下载文件大小无效');
}
