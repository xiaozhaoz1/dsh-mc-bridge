/**
 * dsh-mc-bridge · 闸门纯逻辑（**零依赖**，可单测）
 *
 * 为什么单独一个文件：`tools.ts` 顶部 import 了 dsh 官方 SDK（`@deepseek-ai/dsh-tools`），
 * 而该包是 peer 依赖、本地未安装 ⇒ **测试无法 import `tools.ts`**。
 * 把纯逻辑抽到这里后，授权/限流/tier 映射都能在无 SDK 环境下单测。
 * （同 LMA 的「纯逻辑不得放进会被外部类加载拖下水的类」教训。）
 */
import type { BridgeConfig } from './config.ts';
import type { ToolSpec } from './types.ts';

/** 内置静态清单：mod 未连接时也让 AI 看见"有哪些能力"（字段与 mod 的 `/tools` 同源）。 */
export const FALLBACK_TOOLS: ToolSpec[] = [
  { name: 'look', tier: 1, desc: '转视角（度）', params: { yaw: { type: 'num', req: true }, pitch: { type: 'num', req: true } } },
  {
    name: 'move',
    tier: 1,
    desc: '朝某方向走 ticks 个 tick',
    params: {
      dir: { type: 'enum', req: true, values: ['forward', 'back', 'left', 'right'] },
      ticks: { type: 'int', req: true, range: [1, 200] },
    },
  },
  { name: 'jump', tier: 1, desc: '跳跃', params: {} },
  { name: 'sneak', tier: 1, desc: '潜行开关', params: { on: { type: 'bool', req: true } } },
  { name: 'stop', tier: 1, desc: '立即停止移动', params: {} },
  { name: 'climbTo', tier: 1, desc: '向上挖/爬到指定 y（不含绕障）', params: { y: { type: 'num', req: true } } },
  {
    name: 'walkToward',
    tier: 1,
    desc: '朝 (x,z) 直线走，遇阻即停（不绕障）',
    params: {
      x: { type: 'num', req: true },
      z: { type: 'num', req: true },
      maxTicks: { type: 'int', req: false, default: 600 },
    },
  },
  {
    name: 'exec_ops',
    tier: 2,
    desc: '执行自定义动作序列（逃生舱）',
    params: {
      ops: { type: 'op[]', req: true },
      until: { type: 'cond[]', req: false },
      maxDurationMs: { type: 'int', req: false, default: 30000 },
    },
  },
];

/** tier 是否被授权（`allowTiers` 白名单，形如 `act.tier1`）。 */
export function tierAllowed(cfg: Pick<BridgeConfig, 'allowTiers'>, tier: 1 | 2): boolean {
  return cfg.allowTiers.includes(tier === 1 ? 'act.tier1' : 'act.tier2');
}

/** 工具名 → 限流间隔（毫秒）。未知工具按 tier1 配额。 */
export function intervalFor(cfg: Pick<BridgeConfig, 'rateLimit'>, tool: string): number {
  const rl = cfg.rateLimit;
  switch (tool) {
    case 'say':
      return rl.say;
    case 'anim':
      return rl.anim;
    case 'screenshot':
      return rl.screenshot;
    default:
      return rl.actTier1;
  }
}

/**
 * 速率闸。返回 `null` = 放行；否则返回**还需等待的毫秒数**。
 * @param lastAt 上次调用时刻（0 = 从未调用）
 */
export function rateLimitCheck(lastAt: number, nowMs: number, minIntervalMs: number): number | null {
  if (minIntervalMs <= 0) return null; // 配 0/负数 = 不限流（显式关闭）
  if (lastAt <= 0) return null; // 从未调用过 ⇒ 放行（**不可假设时钟基点是 epoch**：
  //                               若传入单调时钟（performance.now() 从 0 起），
  //                               把 0 当作"原点调用"会误限流首次调用）
  const elapsed = nowMs - lastAt;
  return elapsed >= minIntervalMs ? null : minIntervalMs - elapsed;
}

/** 组装给 AI 看的工具描述（单一来源：由 spec 生成，避免描述漂移）。 */
export function describeTool(spec: ToolSpec): string {
  const params = Object.keys(spec.params);
  return (
    `[Minecraft] ${spec.desc}。` +
    `参数: ${params.length ? params.join(', ') : '无'}。` +
    `权限层: act.tier${spec.tier}。` +
    '执行发生在玩家的 Minecraft 客户端（走原版玩家路径，等价于玩家自己操作）；' +
    '可能被阻塞/超时/被玩家夺回，返回里会说明终止原因。'
  );
}
