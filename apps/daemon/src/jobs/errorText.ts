/**
 * job 失败时**说给用户听的那两句话** —— 中英各一份，全 daemon 只有这一处产。
 *
 * ## 为什么需要它（两个都是实测出来的缺陷，不是整理癖）
 *
 * ### ① `messageZh` 曾经就是英文原文
 *
 * `jobs/events.ts` 的 `pipelineJobOf()` 原来是这么写的：
 *
 * ```ts
 * error: row.error_code ? {
 *   code: row.error_code,
 *   message:   row.error_detail ?? row.error_code,
 *   messageZh: row.error_detail ?? row.error_code,   // ← 同一个英文串
 *   retryable: false,
 * } : null
 * ```
 *
 * 两个字段填的是**同一个英文串**。而消费方（`JobList.tsx`、`JobToaster.tsx`）
 * 都是按界面语言二选一：中文界面读 `messageZh` —— 于是它老老实实渲染出
 * `no media source can handle this input`。契约里 `messageZh` 存在的**全部理由**
 * 就是"这句话已经翻译好了"，而这里等于宣称翻译好了然后交出原文。
 * 不会有任何测试变红，因为字段确实存在、类型也对。
 *
 * ### ② 错误自带的补救说明在离终点一步的地方被丢掉
 *
 * `NoMediaSourceError` 带着一个 `remediation` 字符串，`media/registry.ts` 为它
 * 认真写了三种措辞（换直链 / 换 RSS / 从本机导入，外加"每个候选适配器分别为什么不行"）。
 * `scheduler.ts` 的 catch 里只有一句 `err.message` —— 而 `NoMediaSourceError.message`
 * 是**写死的** `no media source can handle this input`，**信息量为零**。
 * 也就是说：适配器把"该怎么办"算出来了，调度器把它扔了，用户拿到一句
 * 既看不懂、也做不了任何事的英文。
 *
 * ## 判据
 *
 * **任何一句提示语，都不许说一件它并不知道的事。**
 *   · 认得出的失败 → 给一句真的中文，外加原始技术细节（标注成"技术细节"，不冒充中文）；
 *   · 认不出的失败 → 如实说"任务失败"并把原文附上。**不编**一句像模像样的中文诊断。
 *
 * ## 为什么写入方与读取方要共用这里
 *
 * `scheduler.ts` 发 SSE（`job.failed`）时手里有**活的 Error 对象**（能读 `.remediation`）；
 * `events.ts` 序列化 `/api/jobs` 时手里只有**库里那两列**（`error_code` / `error_detail`）。
 * 两条路必须给出同一句话，否则右下角的 toast 和任务中心那一行会各说各的。
 * 做法是：调度器把**已经拼好的完整英文**落进 `error_detail`，两边再用同一个
 * `jobErrorTextOf(code, detail)` 从它派生中文 —— 于是两处天然一致，
 * 且不需要给 `jobs` 表加列（迁移在本轮之外）。
 */
import { NoMediaSourceError } from '@openmemo/pipeline';

/** 一次失败的完整说法。 */
export interface JobErrorText {
  /** 落进 `jobs.error_code`。 */
  code: string;
  /** 落进 `jobs.error_detail`，也是 SSE 的 `error.message`。**英文/技术原文。** */
  message: string;
  /** SSE 与 REST 的 `error.messageZh`。**真的中文**，由 `code` + `message` 派生。 */
  messageZh: string;
  /** 交给 `queue.fail()`：true 时退避后回 `queued` 再试，false 时直接终态 `failed`。 */
  retryable: boolean;
}

/**
 * 瞬时错误可重试；参数/格式类错误不重试（D-01 §4.7）。
 *
 * ⚠️ 从 `scheduler.ts` 原样搬过来，**判据一个字没改**。搬家的理由是"哪些错误算终态"
 * 与"终态错误该怎么说"必须在同一个文件里对得上：`notes.status` 的读时自愈判的正是
 * `jobs.state === 'failed'`，而只有这个函数回 false 时才会真的落到那个状态。
 * 两者分居两处的话，改其中一个不会有任何东西提醒你另一个的含义也变了。
 */
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EBUSY|socket hang up|timeout/i.test(msg)) return true;
  if (/not found|unsupported|invalid|forbidden|refused|guard/i.test(msg)) return false;
  return false;
}

