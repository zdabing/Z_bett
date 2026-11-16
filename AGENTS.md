# AGENTS.md — Z_bett (`bettbox` + `luci-app-bettbox`) 业务模块化开发规范

> **唯一基准版本**：本规范以当前 `main` 分支稳定版本（基线提交 `595652e`，OpenWrt 25.12.6 `aarch64_generic` / `aarch64_cortex-a53` / `x86_64` 双包架构与 Zen 双预设 UI）为唯一设计与重构基准。  
> 详细模块契约与上游同步流程见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/ZEN-UI-SPEC.md](docs/ZEN-UI-SPEC.md)。

---

## 1. 项目定位与不可破坏红线

1. **双包独立、职责清晰**：
   - `bettbox/`（架构相关 `aarch64_generic` / `aarch64_cortex-a53` / `x86_64`）：包含 Mihomo 核心（含内嵌上游合并/统计/追踪 Go 模块）、Rust/QuickJS 脚本引擎 `bettbox-forge`、UCI 默认配置、`procd` 服务、透明代理与规则渲染脚本。
   - `luci-app-bettbox/`（架构无关 `all`）：包含 LuCI 菜单/ACL、ucode `rpcd` 后端与原生 ES5/LuCI JS + Scoped CSS 界面。
2. **宿主主题零硬依赖**：
   - `luci-app-bettbox` 只依赖 `+luci-base +bettbox`，**不得**在 `Makefile`、`rpcd` 或 JS 运行时强依赖 `luci-theme-zen`、Bootstrap 特定 DOM 或外部前端框架。
   - 在任何 LuCI 主题（包括 `luci-theme-zen` 雾岚、Bootstrap、Argon 等）下都必须独立可用。
3. **不绕过边界与安全护栏**：
   - 前端所有路由器配置与敏感操作必须经由 LuCI UCI 或 `luci-app-bettbox/root/usr/share/rpcd/ucode/bettbox.uc` 白名单方法执行，受 `acl.d/luci-app-bettbox.json` 读写分离约束。
   - 禁止把持久态写入纯前端 `localStorage` 作为路由器配置源（`localStorage` 仅用于浏览器外观偏好 `bettbox.appearance.v1` 与代理测速会话缓存等纯界面状态）。
4. **测试与草稿隔离**：
   - 临时排查脚本、预览 HTML、截图和构建缓存不得直接提交到产品源码目录；修改完成后保持 `git status` 干净。

---

## 2. 六大业务模块边界

新增或修改任何功能，必须先确定归属模块，严禁跨层硬编码或绕过接口：

| 层级 | 目录 / 关键文件 | 唯一职责 | 禁止事项 |
|---|---|---|---|
| **1. 核心与上游扩展** | `bettbox/Makefile`、`bettbox/patches/*.patch`、`bettbox/upstream/*.go` | 封装 Mihomo 构建、补丁与上游 `appshubcc/Bettbox` 核心能力（合并/追踪/流量统计） | 禁止在 `Makefile` 中引入未记录源的上游代码；禁止改坏 `/traffic`、`/memory`、`/connections` 原生 API 契约 |
| **2. 脚本引擎** | `bettbox/forge/`（`Cargo.toml`、`src/main.rs`、`src/script/*`） | QuickJS 沙箱执行订阅脚本（`main(config, customOptions)`）、参数提取（`options`）与分享链接转换 | 禁止改动 `--script`/`--config`/`--options`/`--timeout`/`--out` CLI 参数契约；必须保持 `RUST_PKG_LOCKED:=1` 与 `cargo fmt --check` 通过 |
| **3. 路由器控制面** | `bettbox/files/etc/config/bettbox`、`bettbox/files/usr/bin/bettbox`、`bettbox/files/usr/libexec/bettbox/*` | UCI Schema、配置渲染（`render.uc`）、订阅合并（`profile-merge.sh`）、托管分流（`managed-routing.*`）、防火墙/DNS/健康检查 | 禁止删除已有 UCI 字段的向后兼容读取；禁止直接用 `echo`/字符串拼接生成复杂 YAML 或 shell 注入 |
| **4. LuCI RPC 网关** | `luci-app-bettbox/root/usr/share/rpcd/ucode/bettbox.uc`、`acl.d/luci-app-bettbox.json`、`menu.d/luci-app-bettbox.json` | 暴露 `bettbox` ubus 对象、校验参数/路径、调度异步诊断/更新任务、中转非流式 REST | 禁止在 `api_proxy` 中放行 `/traffic`、`/memory`、`/logs` 长流；禁止新增 `rpcd` 方法却漏配 `acl.d`；所有命令参数必须经 `shellquote()` 与白名单校验 |
| **5. 前端传输与 UI 基座** | `luci-app-bettbox/htdocs/luci-static/resources/bettbox/core.js`、`ui.js`、`ui.css` | 统一的核心 REST 直连/RPC 回退（`core.js`）、页面导航壳层/图标/模态框/异步任务轮询/Zen 外观引擎（`ui.js` + `ui.css`） | 禁止业务视图绕过 `core.js` 自拼 `fetch`/端口；禁止在全局选择器编写无 `.bb-app`/`body.bb-page` 前缀的 CSS |
| **6. 业务视图与子模块** | `luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/*.js`、`bettbox/*.{js,css}` | 概览、代理、连接、订阅与脚本、资源、工具箱、日志、设置等具体页面逻辑 | 禁止在各页面标题栏重复塞入“主题”等全局公共按钮；禁止把复杂子域（如设备选择器、脚本管理器）全部堆进 `view/*.js` 单文件 |

