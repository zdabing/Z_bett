# Bettbox × Zen UI 架构与设计规范

> 本文档固化当前 `main` 分支（Bettbox v1.20.0 同步后，7 项主导航架构）确立的 Bettbox LuCI 界面设计体系、样式隔离规范、纯白微卡片与弹框规范，以及与 `luci-theme-zen`（雾岚）的宿主主题兼容协议。

---

## 1. 外观体系概览

`luci-app-bettbox` 在保持原生 LuCI 组件轻量化（无 React/Vue/第三方样式框架）的前提下，通过 [ui.js](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.js) 与 [ui.css](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.css) 提供三种外观风格、五种主题色与三种明暗模式：

### 1.1 外观风格（`data-bb-style`）

| 风格 Key (`data-bb-style`) | 名称 | 视觉特征 | 默认/适用场景 |
|---|---|---|---|
| `meridian`（默认） | Meridian 默认 | 雪白画布 `#fcfcfd` / 纯白卡片 `#ffffff` / 柔边 `#e4e7ee` + 轻投影（暗色石墨灰 `#121418` / `#1b1e24`），圆角 `20px / 12px`，默认极光蓝 `#2563eb`，无重度模糊 | Bettbox 默认高对比度桌面/路由界面 |
| `apple` | Apple 卡片 | 清透微蓝白画布 `#fbfcfe` / 纯白卡片 `#ffffff` / 细边 `#e2e7f0`（暗色 `#161920` / `#1f232c`），圆角 `22px / 11px`，零模糊纯实色卡片 | 极简低渲染开销的清透卡片风格 |
| `host` | 跟随宿主主题 | 清除 `meridian`/`apple` 与主题色专属覆写，通过 CSS 变量回退自动继承当前 LuCI 宿主主题（如 `luci-theme-zen`） | 与 `luci-theme-zen` 等宿主主题无缝融合 |

### 1.2 主题色体系（`data-bb-accent`）

仅在 `meridian` 与 `apple` 风格下生效，**严禁在 `host` 模式下覆盖宿主配色**。配置与风格、明暗模式一同持久化在浏览器 `localStorage` 的 `bettbox.appearance.v1` 键中（JSON 格式：`{ style, mode, accent }`）：

| 主题色 Key (`data-bb-accent`) | 名称 | 浅色模式 (`--bb-accent` / `--on-accent` / `--soft`) | 深色模式 (`--bb-accent` / `--on-accent` / `--soft`) |
|---|---|---|---|
| `blue`（默认） | 极光蓝 | `#2563eb` / `#ffffff` / `#eff6ff` | `#3b82f6` / `#ffffff` / `rgba(59, 130, 246, 0.16)` |
| `teal` | 翡翠青 | `#0d9488` / `#ffffff` / `#f0fdfa` | `#14b8a6` / `#042f2e` / `rgba(20, 184, 166, 0.16)` |
| `indigo` | 靛蓝紫 | `#4f46e5` / `#ffffff` / `#eef2ff` | `#6366f1` / `#ffffff` / `rgba(99, 102, 241, 0.18)` |
| `ink` | 极简墨 | `#18181b` / `#ffffff` / `#f4f4f5` | `#e4e4e7` / `#18181b` / `rgba(228, 228, 231, 0.14)` |
| `amber` | 暖琥珀 | `#ea580c` / `#ffffff` / `#fff7ed` | `#f97316` / `#1c1008` / `rgba(249, 115, 22, 0.16)` |

### 1.3 明暗模式与挂载属性

- 明暗模式（`mode`）：`system`（默认，监听 `prefers-color-scheme: dark`）、`light`、`dark`。
- 实际渲染属性挂载于 `<body>`：
  - `body.bb-page`：标记处于 Bettbox 独立页面，清除宿主 `#maincontent` / `.main-right` 默认留白与 `#tabmenu`。
  - `body[data-bb-style="meridian|apple|host"]`、`body[data-bb-scheme="light|dark"]`、`body[data-bb-accent="blue|teal|indigo|ink|amber"]`。

---

## 2. 宿主变量映射契约（对接 `luci-theme-zen`）

`ui.css` 在 `.bb-app`（第 3 行）与 `body[data-bb-scheme] .modal:has(.bb-modal-content)`（第 845 行）中声明了一套与 `luci-theme-zen`（`theme.css`）1:1 对应的语义回退链路：

