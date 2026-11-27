# Z_bett 前端设计声明

> 本项目前端界面（`luci-app-bettbox`，OpenWrt 25.12 原生 ES5 LuCI View + Scoped CSS）全面对齐 **Z Design System v2.0.0**（通用视觉语言 `spec/00-foundations.md` 与 OpenWrt LuCI 专项规范 `spec/01-web-luci.md`）。完整色板、Token 与跨端细则以全局 `z-design-system` 为单一真相源，本文档仅声明本项目独有的页面信息架构、外观挂载与样式边界。

---

## 1. 外观与宿主兼容契约

- **风格体系**：内置 `Meridian 默认`（`meridian`，默认）、`Apple 卡片`（`apple`）与 `跟随宿主主题`（`host`），持久化于 `localStorage['bettbox.appearance.v1']`，通过 `body[data-bb-style]`、`body[data-bb-scheme]`、`body[data-bb-accent]` 挂载。
- **五色主题与明暗模式**：支持 `blue`（极光蓝，默认）、`teal`、`indigo`、`ink`、`amber` 与 `system` / `light` / `dark`，仅作用于 `meridian` 与 `apple`，`host` 模式严格透传宿主变量（如 `luci-theme-zen`），不覆写宿主配色。
- **作用域隔离**：所有样式限定在 `.bb-app`、`body.bb-page`、`.modal:has(.bb-modal-content)` 及顶层下拉菜单 `.bb-select-menu` 内，宿主零硬依赖。

---

## 2. 页面信息架构（7 项主导航）

所有页面通过 `UI.page()` 渲染统一粘性导航栏（左侧 7 项主入口 + 右侧轻量风格/明暗切换胶囊；`<= 599px` 折叠为 4 列 2 行网格并隐藏胶囊）：

| 页面路由 (`admin/services/bettbox/*`) | 职责与核心视觉结构 |
|---|---|
| `overview`（概览） | 服务状态与运行模式分段卡 + 4 张独立纯白 KPI 微卡片（`4 → 2` 列，含实时折线趋势）+ 流量环图 / 网络双出口独立微卡 / 内网信息 3 栏区 + 3×2 连通性测试微卡片 |
| `proxies`（代理） | 搜索栏 + 统一下拉排序/视图控件 + 双列可折叠策略组卡片与实色节点微卡片网格（`4/3/2` 列），支持节点分享弹框与二维码 |
| `connections`（连接） | 实时/历史分段切换 + 筛选栏 + 宽屏表格 / 移动端卡片列表 + 规则快捷添加卡片化弹框 |
| `profiles`（订阅与脚本） | 订阅、合并配置、覆写脚本与节点库聚合视图；独立微卡片信息条、右侧固定动作抽屉（`.hub-drawer`）与分组折叠编辑器（`scripts` 保留书签跳转） |
| `toolbox`（工具箱） | 4 项核心诊断标签（网络健康、DNS、路由追踪、流量统计），内部 KPI、分层状态与规则链均采用纯白独立微卡片 |
| `logs`（日志） | 筛选工具栏 + 统一日志行（`3px` 左侧状态条 + 轻度底色 + 固定 `68px` 描边级别胶囊） |
| `settings`（设置） | 4 标签页（`常规`、`网络与代理`、`设备控制`、`资源与维护`；`resources` 保留书签跳转）；常规内含完整外观设置面板（精简单选风格卡 + 3 段式滑块分段器 + 5 色圆点胶囊）、4 列响应式设置微卡片网格、同行流式设备 MAC/IP 选择器与独立兜底策略微卡片行 |

---

## 3. 统一组件基座

- **统一下拉选择器（`UI.enhanceSelect`）**：对 `.bb-app` 及模态框内原生 `<select>` 自动渐进增强，保留原生值与 `change` 事件以兼容 UCI 提交；弹出菜单挂载于 `dialog[open]` 或 `document.body` 顶层浮层，支持自动翻转、键盘导航与 `Escape` 隔离。
- **弹框与提示条（`UI.modal` / `.alert-message`）**：外框零裁边内边距，划分固定标题栏、滚动正文区与底栏操作区；所有浮层、抽屉、弹窗与下拉菜单均采用实色 `--surface-solid`。
- **样式资源拆分与缓存版本**：基础样式在 `ui.css`，页面专属样式按需拆分至 `settings.css`、`subscriptions.css`、`scripts.css`、`connections.css`、`health.css`、`proxy-state.css`，每次改动同步递增引用处 `?v=YYYYMMDD-N`。
