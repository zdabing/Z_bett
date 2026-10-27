# 脚本引擎合包与 QuickJS 迁移（2026-10-27）

本轮完成源码迁移；下述本地记录形成于未编译、未提交的源码阶段。正式发布通过 GitHub Actions 补齐原生引擎、两个 SDK 目标与 APK 元数据校验，结果以 Release / Actions 为准；实际路由器 APK 升级事务仍待验收。此前 Boa / 三包版本的历史实测不能当成本版本验收结果。

## 安装包与运行方式

| 包 | 版本 | 内容 |
|---|---|---|
| `bettbox` | `1.19.33-r4` | Mihomo、服务脚本和 `/usr/bin/bettbox-forge` |
| `luci-app-bettbox` | `1.19.7-r4` | LuCI 界面，依赖 `bettbox` |

`bettbox-forge` 不再单独生成 APK。Rust 源码、锁文件和原生测试移动到 `bettbox/forge/`，可执行文件仍是独立进程，仅在配置覆写和选项提取时调用。未嵌入 Mihomo，也未增加常驻服务。资源页的一键核心更新仍只更新 Mihomo，脚本引擎随 `bettbox.apk` 更新。

`bettbox/Makefile` 同时声明 `golang/host` 和 `rust/host`，先执行 Go 构建，再调用 Cargo helper 构建 `.bettbox-forge`，由同一个安装配方装入两个可执行文件。Rust 源码目录参加构建缓存失效；保留 Go configure hook，并显式传入 SDK 的目标 archiver。

支持范围限定 x86_64 和 aarch64，与现有 CI 矩阵一致；`rquickjs-sys 0.12.0` 自带这两个 musl 目标的绑定，不开启 bindgen，不增加 libclang 构建依赖。其他 CPU 架构未纳入本轮支持声明。CI、WSL 构建和产物导出脚本都只选择两个安装包，避免捡到 SDK 内遗留的旧 forge APK。

## 引擎行为

引擎改为与上游相同的 `rquickjs 0.12.0`（使用 QuickJS-NG）；主绑定、core、sys 的解析版本通过 `Cargo.lock` 固定为 0.12.0。替换了 Boa 和其依赖。

执行模块、JSON 转换、日志收集和原生用例基于上游 Bettbox `1fb8806fdf8275a3694cda31eec7ed2062330aee` 的 `plugins/code_forge/rust/src/script/`，保留来源与 GPL 标注。[上游源码](https://github.com/appshubcc/Bettbox/tree/1fb8806fdf8275a3694cda31eec7ed2062330aee/plugins/code_forge/rust/src/script)

- 执行默认限时 10 秒，JS 运行时分配上限 128MiB、栈 512KiB。原有 `run --timeout SECS` 接口保留，最高 60 秒；选项提取固定 2 秒、32MiB、512KiB。
- 使用引擎中断回调终止超时，超时退出码仍是 124；内存耗尽返回 `OutOfMemory`，并捕获语法、运行和输出转换错误。这些是 JS 运行时限制，不代表整个进程 RSS 不超过 128MiB。
- 不向用户脚本开放文件、网络、shell、Node `require/process` 等宿主能力。配置读取/写入由外层 CLI 完成；`console` 的日志最多 200 行、64KiB。
- 支持普通函数、词法声明的 `main`、Promise 成功/拒绝及不结束的 Promise 错误；输入 `rule` 规范为 `rules`，填充空 `proxy-providers`。
- 保留 `ruleOptionsEnable` 合并、策略组图标和 `policyGroupOptions`；路由器已有的 `main(config, customOptions)` 第二参数继续可用。上游只显式传入第一个参数，这是保留的路由器接口扩展。
- 非对象或数组返回值保留原始规范化输入，而不是脚本已经修改的对象，现与上游一致；原 Boa 包在此处存在行为差异。修改配置的脚本应显式 `return config`。

CLI 的 `run/options/version`、`--script/--config/--options/--timeout/--out` 保留。stdout 为结果 JSON（`--out` 时写文件），日志和结构化错误走 stderr；脚本失败不会写入候选输出文件。LuCI、订阅和渲染脚本继续调用同一个命令路径。

## 从旧三包版本升级

`bettbox` 增加版本化的 `PROVIDES:=bettbox-forge`，接续旧 LuCI 及 world 依赖并排斥旧真实包同时占有该名称。使用 OpenWrt APK 的 `APK_INFO_bettbox` 传入 `replaces:bettbox-forge`，允许接管旧包文件；赋值放在 `BuildPackage` 之后，防止打包宏清空该字段。不使用 SDK 未消费的通用 `REPLACES` 变量，不在安装脚本内嵌套 `apk del`，不依赖 `--force-overwrite`。

首次从三包升级时，建议在两个新 APK 所在目录执行以下命令。最后的 `bettbox-forge` 是由新 `bettbox` 提供的兼容名称，不是第三个安装包；显式传入可同时替换 world 中可能残留的旧版本/哈希约束，避免旧 forge 被固定版本钉住。

```sh
# 先查看同一事务的求解结果，应升级两个包并移除旧真实 forge 包。
apk add --simulate --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk bettbox-forge
# 确认上述事务符合预期后安装；安装本身可能触发 Bettbox 服务重启。
apk add --allow-untrusted ./bettbox-[0-9]*.apk ./luci-app-bettbox-[0-9]*.apk bettbox-forge
apk info --who-owns /usr/bin/bettbox-forge
bettbox-forge version
```

文件所有者应为 `bettbox-1.19.33-r4`。若求解包含无关软件删除或报告约束冲突，不强制删除旧包或覆盖文件，应先检查 world 的额外版本/仓库约束。以后正常升级只提供两个 APK 即可。配置、订阅与脚本目录仍保留原路径。

APK `provides` 的单一所有者规则、文件接管和 world 更新行为分别可见 [APK 元数据定义](https://github.com/alpinelinux/apk-tools/blob/master/doc/apk-package.5.scd) 和 [`apk add` 源码](https://github.com/alpinelinux/apk-tools/blob/master/src/app_add.c)。当前仅核对源码与展开配方，**未实际验证设备包数据库上的事务**。

## 检查结果与待验收项

本地不编译检查：

- `test/forge-contract-test.js`：17 项正式 Rust 源码中 JS 包装/选项提取接口检查，通过 Node 执行，涵盖参数、异步结果、作用域、错误、超时和上游完整配置 fixture；不能替代 QuickJS 行为验证。
- `test/package-layout-test.py`：9 项 GNU Make 配方展开检查，使用 SDK hook 替身，验证 Go/Rust 步骤不互相覆盖、准备/安装路径、旧依赖/文件接管字段及 LuCI 依赖；只做 dry run，未运行编译命令。
- Cargo 依赖解析/下载、锁文件检查、Rustfmt 源码解析与格式检查通过；未调用 `cargo check/test/build`。Shell/JavaScript 语法和原有源码回归继续验证。

新增或移植的 **33 项原生脚本引擎测试和 5 项 CLI 集成测试尚未在本轮运行**。手动 CI 已改为实际执行 `cargo test --locked`，再进入两个 SDK 构建；这些测试覆盖 OOM、死循环、灾难性正则、递归、取消、Promise、编码/数字转换、选项/图标、stdout/stderr、错误退出码和输出文件保留。执行方法见 [测试说明](../test/README.md)。

后续需要原生测试、x86_64/ARM64 SDK 构建、实际 APK 元数据核对、旧三包→新两包升级、文件所有权和真实订阅覆写验收；尚无新版包体积、峰值内存或执行速度实测数据。
