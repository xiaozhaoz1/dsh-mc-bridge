/**
 * 截图留存策略（**纯逻辑，可单测**）+ 落盘清理。
 *
 * 用户 2026-09-24：「截图保存最近 5 张就行了」—— 截图是临时诊断产物，
 * 无限累积只会占盘、且让人（和 AI）翻不出"最新的那张"。
 *
 * 规则：
 *  - 文件名形如 `mc-<epochMs>.png`（时间戳即排序键）
 *  - 保留**最新 N 张**（默认 5），其余**删除**
 *  - 只删**自己命名规则内**的文件（`mc-*.png`），**绝不碰目录里其他文件**
 *  - 删除失败不抛（不因清理失败影响截图本身）
 */
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** 默认保留数量。 */
export const KEEP_SCREENSHOTS = 5;

/** 我们自己的文件命名（用于**安全过滤**：只在自己产物里动手）。 */
export const SCREENSHOT_RE = /^mc-(\d+)\.png$/;

export interface RetainDecision {
  /** 保留（新的） */
  keep: string[];
  /** 删除（旧的） */
  remove: string[];
}

/**
 * 纯函数：给定目录内的文件名列表，决定保留/删除哪些。
 * @param names 文件名（不含路径）
 * @param keepCount 保留最新几张
 */
export function planRetention(names: string[], keepCount = KEEP_SCREENSHOTS): RetainDecision {
  const mine = names
    .map((n) => {
      const m = SCREENSHOT_RE.exec(n);
      return m ? { name: n, ts: Number(m[1]) } : null;
    })
    .filter((x): x is { name: string; ts: number } => x !== null)
    .sort((a, b) => b.ts - a.ts); // 新→旧

  const keep = mine.slice(0, Math.max(0, keepCount)).map((x) => x.name);
  const remove = mine.slice(Math.max(0, keepCount)).map((x) => x.name);
  return { keep, remove };
}

/** 落盘清理：执行 `planRetention`（失败静默，不打断截图流程）。 */
export async function enforceRetention(dir: string, keepCount = KEEP_SCREENSHOTS): Promise<RetainDecision> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { keep: [], remove: [] };
  }
  const plan = planRetention(names, keepCount);
  for (const n of plan.remove) {
    try {
      await unlink(join(dir, n));
    } catch {
      /* 删不掉就算了，不影响本次截图 */
    }
  }
  return plan;
}
