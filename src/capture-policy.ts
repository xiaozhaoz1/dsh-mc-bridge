/**
 * dsh-mc-bridge · 截图策略（**纯逻辑，可单测**）
 *
 * ## 设计口径（用户 2026-09-24 修正）
 * 目的是**防"跑飞式刷图"**（烧 token + `CopyFromScreen` 抓游戏窗口造成卡顿），
 * **不是**限制正常调试 —— 修 UI bug 时一小时截几十上百张是**正常需求**。
 * ⇒ **软警告 + 硬保护** 两档，硬阈值放到"正常干活碰不到"的量级：
 *
 * | 机制 | 作用 |
 * |---|---|
 * | **需求验证**（purpose 必填） | 逼"为什么要看"，防无脑循环截图 |
 * | **最小间隔 1s** | 防连环截图（真正的卡顿来源） |
 * | **同目的去重**（同一 purpose 在 N 秒内重复 ⇒ 拒） | 防"同一个检查反复截"，这是刷图的主要形态 |
 * | **软警告 120/小时** | 只提示"用量偏高"，**继续放行** |
 * | **硬保护 600/小时 · 5000/会话** | 只拦真正的跑飞（正常修 bug 到不了） |
 */

export interface CapturePolicy {
  /** 两次截图最小间隔（毫秒）。默认 1000 —— 防连环卡顿，但调试够快。 */
  minIntervalMs: number;
  /** 软警告阈值（每小时；超过只提示，不拦）。 */
  warnPerHour: number;
  /** 硬保护（每小时；超过则拒绝）。 */
  hardPerHour: number;
  /** 硬保护（每会话；超过则拒绝）。 */
  hardPerSession: number;
  /** 同 purpose 去重窗口（毫秒）：窗口内重复同一目的 ⇒ 拒绝。默认 10000。 */
  dupWindowMs: number;
  /** 目的最短长度。默认 4。 */
  minPurposeLen: number;
}

export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  minIntervalMs: 1000,
  warnPerHour: 120,
  hardPerHour: 600,
  hardPerSession: 5000,
  dupWindowMs: 10_000,
  minPurposeLen: 4,
};

/** 会话内累积状态（调用方持有）。 */
export interface CaptureState {
  total: number;
  lastAt: number;
  /** 一小时内的截图时间戳（滚动窗口）。 */
  recent: number[];
  /** 最近的 purpose 记录（用于去重）。 */
  recentPurposes: Array<{ purpose: string; at: number }>;
}

export function newCaptureState(): CaptureState {
  return { total: 0, lastAt: 0, recent: [], recentPurposes: [] };
}

export type CaptureDecision =
  | { ok: true; warning?: string }
  | {
      ok: false;
      reason: 'no_purpose' | 'too_soon' | 'duplicate_purpose' | 'hard_hour_limit' | 'hard_session_limit';
      message: string;
      retryAfterMs?: number;
    };

/**
 * 判定是否允许截图（**不改状态**，成功后由调用方 `commitCapture()`）。
 * @param purpose 截图目的（必填）—— 逼"有需求"才截
 */
export function checkCapture(
  policy: CapturePolicy,
  state: CaptureState,
  nowMs: number,
  purpose: string,
): CaptureDecision {
  const p = (purpose ?? '').trim();
  if (p.length < policy.minPurposeLen) {
    return {
      ok: false,
      reason: 'no_purpose',
      message: `截图必须说明目的（≥${policy.minPurposeLen} 字），例如「检查宠物是否在右下角渲染」`,
    };
  }

  // 硬保护：只拦真正的跑飞
  if (state.total >= policy.hardPerSession) {
    return {
      ok: false,
      reason: 'hard_session_limit',
      message: `本会话截图达硬上限 ${policy.hardPerSession} 次（疑似跑飞）`,
    };
  }
  const hourAgo = nowMs - 3600_000;
  const recent = state.recent.filter((t) => t > hourAgo);
  if (recent.length >= policy.hardPerHour) {
    const oldest = Math.min(...recent);
    return {
      ok: false,
      reason: 'hard_hour_limit',
      message: `最近一小时达硬上限 ${policy.hardPerHour} 次（疑似跑飞）`,
      retryAfterMs: Math.max(0, oldest + 3600_000 - nowMs),
    };
  }

  // 最小间隔：真正的卡顿来源
  if (state.lastAt > 0 && nowMs - state.lastAt < policy.minIntervalMs) {
    return {
      ok: false,
      reason: 'too_soon',
      message: `距上次截图不足 ${policy.minIntervalMs}ms（防连环截图卡顿）`,
      retryAfterMs: policy.minIntervalMs - (nowMs - state.lastAt),
    };
  }

  // 同目的去重：防"同一个检查反复截"（刷图的主要形态）
  const dup = state.recentPurposes.find(
    (r) => r.purpose === p && nowMs - r.at < policy.dupWindowMs,
  );
  if (dup) {
    return {
      ok: false,
      reason: 'duplicate_purpose',
      message: `同样目的（"${p}"）在 ${policy.dupWindowMs}ms 内已截过 ⇒ 请换目的或稍后再试`,
      retryAfterMs: policy.dupWindowMs - (nowMs - dup.at),
    };
  }

  const warning =
    recent.length >= policy.warnPerHour
      ? `用量偏高：最近一小时已 ${recent.length} 次（软阈值 ${policy.warnPerHour}）`
      : undefined;
  return warning ? { ok: true, warning } : { ok: true };
}

/** 记录一次成功截图（**只在真的截成功后调用**）。 */
export function commitCapture(state: CaptureState, nowMs: number, purpose: string): CaptureState {
  const hourAgo = nowMs - 3600_000;
  const dupWindow = state.recentPurposes.filter((r) => nowMs - r.at < 60_000); // 只留 1 分钟内的目的
  return {
    total: state.total + 1,
    lastAt: nowMs,
    recent: [...state.recent.filter((t) => t > hourAgo), nowMs],
    recentPurposes: [...dupWindow, { purpose: (purpose ?? '').trim(), at: nowMs }],
  };
}

/** 剩余额度与下次可截时间（供 status 展示）。 */
export function remaining(
  policy: CapturePolicy,
  state: CaptureState,
  nowMs: number,
): { sessionLeft: number; hourLeft: number; hourUsed: number; warnThreshold: number; nextAllowedInMs: number } {
  const hourAgo = nowMs - 3600_000;
  const used = state.recent.filter((t) => t > hourAgo).length;
  return {
    sessionLeft: Math.max(0, policy.hardPerSession - state.total),
    hourLeft: Math.max(0, policy.hardPerHour - used),
    hourUsed: used,
    warnThreshold: policy.warnPerHour,
    nextAllowedInMs: state.lastAt > 0 ? Math.max(0, policy.minIntervalMs - (nowMs - state.lastAt)) : 0,
  };
}