| Bettbox 内部 Token | 继承的宿主 (`luci-theme-zen`) 变量 | 默认内置兜底值（无宿主变量时） | 用途 |
|---|---|---|---|
| `--bg` / `--bg-solid` | `--bg-base` | `#fcfcfd` | 页面整体底色 / 不透明背景 |
| `--surface` / `--surface-solid` | `--bg-panel` | `#ffffff` | 卡片、面板、弹窗、抽屉、输入框与微卡片底色 |
| `--subtle` | `--bg-nested`, `--bg-input` | `#f8f9fb` | 分段控件外轨、嵌套辅助区 |
| `--ink` | `--text` | `#232326` | 主文本 |
| `--secondary` | `--text-secondary` | `#62626c` | 次级文本与常规按钮文字 |
| `--muted` | `--text-muted` | `#6b6b75` | 辅助标签与提示 |
| `--bb-accent` | `--accent` | `#2563eb` | 主强调色、主按钮、激活态标识 |
| `--soft` | `--accent-soft` | `#eff6ff` | 轻量高亮底、标签底色 |
| `--bb-line` | `--line` | `#e4e7ee` | 边框与分割线 |
| `--bb-warn` / `--warn-bg` | `--warn` / `--warn-soft` | `#8a5700` / `#fff7de` | 警告状态与告警横幅 |
| `--bb-danger` / `--danger-bg` | `--danger` / `--danger-soft` | `#b42318` / `#fff0ed` | 危险操作与错误状态 |
| `--upload` / `--download` | `--ul` / `--dl` | `#f97316` / `#2563eb` | 上传 / 下载速率与趋势线 |

> **兼容边界**：`luci-zen` 仓库维护其自身的 `luci-zen/docs/DESIGN.md`；`Z_bett` 仅通过上述语义变量回退链路与之保持兼容，不直接修改 `luci-theme-zen` 宿主文件。新组件仅可引用 `--bb-*`、`-solid` 或 semantic 变量，**禁止直接硬编码脱离主题的固定色值**（`meridian` / `apple` / `data-bb-accent` 预设块除外）。

---

## 3. 表面层级、纯白微卡片与通用组件规范

1. **纯白实色微卡片与干净控件原则**：
   - `.field`（搜索/输入框）、`.v4-node`（代理节点卡）、设置项 `.setting-row`、Geo 资源卡 `.bb-geo-card`、概览连通性 `.test-row`、工具箱 `.bb-health-layer` 与 `.bb-health-memory > div` 等内嵌控件统一采用实色 `var(--surface-solid, var(--surface))` + `1px solid var(--bb-line)`。
   - **禁止**在普通输入框、未选中代理节点或内嵌微卡片中填充沉闷灰底（`--subtle`）或大面积暖/彩色底（`--soft`）；悬停与选中态通过 `--bb-accent` 描边、聚焦环或极轻局部高亮表达，避免使用脏灰（如 `#85858f`）悬停边框。
2. **浮层实色与不透底**：
   - `.modal:has(.bb-modal-content)`、`.hub-drawer`、`.hub-modal-backdrop`、`.device-picker-popup`、激活态分段滑块（`.segmented button.active`、`.bb-mode-btn.active`、`.hub-tabs button.active`）与 `.bb-style-card.active .bb-style-radio` 均必须使用 `var(--surface-solid, var(--surface))` 或 `var(--bg-solid, var(--bg))`。
3. **弹框卡片化契约（`UI.modal`）**：
   - `body[data-bb-scheme] .modal:has(.bb-modal-content)` 自管外框：`max-width: 540px; width: min(540px, calc(100vw - 32px)); padding: 0 !important; overflow: hidden; border: 1px solid var(--bb-line); border-radius: var(--bb-radius)`。
   - 内部分段：`> h4` 固定顶栏（`padding: 16px 22px`，带底部分割线）→ `.bb-dialog-body`（`padding: 18px 22px`，含卡片化 `.bb-form-field` 与 `.definition-list`）→ `.bb-dialog-actions` 底栏。
   - 同步卡片化 `body.bb-page .alert-message` 提示条；`UI.field(label, control, help)` 支持第 3 参数渲染输入说明文字。
4. **统一日志行样式**：
   - `.bb-log-list` 每行保留 `3px` 左侧状态色条与轻度行底色（`5%` / `6%` `color-mix`），级别徽章 `.bb-log-level` 采用固定宽度 `68px` 居中描边胶囊，清晰区分 `INFO` / `WARNING` / `ERROR` / `DEBUG`，避免浅底吞没文字对比度。
5. **暗黑模式危险按钮优先级**：
   - `body[data-bb-scheme="dark"] .bb-app .btn:not(.primary):not(.danger)` 必须排除 `.danger`，且由 `body[data-bb-scheme] .bb-app .btn.danger` 统一声明 `color: var(--bb-danger); background: var(--surface-solid, var(--surface)); border-color: var(--danger-line, var(--bb-line))`。

---

