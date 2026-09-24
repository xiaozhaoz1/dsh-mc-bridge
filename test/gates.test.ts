/**
 * 闸门纯逻辑单测（零依赖，不需要 dsh SDK / mod）。
 * 跑法：`node --experimental-strip-types --test test/`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACK_TOOLS, describeTool, intervalFor, rateLimitCheck, tierAllowed } from '../src/gates.ts';
import { DEFAULTS } from '../src/config.ts';

const cfgWith = (allowTiers: string[]) => ({ allowTiers });

// ── 授权矩阵 ──────────────────────────────────────────────────────────────
test('tierAllowed: 默认（空白名单）⇒ 两层都拒绝', () => {
  assert.equal(tierAllowed(cfgWith([]), 1), false);
  assert.equal(tierAllowed(cfgWith([]), 2), false);
});

test('tierAllowed: 只授权 tier1 ⇒ tier2 仍拒绝（最小权限）', () => {
  assert.equal(tierAllowed(cfgWith(['act.tier1']), 1), true);
  assert.equal(tierAllowed(cfgWith(['act.tier1']), 2), false, 'tier1 授权不得外溢到 tier2');
});

test('tierAllowed: 授权 tier2 不影响 tier1 判定（互不蕴含）', () => {
  assert.equal(tierAllowed(cfgWith(['act.tier2']), 2), true);
  assert.equal(tierAllowed(cfgWith(['act.tier2']), 1), false);
});

// ── 限流 ──────────────────────────────────────────────────────────────────
test('rateLimitCheck: 首次调用放行', () => {
  assert.equal(rateLimitCheck(0, 1000, 5000), null);
});

test('rateLimitCheck: 冷却内返回剩余等待毫秒', () => {
  assert.equal(rateLimitCheck(1000, 3000, 5000), 3000, '还需等 3000ms');
});

test('rateLimitCheck: 冷却满 ⇒ 放行', () => {
  assert.equal(rateLimitCheck(1000, 6000, 5000), null);
});

test('rateLimitCheck: 间隔 <= 0 ⇒ 不限流', () => {
  assert.equal(rateLimitCheck(1000, 1000, 0), null);
  assert.equal(rateLimitCheck(1000, 1000, -5), null);
});

test('intervalFor: 按工具取配额（say/anim/screenshot/其余=tier1）', () => {
  const rl = DEFAULTS.rateLimit;
  assert.equal(intervalFor({ rateLimit: rl }, 'say'), rl.say);
  assert.equal(intervalFor({ rateLimit: rl }, 'anim'), rl.anim);
  assert.equal(intervalFor({ rateLimit: rl }, 'screenshot'), rl.screenshot);
  assert.equal(intervalFor({ rateLimit: rl }, 'walkToward'), rl.actTier1);
  assert.equal(intervalFor({ rateLimit: rl }, 'exec_ops'), rl.actTier1);
});

// ── 静态清单与描述 ────────────────────────────────────────────────────────
test('FALLBACK_TOOLS: 含沙箱逃生舱且 tier2 只有它', () => {
  const t2 = FALLBACK_TOOLS.filter((t) => t.tier === 2).map((t) => t.name);
  assert.deepEqual(t2, ['exec_ops'], 'tier2 应仅 exec_ops（危险面最小化）');
});

test('FALLBACK_TOOLS: 名称唯一（防注册撞名）', () => {
  const names = FALLBACK_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test('describeTool: 描述含参数/权限层/终止原因说明（写给 AI 看）', () => {
  const spec = FALLBACK_TOOLS.find((t) => t.name === 'walkToward')!;
  const d = describeTool(spec);
  assert.ok(d.includes('walkToward'.slice(0, 0) || 'Minecraft'), '应标注 Minecraft 域');
  assert.ok(d.includes('x, z, maxTicks'), `应列出参数，实际: ${d}`);
  assert.ok(d.includes('act.tier1'), '应标注权限层');
  assert.ok(d.includes('夺回') || d.includes('阻塞'), '应说明可能被中断');
});
