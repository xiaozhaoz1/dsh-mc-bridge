/**
 * 纯逻辑单测（不需要 dsh、不需要 mod）：退避序列 / SSE 解析 / 停止矩阵 / 配置校验。
 * 跑法：`node --test test/`（Node ≥22 原生跑 TS）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextBackoff, parseSseFrame, shouldStopOnStatus } from '../src/bridge.ts';
import { DEFAULTS, canEnable, isLoopbackEndpoint, maskToken, validateConfig } from '../src/config.ts';

// ── 退避序列（2s→4s→8s→16s→30s 封顶）─────────────────────────────────────
test('nextBackoff: 指数退避并封顶', () => {
  const seq = [0, 1, 2, 3, 4, 5].map((n) => nextBackoff(n, 2000, 30000));
  assert.deepEqual(seq, [2000, 4000, 8000, 16000, 30000, 30000]);
});

test('nextBackoff: 自定义上下限生效', () => {
  assert.equal(nextBackoff(0, 500, 1000), 500);
  assert.equal(nextBackoff(3, 500, 1000), 1000);
});

// ── SSE 解析 ─────────────────────────────────────────────────────────────
test('parseSseFrame: 标准帧（event+data+id）', () => {
  const f = parseSseFrame('event: say\nid: 42\ndata: {"text":"你好"}');
  assert.deepEqual(f, { event: 'say', id: '42', data: '{"text":"你好"}' });
});

test('parseSseFrame: 多行 data 合并', () => {
  const f = parseSseFrame('event: x\ndata: a\ndata: b');
  assert.equal(f?.data, 'a\nb');
});

test('parseSseFrame: 注释/空帧 ⇒ null（不丢帧也不误报）', () => {
  assert.equal(parseSseFrame(': keep-alive\n'), null);
  assert.equal(parseSseFrame(''), null);
  assert.equal(parseSseFrame('event: ping'), null, '无 data 不算事件');
});

test('parseSseFrame: 缺 event ⇒ 默认 message', () => {
  assert.equal(parseSseFrame('data: {}')?.event, 'message');
});

test('parseSseFrame: data 中的冒号与空格不被吞', () => {
  const f = parseSseFrame('data: {"url":"http://x:25580/stream"}');
  assert.equal(f?.data, '{"url":"http://x:25580/stream"}');
});

// ── 停止矩阵（401 不无限重试）────────────────────────────────────────────
test('shouldStopOnStatus: 401/403/4xx 停止，5xx 允许重连', () => {
  assert.equal(shouldStopOnStatus(401), true);
  assert.equal(shouldStopOnStatus(403), true);
  assert.equal(shouldStopOnStatus(404), true);
  assert.equal(shouldStopOnStatus(400), true);
  assert.equal(shouldStopOnStatus(500), false);
  assert.equal(shouldStopOnStatus(502), false);
});

// ── 配置校验 ─────────────────────────────────────────────────────────────
test('validateConfig: 空配置 ⇒ 全默认且无问题', () => {
  const v = validateConfig({});
  assert.deepEqual(v.config, DEFAULTS);
  assert.equal(v.problems.length, 0);
  assert.equal(canEnable(v), false, '默认 enabled=false ⇒ 不可启用');
});

test('validateConfig: 非法类型逐字段回落并记录原因', () => {
  const v = validateConfig({
    enabled: 'yes',            // 非布尔
    endpoint: 'ftp://x',        // 非 http/https
    reconnectMinMs: -1,         // 越界
    rateLimit: { say: 'fast' }, // 非数字
  });
  assert.equal(v.config.enabled, DEFAULTS.enabled);
  assert.equal(v.config.endpoint, DEFAULTS.endpoint);
  assert.equal(v.config.reconnectMinMs, DEFAULTS.reconnectMinMs);
  assert.equal(v.config.rateLimit.say, DEFAULTS.rateLimit.say);
  assert.ok(v.problems.length >= 4, '每条回落都要能说清');
});

test('validateConfig: allowTiers 白名单，未知层丢弃', () => {
  const v = validateConfig({ allowTiers: ['act.tier1', 'act.hack', 42] });
  assert.deepEqual(v.config.allowTiers, ['act.tier1']);
  assert.equal(v.problems.filter((p) => p.includes('allowTiers')).length, 2);
});

test('validateConfig: min>max 自动交换并告警', () => {
  const v = validateConfig({ reconnectMinMs: 20000, reconnectMaxMs: 5000 });
  assert.ok(v.config.reconnectMinMs <= v.config.reconnectMaxMs);
  assert.ok(v.problems.some((p) => p.includes('交换')));
});

test('安全门: 非回环 + 无 token ⇒ 拒绝启用（不静默放行）', () => {
  const v = validateConfig({ enabled: true, endpoint: 'https://cloud.example.com' });
  assert.equal(canEnable(v), false);
  assert.ok(v.problems.some((p) => p.startsWith('⛔')));
});

test('安全门: 非回环 + 有 token ⇒ 允许启用', () => {
  const v = validateConfig({ enabled: true, endpoint: 'https://cloud.example.com', token: 'secret1234' });
  assert.equal(canEnable(v), true);
});

test('安全门: 回环无需 token', () => {
  const v = validateConfig({ enabled: true, endpoint: 'http://127.0.0.1:25580' });
  assert.equal(canEnable(v), true);
});

test('isLoopbackEndpoint: 识别回环写法', () => {
  assert.equal(isLoopbackEndpoint('http://127.0.0.1:25580'), true);
  assert.equal(isLoopbackEndpoint('http://localhost:1'), true);
  assert.equal(isLoopbackEndpoint('http://[::1]:1'), true);
  assert.equal(isLoopbackEndpoint('http://192.168.1.5:25580'), false);
  assert.equal(isLoopbackEndpoint('不是URL'), false);
});

test('maskToken: 绝不泄露完整 token', () => {
  assert.equal(maskToken(''), '(空)');
  assert.equal(maskToken('abcdefgh'), 'abcd***');
  assert.ok(!maskToken('supersecret').includes('supersecret'));
});