/**
 * 认得出的错误码 → 中文说法。
 *
 * `detail` 是那条错误的英文原文（含被抢救回来的 remediation）。这里**把它标注成
 * 「技术细节」再附上**，而不是塞进句子里假装它是中文的一部分 ——
 * 我们确实只有英文的那一份，如实呈现比缝进中文里更诚实，也更好排查。
 */
type ZhOf = (detail: string) => string;

/*
 * 兜底。**刻意还是把英文原文摆出来** —— 认不出的失败我们只有这一句话，
 * 编一句"网络异常，请稍后重试"之类的通用中文会同时做到两件坏事：
 * 说了一件不知道真假的事，且把唯一能用来排查的线索藏起来。
 */
const ZH_FALLBACK: ZhOf = (detail) => `任务失败：${detail}`;

const ZH_BY_CODE: Record<string, ZhOf> = {
  /*
   * `NoMediaSourceError`。中文那句说的是**我们确实知道**的那部分：
   * 没有任何一个媒体适配器能读这个输入，可换直链 / 播客 RSS / 从本机导入。
   * 这三条来自 `media/registry.ts` 的 `DEFAULT_REMEDIATION`，不是这里发明的。
   */
  NO_MEDIA_SOURCE: (detail) =>
    '没有可用的媒体来源能读取这个输入 —— 可以换成直链音视频文件、播客 RSS，' +
    `或者直接从本机导入文件。技术细节：${detail}`,
  NO_HANDLER: (detail) => `未知任务类型，daemon 里没有注册它的处理器。技术细节：${detail}`,
  CANCELLED: () => '任务已取消',
  RUNNER_ERROR: ZH_FALLBACK,
};

/**
 * `jobs.error_code` + `jobs.error_detail` → 可直接展示的两份文案。
 *
 * **读取方专用**（`/api/jobs` 的序列化、笔记详情的 `lastFailure`）：它只有库里那两列。
 * 认不出的 code 走 `RUNNER_ERROR` 那一档的措辞 —— 那是如实的"我不认识这个失败"，
 * 不是兜底成某个看起来合理的诊断。
 */
export function jobErrorTextOf(
  code: string | null,
  detail: string | null,
): { message: string; messageZh: string } {
  const message = detail?.trim() || code || '未知错误';
  const zh = (code === null ? undefined : ZH_BY_CODE[code]) ?? ZH_FALLBACK;
  return { message, messageZh: zh(message) };
}

/**
 * runner 抛出来的东西 → 一次失败的完整说法。
 *
 * **写入方专用**（`scheduler.ts` 的 catch）：只有这里还握着活的 Error 对象，
 * 也只有这里能把 `NoMediaSourceError.remediation` 抢救进 `message` ——
 * 一旦落库就只剩两个 TEXT 列，那份补救说明就永远找不回来了。
 */
export function describeRunnerError(err: unknown): JobErrorText {
  const raw = err instanceof Error ? err.message : String(err);

  if (err instanceof NoMediaSourceError) {
    /*
     * ★ `NoMediaSourceError.message` 是**写死的常量**（`no media source can handle
     * this input`），真正有用的东西全在 `remediation` 里：换什么来源、以及
     * 每个候选适配器**分别**为什么不行（`yt-dlp: not installed` 这种）。
     * 拼进 `message` 是唯一能让它活过落库那一步的做法。
     */
    const remediation = err.remediation.trim();
    const message = remediation ? `${raw}. ${remediation}` : raw;
    return {
      code: 'NO_MEDIA_SOURCE',
      message,
      messageZh: jobErrorTextOf('NO_MEDIA_SOURCE', message).messageZh,
      // 换个镜像重试帮不上忙：没有适配器认领这个输入，再跑一次结论一样。
      retryable: false,
    };
  }

  return {
    code: 'RUNNER_ERROR',
    message: raw,
    messageZh: jobErrorTextOf('RUNNER_ERROR', raw).messageZh,
    retryable: isRetryable(err),
  };
}
