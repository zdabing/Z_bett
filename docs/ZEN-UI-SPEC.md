# Bettbox × Zen UI 架构与设计规范

> 本文档固化 `main` 分支（`595652e`）确立的 Bettbox LuCI 界面设计体系、样式隔离规范以及与 `luci-theme-zen`（雾岚）的宿主主题兼容协议。

---

## 1. 外观体系概览

`luci-app-bettbox` 在保持原生 LuCI 组件轻量化（无 React/Vue/第三方样式框架）的前提下，通过 [ui.js](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.js) 与 [ui.css](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.css) 提供三种外观风格与三种明暗模式：

| 风格 Key (`data-bb-style`) | 名称 | 视觉特征 | 默认/适用场景 |
|---|---|---|---|
| `meridian`（默认） | Meridian 橙彩玻璃 | 暖橙强调色（`#ea580c` / 暗色 `#fb923c`）、径向渐变底色、毛玻璃卡片（`backdrop-filter`）、柔和内高光 | Bettbox 默认识别度主题 |
| `apple` | Apple 清爽卡片 | 高可读中性灰白底（`#f5f5f7` / 暗色 `#0b0b0d`）、Apple 蓝强调色（`#0071e3` / `#0a84ff`）、零模糊纯实色卡片 | 追求极简低渲染开销的桌面/移动环境 |
| `host` | 跟随宿主主题 | 清除 `meridian`/`apple` 专属覆盖，通过 CSS 变量回退继承当前 LuCI 宿主主题（如 `luci-theme-zen` 雾岚） | 与 `luci-theme-zen` 雾白/石墨绿体系无缝融合 |

- 明暗模式（`mode`）：`system`（默认，监听 `prefers-color-scheme: dark`）、`light`、`dark`。
- 实际渲染属性挂载于 `<body>`：
  - `body.bb-page`：标记处于 Bettbox 独立页面，清除宿主 `#maincontent` / `.main-right` 默认留白与 `#tabmenu`。
  - `body[data-bb-style="meridian|apple|host"]` 与 `body[data-bb-scheme="light|dark"]`。

---

## 2. 宿主变量映射契约（对接 `luci-theme-zen`）

`ui.css` 在 `.bb-app` 与 `body[data-bb-scheme] .modal:has(.bb-modal-content)` 中声明了一套与 `luci-theme-zen` (`theme.css`) 1:1 对应的语义回退链路：

| Bettbox 内部 Token | 继承的宿主 (`luci-theme-zen`) 变量 | 默认内置兜底值（无宿主变量时） | 用途 |
|---|---|---|---|
| `--bg` / `--bg-solid` | `--bg-base` | `#eef0ea` | 页面整体底色 / 不透明背景 |
| `--surface` / `--surface-solid` | `--bg-panel` | `#fbfbf8` | 卡片、面板、弹窗、抽屉与激活胶囊背景 |
| `--subtle` | `--bg-input` | `#fbfbf8` | 输入框、分段控件底槽、只读区块 |
| `--ink` | `--text` | `#17241d` | 主文本 |
| `--secondary` | `--text-secondary` | `#4f5d55` | 次级文本与常规按钮文字 |
| `--muted` | `--text-muted` | `#67756c` | 辅助标签与提示 |
| `--bb-accent` | `--accent` | `#1f7a5a` | 主强调色、主按钮、激活态标识 |
| `--soft` | `--accent-soft` | `#dcefe6` | 浅色高亮底、悬停态、标签底色 |
| `--bb-line` | `--line` | `#e1e5dc` | 边框与分割线 |
| `--bb-warn` / `--warn-bg` | `--warn` / `--warn-soft` | `#956622` / `#f6e8d2` | 警告状态与告警横幅 |
| `--bb-danger` / `--danger-bg` | `--danger` / `--danger-soft` | `#a63d38` / `#f8e8e4` | 危险操作与错误状态 |
| `--upload` / `--download` | `--ul` / `--dl` | `#c07a1f` / `#1f7a5a` | 上传 / 下载速率与趋势线 |

> **升级红线**：任何新组件只能引用上表中的 `--bb-*`、`-solid` 或 semantic 变量，**禁止直接硬编码 `rgb(255,255,255)`、`#123456` 等脱离主题的固定色值**（Meridian/Apple 预设定义块除外）。

