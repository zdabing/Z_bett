# Z_bett 系统架构与长期维护指南

> **基准基线**：`main` 分支稳定版本（提交 `595652e`），与 `luci-zen` 统一基于 OpenWrt `25.12.6` SDK（默认面向 `rockchip/armv8`、`x86/64`、`mediatek/filogic` 与 `armsr/armv8`；本地共享 SDK 合编脚本见 [scripts/build-openwrt-suite.sh](../scripts/build-openwrt-suite.sh)）。  
> **参考上游**：核心引擎 `MetaCubeX/mihomo`、功能上游 `appshubcc/Bettbox`、宿主视觉兼容目标 `luci-theme-zen`（雾岚）。

---

## 1. 总体分层架构

```text
+-------------------------------------------------------------------+
|  Browser (Desktop & Mobile LuCI)                                  |
|  - views/bettbox/*.js (overview, proxies, connections, profiles,  |
|    scripts, resources, toolbox, logs, settings)                   |
|  - bettbox/ui.js + ui.css (Zen Meridian / Apple / Host 外观基座)  |
|  - bettbox/core.js (直连 LAN 控制器 OR 回退 ubus api_proxy)        |
+-------------------------+-------------------------+---------------+
                          | HTTP REST (:9097)       | ubus / rpcd
                          v                         v
+---------------------------------+   +-----------------------------+
| Mihomo Core + Bettbox Extensions|   | rpcd ucode Gateway          |
| - upstream/{profile_merge,      |   | luci-app-bettbox/.../       |
|   route_trace,traffic_stats,    |   |   bettbox.uc + acl.d/*.json |
|   store}.go                     |   +--------------+--------------+
| - patches/100..120              |                  | exec / uci
+----------------+----------------+                  v
                 ^                   +------------------------------+
                 | YAML & CLI        | Router Control Plane         |
                 +-------------------+ bettbox/files/usr/bin/bettbox|
                                     | usr/libexec/bettbox/*.{sh,uc}|
                                     | usr/bin/bettbox-forge (Rust) |
                                     +---------------+--------------+
                                                     |
                                                     v
                                       OpenWrt (procd / nft / tun / dnsmasq)
```

---

## 2. 业务模块清单与依赖矩阵

### 2.1 核心包 `bettbox/`

| 子模块 | 关键文件 | 对外契约 / 接口 | 说明 |
|---|---|---|---|
| **包构建与补丁** | `bettbox/Makefile`、`bettbox/patches/100-closed-connection-history.patch`、`110-reclaim-idle-memory.patch`、`120-traffic-history.patch` | 产出 `/usr/bin/mihomo`、`/usr/bin/bettbox-forge`、`bettbox` 脚本及默认 UCI；`PROVIDES:=mihomo clash-meta bettbox-forge` | `PKG_FILE_DEPENDS` 明确声明依赖 `./forge/...` 与 `./upstream` |
| **上游 Go 移植层** | `bettbox/upstream/profile_merge.go`、`route.go.install`、`route_trace.go`、`store.go`、`traffic_stats.go` | 编译期拷贝为 Mihomo `bettbox/` 包与 `hub/route/bettbox.go`，暴露规则追踪与流量统计 REST | 与上游 `appshubcc/Bettbox` 对齐，保留原文件出处注释 |
| **QuickJS 脚本引擎** | `bettbox/forge/Cargo.toml`、`src/main.rs`、`src/script/{mod,convert,console}.rs` | `bettbox-forge run \| options \| version` | 执行兼容脚本 `main(config, customOptions)`，提取 `policyGroupOptions`，转换分享链接 |
| **UCI 与服务生命周期** | `files/etc/config/bettbox`、`files/etc/init.d/bettbox`、`bettbox-dns`、`files/lib/upgrade/keep.d/bettbox` | UCI schema：`core 'config'`、`backup`、`tun`、`dns`、`quic`、`sniffer`、`experimental` | `procd` 守护与 sysupgrade 配置保留 |
| **配置渲染与分流** | `apply.sh`、`render.uc`、`common.sh`、`router-settings.sh`、`device-access.uc`、`dns-forward.uc`、`dns-policy.uc` | `bettbox apply \| live \| apply-service \| status` | 将 UCI + 订阅 + 脚本 + 设备策略渲染为运行期 `config.yaml` 并校验 |
| **订阅、合并与托管分流** | `subscription.sh`、`subscription-input.uc`、`subscription-normalize.sh`、`subscription-parser.js`、`profile-merge.sh`、`managed-routing.{js,json,uc}`、`script-{store,update}.uc` | `bettbox subscriptions ...`、`profile-merge`、脚本来源管理 | 支持 2-8 份订阅合并、托管分流预设与规则校验失败回退 |
| **网络与透明代理** | `firewall.sh`、`dnsmasq.sh`、`watchdog.sh` | TUN/TPROXY/REDIR 与按源 MAC 白/黑名单分流、周期只读健康检查 | 启用设备控制时禁用核心 `auto_route`/`auto_redirect` 改由插件策略路由接管 |
| **工具箱与自更新** | `toolbox.sh`、`health-check.sh`、`health-policy.uc`、`health-report.uc`、`diagnostic.uc`、`network-check.sh`、`mrs_lookup.uc`、`core-update.uc`、`package-update.uc`、`release-download.uc`、`backup.sh`、`dashboard.sh`、`cron.sh` | `bettbox health \| dns \| ip \| ping \| speedtest \| media \| trace \| traffic-stats \| mrs \| nat \| age \| iperf \| core \| package \| dashboard \| backup` | 只读检测、分层健康诊断、GitHub 发布校验与带 Mixed 代理回退的 APK/核心更新 |

