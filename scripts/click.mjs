/**
 * 窗口内点击工具（配合 l0-e2e 的窗口定位使用）
 *
 * 用法：`node --experimental-strip-types scripts/click.mjs <winX> <winY> [purpose]`
 *   winX/winY = **窗口内相对坐标**（与抓到的截图同尺度，1:1）
 * 行为：找 MC 窗口 → 调前台 → 把光标移到该点 → 左键单击 → 打印实际屏幕坐标
 * 说明：故意**不做**多点连击/拖拽（避免误操作），一次一个点击，便于逐步确认。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findMinecraftWindow } from '../src/window.ts';
import { restoreAndFocus } from '../src/focus.ts';

const execFileAsync = promisify(execFile);

const [xArg, yArg, ...purposeParts] = process.argv.slice(2);
const purpose = purposeParts.join(' ').trim() || '(未注明)';
const rx = Number(xArg);
const ry = Number(yArg);
if (!Number.isFinite(rx) || !Number.isFinite(ry)) {
  console.log('  用法: node --experimental-strip-types scripts/click.mjs <winX> <winY> "目的"');
  process.exit(2);
}

const win = await findMinecraftWindow();
if (!win) {
  console.log('  ❌ 未找到 MC 窗口');
  process.exit(1);
}
console.log(`  目标窗口: "${win.title}" ${win.width}x${win.height} @(${win.left},${win.top}) score=${win.score}`);

if (!win.foreground) {
  const f = await restoreAndFocus(win.hwnd);
  console.log(`  调前台: ok=${f.ok} fg=${f.foreground || '(空)'}`);
  await new Promise((r) => setTimeout(r, 1200));
}

const sx = win.left + Math.round(rx);
const sy = win.top + Math.round(ry);
if (rx < 0 || ry < 0 || rx > win.width || ry > win.height) {
  console.log(`  ⚠️ 坐标 (${rx},${ry}) 超出窗口范围 ${win.width}x${win.height}，仍尝试`);
}

const script = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
}
'@
[M]::Click(${sx}, ${sy})
Write-Output 'CLICKED'
`;
const { stdout } = await execFileAsync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { windowsHide: true },
);
console.log(`  点击 (${rx},${ry}) → 屏幕(${sx},${sy}) · ${stdout.trim()} · 目的: ${purpose}`);
