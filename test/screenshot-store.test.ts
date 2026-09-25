/**
 * 截图留存单测：只留最新 N 张；**只碰自己的文件**（安全边界）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KEEP_SCREENSHOTS, planRetention } from '../src/screenshot-store.ts';

test('默认保留最新 5 张', () => {
  assert.equal(KEEP_SCREENSHOTS, 5);
});

test('planRetention: 超过 N 张 ⇒ 旧的进 remove，新的进 keep', () => {
  const names = ['mc-100.png', 'mc-500.png', 'mc-300.png', 'mc-200.png', 'mc-400.png', 'mc-600.png'];
  const { keep, remove } = planRetention(names, 5);
  assert.deepEqual(keep, ['mc-600.png', 'mc-500.png', 'mc-400.png', 'mc-300.png', 'mc-200.png']);
  assert.deepEqual(remove, ['mc-100.png'], '最旧的被清理');
});

test('planRetention: 恰好 N 张 ⇒ 不删', () => {
  const names = ['mc-1.png', 'mc-2.png', 'mc-3.png', 'mc-4.png', 'mc-5.png'];
  assert.deepEqual(planRetention(names, 5).remove, []);
});

test('planRetention: 非本插件文件一律不动（安全边界）', () => {
  const names = ['mc-1.png', 'screenshot.png', 'F2截图.png', 'notes.txt', 'mc-notatimestamp.png'];
  const { keep, remove } = planRetention(names, 1);
  assert.deepEqual(keep, ['mc-1.png']);
  assert.deepEqual(remove, [], '别人的文件/不规则命名绝不删');
});

test('planRetention: keepCount=0 ⇒ 全清（仅我们自己的）', () => {
  const names = ['mc-1.png', 'mc-2.png', 'other.png'];
  const { keep, remove } = planRetention(names, 0);
  assert.deepEqual(keep, []);
  assert.deepEqual(remove.sort(), ['mc-1.png', 'mc-2.png']);
});

test('planRetention: 空目录/无匹配 ⇒ 空计划', () => {
  assert.deepEqual(planRetention([], 5), { keep: [], remove: [] });
  assert.deepEqual(planRetention(['a.txt'], 5), { keep: [], remove: [] });
});
