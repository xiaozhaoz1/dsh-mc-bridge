/**
 * dsh-mc-bridge · 配置（schema + 校验 + 回落）
 *
 * 纪律（照上游 dsh-pet 模式）：
 *  - **字段级校验**：单个字段非法 ⇒ **取默认值 + 告警**，绝不让整份配置失效
 *  - **回落链**：patch config → 默认值（将来可扩展为 用户覆盖层 → 默认）
 *  - **绝不静默**：每次回落都要能说清"哪个字段、什么值、为什么"
 */

/** 插件配置（与 cordis.patch.yml 的 config 段一致）。 */
export interface BridgeConfig {
  endpoint: string;
  token: string;
  enabled: boolean;
  readOnly: boolean;
  allowTiers: string[];
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heartbeatTimeoutMs: number;
  rateLimit: { say: number; anim: number; actTier1: number; screenshot: number };
  window: {
    enabled: boolean;
    captureIntervalMs: number;
    allowInputInjection: boolean;
    requireForeground: boolean;
  };
  audit: { enabled: boolean; logToFile: boolean };
}

export const DEFAULTS: BridgeConfig = {
  endpoint: 'http://127.0.0.1:25580',
  token: '',
  enabled: false,
  readOnly: true,
  allowTiers: [],
  reconnectMinMs: 2000,
  reconnectMaxMs: 30000,
  heartbeatTimeoutMs: 45000,
  rateLimit: { say: 5000, anim: 2000, actTier1: 2000, screenshot: 30000 },
  window: { enabled: false, captureIntervalMs: 5000, allowInputInjection: false, requireForeground: true },
  audit: { enabled: true, logToFile: false },
};

/** `act.tier1` / `act.tier2` 是唯一合法的动作层名。 */
export const VALID_TIERS = ['act.tier1', 'act.tier2'] as const;

export interface ValidationResult {
  config: BridgeConfig;
  /** 每条 = 一次回落（用于告警；空数组表示完全合法）。 */
  problems: string[];
}

/** 判断是否回环地址（云端 endpoint 需强制 token）。 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

function num(v: unknown, def: number, min: number, max: number, label: string, out: string[]): number {
  if (v === undefined) return def; // 缺省 ⇒ 静默取默认（只有"存在但非法"才告警）
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    out.push(`${label}: 非数字 ⇒ 取默认 ${def}`);
    return def;
  }
  if (v < min || v > max) {
    out.push(`${label}: 越界(${v} 不在 ${min}..${max}) ⇒ 取默认 ${def}`);
    return def;
  }
  return v;
}

function bool(v: unknown, def: boolean, label: string, out: string[]): boolean {
  if (v === undefined) return def; // 缺省 ⇒ 静默取默认
  if (typeof v !== 'boolean') {
    out.push(`${label}: 非布尔 ⇒ 取默认 ${def}`);
    return def;
  }
  return v;
}

/**
 * 校验 + 回落。**永不抛异常**（插件不能被配置问题带崩）。
 * 额外的**安全校验**：非回环 endpoint 且无 token ⇒ 追加一条 problem（调用方应据此拒绝启用）。
 */