---

## 3. Betta × Zen 模块化 UI 与主题规范

1. **CSS 作用域硬隔离**：
   - 所有样式必须以 `.bb-app`、`body.bb-page` 或 `.modal:has(.bb-modal-content)` 为根作用域。
   - 不允许污染 LuCI 宿主的 `header`、`.main-left`、`.cbi-*`、`body` 通用排版。
2. **三套外观模式与变量契约**：
   - `ui.js` 维护 `meridian`（默认，`Meridian 橙彩玻璃`）、`apple`（`Apple 清爽卡片`）、`host`（`跟随宿主主题`）及 `system` / `light` / `dark` 明暗切换，键名固定为 `bettbox.appearance.v1`。
   - **宿主协同（与 `luci-theme-zen` 对齐）**：`host` 模式下，`ui.css` 顶层 `.bb-app` 通过 `--bg: var(--bg-base, ...)`、`--surface: var(--bg-panel, ...)`、`--subtle: var(--bg-input, ...)`、`--ink: var(--text, ...)`、`--secondary: var(--text-secondary, ...)`、`--muted: var(--text-muted, ...)`、`--bb-accent: var(--accent, ...)`、`--soft: var(--accent-soft, ...)`、`--bb-line: var(--line, ...)` 等变量自动继承 `luci-theme-zen` 雾岚或其它支持同名变量的主题。
   - **严禁覆盖宿主配色**：仅 `body[data-bb-style="meridian"]` 与 `body[data-bb-style="apple"]` 可覆盖主题色板与模糊特效；`body[data-bb-scheme]` 公共块不得强写 `color-scheme: light` 或覆盖 `--bg`/`--surface`/`--bb-accent`。
3. **毛玻璃与实色表面分离**：
   - 任何全屏/半透明底层之上浮层——包括 `.modal:has(.bb-modal-content)`、`.hub-drawer`、`.device-picker-popup`、激活态分段按钮（`.segmented button.active` / `.bb-mode-btn.active`）、下拉菜单和 `.btn.danger`——**必须**使用 `var(--surface-solid, var(--surface))` 或 `var(--bg-solid, var(--bg))`，防止 Meridian 毛玻璃模式透底导致文字对比度下降。
4. **缓存失效版本号**：
   - 每次修改 `ui.css`、`settings.css`、`subscriptions.css`、`scripts.css`、`connections.css`、`health.css`、`proxy-state.css`，必须同步递增所有引用该样式的 JS 文件中的 `?v=YYYYMMDD-N` 查询参数。
5. **交互与布局一致性**：
   - 所有页面统一使用 `UI.page(id, title, actions, content)`；外观完整设置统一收口在「设置 → 外观风格」与导航栏右侧快捷胶囊中。
   - 移动端断点 `@media(max-width:767px)` 与 `@media(max-width:599px)` 下的可点击控件 `min-height` 原则上不低于 `40px`（`<=44px` 标准触控区间），危险按钮在暗色模式下必须通过 `body[data-bb-scheme] .bb-app .btn.danger` 保持高亮红字与独立边框。

