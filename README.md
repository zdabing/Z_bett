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
| 工具箱：DNS 查询（follow 路由/系统/自定义上游） | mihomo `/dns/query` + busybox nslookup |
| 工具箱：IP 归属查询 | `ip-api.com`/`geojs.io`/`ip.sb`（直连+经代理双视图） |
| 工具箱：本地 Ping | busybox ping / TCP ping |
| 工具箱：Cloudflare 测速 | 走 mixed 端口的 CF `__down/__up` 测速 |
| 工具箱：流媒体解锁检测 | Netflix/Disney/YouTube/ChatGPT/Telegram 等主流平台 HTTP 探测 |
| 工具箱：NAT 类型(STUN)、路由追踪、MRS 查询、iperf、age | ⚠️ 见下"依赖上游内核私有 Action 的功能" |
| GeoSite/MMDB/ASN 资源管理 | `geo-auto-update` + geox-url 自定义（默认指向 `appshubcc/bett-rules`，与上游一致）+ 资源页手动更新 |
| 控制面板（zashboard） | `bettbox dashboard install` 下载到 `/usr/share/bettbox/ui`，external-ui 入口 |
| WebDAV 备份 / 日志导出 | `bettbox backup create/restore`（tar 包含 uci+profiles+scripts）；日志页 logread 过滤导出 |
| 托盘/热键/窗口/主题/测速动效/扫码导入 | N/A（路由器无桌面；主题跟随 LuCI） |

**依赖上游内核私有 Action 的功能**：Bettbox 的路由追踪、STUN NAT 检测、MRS 规则查询、内置 iperf、age 加密订阅走的是它 Go 内核里的私有 IPC（`core/toolbox/*`），mihomo 的 REST API 不暴露这些。路由器端用 HTTP 等价物覆盖了大部分场景，其余保留为文档说明，不伪造。

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
| `render.uc` YAML 渲染器 | `test/render-test.js`：Node 加 ucode 内建 stub 实跑渲染器 + js-yaml 往返校验（UCI 补丁、QUIC 规则注入、override_rules 前置/替换、disabled-groups→PASS、geox 默认值等 22 项断言） | ✅ 全过（并借此修掉 3 个 ucode 语义 bug） |
| `bettbox-forge` Rust 沙箱 | `cargo check` + release 构建 + 真实脚本端到端冒烟（选项提取 / customOptions 合并 / console 捕获 / 报错栈 / 超时 124） | ✅ 全过 |
| shell 脚本 | `sh -n` 全量语法检查 | ✅ 全过 |
| LuCI 视图 / JSON | `node --check` + `JSON.parse` | ✅ 全过 |
| mihomo 内核 / SDK 构建 | GitHub Actions（25.12 SDK，x86/64 + armsr/armv8，产物 .apk） | ⏳ CI 执行 |

注意：`mihomo` Go 内核与 OpenWrt SDK 的 golang/rust 工具链不在本机（Windows），编译验证由 CI 完成；本机验证覆盖了全部手写逻辑（ucode 渲染器、Rust 沙箱、shell、LuCI JS）。

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
.github/workflows/  CI（cargo check + 三目标 .apk 构建）
```
