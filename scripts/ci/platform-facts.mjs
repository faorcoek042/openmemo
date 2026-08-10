#!/usr/bin/env node
/**
 * 在 **真 runner** 上把 `platform` T-141 §3 里那些标着 `[未验证：需真机]` 的前提
 * 逐条打成事实。
 *
 * ## 为什么需要它
 *
 * T-141 §3 有 49 条平台假设，其中一大半的证据级别是 `[推测]` 或 `[未验证]` ——
 * 因为这台开发机只有 Linux x64。那些条目不是"没人去查"，是**本机查不了**。
 * 现在有 macOS / Windows runner 了，这个脚本就是去把它们查掉。
 *
 * ## 它**不是**门禁
 *
 * 它只打印事实，永远 exit 0。**判定留给读日志的人**，因为这些性质里有一部分
 * 「是什么样」本身就是待查的，写成断言等于先入为主。
 * 真正的红绿由同一个 job 里的 `pnpm -r test` 决定。
 *
 * ## 安全边界（PROTOCOL §9）
 *
 * 全部临时文件写在 `os.tmpdir()/openmemo-facts-<pid>` 下，跑完删。
 * **绝不碰** `~/.local/share/openmemo/datadir.json`，不写 `$HOME`，不起服务，不占端口。
 * 判据用的是 §9-bis 那条：把它 kill -9 在最坏的一行上，机器上只会剩一个 tmp 目录。
 */
import {
  mkdtempSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  chmodSync,
  statSync,
  symlinkSync,
  linkSync,
  rmSync,
  mkdirSync,
  readdirSync,
  cpSync,
  accessSync,
  constants,
} from 'node:fs';
import { tmpdir, homedir, release, cpus } from 'node:os';
import { join, sep, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const out = [];
const fact = (id, value, note = '') => out.push({ id, value, note });
const tryIt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, value: `${e.code ?? ''} ${e.message}`.trim() };
  }
};

const ROOT = mkdtempSync(join(tmpdir(), 'openmemo-facts-'));

// ── 0. 基线 ────────────────────────────────────────────────────────────────────────
fact('0.platform', `${process.platform}/${process.arch}`);
fact('0.node', process.version);
fact('0.os.release', release());
fact('0.cpus', String(cpus().length));
fact('0.tmpdir', tmpdir());
fact('0.path.sep', JSON.stringify(sep));
fact('0.homedir.exists', String(!!homedir()));

// ── 1. 大小写不敏感文件系统（T-141 §3 第 7 条 / assetPaths.ts:49）────────────────
// platform 在本机用 mkfs.vfat 造过一个，但**真机上的默认文件系统是不是不敏感**没验过。
{
  const d = join(ROOT, 'caseTest');
  mkdirSync(d);
  writeFileSync(join(d, 'Rec.wav'), 'RIFFDATA');
  const lower = tryIt(() => {
    const fd = openSync(join(d, 'rec.wav'), 'r');
    const buf = Buffer.alloc(8);
    readSync(fd, buf, 0, 8, 0);
    closeSync(fd);
    return buf.toString();
  });
  fact(
    '1.fs.case-insensitive',
    String(lower.ok),
    lower.ok ? `open('rec.wav') 读到 ${lower.value}` : `open('rec.wav') -> ${lower.value}`,
  );
  // assetPaths.ts:49 的判定逻辑（大小写敏感前缀比较）在这个文件系统上会怎样
  const rootAbs = d;
  const asWritten = join(d.toUpperCase() === d ? d : d, 'Rec.wav');
  const asStored = asWritten.replace('Rec.wav', 'rec.wav');
  const inside = (p) => p === rootAbs || p.startsWith(rootAbs + sep);
  fact('1.prefix-check(differing case)', String(inside(asStored)), `startsWith 比较：${asStored}`);
}

