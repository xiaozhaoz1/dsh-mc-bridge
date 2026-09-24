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
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr h, bool alt);
  public const byte VK_MENU = 0x12;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public static readonly uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public static string Go(IntPtr target) {
    // ① 若最小化先恢复
    if (IsIconic(target)) { ShowWindow(target, 9); System.Threading.Thread.Sleep(120); }
    // ② ⭐ ALT 键技巧：模拟一次真实用户输入，取得"前台权限"
    //    实测：单独用 AttachThreadInput/SetForegroundWindow 会被 Windows 拒绝；
    //    先发一个 ALT 键（keybd_event）后 SetForegroundWindow 即成功（实测 ok=True）。
    keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
    System.Threading.Thread.Sleep(90);
    bool api = SetForegroundWindow(target);
    if (GetForegroundWindow() != target) {
      // ③ 兜底一：SwitchToThisWindow（未文档化但常有效）
      SwitchToThisWindow(target, true);
      System.Threading.Thread.Sleep(220);
    }
    if (GetForegroundWindow() != target) {
      // ④ 兜底二：最小化→恢复（强制激活）
      ShowWindow(target, 6);
      System.Threading.Thread.Sleep(160);
      ShowWindow(target, 9);
      System.Threading.Thread.Sleep(260);
      SetForegroundWindow(target);
    }
    if (GetForegroundWindow() != target) {
      // ⑤ 兜底三：TOPMOST 弹一下再取消
      SetWindowPos(target, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      SetWindowPos(target, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      SetForegroundWindow(target);
      BringWindowToTop(target);
    }
    var now = GetForegroundWindow();
    return (now == target ? "OK" : "FAILED") + "|" + now + "|" + target + "|" + (api ? "1" : "0");
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
