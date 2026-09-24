# dsh-mc-bridge

**DSH ↔ Minecraft 接入插件**：把 [dshpet-mc](https://github.com/xiaozhaoz1/dshpet-mc)（MC 纯客户端桌宠 mod）的桥接进 DSH —— 让 AI 能**看** MC（结构化状态/事件/截图）并**动** MC（在玩家本地执行动作）。

- **形态**：**纯后端**（不声明 `dsh.client`、不暴露 `./client`）⇒ **零渲染**，无浏览器半侧
- **角色**：**转达层** —— 连桥 / 把状态整理给 AI / 把 AI 的工具调用翻成 HTTP 下发
- **不做什么**：不决策（AI 决策）、不存 API key（DSH 管）、不碰 MC 进程内存

```
AI（DSH 的模型）
  ↕ 工具调用（ctx.tools）
dsh-mc-bridge（本插件：转达层）
  ↕ SSE 订阅 + POST 下发
dshpet-mc（MC mod：感官 + 手脚，走原版玩家路径）
```

---

## 安装

```bash
# 官方安装方式（推荐）：从本仓目录装
dsh plugin add <本仓 tools/dsh-plugin 路径>

# 或在 profile 目录里
cd ~/.dsh/profiles/web
dsh plugin add /path/to/tools/dsh-plugin
```

> ⚠️ `package.json` 必须含 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` ——
> **缺了它插件会被当成普通依赖装上但不激活任何层**（官方文档口径，实测踩点）。

装完重载 DSH，日志里应出现 `[dsh-mc-bridge] 配置: endpoint=… enabled=false …`。

---

## 配置

**改配置的两种方式**（任选）：

**① 覆盖层**（推荐，不动包内文件）：编辑 `~/.dsh/profiles/web/cordis.patch.yml`，按 `id` 定位覆盖：

```yaml
- id: mc-bridge
  config:
    enabled: true
    endpoint: 'http://127.0.0.1:25580'
    token: ''          # 本机可空；云端必填
    readOnly: false
    allowTiers: ['act.tier1']
```

**② 直接改包内的 `cordis.patch.yml`**（会被升级覆盖，不推荐）。

### 字段参考

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:25580` | mod 桥地址。**本机**回环；**云端**填域名（建议走反代/HTTPS） |
| `token` | `''` | `Authorization: Bearer`。**非回环端点必须填**，否则**拒绝启用**（安全门） |
| `enabled` | `false` | 总开关（opt-in：装上不主动连） |
| `readOnly` | `true` | **默认只读**：不注册任何动作工具（AI 只能看） |
| `allowTiers` | `[]` | 授权哪些动作层：`act.tier1`（视角/移动/跳跃/climbTo/walkToward）· `act.tier2`（`exec_ops`、后续 mine/place/attack） |
| `reconnectMinMs` / `reconnectMaxMs` | 2000 / 30000 | 退避区间（2→4→8→16→30s 封顶） |
| `heartbeatTimeoutMs` | 45000 | **SSE 心跳超时**（SSE 无"请求超时"概念）；3 次丢包判死 |
| `rateLimit.say/anim/actTier1/screenshot` | 5000/2000/2000/30000 | 每工具最小间隔（ms）；超限返回 `rate_limited` + `retryAfterMs` |
| `window.enabled` | `false` | **L0 窗口层**（找 MC 窗口/截图/可选简单输入）—— **不依赖 mod** |
| `window.captureIntervalMs` | 5000 | 截取间隔 |
| `window.allowInputInjection` | `false` | 允许简单盲操作（按键/鼠标） |
| `window.requireForeground` | `true` | 抓图前校验前台窗口 == MC 窗口（**防抓到遮挡窗口**） |
| `audit.enabled` | `true` | 审计（默认开，不随 debug） |
| `audit.logToFile` | `false` | 是否额外落文件 |

**非法配置不会让插件失效**：按字段回落到默认并**告警说明原因**（"配置缺失"静默取默认，只有"存在但非法"才告警）。

---

## 命令

```
/mc-bridge status     # 状态 / 收发计数 / endpoint（token 打码）
/mc-bridge reload     # 重连
/mc-bridge window     # 找 MC 窗口（标题/尺寸/hwnd/是否前台）
/mc-bridge shot       # 截一张 MC 画面（需 window.enabled=true）
```

---

## 安全边界

| 机制 | 说明 |
|---|---|
| **安全门（硬）** | 非回环 endpoint + 无 token ⇒ **拒绝启用**（不静默放行） |
| **默认只读** | `readOnly=true` 时**一个动作工具都不注册** |
| **逐项授权** | 工具须在 `allowTiers` 内；未授权 ⇒ 明确返回 `capability_not_granted`（**不静默忽略**） |
| **限流** | 每工具配额；`screenshot` 最严（默认 1/30s） |
| **审计** | 每次调用留痕：`[DSH-MC/AUDIT] tool=… ok=… ms=…` |
| **敏感值** | token **绝不入日志**（只打前 4 位）；审计里 `token/secret/key/password` 一律 `***` |
| **停止而非死循环** | **401/403 与其他 4xx ⇒ 停止重连**（不无限重试）；仅网络/5xx 才退避重连 |
| **透明度** | 不隐藏痕迹、不做拟人化伪装（避免被安全软件/服务器当成恶意软件） |

**L0 窗口层纪律**：只用**区域截图**（`PrintWindow` 对 MC 这类 OpenGL/DirectComposition 窗口**返回全黑**，已取证）；抓图前**校验前台窗口句柄**，否则拒绝抓图。

---

## 当前状态（如实标注）

| 层 | 状态 | 说明 |
|---|---|---|
| **L0 窗口层** | ✅ 可用 | 找窗口 + 截图 + 命令查状态；**不依赖 mod** |
| **L1 桥客户端** | ✅ 代码完成（mock 自测通过） | ⏳ **等 mod 侧的 S1a 桥实现**才能真连（dshpet-mc 的 S1a 尚未开工） |
| **工具注册** | ✅ 代码完成 | mod 未连接时降级为内置静态清单（8 个工具） |

---

## 测试

```bash
# 全部单测（Node ≥22 原生跑 TS，无需安装依赖）
node --experimental-strip-types --test test/
```
覆盖：配置校验/回落/安全门 · 退避序列 · SSE 分帧 · **停止矩阵（401 停/5xx 重试）** · 授权矩阵 · 限流边界 · 审计脱敏。
联调测试会起 mock mod 桥（**只用 3082 端口**，`finally` 里强制 `close()`）。

---

## L0 窗口层：看画面 + 自动转前台

**不依赖 mod**，装上即可用（默认关：需 `window.enabled=true`）。

### 窗口识别（评分制，**不靠标题**）

dev 环境 / 整合包 / 启动器**都会自定义窗口标题** ⇒ 标题不可作硬判据。改用评分（`src/window.ts`）：

| 判据 | 分 | 说明 |
|---|---|---|
| **窗口类名 `GLFW*` / `LWJGL`** | **+50** | **标题无关**（MC 必用 GLFW） |
| **进程命令行含 MC 特征**（`net.minecraft.client.main.Main` · `-Dfml.modFolders` · `--fml.forgeVersion` · `fabric` · `-Dminecraft.`） | **+40** | **标题无关**（官方/Forge/NeoForge/Fabric 都认） |
| 进程名 `java` / `javaw` | +10 | 辅助 |
| 标题含 `minecraft` | +20 | **仅加分**（改名后仍能靠上面两条命中） |

取最高分且 **≥ 60** 才认；**保留判据明细**（命令/日志可查"为什么选它"）。实测：MC = **120**，浏览器（标题含 Minecraft 的网页）= 0。

### 自动转前台（`src/focus.ts`）

截图（`CopyFromScreen`）要求窗口**在前台可见**，所以需要把 MC 调到前台。**Windows 有前台锁**（后台进程不被允许抢焦点），实测解法：

```
① ShowWindow(SW_RESTORE)           若最小化先恢复
② keybd_event(VK_MENU) 按一下 ALT    ← ⭐ 关键：模拟一次真实输入以取得"前台权限"
③ SetForegroundWindow              实测 ok=true（单独用它或 AttachThreadInput 会被拒）
④ 兜底：SwitchToThisWindow → 最小化+恢复 → TOPMOST 弹一下
```

### ⚠️ 自动化操作期间请**不要**操作键盘鼠标

> 这两件事必须**串行**，不能同时：
> - 你的按键会与自动化输入**交错** ⇒ 结果不可预测（点错按钮、进错界面）
> - 反过来，自动化发给 MC 的按键也会**打断你正在做的事**
> - 需要自己接手时：**先让自动化停下**（停用 `window.enabled` 或 `/mc-bridge reload` 前先关），再操作
> - 本插件**只按需短暂抢前台**（截图/取状态后即结束），**不会长期占用**你的输入

### 命令

```
/mc-bridge status    # 状态 / 收发计数 / endpoint（token 打码）
/mc-bridge reload    # 重连
/mc-bridge window    # 找 MC 窗口（标题/尺寸/hwnd/是否前台 + 判据明细）
/mc-bridge shot      # 截一张（需 window.enabled=true）
```

### 开发脚本（自主看界面 / 驱动 UI）

```bash
# 找窗口 → 自动转前台 → 截图（**必须给目的**，见下方截图策略）
node --experimental-strip-types scripts/l0-e2e.mjs "检查宠物是否渲染在右下角"

# 窗口内坐标点击（坐标为相对窗口的像素，与截图 1:1）
node --experimental-strip-types scripts/click.mjs 435 233 "点击单人游戏"
```

**已知限制（均为实测）**：
- **鼠标合成点击进不到 MC**（`mouse_event` 被忽略）⇒ **UI 自动化以键盘为主**（`Tab` 聚焦 + `Enter` 激活）
- **必须先看控件状态**：disabled 按钮吃掉的按键**无任何反馈**，会把"什么都没发生"误当成"做成了" ⇒ 每次动作后**看图确认目标控件**（灰/亮、界面是否变化）
- 校验与操作要**原子**（同一进程/同一调用内完成），否则中间会被抢焦点（TOCTOU）

---

## 截图策略（需求验证 + 限流）

`src/capture-policy.ts` —— 防"跑飞式刷图"（烧 token + `CopyFromScreen` 抓游戏窗口造成卡顿），**不是**限制正常调试：

| 机制 | 默认 | 说明 |
|---|---|---|
| **需求验证** | purpose 必填（≥4 字） | 逼"为什么要看"；**无目的直接拒** |
| 最小间隔 | **1s** | 防连环截图（真正的卡顿来源） |
| 同目的去重 | **10s** | 防"同一个检查反复截"（刷图主要形态） |
| 软警告 | **120/小时** | **只提示，不停机** |
| 硬保护 | **600/小时 · 5000/会话** | 只拦真正的跑飞 |

> 口径：修 UI bug 时一小时截几十上百张是**正常需求** ⇒ 额度按"够干活"定，不按"防干活"定。
> 回归用例锁住：**一小时 200 次必须全部放行，只出 warning**。

---

## 开发与测试

```bash
# 单测（Node ≥22 原生跑 TS，无需安装依赖）
node --experimental-strip-types --test test/     # 58 用例

# 联调测试会起 mock mod 桥 —— **只用 3082 端口**，并在 finally 里强制 close()
```

**边界**：L0 的 PowerShell 调用仅供开发期"看 + 驱动 UI"；**AI 工具集走 mod 侧进程内**（不依赖窗口前台、不用 OS 输入注入 —— 见 `docs/BACKGROUND-CAPTURE.md` 的取证）。

> ⚠️ **进度标注**：`ui` 工具组（`mc_ui_screen` / `mc_ui_click` / `mc_enter_world`，走 mod 侧 `widget.isActive()` + `onPress()`，**不靠看图判灰**）**规划中 · S1a 阶段实现**。
> 当前 L0 的开发期自动化（截图 + 键盘导航）**只用于"看"和调试**，不作为 AI 的正式工具。

### 当前实现进度（诚实标注）

| 能力 | 状态 |
|---|---|
| L0 窗口识别 + 自动转前台 + 截图 | ✅ **已实现**（含 58 单测 + 端到端实测） |
| 截图策略（需求验证 + 限流） | ✅ 已实现 |
| L1 桥客户端（SSE + POST + 退避 + 心跳） | ✅ **代码完成**，mock 联调通过；⏳ **等 mod 侧 S1a** 才能真连 |
| 工具注册（`mc_*` + 三道闸） | ✅ 代码完成；mod 未连接时降级为内置静态清单 |
| **`ui` 工具组**（AI 操作界面/进世界） | ⏳ **规划中 · S1a** |
| 玩家动作工具（`move`/`mine`/`climbTo`…） | ⏳ **规划中 · S1a/A**（依赖 mod 侧进程内实现） |

## 许可证

MIT（本插件）。它连接的 MC 侧 mod 见 [dshpet-mc](https://github.com/xiaozhaoz1/dshpet-mc)（其**调试动画素材**来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，遵循上游条款：允许开源使用、禁止商用）。
