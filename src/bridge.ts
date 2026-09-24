/**
 * dsh-mc-bridge · L1 桥客户端（连 dshpet-mc 的 mod 桥）
 *
 * 协议依据：`dshpet-mc/docs/PLAN-bridge-S1a-fields.md`（冻结版 v1–v8）。
 * 关键纪律（逐条对应冻结决定）：
 *  - **SSE 是长连接**：无"请求超时"；用**心跳超时**判死（默认 45s，收不到 `ping` 即重连）
 *  - **退避矩阵**：网络/5xx ⇒ 退避重连；**401/403 或其他 4xx / 版本不符 ⇒ 停止，不无限重试**
 *  - **重放**：重连带 `Last-Event-ID: <最后收到的 seq>`；收到 `resync` ⇒ **清空本地缓冲并记因**
 *  - **`resync` 必须先于 `welcome` 处理**（先清缓冲，再确立会话）
 *  - **token 绝不入日志**（只打掩码）
 *  - 依赖：仅 Node 内置（`fetch` / `AbortController`），**无第三方包**
 */
import { maskToken, type BridgeConfig, isLoopbackEndpoint } from './config.ts';
import type { AckUp, DownstreamEvents, HelloUp, InstanceInfo } from './types.ts';

export type BridgeState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface BridgeEvents {
  onState?: (state: BridgeState, detail?: string) => void;
  /** 下行事件（已解析）。`welcome` 之前的 `resync` 会被优先投递（见 handleSse）。 */
  onEvent?: <K extends keyof DownstreamEvents>(name: K, data: DownstreamEvents[K]) => void;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** 上行 ack 回执统一出口（用于审计）。 */
  onAck?: (ack: AckUp) => void;
}

/** 退避序列（可测）：2s→4s→8s→16s→30s（封顶）。 */
export function nextBackoff(attempt: number, minMs: number, maxMs: number): number {
  const ms = minMs * 2 ** Math.max(0, attempt);
  return Math.min(ms, maxMs);
}

/** 解析 SSE 单帧（可测）：支持 `event:` / `data:` / `id:` 与多行 data。 */
export function parseSseFrame(frame: string): { event: string; data: string; id?: string } | null {
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n'), ...(id ? { id } : {}) };
}

/** 判定某 HTTP 状态码是否应**停止**重连（而非退避重试）。 */
export function shouldStopOnStatus(status: number): boolean {
  if (status === 401 || status === 403) return true; // 认证问题：重试无意义
  if (status >= 400 && status < 500) return true; // 协议/配置错误：重试无意义（404/400…）
  return false; // 5xx / 网络错误 ⇒ 允许退避重连
}

export class BridgeClient {
  private readonly cfg: BridgeConfig;
  private readonly ev: BridgeEvents;
  private readonly info: InstanceInfo;
  private state: BridgeState = 'idle';
  private lastSeq = 0;
  private attempt = 0;
  private controller: AbortController | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(cfg: BridgeConfig, info: InstanceInfo, ev: BridgeEvents = {}) {
    this.cfg = cfg;
    this.info = info;
    this.ev = ev;
  }

  getState(): BridgeState {
    return this.state;
  }

  private setState(s: BridgeState, detail?: string): void {
    if (this.state === s) return;
    this.state = s;
    this.ev.onState?.(s, detail);
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.ev.onLog?.(level, `[mc-bridge] ${msg}`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.cfg.token) h.Authorization = `Bearer ${this.cfg.token}`;
    if (this.lastSeq > 0) h['Last-Event-ID'] = String(this.lastSeq);
    return h;
  }

