# Bettbox for OpenWrt 25

把 [Bettbox](https://github.com/appshubcc/Bettbox)（基于 Mihomo 内核的多平台代理客户端，FlClash 衍生）的功能搬到 **OpenWrt 25.12+** 路由器上：

- **内核**：Mihomo（Go，`v1.19.33`，源码编译，`PROVIDES:=mihomo`）
- **配置引擎**：`ucode` 渲染器 + `yq`（YAML⇄JSON），保留 Bettbox 的分流/覆写语义，移除终端专用配置（见[路由器设置核对](docs/ROUTER_SETTINGS.md)）
- **JS 覆写引擎**：`bettbox-forge`（Rust + rquickjs/QuickJS，随 `bettbox.apk` 安装，独立进程执行脚本）
- **前端**：`luci-app-bettbox`（LuCI 客户端渲染 JS + ucode rpcd 后端）
- **产物**：标准 OpenWrt feed，25.12 构建后输出 **.apk** 包（opkg 已在 25.12 被 APK 取代）

九个页面统一使用浅绿视觉规范，支持 PC 流式布局与手机两行导航。实现、验证方式及限制见 [UI 实现记录](docs/UI_IMPLEMENTATION.md) 与 [UI 设计规范](docs/UI_DESIGN_SYSTEM.md)。

版本变更见 [更新日志](CHANGELOG.md)，本版安装与更新说明见 [v2026.10.27 发布说明](docs/releases/v2026.10.27.md)。

## 两个包

| 包 | 语言 | 说明 |
|---|---|---|
| `bettbox` | Go + Rust + sh/ucode | mihomo 内核、内置 QuickJS 脚本引擎、procd、nft 透明代理、订阅、配置渲染、工具箱 |
| `luci-app-bettbox` | JS+ucode | LuCI 界面：概览/代理/订阅/连接/脚本/资源/工具箱/日志/设置 |

## 功能映射（Bettbox → OpenWrt）

| Bettbox 功能 | 本项目实现 |
|---|---|
| 多协议代理内核 (SS/VMess/VLESS/Trojan/Hysteria2/TUIC/WireGuard…) | mihomo 内核（与 Bettbox `core/Clash.Meta` 同源） |
| TUN 模式（auto-route/auto-redirect/strict-route/stack） | `uci bettbox.core.transparent_mode=tun` + kmod-tun，mihomo 自管路由 |
| 透明代理（无 TUN 的传统模式） | nftables TPROXY/REDIR（fw4 并存，独立 `inet bettbox` 表） |
| 智能守护 / 无感启停 | procd respawn + 健康看门狗（`bettbox.core.watchdog`）+ iface hotplug 重载 |
| 一键禁用 QUIC（含"排除中国"变体） | 渲染时注入 `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT` 规则，与上游 `state.dart` 逐字一致 |
| 首页小组件（网速/连接/内存/模式/流量） | 概览页 `/connections` 定时快照 + 进程 RSS；累计上传/下载环形统计、LAN IP、出口与连通性检测 |
| 策略组 / 测延迟 / 切换节点 | V4 可折叠代理组、PC/手机布局、订阅图标、独立单测/组测/全部检测（全页限两路）；`/proxies` 与 `/proxies/:name/delay`，`profile.store-selected` 持久化选择 |
| 订阅管理（自动更新/间隔/流量信息） | `uci bettbox.subscription` + cron，`subscription-userinfo` 头解析 |
| **JS 覆写脚本（可视化开关/策略组映射）** | 内置 `bettbox-forge`：保留 `main(config, customOptions)`、`ruleOptionsEnable`、`Compatible_With_Bettbox.policyGroupOptions` 接口；使用上游 rquickjs 执行/转换逻辑 |
| 每订阅规则覆写（前置/替换） | `override_rules` JSON 选项，渲染时前置/替换 |
| 分组开关（禁用策略组→规则改 PASS） | `disabled_groups`，渲染器重写规则为 `PASS`（同上游 `patch.go`） |
| DNS 分流（fake-ip/redir-host、fallback、respect-rules） | DNS 设置页 → 渲染进 `dns:` 段 |
| 嗅探 Sniffer / 实验选项(quic-gso) | 设置页，直通 mihomo 配置 |
| NTP 校时 | 交给 OpenWrt 系统时间服务；不提供重复的内核 NTP 设置 |
| 工具箱（与上游 `lib/views/toolbox.dart` 十项对齐，官方命名） | |
| 工具箱：网速测试 | Cloudflare `speed.cloudflare.com`（与上游 core/toolbox/speedtest.go 同源端点） |
| 工具箱：路由追踪 | **规则匹配追踪**（上游 route_trace.go 语义）：按内核规则顺序求值，显示命中规则/策略链/出口节点；数据集规则（GEOSITE/GEOIP/RULE-SET）不做求值、如实标注 |
| 工具箱：IP 全能查 | ip-api.com/geojs.io/Cloudflare trace（直连+经代理双视图） |
| 工具箱：MRS 速查 | geosite.dat 反查（纯 ucode protobuf 解析，自动按 geox 配置下载）+ 运行中规则提供者列表 |
| 工具箱：DNS 查询 | mihomo `/dns/query` + busybox nslookup（follow/system/custom） |
| 工具箱：NAT 检测 | STUN binding（XOR-MAPPED-ADDRESS 解析，多服务器对称型判定）；无 UDP 工具时诚实降级（WAN/公网 IP 对比），不伪造 |
| 工具箱：本地 Ping | busybox ping / TCP ping |
| 工具箱：iPerf3 工具 | 系统 `iperf3`（可选安装） |
| 工具箱：Age 加解密 | 系统 `age`（可选安装）加解密文本 |
| 工具箱：连通性测试 | Netflix/Disney/YouTube/ChatGPT/Telegram/Bilibili 港澳台 HTTP 探测 |
| JS 覆写脚本导入 | 与上游 editor.dart 交互一致：通过 URL 导入（服务端校验 `function main`）/ 通过文件导入 / 编辑器直接粘贴 |
| age 加密订阅 | `age`（可选安装）解密，密钥在订阅项或全局 `age_identity` |
| GeoSite/MMDB/ASN 资源管理 | `geo-auto-update` + geox-url 自定义（默认指向 `appshubcc/bett-rules`，与上游一致）+ 资源页手动更新 |
| 控制面板（zashboard） | `bettbox dashboard install` 下载到 `/usr/share/bettbox/ui`，external-ui 入口 |
| WebDAV 备份 / 日志导出 | `bettbox backup create/restore` 本地 tar + `backup push/pull/list` WebDAV 云备份（设置页配置 `bettbox.backup.*`）；日志页 logread 过滤导出 |
| 托盘/热键/窗口/主题/测速动效/扫码导入 | N/A（路由器无桌面；主题跟随 LuCI） |

已按上游 `1fb8806` 核对客户端设置：本机进程识别固定关闭，移除 Windows NCSI hosts 自动注入和重复的内核 NTP 配置；升级时清理旧 UCI 项。DNS、TUN、代理端口、LAN 访问及工具箱等路由功能保留。完整对应关系与理由见[路由器设置核对](docs/ROUTER_SETTINGS.md)。

**依赖上游内核私有 Action 的功能**：Bettbox 的路由追踪、MRS 速查、NAT 检测、iperf、age、WebDAV 备份原本走它 Go 内核里的私有 IPC（`core/toolbox/*`），mihomo 的 REST API 不暴露这些。路由器端等价实现：路由追踪=规则匹配模拟（`trace_match.uc`，域名规则精确求值+数据集规则标注）、MRS 速查=geosite.dat 反查（`mrs_lookup.uc` 纯 ucode protobuf 解析，229k 条目约 16s）、NAT 检测=shell STUN（需带 `-u` 的 nc 或 ucode-mod-socket；缺失时降级为 WAN/公网 IP 对比并如实说明）、iperf/age=系统包、WebDAV=curl。已知偏差：STUN 锥型细分（Full-cone/Restricted）需服务端配合或 UDP 工具，当前仅对称型判定；MRS 的 GEOIP 侧（mmdb 反查）未实现，用「IP 全能查」替代。

## 脚本引擎与打包

2026-10-27 将原先独立的 Boa 包合入 `bettbox`，引擎迁移到与上游一致的 `rquickjs 0.12.0`（内含 QuickJS-NG）。Rust 源码在 `bettbox/forge/`，`/usr/bin/bettbox-forge` 仍是按需启动的独立程序，不嵌入 Mihomo，不常驻处理流量。路由器无需 Rust 工具链。

脚本执行默认 10 秒、JS 堆分配上限 128MiB、栈 512KiB；选项提取 2 秒、32MiB。沿用上游输入转换、Promise 处理与日志限制，保留路由器版第二个 `customOptions` 参数。这些限制已写入源码；原生 Rust/QuickJS、SDK 编译及升级安装尚未在本轮执行，不以源码检查代替实测。

构建目标限定 x86_64 和 aarch64，两者都有对应 musl 预生成绑定。`bettbox` 组合 Go/Rust 构建步骤，一次构建安装 Mihomo 和脚本 helper。旧包依赖由版本化 `PROVIDES:=bettbox-forge` 接续，APK 文件接管使用 `replaces` 元数据；不在安装钩子中调用 `apk del`。迁移、验收及已知边界见 [合包与 QuickJS 迁移说明](docs/FORGE_MIGRATION.md)。

## 历史验证情况（此前 Boa / 三包版本）

以下是真机历史记录，不代表本轮 QuickJS / 两包版本已经编译或部署。本轮新增检查与待验收项目见 [迁移说明](docs/FORGE_MIGRATION.md)。

| 验证 | 方式 | 结果 |
|---|---|---|
| `render.uc` YAML 渲染器 | `test/render-test.js`：Node 加 ucode 内建 stub 实跑渲染器 + js-yaml 往返校验（22 项断言）；随后在真机 aarch64 ucode 上实跑 | ✅ 全过 |
| `bettbox-forge` Rust 沙箱 | `cargo check` + SDK 交叉编译（aarch64-musl）+ 真机 run/options 冒烟 | ✅ 全过 |
| shell 脚本 | `sh -n` 全量语法检查 | ✅ 全过 |
| LuCI 视图 / JSON | `node --check` + `JSON.parse` | ✅ 全过 |
| SDK 构建 | 本地 WSL（Ubuntu 26.04）+ OpenWrt 25.12.6 armsr/armv8 SDK，三包 `bettbox/bettbox-forge/luci-app-bettbox` 全部编译产出 .apk（aarch64_generic） | ✅ 全过 |
| **真机部署实测**（rockchip/armv8，OpenWrt 25.12-SNAPSHOT，4GB 内存设备） | 34 项冒烟测试全过：安装/文件/forge run+options/订阅(file://)/渲染/procd 启动/REST API/工具箱全部工具/备份/ubus 全部方法/热重载；随后切换 TUN 透明代理 + dnsmasq 劫持，局域网客户端免配置访问 google/youtube 200、国内直连正常 | ✅ 全过 |

## 真机兼容性修复记录（aarch64 ucode 2026.01 / busybox 1.37 / mihomo 1.19.33 实测）

以下差异全部由真机实测发现并已在代码中修复，任何重新移植 OpenWrt ucode 项目都会遇到：

1. **ucode 正则**：字符类内不支持 `\s`、`\[` 等转义（整个类静默失配），不支持 `{n,m}` 量词（语法错误）。`render.uc` 的 plain_safe 改为字符扫描 + `index()`；rpcd 脚本的 `{1,64}` 量词改为 `+` + 显式长度检查。
2. **ucode `json()`**：字符串入参解析，但对象入参序列化会抛错。序列化统一用 `sprintf('%J', ...)`。
3. **ucode 数组方法语法**：`arr.push(x)` 报 "left-hand side is not a function"，必须用内建 `push(arr, x)`。
4. **busybox pgrep**：无 `-q` 选项；`pgrep mihomo >/dev/null` 替代。
5. **rpcd-mod-ucode**：脚本文件 world-writable 会被静默跳过加载（日志才可见）；顶级 key 是 ubus 对象名，方法须为 `{call: fn, args: {...}}` 字典。改动脚本后必须完整重启 rpcd（孤儿 rpcd 进程会占着旧的对象注册）。
6. **mihomo 1.19.33**：`skip-auth-prefixes` 必须是 CIDR（`127.0.0.1/32`），裸 IP 校验失败。
7. **UCI 语法**：`list foo 'a' 'b'` 一行多值、`list foo ''` 空串项都会 parse error；每行一个值。
8. **curl 8**：裸路径 URL 被拒（"URL rejected"），`file://` 订阅分支直接 `cat` 读取。
9. **GitHub 源码包**：`codeload.github.com` URL 不能被 download.pl 拼接文件名（404），用 `github.com/OWNER/REPO/archive/refs/tags/` 前缀 + `v$(PKG_VERSION).tar.gz`；哈希不变。
10. **本地 feed 包**：无 PKG_SOURCE 时默认 prepare 只拷 `./src`，rust-package.mk 要求 Cargo.toml 在 PKG_BUILD_DIR 根部 → 在包 Makefile 显式定义 `Build/Prepare`。
11. **WSL/drvfs 构建**：`/mnt/d` 上所有文件映射为 0777 并被打进 .apk，rpcd-mod-ucode 拒绝加载 world-writable 脚本 → 构建前把 feed rsync 到 ext4 并规范权限（`test/build-in-wsl.sh` 已内置）；CI 的 git 检出无此问题。
12. **节点域名解析死锁**：mihomo 回退 DNS（1.1.1.1/8.8.8.8 DoH）在隧道建立前不可达，而节点域名恰好被判为需走回退 → 节点永远连不上。渲染器新增 `proxy-server-nameserver`（UCI `bettbox.dns.proxy_server_nameserver`，默认 223.5.5.5/119.29.29.29），节点域名用国内 DNS 直接解析，与上游 Bettbox 的效果对齐。
13. **apply.sh live 的局限**：内核启动阶段（加载 geo/大量节点时）PUT /configs 热重载可能超时静默失败，磁盘配置已是新的但运行态还是旧的——改完透明代理/DNS 等入站配置后应使用完整 `/etc/init.d/bettbox restart`。
14. **LuCI menu.d 格式**：不存在 `children` 数组结构，每个子页面必须是独立顶级路径 + `"action": { "type": "view", "path": "..." }`，父节点用 `"action": { "type": "firstchild" }`；未知键会被静默忽略导致全站 404。另：25.12 的会话 cookie 名是 `sysauth_http`（path=/cgi-bin/luci/）。改 menu.d 后需删除 `/tmp/luci-indexcache*`。
15. **LuCI 25.12 客户端视图 API 变化**：`ui.createHandlerBtn` 被移除（用 `ui.createHandlerFn` + `E('button', {click: …})` 垫片替代）；`E()` 只接受一个 data 参数，多出的变参或嵌套数组会被字符串化成 `[object HTMLDivElement]`，多个子节点必须扁平数组或 `concat`。
16. **mihomo 流式 REST 端点**：`/traffic`、`/memory` 是无限流，REST 轮询会占满 curl 直到超时并把 rpcd/uwsgi 请求队列堵死（页面假死、uhttpd/nginx 被拖垮）。概览页改用一次性 `/connections` 快照做总流量差分算实时网速。
17. **本机 Web 栈部署记录**：此前使用 Zen 主题的设备上，nginx 的 ubus 模块（`/ubus/`）并发下报 `writev() failed (14: Bad address)` 并 crash loop，客户端 form.Map 视图（含官方防火墙/ddns 页）挂起。已切换为 uhttpd 直服 80/443，nginx 配置备份在 `/root/bettbox-backup/nginx-conf-backup`。这条记录不代表已确认故障来自 Zen 主题源码。2026-10-25 再次排查发现 nginx、uhttpd 均未启用自启，设备凌晨重启后 80/443 无监听；启动并启用 uhttpd 后恢复。现存日志无法追溯禁用操作的来源。切换 Web 服务必须同时处理当前运行状态和开机自启，并验证登录及 RPC；仅执行 `start` 不能保证重启后可访问。两个实机测试脚本均检查至少一个 Web 服务处于运行且自启状态，并在出现失败项时返回非零退出码。
18. **订阅定时任务命令不匹配**：旧版 `cron.sh` 写入 `bettbox subscription cron`，但 CLI 当时只支持 `bettbox cron`，实机执行旧命令返回 usage 和退出码 2，自动更新实际未执行。现统一生成 `*/10 * * * * /usr/bin/bettbox cron`，同时保留 `subscription`/`subscriptions` 兼容入口，并在 ensure/remove 时迁移或清理旧行、保留其他定时任务。`test/cron-test.py` 验证真实脚本的命令分发、迁移、幂等和清理最后一行；CI 构建前运行。日志里的 `USER ... cmd ...` 仅表示任务被启动，是否成功需结合实际退出码和订阅更新日志判断。

本机已有 uhttpd 监听 80/443 配置时，从 nginx 切换到 uhttpd 的步骤如下（这是管理员部署操作，安装 Bettbox 包不会自动切换 Web 服务）：

```sh
/etc/init.d/nginx stop
/etc/init.d/uhttpd start
# 确认后台可登录、LuCI RPC 正常后，持久化切换：
/etc/init.d/uhttpd enable
/etc/init.d/nginx disable
/etc/init.d/uhttpd running && /etc/init.d/uhttpd enabled
```

若 uhttpd 启动或后台验证失败，应立即执行 `/etc/init.d/uhttpd stop; /etc/init.d/nginx start` 恢复原服务，再排查配置。切回 nginx 前应先停止 uhttpd，避免争用端口；确认 nginx 后台正常后再启用 nginx 自启、关闭 uhttpd 自启。自启检查不替代受控重启后的验收。

2026-10-25 的配置应用、控制器 API、透明代理、DNS 恢复、订阅元数据与备份检查结果，以及尚未解决的权限/并发风险，见 [路由器代码与日志检查报告](docs/ROUTER_AUDIT_2026-10-25.md)。报告区分已修复、实机验证与未完成项目，不替代生产转发和重启验收。

## 构建与安装

```bash
# OpenWrt 25.12 SDK（产物即 .apk）
curl -LO https://downloads.openwrt.org/releases/25.12.0/targets/x86/64/openwrt-sdk-25.12.0-x86-64_linux-*.tar.zst
tar axf openwrt-sdk-*.tar.zst && cd openwrt-sdk-*

./scripts/feeds update -a && ./scripts/feeds install -a
echo "src-link bettbox /path/to/Z_bett" >> feeds.conf
./scripts/feeds update bettbox && ./scripts/feeds install bettbox

make defconfig
make package/bettbox/compile V=s                 # Go 内核 + Rust/QuickJS helper + 服务脚本
make package/luci-app-bettbox/compile V=s        # LuCI
# 产物: bin/packages/*/bettbox*.apk luci-app-bettbox*.apk
```

设备端安装（APK）：

从旧三包版本首次升级时，请使用 [迁移命令](docs/FORGE_MIGRATION.md#从旧三包版本升级) 同步处理旧 forge 的依赖约束；新安装只需下面两个 APK。

```sh
apk add --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk
```

依赖链：`luci-app-bettbox` → `bettbox`(+mihomo 内核) → 内核模块（kmod-tun/kmod-nft-tproxy）、`curl`、`gzip`、`coreutils-sha256sum`、`yq`、`ucode`、`firewall4`、`ca-bundle`、`unzip`、`ip-full`。

## 目录

启停顺序、异步任务与仍需真机验证的边界见 [启停流程优化](docs/SERVICE_LIFECYCLE.md)。

资源页支持检查、独立更新和回退 Mihomo 核心，保留软件包自带核心；来源、架构支持、重启影响和验证范围见 [核心一键更新](docs/CORE_UPDATE.md)。

资源页同时提供 Bettbox/LuCI 两个 APK 的检查与一键更新，配套手动 Release 发布清单、校验、安装预检查和配置备份；首次部署、发布流程与失败边界见 [APK 一键更新](docs/APK_UPDATE.md)。本轮只实现源码，未编译、安装或发布更新源。

源码回归与浏览器检查的安装、运行方法见 [测试说明](test/README.md)；这些检查不编译安装包。

```
bettbox/            核心包（内核+QuickJS helper+init+nft+订阅+渲染+工具箱）
bettbox/forge/      内置脚本 helper 的 Rust 源码与测试（rquickjs/QuickJS）
luci-app-bettbox/   LuCI 应用
test/               辅助脚本：fetch-sdk.sh（SDK 下载）、build-in-wsl.sh（WSL 本地构建）、
                    export-artifacts.sh（导出 .apk）、router-smoke.sh（真机 34 项冒烟）
.github/workflows/  手动 CI（原生脚本引擎测试 + x86_64/ARM64 两目标 .apk 构建）
```
