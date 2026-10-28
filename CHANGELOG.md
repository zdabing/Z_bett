# 更新日志

## v2026.10.27 · 2026-10-27

面向 **OpenWrt 25.12 系列**，提供 **x86_64** 和 **aarch64_generic（ARM64）** 两组安装文件。每台设备只安装对应架构的一组两个 APK：

| 安装包 | 版本 | 内容 |
|---|---|---|
| `bettbox` | `1.19.33-r4` | Mihomo v1.19.33、服务脚本、QuickJS 脚本引擎、更新与诊断工具 |
| `luci-app-bettbox` | `1.19.7-r4` | LuCI 管理界面 |

### 新增与改进

- **核心独立更新**：资源页检查并下载 Mihomo 官方稳定版，校验 SHA-256、架构、版本和配置；保留随包核心与上一选择，提供回退入口。
- **APK 一键更新**：资源页同时更新 Bettbox/LuCI；按设备接受的 APK 架构选择文件，核对发布清单、GitHub digest 和 APK 内部信息，模拟安装事务并自动备份配置。
- **安装包合并**：`bettbox-forge` 随 `bettbox.apk` 安装，仍以独立进程执行覆写脚本；不再需要单独安装 forge APK。
- **QuickJS 引擎**：沿用上游 rquickjs/QuickJS-NG 执行与转换逻辑，保留脚本开关、策略组图标和 `main(config, customOptions)` 接口；默认执行限时 10 秒、JS 运行时内存分配上限 128MiB、栈 512KiB。
- **启停顺序**：重启前校验新配置，核心 API 与自身 DNS 监听就绪后再接管外置规则和 dnsmasq；停止时先恢复普通网络，失败保留可恢复状态。
- **异步管理任务**：启停、应用配置、核心/APK 更新等待真实完成结果；并发切换被拒绝。APK 安装运行在独立 procd 任务中，页面刷新和 rpcd 重连不会取消已受理任务。
- **NAS 外网回包**：TPROXY/REDIR 增加连接跟踪 reply 方向豁免，避免将端口转发回包当作新上网流量接管。
- **界面与诊断**：资源页提供软件/核心版本和更新状态，适配电脑、手机和深色模式；本版亦包含此前已提交的 V4 代理布局、独立单节点测试、订阅图标和移动端修复。
- **发布兼容性**：修复 OpenWrt 25.12.6 SDK 的合包替换元数据写入和 Python 库环境冲突；已编译产物独立保存，发布校验失败后可在源码及文件内容一致时重新打包。

### 安装与升级

下载匹配设备 APK 架构的 `bettbox-…-<架构>.apk` 和 `luci-app-bettbox-…-<架构>.apk`，只保留这一组两个文件，再在它们所在目录执行：

```sh
apk add --simulate --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk bettbox-forge
apk add --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk bettbox-forge
```

最后的 `bettbox-forge` 是新 Bettbox 提供的兼容名称，用来接续旧三包版本可能留下的依赖约束，不是第三个 APK。先核对模拟事务，若出现无关软件删除或冲突，不强制覆盖。首次使用在线更新须先安装包含该功能的本版；后续版本可在“资源 → Bettbox 更新”检查。

附件 `bettbox-update.json` 提供两架构的文件名、版本、大小和 SHA-256，供设备在线更新使用。项目 APK 未接入设备官方源签名密钥，使用 `--allow-untrusted`；在线更新会额外验证固定 GitHub 仓库、发布清单与所有资源的 digest。

### 验证与注意事项

本地源码、隔离进程和电脑/手机页面回归已通过，原生 QuickJS 的 33 个单元用例和 5 个 CLI 用例已在发布构建中通过。测试文件与过程记录仅保留本地；发布流程执行源码检查、两个 SDK 构建、原生 ucode 语法和 APK 元数据/完整性校验，通过后发布附件与更新清单。

尚未在生产路由器执行本版安装或转发验收。核心或软件更新会重启运行中的代理服务，已有代理连接及 DDNS → NAS 连接仍可能短暂中断，不能承诺无感。APK 安装开始后的错误可能已写入部分文件，本版没有 APK 自动回滚；更新前配置备份保存在 `/etc/bettbox/state/before-package-update.tar`，它不是旧 APK 或整个固件的备份。