  /** 建立 SSE 长连接（含退避重连；返回的 Promise 在停止时 resolve）。 */
  async start(): Promise<void> {
    if (!this.cfg.enabled) {
      this.log('info', '未启用（config.enabled=false）');
      return;
    }
    if (!isLoopbackEndpoint(this.cfg.endpoint) && !this.cfg.token) {
      this.setState('stopped', '非回环 endpoint 缺少 token');
      this.log('error', '拒绝连接：非回环 endpoint 必须配置 token');
      return;
    }
    this.setState('connecting');
    while (this.state !== 'stopped') {
      try {
        await this.connectOnce();
        this.attempt = 0; // 正常结束（服务端关闭）也算成功过
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = (e as { status?: number }).status;
        if (typeof status === 'number' && shouldStopOnStatus(status)) {
          this.setState('stopped', `HTTP ${status}`);
          this.log('error', `停止重连：HTTP ${status}（token 缺失/错误或协议不匹配）——修正配置后手动重连`);
          return;
        }
        this.log('warn', `连接中断: ${msg}`);
      }
      if (this.state === 'stopped') return;
      const wait = nextBackoff(this.attempt, this.cfg.reconnectMinMs, this.cfg.reconnectMaxMs);
      this.attempt += 1;
      this.setState('reconnecting', `${wait}ms 后重试（第 ${this.attempt} 次）`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  stop(): void {
    this.setState('stopped', '手动停止');
    this.clearHeartbeat();
    this.controller?.abort();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 重置心跳计时：超时未收到任何下行 ⇒ 视为断线（SSE 无"请求超时"概念）。 */
  private bumpHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.log('warn', `心跳超时 ${this.cfg.heartbeatTimeoutMs}ms ⇒ 主动断开重连`);
      this.controller?.abort();
    }, this.cfg.heartbeatTimeoutMs);
  }

  private async connectOnce(): Promise<void> {
    const url = this.cfg.endpoint.replace(/\/+$/, '') + '/stream';
    this.controller = new AbortController();
    const res = await fetch(url, {
      headers: this.headers(),
      signal: this.controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    if (!res.body) throw new Error('响应无 body（非 SSE？）');
    await this.postHello();
    this.bumpHeartbeat();
    this.setState('connected', url);
    this.log('info', `已连接 ${url}（token=${maskToken(this.cfg.token)}）`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.handleSse(frame);
      }
    }
    this.clearHeartbeat();
  }

  /** 处理一帧 SSE（顺序纪律：`resync` 先于 `welcome` 生效）。 */
  handleSse(frame: string): void {
    const parsed = parseSseFrame(frame);
    if (!parsed) return;
    this.bumpHeartbeat();
    let data: unknown;
    try {
      data = JSON.parse(parsed.data);
    } catch {
      this.log('warn', `SSE data 非 JSON，已丢弃（event=${parsed.event}）`);
      return;
    }
    if (parsed.id) {
      const n = Number(parsed.id);
      if (Number.isFinite(n) && n > this.lastSeq) this.lastSeq = n;
    }
    if (parsed.event === 'resync') {
      const reason = (data as { reason?: string }).reason ?? 'unknown';
      this.lastSeq = 0; // 清空本地续接点（dsh 放弃续接要求）
      this.log('warn', `收到 resync（${reason}）：已清空本地缓冲/续接点`);
    }
    this.ev.onEvent?.(parsed.event as keyof DownstreamEvents, data as never);
  }

  private async postHello(): Promise<void> {
    const body: HelloUp = {
      ...this.info,
      protocol: '1',
      startedAt: Date.now(),
      capabilities: ['state', 'event', 'say', 'anim', 'act', 'config', 'screenshot'],
      seqBase: this.lastSeq,
    };
    await this.post('/hello', body);
  }

  /** 统一 POST（带 token、超时、错误归一）。 */
  async post(path: string, body: unknown): Promise<{ status: number; json?: unknown }> {
    const url = this.cfg.endpoint.replace(/\/+$/, '') + path;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000); // POST 超时（SSE 不用这个）
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      if (res.status === 401 || res.status === 403) {
        const err = new Error(`HTTP ${res.status} on POST ${path}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 上报游戏事件（mod → 本插件方向：本插件是客户端，向 mod 提交 ack；此方法用于测试/模拟）。 */
  async postAck(ack: AckUp): Promise<{ status: number; json?: unknown }> {
    this.ev.onAck?.(ack);
    return this.post('/ack', ack);
  }
}
