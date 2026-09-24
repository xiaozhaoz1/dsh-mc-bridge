/**
 * dsh-mc-bridge · L0 窗口层（**零依赖**：用 PowerShell 做 Win32 调用）
 *
 * 取证结论（写码依据）：
 *  - ❌ **不用 `PrintWindow`**：对 OpenGL/DirectComposition 窗口（MC 就是）返回**全黑**
 *  - ✅ 用 **屏幕区域抓取 `CopyFromScreen`**（需窗口在前台/未被遮挡）
 *  - ⚠️ 抓图前**必须校验前台窗口句柄 == MC 窗口句柄**，否则会静默抓到遮挡窗口
 *
 * 依赖：仅 Node 内置 `child_process`（Node ≥22），**无第三方包**（插件自包含）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface WindowInfo {
  hwnd: string;
  title: string;
  left: number;
  top: number;
  width: number;
  height: number;
  foreground: boolean;
}

/** MC 窗口标题特征（NeoForge/Forge 均为 "Minecraft*"；大小写不敏感）。 */
const TITLE_HINT = 'minecraft';

async function ps(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * 枚举可见顶层窗口，找出 Minecraft 窗口。
 * @returns 匹配的窗口（多个时取第一个）；找不到返回 null
 */
export async function findMinecraftWindow(): Promise<WindowInfo | null> {
  const script = `
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rr,B; }
  public static List<string> Out = new List<string>();
  public static void Run() {
    var fg = GetForegroundWindow();
    EnumWindows((h,l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h); if (n <= 0) return true;
      var sb = new StringBuilder(n+2); GetWindowText(h, sb, sb.Capacity);
      R r; GetWindowRect(h, out r);
      Out.Add(string.Join("\\t", h.ToString(), sb.ToString().Replace("\\t"," "),
        r.L.ToString(), r.T.ToString(), (r.Rr-r.L).ToString(), (r.B-r.T).ToString(),
        (h==fg?"1":"0"), (IsIconic(h)?"1":"0")));
      return true;
    }, IntPtr.Zero);
  }
}
'@
[W]::Run(); [W]::Out | ForEach-Object { Write-Output $_ }
`;
  let out: string;
  try {
    out = await ps(script);
  } catch {
    return null;
  }
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 8) continue;
    const [hwnd, title, left, top, width, height, fg, minimized] = parts as [
      string, string, string, string, string, string, string, string,
    ];
    if (!title.toLowerCase().includes(TITLE_HINT)) continue;
    if (minimized === '1') continue;
    return {
      hwnd,
      title,
      left: Number(left),
      top: Number(top),
      width: Number(width),
      height: Number(height),
      foreground: fg === '1',
    };
  }
  return null;
}

export interface CaptureResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
}

/**
 * 抓取 MC 窗口区域并落盘为 PNG。
 *
 * @param requireForeground true 时先校验前台窗口（**默认 true**，防抓到遮挡窗口）
 * @param outDir 落盘目录（默认系统临时目录，**不碰用户配置目录**）
 */
export async function captureWindow(
  win: WindowInfo,
  requireForeground = true,
  outDir?: string,
): Promise<CaptureResult> {
  if (win.width <= 0 || win.height <= 0) {
    return { ok: false, error: `窗口尺寸非法: ${win.width}x${win.height}` };
  }
  if (requireForeground) {
    const fg = await ps(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public class F { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
'@
[F]::GetForegroundWindow().ToString()
`);
    if (fg.trim() !== win.hwnd) {
      return { ok: false, error: `前台窗口(${fg.trim()}) != MC 窗口(${win.hwnd})：拒绝抓图以免抓到遮挡窗口` };
    }
  }

  const dir = outDir ?? (await mkdtemp(join(tmpdir(), 'dsh-mc-bridge-')));
  const path = join(dir, `mc-${Date.now()}.png`);
  const script = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap -ArgumentList ${win.width}, ${win.height}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${win.left}, ${win.top}, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'OK'
`;
  try {
    const res = await ps(script);
    if (!res.includes('OK')) return { ok: false, error: '抓图脚本未返回 OK' };
    const buf = await readFile(path);
    return { ok: true, path, bytes: buf.length, width: win.width, height: win.height };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
