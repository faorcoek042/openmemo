import { useTranslation } from 'react-i18next';

import { Banner } from './Banner';
import {
  detectBlockedCapabilities,
  httpsEquivalent,
  isSecureContext,
  localhostEquivalent,
} from '../../lib/secure-context';

/**
 * 非安全上下文横幅 —— **说清"什么用不了"和"怎么办"**。
 *
 * 比 `multiTab` 那条重要得多：多标签选主失效只是体验降级，
 * 而**录音转文字在这个地址下完全不能用**，产品此前对此一个字都没说。
 * 用户会点录音、拿到一个 `undefined` 报错，然后以为是软件坏了。
 *
 * 这条横幅**不可关闭**：前提不满足的时候它就该一直在
 * （改成 https 或换 localhost 之后它自己消失，不需要谁记得回来删）。
 */
export function SecureContextBanner() {
  const { t } = useTranslation();

  if (isSecureContext()) return null;

  const blocked = detectBlockedCapabilities();
  if (blocked.length === 0) return null;

  const https = httpsEquivalent();
  const local = localhostEquivalent();

  return (
    <Banner
      tone="warning"
      title={t('secureContext.title')}
      detail={
        <div className="flex flex-col gap-1" data-testid="secure-context-banner">
          {/* 先说失去了什么 —— 逐项，而不是一句笼统的"部分功能受限" */}
          <ul className="list-disc pl-4">
            {blocked.map((c) => (
              <li key={c.key} data-testid={`secure-blocked-${c.key}`}>
                {t(`secureContext.caps.${c.key}`)}
              </li>
            ))}
          </ul>

          {/*
            ★ 再给**可点的动作**，而不是让用户自己琢磨怎么改地址。
            两条路都给：远程访问的用户换 localhost 没用（会打开他自己机器上的空端口），
            本机访问的用户又未必愿意折腾自签证书 —— 谁适用谁点。
          */}
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-ink-secondary">{t('secureContext.howTo')}</span>
            {https ? (
              <a className="text-accent underline" href={https} data-testid="secure-try-https">
                {t('secureContext.tryHttps')}
              </a>
            ) : null}
            {local ? (
              <a className="text-accent underline" href={local} data-testid="secure-try-localhost">
                {t('secureContext.tryLocalhost')}
              </a>
            ) : null}
          </p>
          {/* 说清 localhost 这条路的适用范围，免得远程用户点了更困惑 */}
          <p className="text-ink-muted">{t('secureContext.localhostCaveat')}</p>
        </div>
      }
    />
  );
}