---

## 4. 上游同步与版本升级规范

本项目同时追踪三个上游源：**`MetaCubeX/mihomo`**、**`appshubcc/Bettbox`** 与 **`luci-zen`（`luci-theme-zen`）**。升级任一上游时遵循以下原则：

1. **Mihomo 核心升级（`bettbox/Makefile` + `bettbox/patches/`）**：
   - 更新 `PKG_VERSION` 与 `PKG_HASH`，同步更新 `bettbox/files/etc/config/bettbox` 中 `global_ua` 默认版本号。
   - 逐一验证 `bettbox/patches/100-*.patch`、`110-*.patch`、`120-*.patch` 在新源码树上干净应用；`120-traffic-history.patch` 对 `main.go` 的改动仅负责引入 `github.com/metacubex/mihomo/bettbox` 与挂接路由，业务逻辑留在 `bettbox/upstream/*.go`，避免产生大范围 Go 冲突。
   - 同步核对 `bettbox/upstream/route.go.install` 所依赖的 Mihomo `hub/route` / `chi/render` 导入签名。
2. **Bettbox 桌面端能力同步（`bettbox/upstream/` + `managed-routing.*` + `bettbox/forge/`）**：
   - 移植至 `bettbox/upstream/*.go` 的文件必须在顶部注释标明上游版本与 Commit（如 `// Bettbox v1.19.8 (88b9597), core/profile_merge.go.`），保持与桌面端接口 JSON 字段一致。
   - 托管分流目录及规则（`managed-routing.js`、`managed-routing.json`、`managed-routing.uc`）独立存放，不直接散落写入 `render.uc` 或前端视图。
   - 更新 `bettbox/forge/` 后若修改 Rust 源码或 `Cargo.lock`，需在提交前跑通 `cargo fmt --check` 与 `cargo check --locked`。
3. **LuCI Zen 主题联动升级（`luci-theme-zen` ↔ `luci-app-bettbox`）**：
   - 当 `luci-theme-zen` 新增或调整 `:root` / `:root[data-theme="dark"]` 语义 CSS 变量时，同步核对 [ui.css](luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.css) 第 3 行回退映射以及第 853 行 `.modal:has(.bb-modal-content)` 变量映射。
   - `luci-app-bettbox` 与 `luci-theme-zen` 不共享写状态：`zen` 的主题设置存储于 `/etc/config/zen` 与 `luci-theme-zen` 本地键，`bettbox` 外观偏好存储于 `bettbox.appearance.v1`；当选择 `host` 模式时，Bettbox 自然跟随 `zen` 的亮/暗态变量切换。

---

## 5. 提交前自检要求

修改代码后、提交或交付前，按变更范围执行对应检查并**仅报告真实执行通过的结果**：

1. **前端 JS 语法**：对改动及关联 JS 执行 `node --check <file>.js`（Windows/Linux 通用）。
2. **托管脚本 / 解析器**：若改动 `managed-routing.js` 或 `subscription-parser.js`，执行 `node --check`。
3. **CSS 结构完整性**：确认所有 `.css` 花括号 `{}` 与注释 `/* */` 闭合，且 `ui.css?v=...` 等资源版本号已同步更新。
4. **CI 对齐检查（Linux / WSL / GitHub Actions 环境）**：
   - Shell 语法：`sh -n bettbox/files/usr/bin/bettbox bettbox/files/etc/init.d/bettbox bettbox/files/usr/libexec/bettbox/*.sh`
   - Rust 检查：`cargo fmt --manifest-path bettbox/forge/Cargo.toml -- --check` 与 `cargo check --locked --manifest-path bettbox/forge/Cargo.toml`
   - ucode 语法：通过 OpenWrt 25.12 SDK `ucode -cno-interp,...` 校验 `bettbox/files/usr/libexec/bettbox/*.uc` 与 `bettbox.uc`（含 `export function` 包装检查）。
   - Git 空白与冲突标记：`git diff --check`。
