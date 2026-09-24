/**
 * dsh-mc-bridge · 审计（每次工具调用/下行事件留痕，可追溯到"AI 为什么做了这个动作"）
 *
 * 纪律（v7 冻结）：
 *  - **默认开**（不随 debug 开关）
 *  - 单行、定长前缀 `[DSH-MC/AUDIT]`，一条 grep 可捞出全部
 *  - **绝不记录 token**；文本类参数**截断**（防刷屏/防把整屏聊天灌进日志）
 *  - 落文件可选（`audit.logToFile`）；默认只进宿主日志（不额外占盘）
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const AUDIT_PREFIX = '[DSH-MC/AUDIT]';

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  error?: string;
}

/** 参数值摘要：长文本截断、对象浅层化、**永不展开敏感字段**。 */
export function summarizeArgs(args: Record<string, unknown>, maxLen = 120): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (/token|secret|key|password/i.test(k)) {
      parts.push(`${k}=***`);
      continue;
    }
    let s: string;
    if (typeof v === 'string') s = v;
    else {
      try {
        s = JSON.stringify(v) ?? String(v);
      } catch {
        s = String(v);
      }
    }
    if (s.length > maxLen) s = `${s.slice(0, maxLen)}…(${s.length})`;
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

/** 格式化一条审计行（纯函数 ⇒ 可单测）。 */
export function formatAudit(e: AuditEntry): string {
  const parts = [
    AUDIT_PREFIX,
    `ts=${Date.now()}`,
    `tool=${e.tool}`,
    `ok=${e.ok}`,
    `ms=${Math.round(e.ms)}`,
  ];
  if (e.error) parts.push(`error=${e.error}`);
  const args = summarizeArgs(e.args);
  if (args) parts.push(`args[${args}]`);
  return parts.join(' ');
}

export interface AuditSink {
  (line: string): void;
}

/** 建一个审计器：写日志 +（可选）落文件。返回可传给 `registerMcTools` 的 audit 函数。 */
export function makeAudit(opts: {
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  logToFile: boolean;
  filePath?: string;
}): AuditSink & ((e: AuditEntry) => void) {
  const file = opts.filePath;
  const write = (e: AuditEntry): void => {
    const line = formatAudit(e);
    opts.log('info', line);
    if (opts.logToFile && file) {
      void (async () => {
        try {
          await mkdir(dirname(file), { recursive: true });
          await appendFile(file, line + '\n', 'utf8');
        } catch (err) {
          // 落文件失败不得影响功能：降级为只在日志里可见
          opts.log('warn', `${AUDIT_PREFIX} 落文件失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    }
  };
  return write as AuditSink & ((e: AuditEntry) => void);
}
