/**
 * dsh-mc-bridge · L0 窗口层（零依赖：PowerShell + Win32）
 *
 * ## 为什么不靠标题识别窗口（2026-09-24 用户指出 + 本机实测）
 * **dev 环境 / 整合包 / 启动器都会自定义窗口标题** ⇒ 标题不可作硬判据。
 * 实测（本机 dev 窗口）：`类名=GLFW30`（MC 必用 GLFW）· 命令行含 `-Dfml.modFolders`。
 * ⇒ 改**评分制**：
 *   class=GLFW*(+50) · 命令行含 MC 特征(+40) · 进程 java/javaw(+10) · 标题含 minecraft(+20，仅加分)
 *   取最高分且 ≥ 阈值，并**保留判据明细**（诊断"为什么选它"）。
 *
 * ## 截图纪律
 * - ❌ 不用 `PrintWindow`（对 OpenGL/DirectComposition 窗口**全黑**）
 * - ✅ `CopyFromScreen`（要求窗口**前台可见**）
 * - **双闸**：① 前台 hwnd == 目标 hwnd ② 目标 hwnd 必须**通过判据**（score ≥ 阈值）
 * - 失败时**回显 stderr**（教训：只看 stdout 会把失败伪装成无信息）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP_SCREENSHOTS, enforceRetention } from './screenshot-store.ts';

const execFileAsync = promisify(execFile);

/** 候选窗口的原始事实（PowerShell 采集）。 */
export interface WindowFacts {
  hwnd: string;
  title: string;
  className: string;
  pid: number;
  processName: string;
  /** 命令行是否含 MC 特征：`net.minecraft.client.main.Main` / `-Dfml.modFolders` / `--fml.forgeVersion` / `fabric` / `-Dminecraft.` */
  cmdLooksLikeMc: boolean;
  minimized: boolean;
  foreground: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 识别结果（含判据明细）。 */
export interface MatchedWindow extends WindowFacts {
  score: number;
  reasons: string[];
}

/** 通过阈值（任一强判据 50/40 单独不足，但两者都中必过）。 */
export const SCORE_THRESHOLD = 60;

/** 评分（纯函数 ⇒ 可单测）。 */
export function scoreWindow(
  f: Pick<WindowFacts, 'className' | 'cmdLooksLikeMc' | 'processName' | 'title'>,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const cls = f.className.toUpperCase();
  if (cls.startsWith('GLFW') || cls.includes('LWJGL')) {
    score += 50;
    reasons.push(`class=${f.className}(+50)`);
  }
  if (f.cmdLooksLikeMc) {
    score += 40;
    reasons.push('cmd=MC特征(+40)');
  }
  const pn = f.processName.toLowerCase().replace(/\.exe$/, '');
  if (pn === 'java' || pn === 'javaw') {
    score += 10;
    reasons.push(`proc=${f.processName}(+10)`);
  }
  if (/minecraft/i.test(f.title)) {
    score += 20;
    reasons.push('title~minecraft(+20)');
  }
  return { score, reasons };
}

/** 排序取最优（纯函数）：排除最小化/零尺寸；分数 ≥ 阈值；降序取第一。 */
export function pickBest(facts: WindowFacts[], threshold = SCORE_THRESHOLD): MatchedWindow | null {
  const scored: MatchedWindow[] = [];
  for (const f of facts) {
    if (f.minimized || f.width <= 0 || f.height <= 0) continue;
    const { score, reasons } = scoreWindow(f);
    if (score >= threshold) scored.push({ ...f, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
}

/** 采集所有可见顶层窗口的事实（一次 PowerShell 调用）。 */
export async function listWindows(): Promise<WindowFacts[]> {
  const script = String.raw`
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class W2 {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rr,B; }
  public static List<string> Out = new List<string>();
  public static void Run() {
    var fg = GetForegroundWindow();
    EnumWindows((h,l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      var sb = new StringBuilder(n+2); GetWindowText(h, sb, sb.Capacity);
      var cb = new StringBuilder(256); GetClassName(h, cb, cb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      R r; GetWindowRect(h, out r);
      Out.Add(string.Join("\t", h.ToString(), pid.ToString(), cb.ToString(),
        sb.ToString().Replace("\t"," ").Replace("\n"," "),
        r.L.ToString(), r.T.ToString(), (r.Rr-r.L).ToString(), (r.B-r.T).ToString(),
        (h==fg?"1":"0"), (IsIconic(h)?"1":"0")));
      return true;
    }, IntPtr.Zero);
  }
}
'@
[W2]::Run()
$procs = @{}
Get-CimInstance Win32_Process -Filter "Name='java.exe' or Name='javaw.exe'" | ForEach-Object {
  $procs[[int]$_.ProcessId] = @{ n = $_.Name; c = $_.CommandLine }
}
[W2]::Out | ForEach-Object {
  $p = $_ -split "\t"
  $info = $procs[[int]$p[1]]
  $pn = if ($info) { $info.n } else { "" }
  $cl = if ($info -and $info.c) { $info.c } else { "" }
  $isMc = if ($cl -match 'net\.minecraft\.client\.main\.Main|-Dfml\.modFolders|--fml\.forgeVersion|fabric|-Dminecraft\.') { "1" } else { "0" }
  $tab = [char]9
  Write-Output ($_ + $tab + $pn + $tab + $isMc)
}
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const out: WindowFacts[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const p = line.split('\t');
      if (p.length < 12) continue;
      out.push({
        hwnd: p[0]!,
        pid: Number(p[1]),
        className: p[2]!,
        title: p[3]!,
        left: Number(p[4]),
        top: Number(p[5]),
        width: Number(p[6]),
        height: Number(p[7]),
        foreground: p[8] === '1',
        minimized: p[9] === '1',
        processName: p[10] ?? '',
        cmdLooksLikeMc: p[11] === '1',
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** 找 MC 窗口（评分制）。找不到返回 null。 */
export async function findMinecraftWindow(): Promise<MatchedWindow | null> {
  return pickBest(await listWindows());
}

export interface CaptureResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
  /** 失败诊断（前台是谁/判据/脚本 stderr）。 */
  detail?: string;
}

async function foregroundHwnd(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type @'
using System; using System.Runtime.InteropServices;
public class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
'@
[FG]::GetForegroundWindow().ToString()`,
      ],
      { windowsHide: true },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * 抓取目标窗口（**双闸**）。
 * @param expected 必须是 `findMinecraftWindow()` 返回的窗口（含判据）
 * @param requireForeground true ⇒ 前台必须是该窗口（防抓到遮挡窗口）
 */
export async function captureWindow(
  expected: MatchedWindow | WindowFacts,
  requireForeground = true,
  outDir?: string,
): Promise<CaptureResult> {
  if (expected.width <= 0 || expected.height <= 0) {
    return { ok: false, error: `窗口尺寸非法: ${expected.width}x${expected.height}` };
  }
  const { score, reasons } = scoreWindow(expected);
  if (score < SCORE_THRESHOLD) {
    return {
      ok: false,
      error: `拒绝抓图：目标判据不足（score=${score} < ${SCORE_THRESHOLD}）`,
      detail: reasons.join(' ') || '(无任何判据命中)',
    };
  }
  if (requireForeground) {
    const fg = await foregroundHwnd();
    if (fg !== expected.hwnd) {
      return {
        ok: false,
        error: `前台窗口(${fg}) != 目标窗口(${expected.hwnd})，拒绝抓图以免抓到遮挡窗口`,
        detail: `目标判据: ${reasons.join(' ')}`,
      };
    }
  }

  const dir = outDir ?? (await mkdtemp(join(tmpdir(), 'dsh-mc-bridge-')));
  const path = join(dir, `mc-${Date.now()}.png`);
  const script = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap -ArgumentList ${expected.width}, ${expected.height}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${expected.left}, ${expected.top}, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'OK'
`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    if (!stdout.includes('OK')) return { ok: false, error: '抓图脚本未返回 OK', detail: stdout.trim() };
    const buf = await readFile(path);
    // 留存策略：只保留最新 N 张（默认 5）—— 截图是临时诊断产物，防无限累积
    const plan = await enforceRetention(dir, KEEP_SCREENSHOTS);
    return {
      ok: true,
      path,
      bytes: buf.length,
      width: expected.width,
      height: expected.height,
      detail: plan.remove.length ? `已清理旧截图 ${plan.remove.length} 张（保留最新 ${KEEP_SCREENSHOTS}）` : undefined,
    };
  } catch (e) {
    const err = e as { message?: string; stderr?: string; code?: number };
    return {
      ok: false,
      error: err.message ?? String(e),
      detail: `exit=${err.code ?? '?'} stderr=${(err.stderr ?? '').slice(0, 400)}`,
    };
  }
}

/** 恢复最小化（不抢焦点）。 */
export async function restoreOnly(hwnd: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const h = String(hwnd).replace(/[^0-9A-Fa-fx]/g, '');
  try {
    const { stdout } = await execFileAsync(
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
    return { ok: true, detail: stdout.trim() };
  } catch (e) {
    const err = e as { message?: string; stderr?: string };
    return { ok: false, error: err.message ?? String(e), detail: (err.stderr ?? '').slice(0, 300) };
  }
}
