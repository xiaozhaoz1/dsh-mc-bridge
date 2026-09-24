/**
 * 窗口识别单测（**纯函数**，不需要真窗口）。
 *
 * 重点回归：**Edge 误匹配**（BUG-A）—— 浏览器标题里可能含 "Minecraft"
 * （例如打开本项目的 GitHub 页面），旧实现用 `title.includes('minecraft')` 会误命中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCORE_THRESHOLD, pickBest, scoreWindow, type WindowFacts } from '../src/window.ts';

function facts(over: Partial<WindowFacts> = {}): WindowFacts {
  return {
    hwnd: '1',
    title: '',
    className: '',
    pid: 1,
    processName: '',
    cmdLooksLikeMc: false,
    minimized: false,
    foreground: false,
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    ...over,
  };
}

test('回归(BUG-A): 浏览器标题含 Minecraft ⇒ 不得被判为 MC', () => {
  // 真实案例：Edge 打开 https://github.com/xiaozhaoz1/dsh-mc-bridge 时标题含 "Minecraft"
  const edge = facts({
    title: 'xiaozhaoz1/dsh-mc-bridge: DSH ↔ Minecraft 接入插件 - Microsoft Edge',
    className: 'Chrome_WidgetWin_1',
    processName: 'msedge.exe',
  });
  const { score } = scoreWindow(edge);
  assert.ok(score < SCORE_THRESHOLD, `浏览器不得过阈值（实际 score=${score}）`);
});

test('GLFW 类名 + MC 命令行 ⇒ 稳过阈值（标题改名也不影响）', () => {
  const mc = facts({
    title: '某个整合包的自定义标题', // 故意不含 minecraft
    className: 'GLFW30',
    processName: 'java.exe',
    cmdLooksLikeMc: true,
  });
  const { score, reasons } = scoreWindow(mc);
  assert.ok(score >= SCORE_THRESHOLD, `应过阈值（score=${score}）`);
  assert.ok(reasons.some((r) => r.includes('class=')), '应记录类名判据');
  assert.ok(reasons.some((r) => r.includes('cmd=')), '应记录命令行判据');
});

test('仅类名（无命令行）⇒ 50 分，不足阈值（避免误判其他 GLFW 程序）', () => {
  const { score } = scoreWindow(facts({ className: 'GLFW30', processName: 'other.exe' }));
  assert.equal(score, 50);
  assert.ok(score < SCORE_THRESHOLD);
});

test('仅命令行（类名不同）⇒ 40 分，不足阈值', () => {
  const { score } = scoreWindow(facts({ cmdLooksLikeMc: true, className: 'SunAwtFrame', processName: 'java.exe' }));
  assert.equal(score, 50, '40(cmd) + 10(java) —— 仍不足阈值');
  assert.ok(score < SCORE_THRESHOLD);
});

test('类名 + 命令行 + java ⇒ 100 分（拿满强判据）', () => {
  const { score } = scoreWindow(facts({ className: 'GLFW30', cmdLooksLikeMc: true, processName: 'javaw.exe' }));
  assert.equal(score, 100);
});

test('LWJGL 类名也认（不同 GLFW 版本/包装）', () => {
  const { score } = scoreWindow(facts({ className: 'LWJGL', cmdLooksLikeMc: true }));
  assert.ok(score >= SCORE_THRESHOLD);
});

test('pickBest: 最小化与零尺寸被排除（不能抓图）', () => {
  const a = facts({ hwnd: '1', className: 'GLFW30', cmdLooksLikeMc: true, minimized: true });
  const b = facts({ hwnd: '2', className: 'GLFW30', cmdLooksLikeMc: true, width: 0 });
  assert.equal(pickBest([a, b]), null, '都不可抓 ⇒ null');
});

test('pickBest: 多候选取分最高（Edge 与 MC 同屏时选 MC）', () => {
  const edge = facts({
    hwnd: '100',
    title: 'xxx Minecraft 页面 - Microsoft Edge',
    className: 'Chrome_WidgetWin_1',
    processName: 'msedge.exe',
  });
  const mc = facts({ hwnd: '200', className: 'GLFW30', cmdLooksLikeMc: true, processName: 'java.exe' });
  const best = pickBest([edge, mc]);
  assert.equal(best?.hwnd, '200', '必须选 MC 而不是 Edge');
  assert.ok((best?.score ?? 0) >= SCORE_THRESHOLD);
});

test('pickBest: 带判据明细（便于诊断"为什么选它"）', () => {
  const best = pickBest([facts({ className: 'GLFW30', cmdLooksLikeMc: true })]);
  assert.ok(best && best.reasons.length >= 2, '应至少两条判据');
});
