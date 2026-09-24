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

## 许可证

MIT（本插件）。它连接的 MC 侧 mod 见 [dshpet-mc](https://github.com/xiaozhaoz1/dshpet-mc)（其**调试动画素材**来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，遵循上游条款：允许开源使用、禁止商用）。
