/**
 * `notes.body_text` 的**存量回填**（#87 的另一半）。
 *
 * ## 为什么必须有这一步 —— #87 只修了「以后」
 *
 * `c58c2dc` 让时间锚点（`timeAnchor`）能进纯文本投影了，于是也能进 FTS 索引了。
 * 但那个修复**只在 `PATCH /api/notes/:uid` 走一遍时才生效**：
 *
 *   · `extractPlainText()` 全仓**只有一个产品调用方** —— `http/rest/content.ts` 的
 *     PATCH 分支（`body.bodyJson !== undefined` 那一支）；
 *   · `notes.body_text` 全仓**只有一个写入方** —— `db/noteContentRepo.ts` 的
 *     `updateNoteContent()`，而它同样只从那个 PATCH 到达。
 *   · **没有导入路径、没有转写完成路径、也没有启动重建**在写这一列。
 *
 * `[浏览器实测]` 三阶段对照，每一步都是真的 `GET /api/search`：
 *
 * | 构建 | 笔记有没有被重新保存过 | 搜 `0:39` |
 * | --- | --- | --- |
 * | 旧构建 | — | **0 命中** |
 * | 新构建（含 #87） | **没有** | **仍然 0 命中** |
 * | 新构建 | 手工重存了一次 | 命中 |
 *
 * 也就是说：**升级之后不重存，存量笔记里的锚点照样搜不到** —— 而用户没有任何理由
 * 知道自己需要去把每条笔记都打开再存一遍。把这件事写进发布说明不是出路，
 * 那是**请用户替我们手工做数据迁移**。所以这里做回填。
 *
 * ## 为什么是启动期的 JS 任务，不是 `packages/db/migrations/NNNN_*.sql`
 *
 * 判过三条路：
 *
 * 1. **SQL 迁移文件** —— 做不到。投影是 `extractPlainText()`（`db/richText.ts`）这个
 *    **JS 函数**：递归收 `text` 节点、认 `timeAnchor` 这类 atom node、块级补换行、
 *    深度/长度/环保护。SQLite 里没有任何东西能表达它，而在 SQL 里再写一份
 *    近似实现，等于制造第二个会和真实投影漂移的事实来源 —— 那正是 #87 的病因。
 * 2. **`packages/db` 里做**（像 `migrateSearchIndex()` 那样） —— 层次不对。
 *    `extractPlainText()` 住在 `apps/daemon`，而 `packages/db` 不依赖 `apps/*`；
 *    把投影函数注入进去只是把同一段代码换个地方写，还多一层间接。
 * 3. **daemon 启动期的一次性任务** —— 选它。本仓已有先例：
 *    `apps/daemon/src/storage/migrateRecords.ts`（安装记录的格式迁移）就是
 *    「启动时跑、幂等、失败不阻塞、把无法处理的条目如实计数报出来」这一形状。
 *
 * ## `body_text` 是**派生数据**，这一点决定了整个方案的安全性
 *
 * 它在契约上就是 `body_json` 的纯函数（D-02 §1.3，`content.ts` 里那条
 * 「有 `bodyJson` 时 `body_text` 一律由服务端推导」的权威规则）。
 * 所以重算它**不是在改用户输入**，而是在把一个缓存重新算对 ——
 * 和 `migrateSearchIndex()` 里那句 `INSERT INTO <fts>(<fts>) VALUES('rebuild')` 同性质。
 *
 * ## 四条硬约束（每条都对着一个具体的坏结果）
 *
 * · **幂等**：只在「重算结果 ≠ 库里的值」时才 UPDATE。跑第二遍 `updated=0`。
 *   `[实测]` 审计现场那条已经手工重存过的笔记（`01M1RY1FZ38EWNX5GQVW7ZYKBE`），
 *   重算结果与库里逐字相同 ⇒ 它是这条性质的现成对照。
 * · **只动该动的**：`WHERE body_json IS NOT NULL`。纯文本笔记（`kind='plain'`
 *   或任何 `body_json` 为空的笔记）根本不进这个循环，它们的 `body_text` 一个字节都不碰。
 *   `[实测]` 用户库里 8 条笔记，**7 条 `body_json IS NULL`** —— 这一条不是理论风险。
 * · **绝不把有内容的 `body_text` 覆盖成空**：万一某条 `body_json` 投影出空串
 *   （畸形文档、投影器将来收窄），宁可留着旧值、计入 `refused` 报出来，
 *   也不要让一条本来搜得到的笔记因为一次"修复"而搜不到了。
 * · **不动 `updated_at`**：那是用户可见的「最近修改」，笔记列表按它排序。
 *   一次后台的派生数据重算把用户的笔记列表整个搅乱，是比原 bug 更糟的后果。
 *
 * ## FTS 索引不需要单独处理
 *
 * `0002_search.sql` 的 `notes_fts_au` 是 `AFTER UPDATE OF title, body_text, summary_md`，
 * 所以这里的 `UPDATE notes SET body_text = …` **会自动带着影子表一起走**
 * （delete 旧行 + insert 新行）。反过来说：**别在这里额外调 `rebuild`** ——
 * 那既多余又会把整张索引重建的代价加到每次启动上。
 *
 * ⚠️ 顺序前提：本函数必须在 `openAppDatabase()` **返回之后**调用，
 * 因为 FTS 表与触发器是在 `migrateSearchIndex()` 里建的。索引层整个失败时
 * （`search.ok === false`，触发器可能已被 drop 掉）这里的 UPDATE 仍然成功，
 * 只是不会同步索引 —— 那是既定的降级语义，不是本函数要解决的问题。
 *
 * ## 为什么用「指纹」而不是「跑过就不再跑」的布尔
 *
 * 与 `packages/db/src/migrate.ts` 的 `search_index_version` 同一套理由，
 * 而且这里更要紧：**投影器还会变**（#87 就是一次改动，以后认新的 atom node 还会有）。
 * 一个布尔标记会让「投影器改了但存量数据没跟上」重新变成一件没人知道的事 ——
 * 也就是把今天正在修的这个 bug 原样重新制造一遍。
 *
 * 指纹不是手写的版本号（手写的那个一定会有人忘记改），而是
 * **投影器自己对一份固定样本文档的输出**（见 `PROJECTION_CANARY`）：
 * 投影行为一变，指纹自动就变，回填自动重跑。
 *
 * ⚠️ 它的**边界**写在这里，别读成"投影器怎么改都盖得住"：
 * 样本里没出现的节点类型，改了它也不会让指纹变。所以样本必须覆盖投影器的每一类
 * 行为分支，而这一点由 `backfillBodyText.test.ts` 的「样本不许退化」那条守着。
 */
