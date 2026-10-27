# Bettbox APK 一键更新（2026-10-27）

正式资源页新增“Bettbox 更新”，用于一起更新 `bettbox` 与 `luci-app-bettbox`，包含服务脚本、QuickJS helper 和后台界面。Mihomo 独立更新入口继续保留，管理的核心选择不会因 APK 更新而主动切回随包核心。

以下本地测试记录形成于源码实现阶段；正式发布还需通过 GitHub Actions 的原生测试、SDK 构建、原生 ucode 语法与真实 APK 校验。未在生产路由器安装或启停本版，构建和产物状态以 Release / Actions 为准。**需要先手动安装包含更新功能的初始两个 APK，并完成首次稳定 Release 发布，设备才有可下载安装的更新源。**

## 页面与命令

入口：“资源 → Bettbox 更新”。显示已安装的 Bettbox/LuCI APK 版本、匹配架构和已检查的最新发布；检查后显示版本变化。

- “检查更新”只读取本项目稳定 Release，不安装。
- “更新并重启服务”用于当前核心正在运行的情况；当前停止时显示“更新 APK”，完成后仍保持停止。
- 操作中禁用本页重复的软件/核心操作。完成或连接状态无法确认时提供“刷新页面”；rpcd 重启可能需要重新登录。
- 重新打开页面时会显示仍在运行的 APK 更新、上次安装失败或异常中断状态。

```sh
bettbox package status
bettbox package check
bettbox package update
```

支持 OpenWrt 25.12 系列；必须在设备 `/etc/apk/arch` 中明确接受 `x86_64` 或 `aarch64_generic`，并与 CPU 匹配。不会仅凭 CPU 是 ARM64 就强行安装其他 APK 架构，不传 `--arch` 绕过设备检查。

## 来源、校验与安装