export function validateConfig(raw: unknown): ValidationResult {
  const problems: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = DEFAULTS;

  let endpoint: string;
  if (r.endpoint === undefined) {
    endpoint = d.endpoint; // 缺省 ⇒ 静默取默认
  } else if (typeof r.endpoint !== 'string' || !r.endpoint.trim()) {
    problems.push(`endpoint: 非法(${JSON.stringify(r.endpoint)}) ⇒ 取默认 ${d.endpoint}`);
    endpoint = d.endpoint;
  } else if (!/^https?:\/\//i.test(r.endpoint.trim())) {
    problems.push(`endpoint: 协议必须是 http/https（收到 ${r.endpoint}）⇒ 取默认 ${d.endpoint}`);
    endpoint = d.endpoint;
  } else {
    endpoint = r.endpoint.trim();
  }

  const token =
    r.token === undefined
      ? '' // 缺省 ⇒ 静默取空
      : typeof r.token === 'string'
        ? r.token
        : (problems.push('token: 非字符串 ⇒ 取空'), '');

  // 授权层：只接受白名单值；非法值丢弃并告警
  let allowTiers: string[] = [];
  const rawTiers = r.allowTiers;
  if (rawTiers === undefined) {
    allowTiers = [...d.allowTiers];
  } else if (!Array.isArray(rawTiers)) {
    problems.push('allowTiers: 非数组 ⇒ 取空');
  } else {
    for (const t of rawTiers) {
      if (typeof t === 'string' && (VALID_TIERS as readonly string[]).includes(t)) {
        allowTiers.push(t);
      } else {
        problems.push(`allowTiers: 未知层 ${JSON.stringify(t)} ⇒ 丢弃（合法值: ${VALID_TIERS.join('/')}）`);
      }
    }
  }

  const rl = (r.rateLimit ?? {}) as Record<string, unknown>;
  const rw = (r.window ?? {}) as Record<string, unknown>;
  const ra = (r.audit ?? {}) as Record<string, unknown>;

  const cfg: BridgeConfig = {
    endpoint,
    token,
    enabled: bool(r.enabled, d.enabled, 'enabled', problems),
    readOnly: bool(r.readOnly, d.readOnly, 'readOnly', problems),
    allowTiers,
    reconnectMinMs: num(r.reconnectMinMs, d.reconnectMinMs, 200, 600000, 'reconnectMinMs', problems),
    reconnectMaxMs: num(r.reconnectMaxMs, d.reconnectMaxMs, 200, 600000, 'reconnectMaxMs', problems),
    heartbeatTimeoutMs: num(r.heartbeatTimeoutMs, d.heartbeatTimeoutMs, 5000, 600000, 'heartbeatTimeoutMs', problems),
    rateLimit: {
      say: num(rl.say, d.rateLimit.say, 0, 600000, 'rateLimit.say', problems),
      anim: num(rl.anim, d.rateLimit.anim, 0, 600000, 'rateLimit.anim', problems),
      actTier1: num(rl.actTier1, d.rateLimit.actTier1, 0, 600000, 'rateLimit.actTier1', problems),
      screenshot: num(rl.screenshot, d.rateLimit.screenshot, 0, 3600000, 'rateLimit.screenshot', problems),
    },
    window: {
      enabled: bool(rw.enabled, d.window.enabled, 'window.enabled', problems),
      captureIntervalMs: num(rw.captureIntervalMs, d.window.captureIntervalMs, 500, 600000, 'window.captureIntervalMs', problems),
      allowInputInjection: bool(rw.allowInputInjection, d.window.allowInputInjection, 'window.allowInputInjection', problems),
      requireForeground: bool(rw.requireForeground, d.window.requireForeground, 'window.requireForeground', problems),
    },
    audit: {
      enabled: bool(ra.enabled, d.audit.enabled, 'audit.enabled', problems),
      logToFile: bool(ra.logToFile, d.audit.logToFile, 'audit.logToFile', problems),
    },
  };

  if (cfg.reconnectMinMs > cfg.reconnectMaxMs) {
    problems.push(`reconnectMinMs(${cfg.reconnectMinMs}) > reconnectMaxMs(${cfg.reconnectMaxMs}) ⇒ 交换`);
    const t = cfg.reconnectMinMs;
    cfg.reconnectMinMs = cfg.reconnectMaxMs;
    cfg.reconnectMaxMs = t;
  }

  // ⚠️ 安全门：非回环 + 无 token ⇒ 明确拒绝（不静默放行）
  if (!isLoopbackEndpoint(cfg.endpoint) && !cfg.token) {
    problems.push('⛔ 非回环 endpoint 必须配置 token（拒绝启用，避免裸奔）');
  }

  return { config: cfg, problems };
}

/** 是否允许真正启用（安全门通过 + 用户已开开关）。 */
export function canEnable(v: ValidationResult): boolean {
  return v.config.enabled && !v.problems.some((p) => p.startsWith('⛔'));
}

/** 掩码 token 供日志（**绝不打印完整 token**）。 */
export function maskToken(token: string): string {
  if (!token) return '(空)';
  return token.slice(0, 4) + '***';
}