import { createHash } from 'node:crypto';

import type { DatabaseHandle } from '@openmemo/db';
import { TIME_ANCHOR_NODE_TYPE } from '@openmemo/shared';

import { extractPlainText } from './richText.js';

/** `app_meta` 里存投影指纹的键。 */
export const BODY_TEXT_PROJECTION_KEY = 'body_text_projection';

/**
 * 指纹样本：**必须把 `extractPlainText()` 的每一类行为分支都走一遍**。
 *
 * 覆盖：`text` 节点 / 块级节点之间补换行 / `hardBreak` / `attrs` 里的
 * `alt`·`title`·`label` / **可见文字由 attrs 算出来的 atom node（时间锚点）** /
 * 多余空行收敛与首尾裁剪。
 *
 * ⚠️ 加新分支时**这份样本也要加**，否则那次改动不会触发存量回填 ——
 * 而"投影器改了、存量数据留在旧格式"正是本文件要消灭的那个 bug 的形状。
 */
const PROJECTION_CANARY: unknown = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: '甲乙' },
        // 浮点 startMs + quote 为 null：审计现场那条笔记里真实出现的两个细节
        { type: TIME_ANCHOR_NODE_TYPE, attrs: { startMs: 4706.022, quote: null } },
        { type: 'hardBreak' },
        { type: 'text', text: 'tail' },
      ],
    },
    { type: 'paragraph', content: [{ type: 'image', attrs: { alt: 'ALT', title: 'TITLE' } }] },
    { type: 'heading', content: [{ type: 'mention', attrs: { label: '@某人' } }] },
  ],
};

/**
 * 投影器的行为指纹。**不是版本号** —— 是投影器自己算出来的东西的哈希。
 *
 * 前缀 `p1:` 只用来在人眼读 `app_meta` 时认出这是哪种指纹；它变了也一样触发重跑。
 */
export function projectionFingerprint(): string {
  const projected = extractPlainText(PROJECTION_CANARY);
  return `p1:${createHash('sha256').update(projected, 'utf8').digest('hex').slice(0, 16)}`;
}

/** 只导出给测试用：守住「样本不许退化成一个什么都不覆盖的空文档」。 */
export function projectionCanaryText(): string {
  return extractPlainText(PROJECTION_CANARY);
}

export interface BackfillBodyTextResult {
  /** 指纹一致时为 `false`（这一次什么都没扫、什么都没写）。 */
  readonly ran: boolean;
  readonly fingerprint: string;
  /** 读到的、`body_json IS NOT NULL` 的笔记条数。 */
  readonly scanned: number;
  /** 真的写回去了几条（幂等的判据：第二次跑必须是 0）。 */
  readonly updated: number;
  /** 投影出空串、而库里原本有内容 —— **刻意不覆盖**，留着旧值。 */
  readonly refused: number;
  /** `body_json` 不是合法 JSON，原样跳过。 */
  readonly unparsable: number;
  /** 耗时（毫秒），用于判断要不要改成后台跑。 */
  readonly ms: number;
  /** 出错原因。**出错不抛** —— 见下面的契约。 */
  readonly error?: string | undefined;
}

