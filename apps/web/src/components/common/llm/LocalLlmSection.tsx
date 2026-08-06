import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Radar } from 'lucide-react';

import { Button } from '../Button';
import { Emphasis } from '../Emphasis';
import { ErrorBlock } from '../ErrorBlock';
import { useLlmDetectMutation, type LlmProviderConfig } from './api';

/**
 * 「本地模型」折叠组 —— **D-10 §4.2 / #3，T-153 才第一次真的做得出来**。
 *
 * ## 为什么这一格空了这么久
 *
 * `detectLocalBackends()` 很早就写好了，但它只在 `jobs/runners/mindmap.ts` 与
 * `rest/selfcheck.ts` **内部**被调用 —— 没有任何 HTTP 端点，**前端够不着**。
 * `frontend-truth` T-150 做完了 D-10 六项里的五项，第 6 项就卡在这里，
 * 它的判断是对的：**没有端点，做出来只能是个假按钮。**
 * T-153 补上了 `POST /api/llm/detect`，这个组件是它的消费方。
 *
 * ## 三条判据（都不是审美问题）
 *
 * **① "还没探测过" ≠ "没探到"。**
 * 首屏必须说"还没探测过"，而不是"未检测到正在运行的本地服务"。
 * 后者是一句**我们还没有资格说的话** —— 与 ⑤A-2「空集不等于一切正常」同族，
 * 只不过方向相反：这里是**未测被渲染成了已测**。
 *
 * **② 探不到时，必须把"探过哪几个地址"列出来。**
 * 只说"没探到"，用户分不清"我的 Ollama 改过端口"和"我压根没装"——
 * 而这两种情况的下一步动作完全不同。地址与超时值都取自响应，
 * **不在文案里抄一份**（抄一份就会变成第二处事实）。
 *
 * **③ 探到 = 真的问出了模型列表。**
 * 判据在 daemon 侧（`packages/llm/src/detect.ts`：2xx + 合法 JSON + `data` 非空），
 * 教训来自 R-02：端口开着可能是别的服务、僵尸进程、代理。
 * 界面把"它报了几个模型"直接显示出来，让这条判据在用户那里也是可见的。
 */
export function LocalLlmSection({
  configuredIds,
  onAdd,
}: {
  /** 已经配置过的 provider id，用来把"探到了"和"已经加过了"分开说。 */
  configuredIds: readonly string[];
  onAdd: (p: LlmProviderConfig) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detect = useLlmDetectMutation();
  const result = detect.data;

  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="llm-local-section">
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-xs font-medium text-ink-secondary hover:underline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="llm-local-toggle"
      >
        {open ? (
          <ChevronDown className="size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5" aria-hidden />
        )}
        {t('settings.local.title')}
      </button>

      {open ? (
        <div className="mt-2 rounded-md border border-dashed border-line px-3 py-3">
          {/* 词条里带 `**…**` —— 必须走 <Emphasis>，否则用户看到的是两颗裸星号（T-129 那一族） */}
          <Emphasis className="block text-xs text-ink-secondary" text={t('settings.local.intro')} />

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={detect.isPending}
              data-testid="llm-detect"
              onClick={() => detect.mutate()}
            >
              <Radar className="mr-1 size-3.5" aria-hidden />
              {detect.isPending ? t('settings.local.probing') : t('settings.local.probe')}
            </Button>

            {/*
              ★ 三档措辞互不相同，而且**首屏那一档不许说"未检测到"** ——
              我们还没探过，没有资格下这个结论。
            */}
            <span className="text-xs text-ink-muted" data-testid="llm-detect-status">
              {detect.isPending
                ? t('settings.local.probing')
                : !result
                  ? t('settings.local.notProbedYet')
                  : result.detected.length === 0
                    ? t('settings.local.none')
                    : t('settings.local.found', { n: result.detected.length })}
            </span>
          </div>

          {detect.isError ? <ErrorBlock error={detect.error} /> : null}

          {/*
            ★ 探过之后，无论探到没探到，都把**探过哪几个地址**列出来。
            地址与超时值全部来自响应 —— 界面不持有第二份候选清单。
          */}
          {result ? (
            <p className="mt-2 text-xs text-ink-muted" data-testid="llm-detect-probed">
              {t('settings.local.probedList', {
                list: result.probed.map((c) => `${c.label} ${c.baseUrl}`).join('、'),
                seconds: (result.timeoutMs / 1000).toFixed(result.timeoutMs % 1000 === 0 ? 0 : 1),
              })}
            </p>
          ) : null}

          {result && result.detected.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-2" role="list" data-testid="llm-detected-list">
              {result.detected.map((d) => {
                const already = configuredIds.includes(d.id);
                return (
                  <li
                    key={d.id}
                    data-testid={`llm-detected-${d.id}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2 py-1.5"
                  >
                    <span className="text-sm text-ink">{d.label}</span>
                    <span className="font-mono text-xs text-ink-muted">{d.baseUrl}</span>
                    {/*
                      ★ 把"它报了几个模型"显示出来：这正是"真发请求确认"这条判据的证据。
                      只说"检测到 Ollama"的话，用户没法区分"探到了服务"和"探到了能用的服务"。
                    */}
                    <span className="text-xs text-good">
                      {t('settings.local.models', { n: d.models.length })}
                    </span>
                    <span className="ml-auto">
                      {already ? (
                        <span className="text-xs text-ink-muted">
                          {t('settings.local.alreadyAdded')}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="primary"
                          data-testid={`llm-detected-add-${d.id}`}
                          onClick={() =>
                            onAdd({
                              id: d.id,
                              /*
                               * 探到的一律走 OpenAI 兼容 —— 判据不是"我猜它是"，
                               * 而是**探测本身就是用 `/v1/models` 问出来的**：
                               * 能这样回答的服务，按定义就有 OpenAI 兼容面。
                               * （目录里 ollama 的 kind 是 `ollama-native`，
                               * 而 `WIRE_KIND_BY_CATALOG_KIND` 把它也映射到这一档。）
                               */
                              kind: 'openai-compatible',
                              label: d.label,
                              baseUrl: d.baseUrl,
                              // 探到的第一个型号先填上，用户可以在上面的卡片里改
                              model: d.models[0] ?? '',
                              isLocal: true,
                            })
                          }
                        >
                          {t('settings.local.add')}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <Emphasis
            className="mt-2 block text-xs text-ink-muted"
            text={t('settings.local.falsePositiveNote')}
          />
        </div>
      ) : null}
    </div>
  );
}
