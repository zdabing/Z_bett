# Bettbox 上游设置与路由器适用范围

核对日期：2026-10-25。已 fetch 上游，`origin/main` 为 [`1fb8806fdf8275a3694cda31eec7ed2062330aee`](https://github.com/appshubcc/Bettbox/tree/1fb8806fdf8275a3694cda31eec7ed2062330aee)。本次只修改 OpenWrt 移植，`bettbox-src` 参考仓库保持不变。

判定依据是功能实际运行在哪一端，以及 OpenWrt 是否已有对应系统服务。设置出现在手机/电脑客户端中，并不代表它只适用于手机/电脑。

## 已清理的遗留配置

| 上游设置/行为 | 路由器处理 | 原因 |
|---|---|---|
| 本机进程识别 `find-process-mode` | 删除 `config.find_process_mode` UCI 项，渲染时固定 `off` | 无法从路由器识别 LAN 设备上的进程、应用包名；避免订阅或旧配置开启无效的本机查找 |
| Windows 网络状态检测 `dns.msftncsi.com` hosts 自动注入 | 删除自动注入；保留用户/订阅明确提供的 hosts | 路由器不负责给全部客户端强制套用桌面网络检测修复 |
| Mihomo NTP 启用、服务器、端口、间隔、写系统时间 | 删除 LuCI 设置组、默认 UCI 段和渲染逻辑；不继承订阅的 `ntp` 段 | NTP 并非终端独占功能，但 OpenWrt 已有系统时间服务，避免重复校时或争用系统时钟 |

上游依据：[`lib/state.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/state.dart) 的配置组装、[`lib/views/config/general.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/config/general.dart) 的本机进程选项、[`lib/views/config/ntp.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/config/ntp.dart) 的校时及写系统时间选项。

## 仅供终端的功能：本移植原本未包含

| 功能 | OpenWrt 处理 |
|---|---|
| 桌面开机启动、静默启动、启动后隐藏、Dock 图标、标题栏 | 无客户端进程和窗口；服务开机启动由 procd 管理，仍保留 |
| 托盘图标、点击行为、托盘网速 | 无桌面托盘，不提供 |
| 全局热键、侧栏/导航栏操作、触觉反馈、桌面小组件 | 无对应终端运行环境，不提供；LuCI 页面仍有正常导航和状态显示 |
| Android VPN 授权、按应用允许/排除、应用图标和包名列表 | 无法获取其他 LAN 设备的 Android 应用信息，不提供 |
| 电池优化豁免、休眠暂停、智能自动停止、高优先级常驻通知 | 路由服务需持续为 LAN 提供网络，不提供这些手机后台生命周期开关 |
| 修改 Windows 注册表的联网检测/商店修复、修改主机系统代理和绕过域名 | 不操作 LAN 设备的系统设置；路由器通过透明代理或显式代理端口服务客户端 |
| 手机/桌面 App 自更新、二维码扫描、终端界面外观/动画 | 使用 OpenWrt 包管理和 LuCI；不移植上游终端安装器或系统权限逻辑 |

依据：上游 [`application_setting.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/application_setting.dart)、[`other_setting.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/other_setting.dart)、[`access.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/access.dart)、[`hotkey.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/hotkey.dart)、[`theme.dart`](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/views/theme.dart)。

## 路由器仍然需要的功能

| 保留项 | 用途 |
|---|---|
| 服务启停、开机自启、看门狗 | 路由器后台服务生命周期，与桌面 App 自启动/休眠暂停不同 |
| TUN 栈、自动路由/重定向、严格路由、MTU、LAN 路由排除 | 接管 LAN 流量并控制实际转发路径 |
| Mixed/HTTP/SOCKS/TPROXY/REDIR 端口、LAN 监听、认证 | 提供透明代理和 LAN 显式代理入口 |
| DNS、fake-ip/redir-host、节点域名解析、嗅探、QUIC 策略、IPv6 | LAN 分流和代理协议需要的核心网络功能 |
| TCP 并发、统一测延迟、保活、TUN 拥塞控制、QUIC GSO/ECN | 内核网络行为，并非桌面/手机专用选项，本次保留 |
| 控制 API、密钥、zashboard、测延迟 URL | LuCI 和 LAN 用户管理代理核心所需 |
| 订阅自动更新、脚本/规则覆写、策略组、Geo 资源 | 路由代理的配置和分流能力 |
| Age、WebDAV 备份、日志、工具箱 | 路由器配置备份、订阅解密和网络诊断 |

用户自定义的 hosts、代理节点、分流规则和 WebDAV 信息保留。本次不删除订阅中的 PROCESS/UID 规则：它们是用户配置，不把“进程识别不可用”转换成静默重写用户规则。

### TUN 栈选项补齐

2026-10-25 复核发现移植页面漏掉 `mips`，默认 UCI 和渲染回退还沿用了 `mixed`。上游 `TunStack` 为 `gvisor/system/mixed/mips`，`Tun` 默认 `TunStack.mips`；本项目采用的 Mihomo v1.19.33 也包含 `TunMips`。现已补齐四项，并将新配置、缺省渲染和页面无配置时的选择统一为 `mips`，明确保存的其他栈继续保留。这是网络功能移植遗漏，属于路由器需要保留的选项。

依据：[Bettbox Tun 默认值](https://github.com/appshubcc/Bettbox/blob/1fb8806fdf8275a3694cda31eec7ed2062330aee/lib/models/clash_config.dart#L289)、[Mihomo v1.19.33 栈枚举](https://github.com/MetaCubeX/mihomo/blob/v1.19.33/constant/tun.go)。

实机 `mihomo -t` 对四种栈的最小 TUN 配置均通过。页面和渲染回退已更新；当时服务已开启，保存的 mixed 及运行进程 PID 24394 保持不变，由管理员选择 mips 并保存应用后切换。安装包默认 UCI 已修改，现有设备配置文件没有被整份覆盖。渲染回归验证缺省 mips 和四种明确配置值；修复前文件保存在 `/root/router-diagnostic-20261025/tun-stack-before/`。

## 升级与验证

- 包安装脚本调用 `router-settings.sh`，只删除旧 `bettbox.config.find_process_mode` 和 `bettbox.ntp`，没有旧项时不提交 UCI；保留服务启停状态、订阅及系统 NTP 配置。
- 渲染器在升级迁移前后均禁止启用进程识别和内核 NTP，避免旧 UCI 或订阅再次带回这些选项。
- `test/router-settings-test.py` 实跑迁移脚本，验证删除范围、幂等和不改动无关设置。
- `test/render-test.js` 验证默认不注入 Windows hosts、旧设置无法重新开启被清理功能，以及显式 hosts、DNS、TUN、代理规则仍可正常生成。
