/**
 * 轮询等待 MC 窗口出现（**替代固定 sleep** —— 用户 2026-09-24 指出"开 MC 花了 6 分钟大部分在发呆"）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/wait-mc.mjs [超时秒=300]
 * 行为：
 *   - 每 1s 检查一次（`listWindows` 评分制），**就绪立即返回**，不傻等
 *   - 打印：首次探测到窗口的耗时、窗口判据、是否前台
 *   - 超时（默认 300s）⇒ 退出码 1（调用方可据此报错，而不是盲目 sleep + 猜）
 */
import { listWindows, scoreWindow, SCORE_THRESHOLD } from '../src/window.ts';

const timeoutSec = Number(process.argv[2] ?? 300);
const t0 = Date.now();
const deadline = t0 + timeoutSec * 1000;

let lastNote = '';
for (;;) {
  const wins = await listWindows();
  const mc = wins.find((f) => scoreWindow(f).score >= SCORE_THRESHOLD && !f.minimized);
  if (mc) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const reasons = scoreWindow(mc).reasons.join(' ');
    console.log(`  ✅ 就绪 ${elapsed}s（轮询，未盲目等待）`);
    console.log(`     窗口: "${mc.title}" ${mc.width}x${mc.height} hwnd=${mc.hwnd} foreground=${mc.foreground}`);
    console.log(`     判据: ${reasons}`);
    process.exit(0);
  }
  const note = `已探测 ${((Date.now() - t0) / 1000).toFixed(0)}s，可见窗口 ${wins.length} 个，暂无 MC 窗口`;
  if (note.slice(0, 8) !== lastNote.slice(0, 8)) {
    // 每 10s 左右报一次进度，避免刷屏
    if (Math.floor((Date.now() - t0) / 1000) % 10 === 0) console.log(`  … ${note}`);
    lastNote = note;
  }
  if (Date.now() > deadline) {
    console.log(`  ❌ 超时 ${timeoutSec}s 仍未发现 MC 窗口（退出码 1）`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
