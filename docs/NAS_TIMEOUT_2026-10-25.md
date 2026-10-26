# NAS 外网连接超时与日志级别筛选：2026-10-25

用户截图为 11:35:12 的 Mihomo 记录：`10.0.0.194:1826 -> 118.31.169.4:8443`，命中 `cn_ip` 使用直连，拨号返回 `i/o timeout`。核心的实际级别为 `warning`。它表示这次 TCP 连接未在时限内建立；没有记录规则拒绝、核心崩溃或进程退出。

## 现场核验

- 当前 procd 核心 PID 26530，运行栈 mips；检查期间未重启、切换栈或修改分流规则。
- 周边日志存在同一 NAS 对相同目标的其他连接记录，以及对 `110.42.12.249:22067` 的超时。不能把截图解释为 NAS 所有连接都失败，也不能只凭后续规则记录认定业务请求成功。
- 电脑分别 TCP 探测这两个目标，均约 7ms 建立连接；普通网站对照成功。
- 实际 WAN 是 PPPoE 的 `pppoe-wan`。绑定该逻辑接口访问 `118.31.169.4:8443`，TCP 约 16ms，TLS 成功并收到 HTTP 404；访问百度返回 200。此前绑定物理 eth1 的探测因接口选错而超时，该组结果不作为外网故障依据。
- 通过当前核心的本机 SOCKS 入口访问同一目标，也收到 HTTP 404；百度对照返回 200。404 是测试根路径的 HTTP 响应，仅证明连接及 TLS/HTTP 通信可达，不证明 NAS 业务 API 正常。
- 这些检查没有从 NAS 自身发起对应业务请求，也没有复现截图时的超时。仍无法确定当时是目标服务、路径丢包、NAS/对端连接行为还是 TUN 流量处理方面的问题，不能直接归因 mips 或宣称完全排除项目。

该日志记录 NAS 访问公网目标，不能用它证明手机与 NAS 内网文件传输慢的原因。本次没有把目标改走代理、插入绕过规则或降低核心日志级别。

## 确认并修复的界面缺陷

日志页原先用 `line.includes(selectedLevel)` 在整行搜索级别。截图正文有 `error:`，因此 `level=warning` 也进入了 error 筛选；外层 `daemon.info` 又会使核心 warning/error 同时进入 info 筛选。

现已优先解析核心 `level=...`，没有核心级别时才读取 syslog facility.priority；关键字搜索保持独立。warning 不再因为正文出现 error 被列入 error。这只修正展示筛选，没有清除或隐藏原始日志。

涉及 `luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/logs.js`，已更新实机，原文件保留在 `/root/router-diagnostic-20261025/log-level-before/`。`test/logs-test.js` 的 10 个真实级别样例及 error 筛选检查通过，覆盖截图、外层 daemon.info、quoted level、正文带 error 和 syslog 回退；CI 已加入检查。