## 4. 页面外壳、导航与模块结构标准

1. **统一页面入口 (`UI.page`)**：
   - 顶部粘性导航 `.main-nav` 包含左侧 **7 项主导航**（`.bb-nav-links`：`概览`、`代理`、`连接`、`订阅与脚本`、`工具箱`、`日志`、`设置`；原「资源」已并入「设置 → 资源与维护」，保留 [resources.js](../luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/resources.js) 书签跳转）。
   - 右侧保留外观快捷胶囊（`.bb-nav-appearance`：一键轮切风格 + 切换浅色/深色）。
   - 页面右上角工具栏 `.heading-actions` 仅放置当前页面特有主操作，空数组时通过 `:empty{display:none}` 自动折叠，**不得在各页重复塞入“主题”按钮**。
   - 完整外观配置入口固定位于 **「设置 → 常规 → 外观风格」**（风格 + 5 色主题色 + 明暗模式），并与顶栏胶囊及 `UI.themePicker()` 通过 `appearanceListeners` 实时同步。
2. **关键页签与微卡片网格标准**：
   - **设置页**（[settings.js](../luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/settings.js) + [settings.css](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/settings.css)）：收口为 4 个标签页（`常规`、`网络与代理`、`设备控制`、`资源与维护`）；PC 端采用 4 列响应式微卡片网格（`4 → 3 → 2 → 1`），首行归置输入项、次行归置开关项；按 `transparent_mode` 动态显隐 `tproxy_port` / `redir_port` / `tun` 控件，高频进阶参数收纳进折叠 `<details>`；`资源与维护` 内嵌 4 列 Geo 微卡片（`.bb-geo-grid` / `.bb-geo-card`）。
   - **概览页**：连通性区域采用 3×2 实色微卡片（`.test-grid` / `.test-row`）。
   - **工具箱页**（[toolbox.js](../luci-app-bettbox/htdocs/luci-static/resources/view/bettbox/toolbox.js) + [health.css](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/health.css)）：网络健康分层卡 `.bb-health-grid`（4 列 → 2 列 → 1 列）与内存 KPI `.bb-health-memory > div`（4 列实色微卡片）。
3. **模块级样式拆分与缓存版本号**：
   - `ui.css`：基础排版、导航、卡片、表单、弹窗、日志行、Meridian/Apple/Host 与 5 色主题系统。
   - 专属样式按域按需注入：`settings.css`、`subscriptions.css`、`scripts.css`、`connections.css`、`health.css`、`proxy-state.css`。
   - 修改任意 CSS 后，必须在所有加载该 CSS 的 JS 文件中同步更新 `?v=YYYYMMDD-N`，防止路由器升级后浏览器命中旧缓存。
4. **响应式与触控规范**：
   - `>= 1200px`：设置页呈现完整 4 列微卡片网格，工具箱网络健康 4 列展开。
   - `<= 1199px`：设置页网格与健康分层逐步降为 3 列 / 2 列。
   - `<= 767px`：工具箱切换为顶部横向滚动条，服务控制区与订阅操作区允许换行对齐；可点击控件最小触控高度 `40px`（`<= 44px`）。
   - `<= 599px`：主导航转为 4 列 2 行紧凑网格，隐藏顶栏外观胶囊（保留「设置」页完整入口），节点/表单项全宽伸缩。

---

## 5. 开发期常见反模式清单（禁止出现）

- ❌ 在 `view/bettbox/*.js` 中编写未前缀的全局样式或直接修改 `document.documentElement.dataset.theme`（`data-theme` 归属宿主主题如 `luci-theme-zen`，Bettbox 只维护 `body.dataset.bbStyle`、`body.dataset.bbScheme`、`body.dataset.bbAccent`）。
- ❌ 在 `host` 模式下注入 `data-bb-accent` 或色板覆写，破坏宿主主题一致性。
- ❌ 在输入框（`.field`）、代理节点卡（`.v4-node`）或内嵌微卡片中回退使用灰底 `--subtle` 或大面积橙/彩底 `--soft`。
- ❌ 在 `UI.modal` 中省略 `.bb-dialog-body` / `.bb-dialog-actions` 或重加外层内边距导致内容贴边。
- ❌ 在多个页面重复添加全局外观按钮或全局控制入口。
- ❌ 在阻塞弹窗、选择器浮层或下拉列表使用半透明 `rgba` 背景导致底层文字穿透。
- ❌ 修改 CSS 文件却遗漏更新对应 JS 中的 `?v=...` 版本参数（尤其是同时被多处加载的 `subscriptions.css`）。
- ❌ 使用外部 CDN 字体、图标库或打包工具引入非原生运行时依赖。