### 2.2 界面包 `luci-app-bettbox/`

| 子模块 | 关键文件 | 对外契约 / 接口 | 说明 |
|---|---|---|---|
| **菜单与权限** | `root/usr/share/luci/menu.d/luci-app-bettbox.json`、`root/usr/share/rpcd/acl.d/luci-app-bettbox.json` | 挂点 `admin/services/bettbox/*`；ACL 分 `luci-app-bettbox`（常规读写）与 `luci-app-bettbox-local-update`（本地 APK 上传） | `scripts` 路由保留无标题跳转页兼容旧书签 |
| **RPC ucode 网关** | `root/usr/share/rpcd/ucode/bettbox.uc` | ubus 对象 `bettbox`（共 33 个方法：`get_status`、`api_proxy`、`diagnostic_start/status`、`get_profiles`/`add_profile`/`import_profile`/`merge_profile`/`del_profile`、`get_scripts`/`save_script`/`script_options`/`script_check`/`script_update`、`managed_catalog`、`package_*`、`core_*`、`apply`、`service_action`、`geo_update`、`get_logs`、`backup_*` 等） | 受限超时与锁保护；拒绝通过 `api_proxy` 请求 `/traffic`、`/memory`、`/logs` 长连接流 |
| **基础通信与 UI 壳层** | `resources/bettbox/core.js`、`ui.js`、`ui.css` | `core.{init,get,put,patch,del,stream}`、`UI.{page,panel,button,tag,modal,themePicker,appearanceControls,job,operation,...}` | `core.js` 在 HTTPS 或 loopback-only 控制器下自动切换 `api_proxy` 与 `/connections` 轮询 |
| **可复用业务组件** | `subscription-controls.js`、`subscription-editor.js`、`subscriptions.js`、`script-manager.js`、`device-picker.js`、`resources/request.js` | 以 `baseclass` / 独立模块导出供父页面复用 | 避免业务逻辑全部堆砌在 `view/bettbox/*.js` |
| **8 个核心视图页** | `view/bettbox/{overview,proxies,connections,profiles,scripts,resources,toolbox,logs,settings}.js` | 对应 `PAGES` 导航的 8 大业务入口（`profiles` 页内聚合订阅与脚本） | 所有视图统一通过 `UI.page` 渲染外壳与导航 |
| **静态图标资产** | `resources/icons/bettbox.svg`、`resources/bettbox/flags/*.svg`、`resources/bettbox/qure/*.svg` | 由 `UI.artwork()` 与代理页按策略名/地区匹配加载 | 缺失时自动回退内置 SVG `icon()` |

---

## 3. 核心数据流与状态归属规范

1. **配置单一事实源**：
   - 所有持久业务配置（服务开关、透明代理模式、DNS、设备 MAC 名单、设备兜底策略、订阅元信息、备份配置）写入 `/etc/config/bettbox`（UCI）或 `/etc/bettbox/`。
   - **禁止**在前端 JS 内部维护与 UCI 脱节的业务默认状态副本；如概览页需要当前订阅和出口信息，必须通过 `get_status` / `callProfiles` 与核心 `/proxies` 实时对齐（参考 `overview.js` 的 `resolveProxyGroup()` 与 `direct` 模式处理）。
2. **核心通信与降级路径**：
   - 普通 GET 在 LAN HTTP 直连失败时（无 `httpStatus`），允许回退 `api_proxy` RPC；写操作（`PUT`/`PATCH`/`POST`/`DELETE`）在状态不明的网络异常后**禁止自动重放**，防止重复触发副作用。
   - `/traffic`、`/memory` 在直连模式使用 NDJSON `ReadableStream`；在中转模式下统一降级为 1 秒粒度的 `/connections` 快照差分。
3. **长耗时作业模型**：
   - 服务启停/应用、核心与 APK 更新、诊断工具、脚本拉取均通过 `bettbox.uc` 创建后台作业并由前端 `UI.job()` / `UI.operation()` 轮询 `diagnostic_status`（`package-update` 断连重连窗口最长可达约 40 分钟，保留 `reconnect: true` 语义）。