export interface BackfillBodyTextOptions {
  /** 忽略指纹，强制全扫（测试与将来可能的「重建索引」按钮用）。 */
  readonly force?: boolean;
  /** 每批条数。默认 200。 */
  readonly chunkSize?: number;
}

/**
 * 把存量笔记的 `body_text` 重算成当前投影器的输出。
 *
 * **本函数永不抛异常。** 与 `migrateSearchIndex()` 同一条契约：
 * `body_text` 是可重建的派生数据，回填失败的正确后果是**搜索结果不全**，
 * 不是"daemon 起不来"。失败原因落在返回值的 `error` 里，由调用方打印出来 ——
 * **"没跑"和"跑了没事"绝不能长得一样**。
 *
 * 分批 + 每批一个事务（不是一整个大事务）的理由：
 * 用户可能有几千条笔记，每条 `body_json` 可以有几十 KB。一整个事务会把写锁
 * 攥住整个过程、并把全部改动堆在内存里；分批之后每批独立提交，中途出错时
 * **已经修好的那部分留在库里**，而指纹只在全部跑完后才写 ⇒ 下次启动接着修，
 * 不会把已经对了的再改一遍（那一批的重算结果与库里相同，直接跳过）。
 */
export function backfillBodyText(
  db: DatabaseHandle,
  opts: BackfillBodyTextOptions = {},
): BackfillBodyTextResult {
  const started = Date.now();
  const fingerprint = projectionFingerprint();
  const idle = (extra: Partial<BackfillBodyTextResult> = {}): BackfillBodyTextResult => ({
    ran: false,
    fingerprint,
    scanned: 0,
    updated: 0,
    refused: 0,
    unparsable: 0,
    ms: Date.now() - started,
    ...extra,
  });

  try {
    const have = db
      .prepare<{ value: string }>('SELECT value FROM app_meta WHERE key = :k')
      .get({ k: BODY_TEXT_PROJECTION_KEY })?.value;
    if (!opts.force && have === fingerprint) return idle();

    const chunkSize =
      typeof opts.chunkSize === 'number' && opts.chunkSize > 0 ? Math.floor(opts.chunkSize) : 200;

    /*
     * 游标分页（`id > :cursor`）而不是 `LIMIT/OFFSET`：本循环**边读边写**，
     * OFFSET 在这种情况下会因为行序变化而漏行/重复行，而漏掉的那几条不会有任何报错。
     * `id` 是 INTEGER PRIMARY KEY，天然有序且唯一。
     */
    const select = db.prepare<{ id: number; body_json: string; body_text: string | null }>(
      `SELECT id, body_json, body_text FROM notes
       WHERE id > :cursor AND body_json IS NOT NULL
       ORDER BY id LIMIT :limit`,
    );
    /*
     * ⚠️ 只写 `body_text` 一列，**刻意不写 `updated_at`**：那是用户可见的
     * 「最近修改」，笔记列表按它排序。一次后台重算把全部笔记顶到列表最前面，
     * 比原来的搜索缺陷更糟。
     * 索引同步由 `notes_fts_au` 触发器负责（`0002_search.sql`），这里不碰 FTS 表。
     */
    const update = db.prepare('UPDATE notes SET body_text = :bodyText WHERE id = :id');

    let cursor = 0;
    let scanned = 0;
    let updated = 0;
    let refused = 0;
    let unparsable = 0;

    for (;;) {
      const rows = select.all({ cursor, limit: chunkSize });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.id ?? cursor;

      // 计数只在整批提交成功之后才累加 —— 否则回滚掉的那一批会留下假数字
      const batch = db.transaction(() => {
        let u = 0;
        let r = 0;
        let bad = 0;
        for (const row of rows) {
          let doc: unknown;
          try {
            doc = JSON.parse(row.body_json) as unknown;
          } catch {
            // 认不出的 body_json 原样留着：读不出来 ≠ 里面没东西
            bad++;
            continue;
          }
          const next = extractPlainText(doc);
          const current = row.body_text ?? '';
          if (next === current) continue; // ← 幂等就落在这一行
          if (next === '' && current !== '') {
            // 见文件头「绝不把有内容的 body_text 覆盖成空」
            r++;
            continue;
          }
          update.run({ bodyText: next, id: row.id });
          u++;
        }
        return { u, r, bad };
      });

      scanned += rows.length;
      updated += batch.u;
      refused += batch.r;
      unparsable += batch.bad;
    }

    db.prepare(
      `INSERT INTO app_meta(key, value) VALUES (:k, :v)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run({ k: BODY_TEXT_PROJECTION_KEY, v: fingerprint });

    return {
      ran: true,
      fingerprint,
      scanned,
      updated,
      refused,
      unparsable,
      ms: Date.now() - started,
    };
  } catch (err) {
    return idle({ error: err instanceof Error ? err.message : String(err) });
  }
}