// ── 2. 可执行位（T-141 §3 第 10 条 / installer.ts:286）──────────────────────────
{
  const f = join(ROOT, 'binlike');
  writeFileSync(f, '#!/bin/sh\necho hi\n');
  const chmodRes = tryIt(() => {
    chmodSync(f, 0o755);
    return (statSync(f).mode & 0o777).toString(8);
  });
  fact('2.chmod(0o755)->mode', String(chmodRes.value), chmodRes.ok ? '' : 'chmod 抛了');
  const xok = tryIt(() => {
    accessSync(f, constants.X_OK);
    return 'X_OK 通过';
  });
  fact('2.access(X_OK)', String(xok.ok), String(xok.value));
}

// ── 3. 0o600 语义（T-141 §3 第 23 条：runtime.json 里有 token）─────────────────
{
  const f = join(ROOT, 'secret.json');
  writeFileSync(f, '{"token":"x"}', { mode: 0o600 });
  fact(
    '3.write(mode 0o600)->mode',
    (statSync(f).mode & 0o777).toString(8),
    'Windows 上 POSIX 位被忽略 → 期望看到 666/644 之类',
  );
}

// ── 4. 符号链接 / 硬链接（T-141 §3 第 13 条：move.ts:470 是唯一没有回退的那条）──
{
  const target = join(ROOT, 'linkTarget');
  writeFileSync(target, 'x');
  const sym = tryIt(() => {
    symlinkSync(target, join(ROOT, 'aSymlink'));
    return 'created';
  });
  fact('4.symlink()', String(sym.ok), String(sym.value));
  const hard = tryIt(() => {
    linkSync(target, join(ROOT, 'aHardlink'));
    return 'created';
  });
  fact('4.link()  [hardlink]', String(hard.ok), String(hard.value));

  // move.ts:470 用的正是这一条：fs.cp(recursive, verbatimSymlinks)
  const srcDir = join(ROOT, 'cpSrc');
  mkdirSync(srcDir);
  writeFileSync(join(srcDir, 'a.txt'), 'a');
  if (sym.ok) tryIt(() => symlinkSync(target, join(srcDir, 'inner-link')));
  const cpRes = tryIt(() => {
    cpSync(srcDir, join(ROOT, 'cpDst'), { recursive: true, verbatimSymlinks: true });
    return 'copied';
  });
  fact('4.cp(verbatimSymlinks) with a symlink inside', String(cpRes.ok), String(cpRes.value));
}

// ── 5. 入口守卫的 file:// 拼法（T-141 §3 第 1 条 / main.ts:1075）────────────────
{
  const p = join(ROOT, 'my dir', 'main.js');
  const handRolled = `file://${p}`;
  const correct = pathToFileURL(p).href;
  fact(
    '5.`file://`+path === pathToFileURL()',
    String(handRolled === correct),
    `手拼=${handRolled}  正确=${correct}`,
  );
}

// ── 6. 路径分隔（T-141 §3 第 26 条 / migrateAssets.ts:93 的 abs.split('/')）──────
{
  const p = join('dd', 'tmp', 'job', 'a.wav');
  fact(
    '6.join(...).split("/").length',
    String(p.split('/').length),
    `p=${p}（Linux 期望 4；Windows 期望 1 → matchBySuffix 永远匹配不上）`,
  );
  fact('6.isAbsolute("/media/x.wav")', String(isAbsolute('/media/x.wav')));
  fact('6.isAbsolute("C:\\\\data\\\\x.wav")', String(isAbsolute('C:\\data\\x.wav')));
  fact('6.resolve("C:\\\\d\\\\m\\\\r.wav")', resolve('C:\\d\\m\\r.wav'));
}

// ── 7. 外部命令是否存在（T-141 §3 第 2/21/24/30/31 条）─────────────────────────
for (const [bin, args] of [
  ['sh', ['-c', 'echo ok']],
  ['bash', ['-c', 'echo ok']],
  ['openssl', ['version']],
  ['taskkill', ['/?']],
  ['find', ['--version']],
  ['zip', ['-v']],
  ['7z', ['i']],
]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', shell: false, timeout: 15000 });
  const first = (r.stdout || r.stderr || '').split(/\r?\n/)[0]?.slice(0, 90) ?? '';
  fact(`7.${bin}`, r.error ? `NOT FOUND (${r.error.code})` : `exit=${r.status}`, first);
}