---

## 4. 上游同步与升级操作手册

当上游发布新版本时，按以下三个独立轨道升级，互不耦合：

### 4.1 轨道 A：升级随包核心（`appshubcc/Bettbox` `core/Clash.Meta`）
1. 修改 [bettbox/Makefile](../bettbox/Makefile) 的 `BETTBOX_UPSTREAM_VERSION` 与 `PKG_HASH`（并按需更新内嵌 Mihomo 对应的 `PKG_VERSION` 与 [bettbox UCI 默认配置](../bettbox/files/etc/config/bettbox) 中的 `global_ua`；注意保持 `PKG_VERSION` 单调不降级以免触发 APK 更新器降级拦截）。
2. 在 OpenWrt SDK 或从源码归档提取 `core/Clash.Meta` 后的目录中，逐个验证 `bettbox/patches/100-*.patch`、`110-*.patch`、`120-*.patch` 能否无冲突按顺序应用。
3. 核对 [route.go.install](../bettbox/upstream/route.go.install) 中 `hub/route` 接口签名是否被上游重构；确保 Mihomo `constant.Version` 与自定义路由 `/bettbox/...` 正常暴露，且精简标签 `GO_PKG_TAGS` 持续编译通过。
4. 回归检查 `120-traffic-history.patch` 与 `bettbox/upstream/*.go` 的联动：流量记录与路由追踪必须保持兼容 `/connections` 原生格式。

### 4.2 轨道 B：同步 `appshubcc/Bettbox` 功能
1. **Go 内嵌算法**（`bettbox/upstream/*.go`）：对比上游 `core/profile_merge.go`、`core/toolbox/{store,route_trace,traffic_stats}.go`，更新文件后必须在文件首部注释保留上游版本与短 Commit SHA，并在 `CHANGELOG.md` 标明变更范围。
2. **托管分流与脚本引擎**：
   - 托管分流规则变更只更新 `managed-routing.{js,json,uc}`，通过 `render.uc` 调用。
   - QuickJS 引擎变更集中在 `bettbox/forge/src/`；若修改 Cargo 依赖，需跑通 `cargo check --locked`。
3. **RPC 与前端联动**：若上游新增 API 参数，优先在 `ucode` 层或 `subscription-controls.js` / `script-manager.js` 等共享业务模块扩展，不要在 8 个 `view/*.js` 之间复制粘贴相似表单或请求逻辑。

### 4.3 轨道 C：跟随 `luci-theme-zen`（雾岚）及 Zen 规范演进
1. **依赖边界保持只读**：`luci-app-bettbox` 永远只消费标准 LuCI 宿主 CSS 变量（由 `luci-theme-zen` 在 `:root` 与 `:root[data-theme="dark"]` 声明），**绝不**直接引用 `zen-dash-*`、`zen-pref-*` 类名或调用 `window.ZenAppearance` 私有方法。
2. **变量对照检查**：当 `luci-theme-zen` 更新 `theme.css` 时，只需检查其顶层语义变量（`--bg-base`、`--bg-panel`、`--bg-input`、`--text`、`--text-secondary`、`--text-muted`、`--line`、`--accent`、`--accent-soft`、`--warn`、`--danger`、`--ul`、`--dl`）是否改名；若有新增语义色，只需更新 [ui.css](../luci-app-bettbox/htdocs/luci-static/resources/bettbox/ui.css) 顶层 `.bb-app` 回退表与弹窗回退块。
3. **菜单与路由互不侵占**：`luci-theme-zen` 占用 `admin/zen` 首页与 `admin/status/zen-traffic/*`；`luci-app-bettbox` 占用 `admin/services/bettbox/*`。两边新增导航入口时保持路由命名空间隔离。

---

## 5. 新增业务模块的准入清单

每当在 `Z_bett` 中新增一项独立业务能力（新页面、新诊断工具或新管理面板）：

1. **后端先定 Schema 与 CLI**：先明确 UCI 字段 / `bettbox` CLI 子命令 / 独立 `.uc` 或 `.sh` 脚本职责，再写入 `bettbox.uc` 与 `acl.d`。
2. **共享逻辑进 `bettbox/*.js`**：视图文件 `view/bettbox/*.js` 只做页面组装与事件绑定；超过 150 行的独立交互子域（如编辑器、选择器、批量控制器）拆入 `resources/bettbox/*.js`。
3. **样式模块化与版本同步**：页面专属样式放对应 CSS（如 `connections.css`、`settings.css`），公共设计 Token 与组件样式只放 `ui.css`；更新后递增 `?v=YYYYMMDD-N`。
4. **双预设 × 双明暗 × 宿主模式验收**：任何 UI 改动都必须在 `meridian`、`apple`、`host` 三种风格 × `light`、`dark` 两种配色以及桌面/移动端下保持可读性与可点击区域完整。
