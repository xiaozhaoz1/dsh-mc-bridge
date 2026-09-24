/**
 * dsh-mc-bridge · 插件入口（Cordis）
 *
 * 形态：**纯后端**（不声明 `dsh.client`、不暴露 `./client`）⇒ 无浏览器半侧、零渲染。
 * 职责（转达层）：连 dshpet-mc 的 mod 桥 → 把状态/事件给上层 → 把上层动作翻成 HTTP 下发。
 * 纪律：插件抛异常不得带崩 DSH ⇒ `apply` 内全面 try/catch，失败降级 + 日志。
 */
import { BridgeClient, type BridgeState } from './bridge.ts';
import { canEnable, maskToken, validateConfig, type BridgeConfig } from './config.ts';
import { findMinecraftWindow, captureWindow } from './window.ts';

export const name = 'mc-bridge';
/** 依赖注入声明：只声明我们真正要用的服务（缺失时 Cordis 会等/报错，而不是运行时 undefined）。 */
export const inject: string[] = ['commands'];

/** 运行时状态（供后续工具调用与状态查询；不外泄 token）。 */
const runtime = {
  state: 'idle' as BridgeState,
  lastError: '',
  sent: 0,
  recv: 0,
  startedAt: 0,
  client: null as BridgeClient | null,
};

function log(ctx: any, level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `[dsh-mc-bridge] ${msg}`;
  // 部分宿主下 ctx.logger 不映射到终端 ⇒ 关键信息同时走 console（上游踩过的坑）
  try {
    ctx?.logger?.[level]?.(line);
  } catch {
    /* ignore */
  }
  if (level !== 'info') console[level === 'warn' ? 'warn' : 'error'](line);
}

function infoOf(): {
  instanceId: string;
  playerName: string;
  mod: string;
  modVersion: string;
  mc: string;
  loader: string;
  platform: string;
} {
  // instanceId 由本插件侧生成：dsh 视角的“这个 host 进程”标识（与 mod 侧各自生成、互不混用）
  return {
    instanceId: `host-${process.pid}-${Date.now()}`,
    playerName: '',
    mod: 'dsh-mc-bridge',
    modVersion: '0.1.0',
    mc: '',
    loader: '',
    platform: process.platform,
  };
}

/**
 * 插件主体。`apply(ctx, config)` 的 config 来自 cordis.patch.yml 的 `config:` 段（用户可覆盖）。
 */
export function apply(ctx: any, rawConfig: unknown): void {
  let cfg: BridgeConfig;
  try {
    const v = validateConfig(rawConfig);
    cfg = v.config;
    for (const p of v.problems) log(ctx, 'warn', `配置回落: ${p}`);
    if (!canEnable(v) && cfg.enabled) {
      log(ctx, 'error', '已启用但安全门未通过（见上面的 ⛔ 项）⇒ 不连接');
    }
    log(ctx, 'info', `配置: endpoint=${cfg.endpoint} token=${maskToken(cfg.token)} enabled=${cfg.enabled} readOnly=${cfg.readOnly} tiers=[${cfg.allowTiers.join(',')}]`);
  } catch (e) {
    log(ctx, 'error', `配置校验异常，插件降级为禁用: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // ── 桥客户端（L1）───────────────────────────────────────────────────────
  const client = new BridgeClient(cfg, infoOf(), {
    onState: (s, detail) => {
      runtime.state = s;
      log(ctx, 'info', `桥状态: ${s}${detail ? ' · ' + detail : ''}`);
    },
    onEvent: (evName, data) => {
      runtime.recv += 1;
      // 事件流交给上层（dsh 的 agent/命令层）；此处仅记日志，避免刷屏
      if (evName === 'ping' || evName === 'resync') return;
      log(ctx, 'info', `↓ ${evName} ${JSON.stringify(data).slice(0, 200)}`);
    },
    onAck: () => {
      runtime.sent += 1;
    },
    onLog: (level, msg) => log(ctx, level, msg),
  });
  runtime.client = client;
  runtime.startedAt = Date.now();

  ctx.effect(() => {
    // 注册时启动；返回 disposer ⇒ 插件卸载时停止（不留残留连接）
    if (canEnable(validateConfig(rawConfig))) {
      runtime.state = 'connecting';
      void client.start().catch((e: unknown) => {
        runtime.lastError = e instanceof Error ? e.message : String(e);
        log(ctx, 'error', `桥启动失败: ${runtime.lastError}`);
      });
    } else {
      log(ctx, 'info', '未启用（enabled=false 或安全门未过）⇒ 不连接；改配置后重载插件即可');
    }
    return () => {
      client.stop();
      log(ctx, 'info', '已停止（插件卸载）');
    };
  });

  // ── 命令（便于在 dsh 里查看状态/手动重连/截图）───────────────────────────
  try {
    if (typeof ctx.commands?.register === 'function') {
      ctx.effect(() =>
        ctx.commands.register('mc-bridge', {
          description: 'dsh-mc 接入插件：查看状态 / 重连 / 截图',
          run: async (args: string[]) => {
            const sub = (args?.[0] ?? 'status').toLowerCase();
            if (sub === 'status') {
              const uptime = runtime.startedAt ? Math.round((Date.now() - runtime.startedAt) / 1000) : 0;
              return `mc-bridge: state=${runtime.state} uptime=${uptime}s recv=${runtime.recv} sent=${runtime.sent}`
                + ` endpoint=${cfg.endpoint} token=${maskToken(cfg.token)}`
                + (runtime.lastError ? ` lastError=${runtime.lastError}` : '');
            }
            if (sub === 'reload') {
              client.stop();
              void client.start();
              return 'mc-bridge: 已请求重连';
            }
            if (sub === 'window') {
              const w = await findMinecraftWindow();
              return w
                ? `mc-bridge 窗口: ${w.title} ${w.width}x${w.height} hwnd=${w.hwnd} foreground=${w.foreground}`
                : 'mc-bridge 窗口: 未找到 Minecraft 窗口';
            }
            if (sub === 'shot') {
              if (!cfg.window.enabled) return 'mc-bridge: window.enabled=false ⇒ 截图功能未启用';
              const w = await findMinecraftWindow();
              if (!w) return 'mc-bridge 截图: 未找到 Minecraft 窗口';
              const r = await captureWindow(w, cfg.window.requireForeground);
              return r.ok
                ? `mc-bridge 截图: ${r.path} (${r.width}x${r.height}, ${r.bytes}B)`
                : `mc-bridge 截图失败: ${r.error}`;
            }
            return '用法: /mc-bridge status | reload | window | shot';
          },
        }),
      );
      log(ctx, 'info', '已注册命令 /mc-bridge（status|reload|window|shot）');
    }
  } catch (e) {
    log(ctx, 'warn', `命令注册失败（不影响桥）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 供测试/自省：当前运行时状态（**不含 token**）。 */
export function status(): Record<string, unknown> {
  return {
    state: runtime.state,
    recv: runtime.recv,
    sent: runtime.sent,
    uptimeSec: runtime.startedAt ? Math.round((Date.now() - runtime.startedAt) / 1000) : 0,
    lastError: runtime.lastError,
  };
}
