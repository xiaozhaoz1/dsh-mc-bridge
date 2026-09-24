/**
 * 截图策略单测：需求验证 + 去重 + 软警告/硬保护 两档（**正常调试不得被拦**）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CAPTURE_POLICY,
  checkCapture,
  commitCapture,
  newCaptureState,
  remaining,
} from '../src/capture-policy.ts';

const P = DEFAULT_CAPTURE_POLICY;

test('需求验证：无目的/太短 ⇒ 拒绝（逼"为什么要看"）', () => {
  const s = newCaptureState();
  assert.equal(checkCapture(P, s, 1_000_000, '').ok, false);
  assert.equal(checkCapture(P, s, 1_000_000, '看').ok, false);
  const d = checkCapture(P, s, 1_000_000, 'ok');
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'no_purpose');
});

test('目的够具体 ⇒ 放行', () => {
  assert.equal(checkCapture(P, newCaptureState(), 1_000_000, '检查宠物是否渲染在右下角').ok, true);
});

test('最小间隔 1s：太近 ⇒ 拒绝并给 retryAfterMs（防连环卡顿）', () => {
  const s = commitCapture(newCaptureState(), 1_000_000, '第一次看宠物');
  const d = checkCapture(P, s, 1_000_000 + 200, '第二次看动画');
  assert.equal(d.ok, false);
  if (!d.ok) {
    assert.equal(d.reason, 'too_soon');
    assert.equal(d.retryAfterMs, 800, '1s 间隔 ⇒ 还剩 800ms');
  }
});

test('同目的去重：10s 内重复同一目的 ⇒ 拒绝（刷图主要形态）', () => {
  const s = commitCapture(newCaptureState(), 1_000_000, '检查宠物位置');
  const d = checkCapture(P, s, 1_000_000 + 2000, '检查宠物位置');
  assert.equal(d.ok, false);
  if (!d.ok) {
    assert.equal(d.reason, 'duplicate_purpose');
    assert.equal(d.retryAfterMs, P.dupWindowMs - 2000);
  }
});

test('同目的但换说法/换目的 ⇒ 放行（不误伤正常调试）', () => {
  const s = commitCapture(newCaptureState(), 1_000_000, '检查宠物位置');
  assert.equal(checkCapture(P, s, 1_000_000 + 2000, '检查配置屏文字是否清晰').ok, true);
});

/**
 * ⭐ 关键回归（用户 2026-09-24 指出）：**修 bug 一小时几十上百次是正常需求**，
 * 软阈值（120/h）**只警告不拦**，硬阈值（600/h）才拦。
 */
test('回归：一小时 200 次（远超软阈值）仍然全部放行，只出警告', () => {
  let s = newCaptureState();
  let now = 5_000_000;
  let warned = 0;
  for (let i = 0; i < 200; i++) {
    now += P.minIntervalMs + 1;
    const d = checkCapture(P, s, now, `第 ${i} 次检查（不同目的）`);
    assert.equal(d.ok, true, `第 ${i} 次应放行（这是正常调试量）`);
    if (d.ok && d.warning) warned++;
    s = commitCapture(s, now, `第 ${i} 次检查（不同目的）`);
  }
  assert.equal(s.total, 200);
  assert.ok(warned > 0, '超过软阈值后应有警告（但不停机）');
});

test('硬保护：每小时 600 次 ⇒ 拦（只拦跑飞）', () => {
  let s = newCaptureState();
  let now = 9_000_000;
  for (let i = 0; i < P.hardPerHour; i++) {
    now += P.minIntervalMs + 1;
    s = commitCapture(s, now, `跑飞 ${i}`);
  }
  const d = checkCapture(P, s, now + P.minIntervalMs + 1, '再截一张不同目的');
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'hard_hour_limit');
});

test('硬保护：每会话 5000 次 ⇒ 拦', () => {
  const s = { total: P.hardPerSession, lastAt: 0, recent: [], recentPurposes: [] };
  // ⚠️ purpose 必须合法（≥4 字），否则会被"需求验证"先拦（那是更高优先级的闸）
  const d = checkCapture(P, s, 99_999_999, '还想再看一眼宠物');
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'hard_session_limit');
});

test('闸门优先级：目的不合法时先报 no_purpose（即便已达硬上限）', () => {
  const s = { total: P.hardPerSession, lastAt: 0, recent: [], recentPurposes: [] };
  const d = checkCapture(P, s, 99_999_999, '短');
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.reason, 'no_purpose', '需求验证优先于上限检查');
});

test('一小时后旧记录滑出 ⇒ 小时配额恢复', () => {
  let s = newCaptureState();
  let now = 1_000_000;
  for (let i = 0; i < 200; i++) {
    now += P.minIntervalMs + 1;
    s = commitCapture(s, now, `旧 ${i}`);
  }
  assert.equal(checkCapture(P, s, now + 3_600_001, '过了一小时再看不同目的').ok, true);
});

test('commitCapture 只在成功后计数（含 purpose 记录）', () => {
  let s = newCaptureState();
  assert.equal(s.total, 0);
  s = commitCapture(s, 1000, '看一次');
  s = commitCapture(s, 2000, '再看一次');
  assert.equal(s.total, 2);
  assert.equal(s.lastAt, 2000);
  assert.equal(s.recentPurposes.length, 2);
});

test('remaining: 暴露额度（软阈值 + 硬上限 + 下次可截）', () => {
  const s = commitCapture(newCaptureState(), 1000, '看一次');
  const r = remaining(P, s, 1000 + 100);
  assert.equal(r.sessionLeft, P.hardPerSession - 1);
  assert.equal(r.hourLeft, P.hardPerHour - 1);
  assert.equal(r.hourUsed, 1);
  assert.equal(r.warnThreshold, P.warnPerHour);
  assert.equal(r.nextAllowedInMs, P.minIntervalMs - 100);
});