来源固定为 [zdabing/Z_bett 稳定发布](https://github.com/zdabing/Z_bett/releases/latest)，不接受页面传入自定义 URL、包名或安装命令。版本检查失败、未发布清单或架构不匹配时不安装。

1. 验证 GitHub 稳定 Release 标签与精确下载地址；下载 `bettbox-update.json`，核对 GitHub 资源的 SHA-256 和大小。
2. 清单 schema 必须为 1、OpenWrt 系列为 25.12，当前架构必须恰好有两个规定的包。APK 文件名、包名、版本、架构、大小及 SHA-256 都有固定约束，且清单和 GitHub 资源 digest 必须一致。
3. 两个 APK 完整下载并校验后，用设备原生 `apk verify` 检查完整性，用 `apk adbdump --format json` 核对内部身份与安装大小。核心包还必须具有 forge 合包的版本化 provide 与文件接管信息。
4. 使用 `apk version -t` 比较各包版本；任何一个发布包比已安装版本旧都会拒绝自动安装。不会通过更新界面强制降级。
5. 检查下载/安装空间，并模拟一次两个 APK 的同一安装事务。允许安装所需的新依赖及移除旧真实 forge 包；拒绝移除其他软件、升级其他已安装依赖、降级或无法识别的事务计划。
6. 再次核对安装版本没有被其他任务更改，导出配置备份到 `/etc/bettbox/state/before-package-update.tar`。备份失败则不安装。
7. 把两个已验证 APK 与 forge 兼容名称传给同一次 `apk add`，延续 [合包迁移规则](FORGE_MIGRATION.md)。不运行全系统 `apk upgrade`，不使用 `--force-overwrite`、强制删除依赖或关闭架构检查。
8. 安装后核对两个真实版本及 APK 文件/脚本状态，按原运行状态执行一次受控服务重启或保持停止；最后重启 rpcd 加载新后台，并返回任务结果。

发布包使用 `--allow-untrusted`，因为项目包未接入设备的 OpenWrt 软件源签名密钥；安装前必须完成固定 GitHub 仓库、Release 清单与资源 digest 的全部校验。这里的信任来源是本项目的 GitHub 发布权限与 HTTPS，不声称具备独立离线签名或防仓库账户被攻陷的保证。

## 独立任务与服务状态

写权限 RPC `package_update` 与页面启停、应用配置、核心更新共享准入锁。后台最长 2400 秒，页面查询预算 2430 秒；检查任务仍为 160 秒。直接 CLI 还有 APK 文件锁，并持有核心更新锁避免与直接核心下载/切换并行。

网页发起的 APK 安装由 procd 的独立 `bettbox-package-update` 实例执行，使用私有任务目录里的 runner 和 worker 快照；不会依附于将被更新/重启的 rpcd，也不继承普通诊断的文件大小限制。任务输出保留末尾最多 1MB，结果文件与任务 ID 延续原异步协议。直接执行 CLI 更新是前台任务，需保持命令行会话。

APK 会清洗安装脚本的环境，因此安装命令明确使用干净环境加 `--preserve-env`，只传 PATH 和 `BETTBOX_SELF_UPDATE=1`。核心 init 对此环境中的隐式 start/stop/enable 调用返回而不操作服务；核心和 LuCI postinst 也把额外的重启/重载交给更新任务。更新任务自身不带此标记，待两个包完成后才恢复原服务状态。正常手动安装仍沿用原安装钩子行为。

网页对短暂的 RPC 断连重试；连续 90 秒仍不可达时显示“连接中断，请刷新页面或重新登录后确认安装结果”，不把失去连接等同于安装失败。页面刷新或重新登录不会停止已被受理的独立任务。

## 发布流程

工作流仍**仅手动触发**，默认 `publish=false`，普通编译不会发布更新。

需要发布时，在 Actions 的 `Build OpenWrt 25 packages` 中设置 `publish=true`，并指定尚不存在的 `release_tag`，格式为 `vX.Y.Z` 或 `vX.Y.Z-rN`，例如 `v2026.10.27`。

- 源码检查和原生 QuickJS 测试通过后，分别构建 x86_64 与 aarch64_generic。
- SDK host APK 工具校验每个真实包的完整性、版本、架构及合包迁移元数据；产物文件名带架构后缀，避免两架构同名覆盖。
- `test/release-manifest.py` 汇总四个架构限定资源和一个更新清单，核对所有 artifact 的哈希/大小，并确保版本与当前源码 Makefile 一致。
- 发布任务仅获得该 job 的 `contents: write` 权限，先创建指向构建提交的新标签和草稿 Release，不覆盖已有标签/Release。
- 上传后再次通过 GitHub API 核对全部五个资源的大小和 digest，全部一致才转为正式 latest。校验失败保留草稿，不向设备提供这个版本。

后续修改软件包内容时也必须递增相应的 `PKG_RELEASE/PKG_VERSION`；仅换 GitHub 标签但两个包版本不变不会被设备视为可更新版本。工作流只准备未来发布，本轮没有运行工作流或授予额外持久权限。

## 失败与恢复边界

下载、哈希、元数据、空间、事务预检查或配置备份失败时，不执行 APK 安装。**APK 事务开始后的错误可能已写入部分文件或提交部分安装状态；本功能不提供 APK 自动回滚。** 会保留更新前配置备份与 `/etc/bettbox/state/package-update-result.json`，报告实际错误，重新读取版本；需要管理员核对包数据库和服务，再修复安装或恢复配置。

配置备份只覆盖原备份功能的 UCI、订阅、脚本、规则，不是整个固件、旧 APK 或完整服务环境快照。下载临时文件会清理。后台任务超时不代表所有子进程必然停止，不能立即并发强行安装其他包。

安装最终需要重启运行中的核心和 rpcd，经过核心的连接可能中断；不保证外网 DDNS→NAS 的已有连接连续保持。不会主动重拨 WAN、重启 Wi-Fi、全局重启防火墙或清空连接跟踪。直接 root 手动干预服务/包管理器不属于网页准入锁的控制范围。

## 验证范围

- `test/package-update-test.js`：35 项正式 ucode 的受控执行，使用真实 SHA-256，覆盖两架构、发布清单、下载、内部包身份/迁移字段、拒绝降级/危险事务、备份、原运行状态、安装部分失败及启动失败。
- `test/release-manifest-test.py`：9 项清单与发布流程检查，验证架构文件名、哈希/大小、APK 身份/合包字段、非法标签、草稿校验门槛和禁止覆盖标签；没有联网或创建 Release。
- `test/package-layout-test.py`：9 项 GNU Make dry run / 隔离安装钩子用例；`test/service-lifecycle-test.py` 新增安装环境不得隐式重启的真实 shell 用例。
- `test/core-test.js`：40 项 RPC/控制器回归，包含 APK 写权限、独立任务快照与 procd 启动、互斥及完成解锁；共享任务组件 10 项、worker 22 项。
- `test/resources-core-test.cjs`：正式页面、共享 CSS、Zen 主题，七种宽度和深色手机、版本对比、重复操作禁用、真实异步完成、RPC 断连后恢复、失败/停止/不支持/后台已忙/读取失败状态。

ucode 测试在 Node 中适配内建函数执行，进程、APK、GitHub、procd 与网络均为受控替身；Make 用例不执行编译。尚未在设备上运行原生 ucode、实际 APK 升级事务、rpcd 登录恢复或新版本转发验收，也没有编译或发布包。测试运行方式见 [测试说明](../test/README.md)。
