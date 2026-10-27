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
- 实时网速、累计上传/下载、活动连接、内存、内网 IP、直连/代理出口和连通性检测。
- 策略组、节点切换、单节点与批量延迟测试、订阅图标和选择持久化。
- 订阅自动更新、用量展示、JS 脚本 URL/文件导入与可视化选项。
- Mihomo 独立检查更新与回退；Bettbox/LuCI APK 检查与一键更新。
- 本地与 WebDAV 配置备份、日志导出，以及网络诊断工具。

脚本使用 `main(config, customOptions)`，支持上游 `Compatible_With_Bettbox.policyGroupOptions`。QuickJS 进程按需运行，默认脚本限时 10 秒、JS 堆分配上限 128MiB、栈 512KiB。

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
