# Bettbox for OpenWrt 25

把 [Bettbox](https://github.com/appshubcc/Bettbox)（基于 Mihomo 内核的多平台代理客户端，FlClash 衍生）的功能搬到 **OpenWrt 25.12+** 路由器上：

- **内核**：Mihomo（Go，`v1.19.33`，源码编译，`PROVIDES:=mihomo`）
- **配置引擎**：`ucode` 渲染器 + `yq`（YAML⇄JSON），完全对齐 Bettbox 的 `applyPatch` 行为
- **JS 覆写引擎**：`bettbox-forge`（**Rust**，移植自上游 `plugins/code_forge/rust` 沙箱，脚本契约 100% 兼容）
- **前端**：`luci-app-bettbox`（LuCI 客户端渲染 JS + ucode rpcd 后端）
- **产物**：标准 OpenWrt feed，25.12 构建后输出 **.apk** 包（opkg 已在 25.12 被 APK 取代）

## 三个包

| 包 | 语言 | 说明 |
|---|---|---|
| `bettbox` | Go(内核)+sh/ucode | mihomo 内核、procd 服务、nft 透明代理、订阅管理、配置渲染、工具箱 |
| `bettbox-forge` | **Rust** | JS 覆写脚本沙箱（QuickJS 契约的 boa 移植） |
| `luci-app-bettbox` | JS+ucode | LuCI 界面：概览/代理/订阅/连接/脚本/资源/工具箱/日志/设置 |

## 功能映射（Bettbox → OpenWrt）

| Bettbox 功能 | 本项目实现 |
|---|---|
| 多协议代理内核 (SS/VMess/VLESS/Trojan/Hysteria2/TUIC/WireGuard…) | mihomo 内核（与 Bettbox `core/Clash.Meta` 同源） |
| TUN 模式（auto-route/auto-redirect/strict-route/stack） | `uci bettbox.core.transparent_mode=tun` + kmod-tun，mihomo 自管路由 |
| 透明代理（无 TUN 的传统模式） | nftables TPROXY/REDIR（fw4 并存，独立 `inet bettbox` 表） |
| 智能守护 / 无感启停 | procd respawn + 健康看门狗（`bettbox.core.watchdog`）+ iface hotplug 重载 |
| 一键禁用 QUIC（含"排除中国"变体） | 渲染时注入 `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT` 规则，与上游 `state.dart` 逐字一致 |
| 首页小组件（网速/连接/内存/模式/流量） | 概览页实时小组件（`/traffic` `/memory` `/connections` 轮询） |
| 策略组 / 测延迟 / 切换节点 | 代理页（`/proxies`、`/group/:name/delay`），`profile.store-selected` 持久化选择 |
| 订阅管理（自动更新/间隔/流量信息） | `uci bettbox.subscription` + cron，`subscription-userinfo` 头解析 |
| **JS 覆写脚本（可视化开关/策略组映射）** | `bettbox-forge`：`main(config, customOptions)` 契约、`ruleOptionsEnable`、`Compatible_With_Bettbox.policyGroupOptions` 全兼容 |
| 每订阅规则覆写（前置/替换） | `override_rules` JSON 选项，渲染时前置/替换 |
| 分组开关（禁用策略组→规则改 PASS） | `disabled_groups`，渲染器重写规则为 `PASS`（同上游 `patch.go`） |
| DNS 分流（fake-ip/redir-host、fallback、respect-rules） | DNS 设置页 → 渲染进 `dns:` 段 |
| 嗅探 Sniffer / NTP / 实验选项(quic-gso) | 独立设置页，直通 mihomo 配置 |
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

**依赖上游内核私有 Action 的功能**：Bettbox 的路由追踪、MRS 速查、NAT 检测、iperf、age、WebDAV 备份原本走它 Go 内核里的私有 IPC（`core/toolbox/*`），mihomo 的 REST API 不暴露这些。路由器端等价实现：路由追踪=规则匹配模拟（`trace_match.uc`，域名规则精确求值+数据集规则标注）、MRS 速查=geosite.dat 反查（`mrs_lookup.uc` 纯 ucode protobuf 解析，229k 条目约 16s）、NAT 检测=shell STUN（需带 `-u` 的 nc 或 ucode-mod-socket；缺失时降级为 WAN/公网 IP 对比并如实说明）、iperf/age=系统包、WebDAV=curl。已知偏差：STUN 锥型细分（Full-cone/Restricted）需服务端配合或 UDP 工具，当前仅对称型判定；MRS 的 GEOIP 侧（mmdb 反查）未实现，用「IP 全能查」替代。

## Rust 怎么选（本项目的取舍）

上游 Bettbox 本身就是 Flutter+Go+**Rust** 混合架构：`plugins/code_forge/rust`（rquickjs/QuickJS 沙箱跑覆写脚本）和 `services/helper`（提权助手）。移植时 Rust 边界保留、实现方式重选：

1. **不重写内核**。分流/TUN/DNS 全部在 mihomo（Go）里，Rust 重写无收益。
2. **Rust 只负责覆写沙箱**（`bettbox-forge`）——这是上游已经用 Rust 做过的决定，照抄边界。
3. **引擎弃 rquickjs、改用纯 Rust 的 `boa_engine`**，原因：
   - rquickjs-sys 不开 `bindgen` 时依赖**预生成绑定**，官方只覆盖 x86_64/aarch64/armv7-gnu/loongarch64/riscv64 等，**没有 mips/mipsel/armv7-musl** 等 OpenWrt 主流路由器架构；
   - 开 `bindgen` 则每台构建机/SDK 都要装 libclang，对 OpenWrt buildbot 不现实；
   - boa 纯 Rust，凡 `rust/host` 能编译的架构（官方 `RUST_ARCH_DEPENDS` 全集）都能出包，无任何宿主额外依赖；
   - 覆写脚本是纯数据变换（对象/数组/正则），boa 的 ES2015+ 完全够用，脚本写法与 Bettbox 完全相同。
4. **工具链**：官方 `packages` feed 的 `lang/rust`（1.94.0），`PKG_BUILD_DEPENDS:=rust/host` + `rust-package.mk` 的 `RustBinPackage` 宏，musl 动态链接（`-crt-static`，依赖 libc）。`Cargo.lock` 已提交并锁定（`RUST_PKG_LOCKED:=1`），CI 先跑 `cargo check --locked` 再进 SDK 构建。
5. **沙箱限制的对齐与偏差**：上游 QuickJS 用 10s/128MB/512KB 栈硬限制；boa 无公开堆上限 API，改为「循环迭代上限 + 递归上限 + 看门狗线程硬超时（超时退出码 124）」，行为对用户一致（卡死脚本必被杀），内存上限这一条记录为已知偏差。

## 验证情况

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
17. **本机 Zen 主题 Web 栈**：nginx 的 ubus 模块（`/ubus/`）并发下报 `writev() failed (14: Bad address)` 并 crash loop，所有客户端 form.Map 视图（含官方防火墙/ddns 页）挂起。已切换为 uhttpd 直服 80/443（原生 ubus 代理），nginx 配置备份在 `/root/bettbox-backup/nginx-conf-backup`，可用 `/etc/init.d/nginx start` 随时切回。bettbox 设置页因此改写为轻量纯 DOM 渲染，不依赖 form.Map。

## 构建与安装

```bash
# OpenWrt 25.12 SDK（产物即 .apk）
curl -LO https://downloads.openwrt.org/releases/25.12.0/targets/x86/64/openwrt-sdk-25.12.0-x86-64_linux-*.tar.zst
tar axf openwrt-sdk-*.tar.zst && cd openwrt-sdk-*

./scripts/feeds update -a && ./scripts/feeds install -a
echo "src-link bettbox /path/to/Z_bett" >> feeds.conf
./scripts/feeds update bettbox && ./scripts/feeds install bettbox

make defconfig
make package/bettbox-forge/{clean,compile} V=s   # Rust（首次会拉 rust 工具链）
make package/bettbox/compile V=s                 # Go 内核 + 脚本
make package/luci-app-bettbox/compile V=s        # LuCI
# 产物: bin/packages/*/bettbox*.apk luci-app-bettbox*.apk
```

设备端安装（APK）：

```sh
apk add --allow-untrusted ./bettbox-*.apk ./bettbox-forge-*.apk ./luci-app-bettbox-*.apk
```

依赖链：`luci-app-bettbox` → `bettbox`(+mihomo 内核) → 内核模块（kmod-tun/kmod-nft-tproxy）、`curl`、`yq`、`ucode`、`firewall4`、`ca-bundle`、`unzip`、`ip-full`。

## 目录

```
bettbox/            核心包（内核+init+nft+订阅+渲染+工具箱）
bettbox-forge/      Rust 覆写引擎（boa）
luci-app-bettbox/   LuCI 应用
test/               辅助脚本：fetch-sdk.sh（SDK 下载）、build-in-wsl.sh（WSL 本地构建）、
                    export-artifacts.sh（导出 .apk）、router-smoke.sh（真机 34 项冒烟）
.github/workflows/  CI（cargo check + 三目标 .apk 构建，SDK 下载带镜像回退）
```
