# Bettbox for OpenWrt

将 [Bettbox](https://github.com/appshubcc/Bettbox) 的代理、订阅与脚本覆写功能适配到 OpenWrt 25.12，提供电脑和手机 LuCI 界面。

## 安装包

| 包 | 内容 |
|---|---|
| `bettbox` | Mihomo、Rust/QuickJS 脚本引擎、服务脚本、透明代理、订阅、配置渲染和工具箱 |
| `luci-app-bettbox` | 概览、代理、连接、订阅、脚本、资源、工具箱、日志和设置 |

支持 `x86_64` 和 `aarch64_generic`（ARM64）。`bettbox-forge` 已包含在 Bettbox 包内，不再单独发布 APK；路由器无需 Rust 或 Python 环境。

## 主要功能

- TUN、TPROXY、REDIR 透明代理，DNS 分流、嗅探、QUIC 控制和规则覆写。
- 按来源 IPv4／IPv6、CIDR 设置设备白名单／黑名单，同步筛选透明代理和 DNS。
- 实时网速、累计上传/下载、活动连接、内存、内网 IP、直连/代理出口和连通性检测。
- 策略组、节点切换、单节点与批量延迟测试、订阅图标和选择持久化。
- 批量测速复用近期结果、共享队列与取消排队；大节点组分批加载。
- 订阅自动更新、Clash YAML／分享链接／Base64 导入、用量展示，JS 脚本 URL/文件导入与可视化选项。
- Mihomo 独立检查更新与回退；Bettbox/LuCI APK 检查与一键更新。
- 本地与 WebDAV 配置备份、日志导出，以及分层网络健康检测。

脚本使用 `main(config, customOptions)`，支持上游 `Compatible_With_Bettbox.policyGroupOptions`。QuickJS 进程按需运行，默认脚本限时 10 秒、JS 堆分配上限 128MiB、栈 512KiB。

「订阅 → 添加订阅」支持订阅链接和粘贴导入。链接返回的完整 Clash YAML 原样保存；分享链接或 Base64 节点列表由现有 QuickJS 引擎按需转换，支持 SS、VMess、VLESS、Trojan、Hysteria2、TUIC、AnyTLS、SOCKS5、HTTP(S) 的常见参数，尚未支持的协议或传输参数会明确报错。去重包含凭据、TLS 和传输参数，同名但配置不同的节点保留并区分名称。网页粘贴上限 1 MiB，下载内容上限 4 MiB，分享链接最多 2048 条；粘贴导入保存为本地配置，默认关闭自动更新。转换失败保留旧订阅。

生成配置时检查 DNS 上游是否指向核心自身、DNS 上游是否缺失，以及 respect-rules 与节点 DNS 的必要配置。节点域名可从明确匹配的订阅 DNS 规则补齐专用解析策略，已有专用策略优先；遇到无法离线判断的规则集不推测覆盖。`system` 或本地 53 端口与 dnsmasq 转发并存时提示核查实际链路，不统一替换为公共 DNS。

代理页的组测速和全部测速默认复用同一运行配置、测试地址下 60 秒内的成功结果，可在「测试设置」选择关闭或改为 30／300 秒；手动点击单节点始终重新检测。结果仅保留当前浏览器会话最近 512 条，最长 5 分钟；核心进程或配置变化后失效。所有组共用两个并发任务，取消后停止后续排队并忽略迟到结果，已提交到后台的请求按原超时结束。展开节点组先展示 48 项，滚动接近底部或点击「加载更多」继续加载，搜索覆盖全部节点。

「工具箱 → 网络健康」或 `bettbox health [域名]` 检测核心进程、控制接口、核心 DNS、dnsmasq、上游 DNS、显式代理和路由器本机访问，区分失败、未检测和无法确认；同时读取核心 RSS／PSS、历史峰值及系统可用内存。缺少 PSS 数据时显示未知。HTTP 响应表示传输链路可达，不保证目标网站所有功能可用；本机访问和上游 DNS 探测遵循路由器实际路径，不等同于手机／NAS 的透明代理验收。加密 DNS 上游不使用 UDP 查询冒充检测结果。

看门狗默认每 300 秒执行一次只读分层检测，`bettbox.config.health_interval=0` 可关闭周期检测；不会因外部网站或 DNS 上游失败而重启核心。基本控制接口检测仍按原间隔运行，连续两次失败才尝试重启，重启间隔至少 5 分钟；启停／应用期间跳过检查，并使用运行中的配置快照，避免未应用设置引发误判。周期检测复用现有看门狗进程，不增加常驻服务。

「设置 → 设备控制」默认关闭，全部 LAN 设备按原方式进入分流。白名单仅接管列表地址，黑名单让列表地址直连；白名单为空时不接管任何设备，黑名单为空时接管全部设备。进入分流后仍遵循规则／全局／直连模式。名单按来源地址匹配，双栈设备需填写相应 IPv4 和 IPv6，最多 256 项；它不限制手动连接 Mixed 等代理端口，也不等同于防火墙禁止上网。

启用设备控制时，名单作用于主 LAN 接口（`network.lan.device`，默认 `br-lan`）的透明代理，其他接口不在接管范围。TUN 使用插件管理的策略路由，核心自身的 auto-route／auto-redirect 不同时启用；关闭后恢复原 TUN 设置。DNS 按来源地址接管，需监听 `0.0.0.0:端口` 或 `[::]:端口`，Bettbox 持有的 dnsmasq 全局转发会恢复原配置。修改名单需要保存并应用；切换前客户端缓存的旧 Fake-IP 可能需要刷新 DNS 后才消失。

## 安装与更新

从 [Releases](https://github.com/zdabing/Z_bett/releases) 下载匹配设备架构的一组两个 APK，将它们放在同一目录，先模拟再安装：

```sh
apk add --simulate --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk bettbox-forge
apk add --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk bettbox-forge
```

最后的 `bettbox-forge` 是新包提供的兼容名称，用于接续旧三包版本的依赖约束。请只保留当前架构的一组 APK，并确认模拟事务没有无关删除或冲突。项目 APK 未使用 OpenWrt 官方源签名，需使用 `--allow-untrusted`。

安装本版后可通过“资源”页分别更新软件包和 Mihomo。在线更新核对固定 GitHub 仓库、发布清单、SHA-256、架构和 APK 元数据，安装前备份配置。核心更新保留随包核心与上一选择；APK 更新没有自动回滚，配置备份位于 `/etc/bettbox/state/before-package-update.tar`。

更新会重启运行中的代理服务，现有连接可能短暂中断。新版本的变化和验证范围见 [更新日志](CHANGELOG.md)。

## 构建与发布

GitHub Actions 的 **Build OpenWrt 25 packages** 工作流支持手动构建。默认只生成构建产物；勾选 `publish` 并填写更新日志中对应的 `release_tag`，两架构构建及校验通过后发布 Release、四个 APK 和 `bettbox-update.json` 在线更新清单。

也可在对应架构的全新 OpenWrt 25.12 SDK 中注册本地 feed：

```sh
cp feeds.conf.default feeds.conf
printf '\nsrc-link bettbox /path/to/Z_bett\n' >> feeds.conf
./scripts/feeds update -a
./scripts/feeds install -a
make defconfig
make package/bettbox/compile V=s
make package/luci-app-bettbox/compile V=s
```

源码目录：`bettbox/` 为核心包，`luci-app-bettbox/` 为界面，`.github/` 为构建与发布配置。测试、设计预览、排查记录、构建缓存和本地配置不纳入 Git。

## 兼容范围

建议使用 OpenWrt 25.12 与设备固件对应的软件源，内核模块必须匹配固件。`iperf3`、`age` 等扩展工具按需安装。规则追踪不完整求值 GEO 数据集；NAT 检测依赖可用的 UDP 工具；MRS 查询不提供 MMDB 反查。

## 许可

本项目采用 GPL-3.0；第三方组件及许可证见 [LICENSE](LICENSE)。
