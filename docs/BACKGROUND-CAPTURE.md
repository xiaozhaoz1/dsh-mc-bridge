# 后台/最小化截图与操作 · 取证（dsh-mc-bridge）

## 一、结论（用户质疑驱动的取证，2026-09-24）

**用户质疑**：「MC 最小化了但还在运行，挖矿机器人都能工作，肯定有办法」⇒ **判断正确，我原思路窄了**。

| # | 事实 | 出处 / 实测 |
|---|---|---|
| **E1** | **MC 最小化后确实继续运行** | [gamingpowerup](https://gamingpowerup.com/cross-platform/how-to-stop-minecraft-from-pausing/)（关 auto-pause 后「continue to run in the background even if you… minimize it」）+ **我实测 T2** |
| **E2** | ⭐ **WGC 能抓「被遮挡/最小化/DX/OpenGL」窗口** | [MS 官方 WGC 文档](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) · [WgcSharp](https://github.com/Giltanas/WgcSharp)（「including occluded, minimized, and DirectX/OpenGL game windows」+ DXGI 兜底） |
| **E3** | 原两条路为何失败 | `PrintWindow` 对 DirectX/WPF 无效（[SO](https://stackoverflow.com/questions/830359/capturing-a-window-that-is-hidden-or-minimized)）⇒ MC 全黑；`CopyFromScreen` 仅能抓屏幕上有像素处 |

## 二、本机实测（T2 / T5）

**T2（最小化时是否仍在跑）— ✅ 已测**
```
MC 进程 CPU 时间：129.0s → 129.9s（6s 墙钟内推进 0.9s ≈ 15% 占用）
窗口：最小化中，进程持续活跃
⇒ 最小化 ≠ 停止运行（与 E1 一致）
```

**T5（PowerShell 能否直调 WGC）— ✅ 类型层可行**
```
Windows.Graphics.Capture.GraphicsCaptureItem        可加载 ✅
Windows.Graphics.DirectX.Direct3D11.IDirect3DDevice 可加载 ✅
系统：Microsoft Windows 10 家庭中文版
```
⇒ **零 npm 依赖**（PowerShell + `Add-Type`）即可用 WGC。

## 三、WGC 落地的真实成本（如实）

要真正抓到帧，需在内嵌 C# 里做一串 COM interop（约 200–300 行）：
1. `IGraphicsCaptureItemInterop::CreateForWindow(hwnd)` 拿 item（**必须 C# interop**，PowerShell 直接调不了）
2. 建 D3D11 设备 → `IDirect3DDevice`
3. `Direct3D11CaptureFramePool::CreateFreeThreaded` → `CreateCaptureSession` → `StartCapture`
4. 取帧 → staging texture 拷回 CPU → 存 PNG

**风险**：D3D 设备/帧池生命周期易错；调试成本高（失败多为黑帧/空帧）。
**收益**：插件侧**无需 mod** 即可抓到**最小化/被遮挡**的 MC 画面 —— 对"挂后台"场景是决定性的。

## 四、⭐ 副作用（正合我们的要求）

WGC 官方文档原文：捕获时**系统会画黄色提示边框** ⇒ 天然满足 v7 的「**截图必须让玩家可见**」，且**系统级强制**，比自绘角标可靠。

## 五、分层策略（截图）

| 层 | 手段 | 抓最小化 | 依赖 | 结论 |
|---|---|---|---|---|
| **mod 侧** | `Screenshot.grab`（framebuffer） | ⏳ T3 待测 | 无 | ⭐ 首选 |
| 插件侧（现） | `CopyFromScreen` | ❌ | 无 | 仅前台可见时 |
| **插件侧（进阶）** | **WGC** | ✅ | **零 npm 依赖**（PowerShell+Add-Type，但 ~250 行 interop） | ⏳ **待你拍是否投入** |
| ❌ | `PrintWindow` | ❌ 全黑 | — | 永久排除 |

## 六、待办
- **T3**：mod 侧 `Screenshot.grab` 在最小化下的表现（等 S1a/A 阶段）
- **L0 修三态**：最小化/未找到分开报错 + `restoreWindow()`
- **WGC 实现**（若拍板）：`window.ts` 增 `captureViaWgc(hwnd)`，与现有 `captureWindow` 并存（前台用 CopyFromScreen，最小化/遮挡用 WGC）


---

## 七、⭐ 换个方法（用户 2026-09-24：WGC 风险太大，找找 AI 玩 MC 的参考）

### 联网取证：AI 玩 MC 项目**怎么"看"**

| 项目 | 感知方式 | 出处原文 |
|---|---|---|
| **AIRI（moeru-ai）** | **Mineflayer 连服务器** | 「uses Mineflayer to **connect AIRI to a Minecraft server** so the agent can receive **context**, perform in-game actions, and **report state**」 |
| **moeru-ai/airi 架构** | **事件驱动** | 「**perceives the game world through events**, generates JavaScript action plans via LLM calls, executes them in a sandboxed VM, manages long-running tasks through a **control action queue**」 |
| **Voyager** | Mineflayer bot + **事件上报**（服务端 mod 补事件） | 见前次取证 |
| [mc-agent](https://github.com/parthlovestech/mc-agent) · [mc-agents](https://github.com/jblemee/mc-agents) | **Mineflayer**（Node.js bot） | 「AI Minecraft bot built with Node.js and **Mineflayer**」 |
| [Jake Frenzel 的 agent](https://jakefrenzel.com/projects/minecraft-agent/) | 三服务分离 | 「one for **sensing**, one for **acting**, one for **reasoning**」= 感知/行动/推理 |

### 结论（**这就是"另一个方法"**）

**正经的 AI 玩 MC 项目都不截窗口图**：
- **Mineflayer 类**（Voyager / AIRI / mc-agent…）⇒ **走协议层**（bot 本身就是玩家）⇒ 不需要游戏窗口
- **mod 类**（Easy LLM / BeaCraft / elly-ai-agent…）⇒ **走进程内 API**（读游戏对象）⇒ 也不需要窗口

**两类都与"窗口是否前台/可见"无关。**

### ⇒ 对我们的裁定：**砍掉 WGC，走 mod 侧（我们已冻结的路线）**

| 能力 | 做法 | 窗口依赖 | 状态 |
|---|---|---|---|
| **看（状态）** | **mod 侧读游戏对象**（`/state`·`/perceive`） | **零依赖** | 📐 已设计（S1a/A1） |
| **看（画面）** | **mod 侧 `Screenshot.grab`**（游戏 framebuffer）；必要时**由 mod 强制渲染一帧**再抓 | **零依赖**（不经过窗口） | 📐 S1a；**T3 待实测** |
| **动** | **mod 侧改 Input / gameMode** | **零依赖** | 📐 已设计（A2） |
| ~~截图~~ | ~~WGC（最小化窗口捕获）~~ | — | ❌ **砍掉**：风险高（~250 行 interop、易黑帧）、**而 mod 侧有更简单且更稳的答案** |

**插件侧 L0 的定位随之收敛**：只服务"**人在电脑前、窗口可见**"的场景（前台校验 + `CopyFromScreen`），**不追求**最小化截图 —— 因为"挂后台"的场景**由 mod 侧覆盖**（那才是正路）。

**待实测 T3**（关键）：mod 侧 `Screenshot.grab` 在**窗口最小化**时能否抓到有效帧。
- 预期可行：它从**游戏 framebuffer**取，不经窗口
- 若最小化导致渲染停止 ⇒ mod 可**主动请求渲染一帧**后再抓（vanilla 渲染循环可调用）
- 若仍不行 ⇒ 才考虑回归 WGC（把它当**最后**的兜底，而非首选）

---

## 八、⚠️ 两处自我纠错（2026-09-24）

### 纠正 1：dev "崩溃"实为**我设的 timeout 杀掉了它**
- 现象：日志停在 `01:33:22`（加载动画处）不再增长；**`crash-reports/` 为空**；MC 进程按命令行匹配为 0
- 根因：**我启动 dev 时写了 `timeout 1200`（20 分钟）** ⇒ 01:33:20 启动，01:53:20 被 SIGTERM 终止
- **教训**：给需要长时观察的 dev 客户端设短 timeout 是自找麻烦；**要么不设，要么设足**
- **澄清**：无 `crash-report` ⇒ **游戏本身没崩**（真崩会留 report）

### 纠正 2：**T2 的"实测"无效，撤回**
- 我用 `Get-Process java,javaw | 按 CPU 排序取第一个` 测"MC 是否仍在跑" ⇒ **很可能测到了别的 java 进程**（如 gradle daemon）
- ⇒ 那份「CPU 129.0s→129.9s 证明最小化仍在跑」**证据不成立，撤回**
- **T2 的结论目前只有联网证据**（E1：关 auto-pause 后可在后台运行），**本机实测待重做**（且必须**按命令行认进程**，不能按 CPU 排序）
- **教训**：探针必须**唯一锁定目标进程**（按命令行的 `runClient|neoforge` 匹配），不许"按 CPU 猜"

---

## 九、⭐ 窗口识别：标题不可靠（用户 2026-09-24 指出）+ 实测判据

**用户指出**：**dev/整合包/启动器常自定义窗口标题** ⇒ 用标题（含/以 `Minecraft` 开头）识别**都不可靠**。

### 本机实测（拿正在跑的 dev 窗口取证）
```
进程 : java.exe pid=25188
命令行: -Dfml.modFolders=dshpet%%D:\…\dshpet-mc\neoforge\versions\1.21.1\build\classes\…   ← MC/Mod 特征
窗口类名: GLFW30          ← ⭐ 不依赖标题的强判据（MC 必用 GLFW；GLFW 3.x 的窗口类名）
窗口标题: Minecraft NeoForge* 1.21.1   （可变！）
```

### ⇒ 判据改为**多元化评分制**（标题只作加分，不作硬要求）

| 判据 | 分值 | 说明 |
|---|---|---|
| **窗口类名 == `GLFW30`**（或 `LWJGL`） | **+50** | **标题无关**；MC 必用 GLFW |
| **进程命令行含 MC 特征**（`net.minecraft.client.main.Main` · `-Dfml.modFolders` · `--fml.forgeVersion` · `fabric` · `-Dminecraft.`） | **+40** | **标题无关**；Forge/NeoForge/Fabric/官方启动皆可识别 |
| 进程名 == `java` / `javaw` | +10 | 辅助 |
| 标题匹配（可配，默认宽松：含 `minecraft`） | +20 | **仅加分**（整合包改名后仍能靠上面两条命中） |
| 窗口可见 + 尺寸 > 0 | 前置 | 过滤无效窗口 |

**判定**：取最高分且 **≥ 阈值（建议 60）**；**多个候选**时按分数排序，**记录判据明细**便于诊断。
**配置可覆盖**：`window.match`（`titlePattern?` / `className?` / `hwnd?`）—— 用户可显式指定，应对极特殊整合包。

**为什么"类名 + 命令行"足够**：**Java 进程 + GLFW 窗口 + MC 特征命令行** 三者组合基本唯一（其他 Java GLFW 应用极少见）。
**当前实现的缺陷（BUG-A）**：只用 `title.includes('minecraft')` ⇒ **误匹配浏览器**（Edge 标题含 "Minecraft"）⇒ 已定位，待修。
