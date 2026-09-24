/**
 * dsh-mc-bridge · 工具注册（mod 的能力 → dsh 工具表，供 AI 调用）
 *
 * API 形状取证（来源：官方包 `@deepseek-ai/dsh-session-health/lib/index.js`）：
 *   import { defineTool } from '@deepseek-ai/dsh-tools';
 *   ctx.tools.register(defineTool({ name, description, parameters, execute: args => … }));
 *
 * 三道闸（冻结纪律，缺一不可）：
 *  ① **授权**：工具 tier 必须在 cfg.allowTiers 内，否则**明确报错**（不静默忽略）
 *  ② **限流**：每工具配额（`feature.rateLimit`），超限返回可读错误 + retryAfterMs
 *  ③ **审计**：每次调用记录 tool/args/结果（由 audit 回调落盘）
 * 另有：`readOnly` ⇒ 只注册只读类（本插件暂无只读工具，故不注册动作工具）
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { BridgeConfig } from './config.ts';
import type { ToolSpec, ToolsResponse } from './types.ts';

export type AuditFn = (entry: {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  error?: string;
}) => void;

export interface ToolDeps {
  cfg: BridgeConfig;
  /** 向 mod 发一次性 GET（`/tools`）；失败返回 null（降级为静态清单） */
  getTools: () => Promise<ToolsResponse | null>;
  /** 调一个 mod 工具（POST /act_player 或对应端点），返回 ack 载荷 */
  invoke: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; payload?: unknown }>;
  audit: AuditFn;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  now?: () => number;
}

/** 内置静态清单：mod 未连接时也让 AI 看见"有哪些能力"（描述与 mod 的 /tools 同源字段）。 */
export const FALLBACK_TOOLS: ToolSpec[] = [
  { name: 'look', tier: 1, desc: '转视角（度）', params: { yaw: { type: 'num', req: true }, pitch: { type: 'num', req: true } } },
  { name: 'move', tier: 1, desc: '朝某方向走 ticks 个 tick', params: { dir: { type: 'enum', req: true, values: ['forward', 'back', 'left', 'right'] }, ticks: { type: 'int', req: true, range: [1, 200] } } },
  { name: 'jump', tier: 1, desc: '跳跃', params: {} },
  { name: 'sneak', tier: 1, desc: '潜行开关', params: { on: { type: 'bool', req: true } } },
  { name: 'stop', tier: 1, desc: '立即停止移动', params: {} },
  { name: 'climbTo', tier: 1, desc: '向上挖/爬到指定 y（不含绕障）', params: { y: { type: 'num', req: true } } },
  { name: 'walkToward', tier: 1, desc: '朝 (x,z) 直线走，遇阻即停（不绕障）', params: { x: { type: 'num', req: true }, z: { type: 'num', req: true }, maxTicks: { type: 'int', req: false, default: 600 } } },
  { name: 'exec_ops', tier: 2, desc: '执行自定义动作序列（逃生舱）', params: { ops: { type: 'op[]', req: true }, until: { type: 'cond[]', req: false }, maxDurationMs: { type: 'int', req: false, default: 30000 } } },
];

/** 速率闸：返回 null=放行；否则返回需等待毫秒数。 */
export function rateLimitCheck(
  lastAt: number,
  nowMs: number,
  minIntervalMs: number,
): number | null {
  if (minIntervalMs <= 0) return null;
  const elapsed = nowMs - lastAt;
  return elapsed >= minIntervalMs ? null : minIntervalMs - elapsed;
}

/** 工具名 → 限流间隔（毫秒）。 */
export function intervalFor(cfg: BridgeConfig, tool: string): number {
  const rl = cfg.rateLimit;
  switch (tool) {
    case 'say':
      return rl.say;
    case 'anim':
      return rl.anim;
    case 'screenshot':
      return rl.screenshot;
    default:
      return rl.actTier1; // 其余动作类按 tier1 配额
  }
}

/** tier 是否被授权（`allowTiers` 白名单）。 */
export function tierAllowed(cfg: BridgeConfig, tier: 1 | 2): boolean {
  return cfg.allowTiers.includes(tier === 1 ? 'act.tier1' : 'act.tier2');
}

/**
 * 注册全部工具（由 `index.ts` 在 `ctx.effect` 内调用；返回 disposer 交给上层）。
 * 注册前会尝试从 mod 拉最新清单；拉不到则用 `FALLBACK_TOOLS` 并记 WARN（**不静默**）。
 */
export async function registerMcTools(ctx: any, deps: ToolDeps): Promise<() => void> {
  const { cfg, getTools, invoke, audit, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const lastCallAt = new Map<string, number>();
  const disposers: Array<() => void> = [];

  if (cfg.readOnly) {
    // 只读模式：不注册任何会驱动玩家的工具（当前无只读工具 ⇒ 全部不注册）
    log('info', 'readOnly=true ⇒ 不注册动作工具（AI 只能通过 /state 看，不能动）');
    return () => {};
  }

  let list: ToolSpec[];
  const remote = await getTools().catch(() => null);
  if (remote?.tools?.length) {
    list = remote.tools;
    log('info', `从 mod 拉到 ${list.length} 个工具（驱动能力，含 untilConds=${remote.untilConds?.join('/') ?? '—'}）`);
  } else {
    list = FALLBACK_TOOLS;
    log('warn', `未取到 mod 工具清单（未连接？）⇒ 降级为内置静态清单（${list.length} 个）`);
  }

  for (const spec of list) {
    const tool = defineTool({
      name: `mc_${spec.name}`,
      description:
        `[Minecraft] ${spec.desc}。` +
        `参数: ${Object.keys(spec.params).join(', ') || '无'}。` +
        `权限层: act.tier${spec.tier}。` +
        `执行发生在玩家的 Minecraft 客户端（走原版玩家路径，等价于玩家自己操作）；` +
        `可能被阻塞/超时/被玩家夺回，返回里会说明终止原因。`,
      parameters: spec.params as Record<string, unknown>,
      execute: async (args: Record<string, unknown>) => {
        const t0 = now();
        const done = (ok: boolean, result: unknown, error?: string) => {
          audit({ tool: spec.name, args, ok, ms: now() - t0, ...(error ? { error } : {}) });
          return result;
        };
        // ① 授权闸
        if (!tierAllowed(cfg, spec.tier)) {
          const msg = `未授权：需要 allowTiers 含 'act.tier${spec.tier}'（当前 [${cfg.allowTiers.join(',')}]）`;

          log('warn', `拒绝 ${spec.name}：${msg}`);
          return done(false, { ok: false, error: 'capability_not_granted', detail: msg }, 'capability_not_granted');
        }
        // ② 限流闸
        const key = spec.name;
        const wait = rateLimitCheck(lastCallAt.get(key) ?? 0, t0, intervalFor(cfg, key));
        if (wait !== null) {
          log('warn', `限流 ${spec.name}：需再等 ${wait}ms`);
          return done(false, { ok: false, error: 'rate_limited', retryAfterMs: wait }, 'rate_limited');
        }
        lastCallAt.set(key, t0);
        // ③ 执行
        try {
          const r = await invoke(spec.name, args);
          return done(r.ok, r, r.error);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log('error', `${spec.name} 执行异常: ${msg}`);
          return done(false, { ok: false, error: 'invoke_failed', detail: msg }, 'invoke_failed');
        }
      },
    });
    const d = ctx.tools.register(tool);
    if (typeof d === 'function') disposers.push(d);
  }
  log('info', `已注册 ${list.length} 个 mc_* 工具（readOnly=${cfg.readOnly} tiers=[${cfg.allowTiers.join(',')}]）`);
  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
  };
}