---

## 3. 表面层级与浮层对比度规范

为了同时兼容 **Meridian 半透明毛玻璃** 与 **Apple / Host 实色卡片**：

1. **实色与透底分离**：
   - 普通面板（`.panel`）、工具卡片（`.tool-card`）与顶栏（`.main-nav`）可使用 `--surface`（在 Meridian 下为 `0.74` 半透明 + `backdrop-filter`）。
   - **所有遮罩浮层、弹窗、抽屉、下拉框与激活滑块必须使用 `var(--surface-solid, var(--surface))` 或 `var(--bg-solid, var(--bg))`**，包含但不限于：
     - `.modal:has(.bb-modal-content)`
     - `.hub-drawer`、`.hub-modal-backdrop`、`.device-picker-popup`
     - `.segmented button.active`、`.bb-mode-btn.active`、`.hub-tabs button.active`
     - `.bb-style-card.active .bb-style-radio`（内环描边）
2. **危险按钮在暗黑模式下的优先级**：
   - `body[data-bb-scheme="dark"] .bb-app .btn:not(.primary):not(.danger)` 必须排除 `.danger`，且由 `body[data-bb-scheme] .bb-app .btn.danger` 统一声明 `color: var(--bb-danger); background: var(--surface-solid, var(--surface)); border-color: var(--danger-line, var(--bb-line))`。

---

## 4. 页面外壳、导航与模块结构标准

1. **统一页面入口 (`UI.page`)**：
   - 所有业务视图通过 `UI.page(id, title, actions, content)` 构建：
     - 顶部粘性导航 `.main-nav` 包含左侧 8 项主导航（`.bb-nav-links`）与右侧外观快捷胶囊（`.bb-nav-appearance`：一键轮切风格 + 切换浅色/深色）。
     - 页面右上角工具栏 `.heading-actions` 仅放置当前页面特有主操作（如日志刷新/导出），空数组时通过 `:empty{display:none}` 自动折叠，**不得在每个页面重复塞入“主题”按钮**。
   - 外观完整配置入口固定位于 **「设置 → 外观风格」**（复用 `UI.appearanceControls(false)`），并与顶栏胶囊及 `UI.themePicker()` 通过 `appearanceListeners` 实时同步。
2. **模块级样式拆分与缓存版本号**：
   - `ui.css`：基础排版、导航、卡片、表单、Zen 预设系统、代理页与工具箱侧栏基础网格。
   - 专属样式按域按需注入：`settings.css`、`subscriptions.css`、`scripts.css`、`connections.css`、`health.css`、`proxy-state.css`。
   - 修改任意 CSS 后，必须在对应 JS 加载处（`document.head.appendChild(E('link', ...))`）同步更新 `?v=YYYYMMDD-N`，防止路由器升级后浏览器命中旧缓存。
3. **响应式与触控规范**：
   - `> 767px`：完整导航 + 快捷外观胶囊；工具箱使用左侧 sticky 导航栏（`.bb-toolbox-split`，240px 侧栏 + 自适应工作区）；资源页包管理与核心面板并列 `.grid-two`。
   - `<= 767px`：工具箱切换为顶部横向滚动条，服务控制区与订阅区块操作区允许换行对齐。
   - `<= 599px`：主导航转为 4 列 2 行网格，隐藏顶栏外观胶囊（保留「设置」页完整入口），节点/操作按钮全宽伸缩。

---

## 5. 开发期常见反模式清单（禁止出现）

- ❌ 在 `view/bettbox/*.js` 中编写未前缀的全局样式或直接修改 `document.documentElement.dataset.theme`（`data-theme` 归属宿主主题如 `luci-theme-zen`，Bettbox 只维护 `body.dataset.bbStyle` 与 `body.dataset.bbScheme`）。
- ❌ 在多个页面重复添加全局外观按钮或全局控制入口。
- ❌ 在阻塞弹窗、选择器浮层或下拉列表使用半透明 `rgba` 背景导致底层文字穿透。
- ❌ 修改 CSS 文件却遗漏更新对应 JS 中的 `?v=...` 版本参数（尤其是同时被多处加载的 `subscriptions.css`）。
- ❌ 使用外部 CDN 字体、图标库或打包工具引入非原生运行时依赖。
