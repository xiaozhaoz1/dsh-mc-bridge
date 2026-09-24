/**
 * dsh-mc-bridge · 窗口前台化（L0 的必需能力）
 *
 * 为什么需要：**界面/渲染类 bug 只能"看着"调**（坐标错位、文字模糊、控件越界…），
 * 所以必须能可靠地把 MC 窗口调到前台；而截图（`CopyFromScreen`）也要求窗口在前台可见。
 *
 * ⚠️ 踩过的坑：直接 `SetForegroundWindow` 会失败 —— Windows 有**前台锁**
 * （后台进程不允许抢焦点，防止弹窗骚扰）。正解是业界标准三步：
 *   ① `ShowWindow(SW_RESTORE)`  —— 若最小化先恢复
 *   ② `AttachThreadInput`        —— 把当前线程挂到目标窗口的输入队列（**绕过前台锁的关键**）
 *   ③ `SetForegroundWindow`（必要时补 `BringWindowToTop` / `SetWindowPos` TOPMOST→NOTOPMOST）
 *
 * 依赖：仅 Node 内置 `child_process` + PowerShell（**零 npm 依赖**）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `SW_*` 常量（Win32 `ShowWindow`）。 */
export const SW = {
  HIDE: 0,
  SHOWNORMAL: 1,
  SHOWMINIMIZED: 2,
  SHOWMAXIMIZED: 3,
  SHOWNOACTIVATE: 4,
  SHOW: 5,
  MINIMIZE: 6,
  SHOWMINNOACTIVE: 7,
  SHOWNA: 8,
  RESTORE: 9,
} as const;

/** 生成"恢复并置前"的 PowerShell 脚本（纯字符串 ⇒ 可单测，无需真窗口）。 */
export function focusScript(hwnd: string | number): string {
  const h = String(hwnd).replace(/[^0-9A-Fa-fx]/g, ''); // 防注入：只留数字/0x 前缀字符
  return `
Add-Type @'
using System; using System.Runtime.InteropServices;
public class Focus {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public static readonly uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
  public static string Go(IntPtr target) {
    // ① 恢复（最小化 ⇒ 还原）
    ShowWindow(target, 9);
    // ② 挂输入队列绕过前台锁
    var fg = GetForegroundWindow();
    uint dummy;
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint targetThread = GetWindowThreadProcessId(target, IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    bool ok = false;
    if (fgThread != 0 && fgThread != myThread) AttachThreadInput(fgThread, myThread, true);
    if (targetThread != 0 && targetThread != myThread) AttachThreadInput(targetThread, myThread, true);
    try {
      ok = SetForegroundWindow(target);
      if (!ok) {
        // 兜底：TOPMOST 弹一下再取消，强制激活
        SetWindowPos(target, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        SetWindowPos(target, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
        ok = SetForegroundWindow(target);
        BringWindowToTop(target);
      }
    } finally {
      if (targetThread != 0 && targetThread != myThread) AttachThreadInput(targetThread, myThread, false);
      if (fgThread != 0 && fgThread != myThread) AttachThreadInput(fgThread, myThread, false);
    }
    var now = GetForegroundWindow();
    return (now == target ? "OK" : "FAILED") + "|" + now + "|" + target + "|" + (ok ? "1" : "0");
  }
}
'@
[Focus]::Go([IntPtr]${h})
`;
}

export interface FocusResult {
  ok: boolean;
  /** 操作后真正的前台窗口句柄（用于对照）。 */
  foreground: string;
  target: string;
  /** `SetForegroundWindow` 本身的返回值（false 但 TOPMOST 兜底成功时仍可能 ok）。 */
  apiReturned: boolean;
  error?: string;
}

/**
 * 恢复（若最小化）+ 置前目标窗口。
 * @param hwnd 目标窗口句柄（十进制或 `0x` 前缀）
 */
export async function restoreAndFocus(hwnd: string | number): Promise<FocusResult> {
  const target = String(hwnd);
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', focusScript(hwnd)],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    const [status, fg = '', tgt = '', api = '0'] = line.split('|');
    return {
      ok: status === 'OK' && fg === tgt,
      foreground: fg,
      target: tgt,
      apiReturned: api === '1',
    };
  } catch (e) {
    return {
      ok: false,
      foreground: '',
      target,
      apiReturned: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 仅恢复（不抢焦点）—— 用于"最小化后想抓图但不想打扰用户"的场景。 */
export async function restoreOnly(hwnd: string | number): Promise<{ ok: boolean; error?: string }> {
  const h = String(hwnd).replace(/[^0-9A-Fa-fx]/g, '');
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type @'
using System; using System.Runtime.InteropServices;
public class SWc { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }
'@
[SWc]::ShowWindow([IntPtr]${h}, 9)`,
      ],
      { windowsHide: true },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
