/**
 * L0 端到端自测脚本（**写成文件**，不用 `node -e` 内联 —— 内联 TS 剥离不可靠）
 *
 * 流程：严格判据找 MC → 调前台（SW_RESTORE + AttachThreadInput）→ 复查 → 抓图
 * 用法：`node --experimental-strip-types scripts/l0-e2e.mjs`
 * 退出码：0 成功 · 1 未找到窗口 · 2 调前台失败 · 3 抓图失败
 */
import { findMinecraftWindow, listWindows, captureWindow, scoreWindow, restoreOnly } from '../src/window.ts';
import { restoreAndFocus } from '../src/focus.ts';

function line(s) {
  console.log('  ' + s);
}

const all = await listWindows();
line(`可见窗口总数: ${all.length}`);

const ranked = all
  .map((f) => ({ f, s: scoreWindow(f).score }))
  .sort((a, b) => b.s - a.s)
  .slice(0, 5);
line('判据排序前 5（诊断"为什么选它"）:');
for (const { f, s } of ranked) {
  const r = scoreWindow(f).reasons.join(' ');
  line(`  score=${String(s).padStart(3)} cls=${f.className.padEnd(18)} mcCmd=${f.cmdLooksLikeMc ? 'Y' : 'n'} ${r}`);
}

let win = await findMinecraftWindow();
if (!win) {
  line('❌ 未找到 MC 窗口（判据不足）');
  process.exit(1);
}
line(`✅ 选定: "${win.title}" hwnd=${win.hwnd} score=${win.score}`);
line(`   判据: ${win.reasons.join(' ')}`);

if (win.minimized) {
  line('窗口最小化 ⇒ 先恢复（不抢焦点）');
  await restoreOnly(win.hwnd);
  await new Promise((r) => setTimeout(r, 800));
  win = (await findMinecraftWindow()) ?? win;
}

if (!win.foreground) {
  line('窗口不在前台 ⇒ 调前台（AttachThreadInput 绕过前台锁）');
  const f = await restoreAndFocus(win.hwnd);
  line(`  结果 ok=${f.ok} foreground=${f.foreground || '(空)'} api=${f.apiReturned}`);
  await new Promise((r) => setTimeout(r, 1500));
  win = (await findMinecraftWindow()) ?? win;
  if (!win.foreground) {
    line('⚠️ 调前台未成功（Windows 可能仍拒绝）⇒ 尝试 forceFront');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const p = promisify(execFile);
    try {
      const r = await p(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.Interaction]::AppActivate(${win.pid})`,
        ],
        { windowsHide: true },
      );
      line(`  AppActivate 兜底: ${r.stdout.trim() || 'ok'}`);
    } catch (e) {
      line(`  AppActivate 失败: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    win = (await findMinecraftWindow()) ?? win;
  }
  if (!win.foreground) {
    line('❌ 调前台失败（前台仍不是 MC）');
    process.exit(2);
  }
}

const cap = await captureWindow(win, true);
line(`抓图: ${JSON.stringify(cap)}`);
if (!cap.ok) process.exit(3);
line(`✅ 成功：${cap.path} (${cap.width}x${cap.height}, ${cap.bytes}B)`);
line(`   判据: ${win.reasons.join(' ')}`);
