/**
 * 审计单测：**敏感值绝不入日志** 是安全断言，必须锁住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_PREFIX, formatAudit, summarizeArgs } from '../src/audit.ts';

test('summarizeArgs: token/secret/key/password 一律打码', () => {
  const s = summarizeArgs({ token: 'supersecret123', apiKey: 'sk-abc', password: 'p', endpoint: 'http://x' });
  assert.ok(!s.includes('supersecret123'), `token 不得出现: ${s}`);
  assert.ok(!s.includes('sk-abc'), 'apiKey 不得出现');
  assert.ok(!s.includes('password=p') && s.includes('password=***'), 'password 应打码');
  assert.ok(s.includes('endpoint=http://x'), '非敏感字段应保留');
});

test('summarizeArgs: 长文本截断并标注原长（防刷屏）', () => {
  const long = 'a'.repeat(500);
  const s = summarizeArgs({ text: long }, 50);
  assert.ok(s.length < 120, `应显著短于原文，实际 ${s.length}`);
  assert.ok(s.includes('(500)'), `应标注原始长度: ${s}`);
});

test('summarizeArgs: 对象参数序列化，循环引用不抛', () => {
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  assert.doesNotThrow(() => summarizeArgs({ ops: cyc }));
});

test('formatAudit: 单行、含固定前缀与关键字段（可 grep）', () => {
  const line = formatAudit({ tool: 'walkToward', args: { x: 1, z: 2 }, ok: true, ms: 12.7 });
  assert.ok(line.startsWith(AUDIT_PREFIX), '必须以固定前缀开头（一条 grep 可捞）');
  assert.ok(line.includes('tool=walkToward'));
  assert.ok(line.includes('ok=true'));
  assert.ok(line.includes('ms=13'), '耗时应取整');
  assert.ok(!line.includes('\n'), '必须是单行');
});

test('formatAudit: 失败时带 error 码', () => {
  const line = formatAudit({ tool: 'exec_ops', args: {}, ok: false, ms: 3, error: 'capability_not_granted' });
  assert.ok(line.includes('error=capability_not_granted'));
  assert.ok(line.includes('ok=false'));
});