// ── 8. bash 版本（T-145：macOS 的 /bin/bash 是 3.2，空数组 + set -u 会炸）───────
{
  const r = spawnSync('bash', ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8', timeout: 15000 });
  fact('8.bash --version', (r.stdout || '').trim() || 'n/a');
  const r2 = spawnSync(
    'bash',
    ['-c', 'set -u; A=(); echo "count=${#A[@]}"; echo "expand=[${A[@]}]"'],
    {
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  fact(
    '8.set -u + empty array expansion',
    `exit=${r2.status}`,
    ((r2.stdout || '') + (r2.stderr || '')).replace(/\r?\n/g, ' | ').trim(),
  );
}

// ── 9. GPU 枚举：**advisory 那一层在这个平台上到底返回什么**（T-195）─────────────
//
// 起因：用户真机 win32/x64 10.0.26200，AMD Ryzen 7 7840HS **w/ Radeon 780M Graphics**，
// 硬件卡写着「未检测到可用 GPU」。三种可能被压成了同一句话：
//   ① 真的没有 GPU  ② 有 GPU 但我们支持不了  ③ **我们根本没查到**
// 而本机（开发容器）只有 Linux、没有显卡，`gpu.ts` 里 Windows 那一段的抬头就写着
// `UNVERIFIED — no Windows machine available`。这一节就是去把它变成事实。
//
// ⚠️ **CI 的 Windows runner 大概率也没有真 GPU** —— 它是「真的没有」那一档的**对照组**，
//    能证明的是「这条命令在 win32 上到底跑不跑得起来、返回什么形状」，
//    **不能**拿它冒充用户那台有 780M 的机器。
{
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 20000 },
    );
    // 原文照抄，不解析 —— 解析器对不对是另一回事，先把**真实返回值**留在日志里
    fact(
      '9.Get-CimInstance Win32_VideoController',
      `exit=${ps.status}`,
      ((ps.stdout || '') + (ps.stderr || '')).replace(/\r?\n/g, ' | ').slice(0, 900).trim() ||
        '(empty)',
    );
    // 单个适配器时 CIM 返回**对象**而不是数组 —— 我们的解析器靠 `Array.isArray` 兜这一层，
    // 这条把"到底是哪一种"记下来，免得又靠推理。
    const t = (ps.stdout || '').trim();
    fact(
      '9.CIM JSON top-level',
      t.startsWith('[') ? 'array' : t.startsWith('{') ? 'object' : 'neither',
    );
    const smi = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    fact(
      '9.nvidia-smi',
      `exit=${smi.status ?? 'spawn-failed'}`,
      (smi.stdout || smi.error?.message || '').trim().slice(0, 200),
    );
  } else if (process.platform === 'linux') {
    let cards;
    try {
      cards =
        readdirSync('/sys/class/drm')
          .filter((d) => /^card\d+$/.test(d))
          .join(',') || '(none)';
    } catch (e) {
      cards = `unreadable: ${e.code ?? e.message}`;
    }
    fact('9./sys/class/drm cards', cards);
  } else {
    const sp = spawnSync(
      'system_profiler',
      ['-json', '-detailLevel', 'mini', 'SPDisplaysDataType'],
      {
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    fact(
      '9.system_profiler SPDisplays',
      `exit=${sp.status}`,
      (sp.stdout || '').replace(/\r?\n/g, ' ').slice(0, 400).trim(),
    );
  }
}

rmSync(ROOT, { recursive: true, force: true });

const w = Math.max(...out.map((o) => o.id.length));
console.log('');
console.log(`===== platform facts on ${process.platform}/${process.arch} =====`);
for (const o of out) console.log(`  ${o.id.padEnd(w)}  ${String(o.value).padEnd(22)} ${o.note}`);
console.log('===== end platform facts =====');
console.log('');
// 永远 exit 0：这是仪表，不是门禁（红绿由同 job 的 pnpm -r test 决定）。
