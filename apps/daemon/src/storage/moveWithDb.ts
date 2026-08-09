/**
 * 「关库 → 搬迁 → 重开」这三步的**顺序编排**。
 *
 * ## 为什么必须关库（这条是实测出来的，不是推理）
 *
 * `[CI 实测 2026-08-09 run 31296921806, windows-2025]`
 * 搬迁本身在 Windows 上**完全没问题**：同卷真 `rename`、跨卷（真 `EXDEV`）
 * `copy` 之后源目录**真的被删掉**。
 *
 * 出问题的是**谁还攥着 `openmemo.db`**：
 * - POSIX 允许 `unlink` 一个仍被打开的文件（目录项先消失，inode 等最后一个 fd 关闭），
 *   所以 Linux / macOS 上开着库搬迁**毫无感觉**；
 * - **Windows 的 SQLite 共享模式不含 `FILE_SHARE_DELETE`** → 删源必然失败。
 *
 * 而 `storage.ts` 此前是**开着库**调 `moveDataDir` 的。合起来的后果：
 * **Windows 用户的每一次搬迁都必然落进「已复制、旧目录仍在」那条分支** ——
 * 不是"可能"，是"必然"。而旧目录里留着明文 `secrets.json`。
 * 用同一个成因（持有真实 better-sqlite3 句柄）注入，Windows 上当场复现。
 *
 * ## 为什么单独抽成一个函数
 *
 * 因为**危险的不是搬迁，是搬迁失败之后**：库已经关了。
 * 如果这时候没能把库重新打开，用户会得到一个"库关了、搬也没搬成、谁也开不了"的
 * daemon —— 那比不搬要糟得多。这条路径**必须能被单元测试穷举**，
 * 而不是靠"在 Windows 上跑一次看起来没事"。
 * 所以这里只依赖注入进来的三个回调，不碰真实的 fs / sqlite。
 *
 * ## 不变量（逐条对应测试）
 *
 * 1. `close()` 抛异常 ⇒ **一步都不许往下走**（库状态未知时搬迁只会更糟），
 *    并且**必须尝试把库开回原位**。
 * 2. 搬迁成功 ⇒ 在**新位置**重开。
 * 3. 搬迁失败（含抛异常）⇒ 在**原位置**重开，且如实报告失败。
 * 4. 在新位置重开失败 ⇒ **退回原位置重开**（数据还在新位置，但至少 daemon 活着）。
 * 5. 连原位置都开不回来 ⇒ `databaseLost = true`。**这一格必须让调用方看得见**，
 *    因为它是唯一一个"用户必须重启才能继续"的状态 —— 不许静默。
 */

export interface MoveWithDbCallbacks<R> {
  /** 关掉当前连接。抛异常表示"没关干净"，此时不许继续搬。 */
  readonly closeDb: () => void;
  /** 在指定 dataDir 重新打开连接。 */
  readonly reopenDb: (dataDir: string) => void;
  /** 真正的搬迁动作。约定：**返回结构化结果，不靠抛异常表达失败**（抛了也接得住）。 */
  readonly move: () => Promise<R>;
  /** 从搬迁结果里读"成没成功"。 */
  readonly succeeded: (r: R) => boolean;
}

export interface MoveWithDbOutcome<R> {
  /** 搬迁结果；`closeDb` 就失败时为 undefined（根本没搬）。 */
  readonly result?: R;
  /** 搬迁到底有没有被执行。 */
  readonly attempted: boolean;
  /** 库最终开在哪个 dataDir；`databaseLost` 时为 null。 */
  readonly reopenedAt: string | null;
  /**
   * 连原位置都没能把库开回来 —— 最糟的一格。
   * 调用方**必须**把它翻译成用户看得懂的话（"请重启"），不许当没发生。
   */
  readonly databaseLost: boolean;
  readonly closeError?: string;
  readonly moveError?: string;
  /** 首选位置重开失败的原因（此时可能已经退回原位重开成功）。 */
  readonly reopenError?: string;
}

export async function moveDataDirWithDatabase<R>(
  from: string,
  to: string,
  cb: MoveWithDbCallbacks<R>,
): Promise<MoveWithDbOutcome<R>> {
  // ── ① 关库。关不干净就一步都不往下走 ──────────────────────────────────────
  try {
    cb.closeDb();
  } catch (err) {
    // 库可能处在半关状态：尽力开回原位，然后如实报告"没搬"
    let reopenedAt: string | null = from;
    let reopenError: string | undefined;
    try {
      cb.reopenDb(from);
    } catch (e2) {
      reopenedAt = null;
      reopenError = String(e2);
    }
    return {
      attempted: false,
      reopenedAt,
      databaseLost: reopenedAt === null,
      closeError: String(err),
      ...(reopenError !== undefined ? { reopenError } : {}),
    };
  }

  // ── ② 搬。约定是返回结构化失败，但抛了也不能让库停在"关着"的状态 ──────────
  let result: R | undefined;
  let moveError: string | undefined;
  try {
    result = await cb.move();
  } catch (err) {
    moveError = String(err);
  }

  const ok = result !== undefined && moveError === undefined && cb.succeeded(result);

  // ── ③ 重开。成功去新位置，失败回原位置 ────────────────────────────────────
  const preferred = ok ? to : from;
  let reopenedAt: string | null = null;
  let reopenError: string | undefined;
  try {
    cb.reopenDb(preferred);
    reopenedAt = preferred;
  } catch (err) {
    reopenError = String(err);
    /*
     * 首选位置开不起来。**数据其实已经在新位置了**（`ok` 为真时），
     * 但开不了就用不了 —— 退回原位置至少让 daemon 活着，
     * 由调用方去告诉用户"数据在新位置，但没能挂上去"。
     */
    if (preferred !== from) {
      try {
        cb.reopenDb(from);
        reopenedAt = from;
      } catch {
        reopenedAt = null;
      }
    }
  }

  return {
    ...(result !== undefined ? { result } : {}),
    attempted: true,
    reopenedAt,
    databaseLost: reopenedAt === null,
    ...(moveError !== undefined ? { moveError } : {}),
    ...(reopenError !== undefined ? { reopenError } : {}),
  };
}
