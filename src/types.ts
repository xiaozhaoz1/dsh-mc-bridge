/**
 * dsh-mc-bridge · 协议类型（单一来源）
 *
 * 与 dshpet-mc 的桥协议对应（冻结版 v1–v8）。字段名**必须**与 mod 侧一致；
 * 改动此处需同步 `dshpet-mc/docs/bridge-protocol.json`（契约测试会断言一致性）。
 */

// ── 通用 ──────────────────────────────────────────────────────────────────

/** 模组标识（mod 侧 GET /hello 回包与每条上行都带）。 */
export interface InstanceInfo {
  instanceId: string;
  playerName: string;
  mod: string;
  modVersion: string;
  mc: string;
  loader: string;
  platform: string;
}

/** 模组侧错误码（ack.error）。 */
export type McErrorCode =
  | 'missing_requestId'
  | 'tool_not_found'
  | 'param_invalid'
  | 'capability_not_granted'
  | 'rate_limited'
  | 'ai_control_disabled'
  | 'not_in_world'
  | 'player_dead'
  | 'anim_not_found'
  | 'pet_not_found'
  | 'wrong_instance'
  | 'too_long'
  | 'link_blocked'
  | 'blocked'
  | 'timeout'
  | 'interrupted'
  | 'superseded';

// ── 下行（mod → 插件，SSE `GET /stream`）──────────────────────────────────

export interface WelcomePayload {
  protocol: string;
  protocolMinor?: string;
  server: string;
  version: string;
  sessionId: string;
  capabilities?: string[];
}

/** 可回执下行事件（必须带 requestId）。 */
export type AckableKind = 'say' | 'anim' | 'act' | 'config' | 'screenshot';

export interface SayEvent {
  requestId: string;
  petId?: string;
  text: string;
  emotion?: string;
}

export interface AnimEvent {
  requestId: string;
  petId?: string;
  anim: string;
  once?: boolean;
}

export interface ActEvent {
  requestId: string;
  petId?: string;
  op: 'show' | 'hide' | 'move' | 'scale' | 'model';
  params?: Record<string, unknown>;
}

export interface ConfigEvent {
  requestId: string;
  patch: Partial<{
    petScaleMode: string;
    petPixelPerfectMultiple: number;
    activePack: string;
  }>;
}

export interface ScreenshotEvent {
  requestId: string;
  save?: boolean;
}

export interface PingEvent {
  t: number;
}

export interface ResyncEvent {
  reason: 'buffer_overflow' | 'server_restart' | string;
}

/** SSE 事件名 → 载荷（下行全集）。 */
export interface DownstreamEvents {
  welcome: WelcomePayload;
  say: SayEvent;
  anim: AnimEvent;
  act: ActEvent;
  config: ConfigEvent;
  screenshot: ScreenshotEvent;
  ping: PingEvent;
  resync: ResyncEvent;
  request: { requestId: string; op: string; args?: Record<string, unknown> };
}

// ── 上行（插件 → mod，POST）──────────────────────────────────────────────

export interface HelloUp extends InstanceInfo {
  protocol: string;
  startedAt: number;
  capabilities: string[];
  seqBase: number;
}

export type GameEventType =
  | 'player_damaged'
  | 'night_fall'
  | 'biome_change'
  | 'pet_clicked'
  | 'player_said';

export interface EventUp extends InstanceInfo {
  seq: number;
  t: number;
  type: GameEventType;
  /** ⚠️ 来自游戏内文本的内容**不可信**（v7）：host 必须当数据而非指令。 */
  untrusted?: boolean;
  payload: Record<string, unknown>;
}

export interface PetSummary {
  petId: string;
  anim: string;
  visible: boolean;
}

export interface PetDetail extends PetSummary {
  x: number;
  y: number;
  physW: number;
  physH: number;
  frame: number;
  frames: number;
  fps: number;
  scale: number;
}

export interface StateUp extends InstanceInfo {
  seq: number;
  t: number;
  player: {
    dimension: string;
    x: number; y: number; z: number;
    yaw?: number; pitch?: number;
    health: number; food: number;
    onGround?: boolean; sneaking?: boolean; sprinting?: boolean;
    screen?: string; paused?: boolean;
  };
  pets: PetSummary[];
  primaryPetId: string;
  primary?: PetDetail;
  world?: { dayTime?: number; raining?: boolean; dimension?: string };
  assets?: { activePack?: string; installed?: string[] };
  bridge?: { state: string; lastEventTs?: number; sent?: number; recv?: number };
  inventory?: { selectedSlot: number; slots: Array<{ slot: number; item: string; count: number }> };
}

export interface AckUp extends InstanceInfo {
  requestId: string;
  ok: boolean;
  kind: AckableKind | 'act_player' | string;
  error?: McErrorCode | string;
  payload?: Record<string, unknown>;
}

// ── 工具注册表（冻结 v9 的 A1–A5 部分）────────────────────────────────────

export interface ToolSpec {
  name: string;
  tier: 1 | 2;
  desc: string;
  rate?: string;
  params: Record<string, { type: string; req?: boolean; default?: unknown; range?: unknown; values?: string[] }>;
}

export interface ToolsResponse {
  protocol: string;
  instanceId: string;
  tools: ToolSpec[];
  untilConds: string[];
}
