import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Cpu, Languages, Package, PlayCircle } from 'lucide-react';

import { Button } from '../../components/common/Button';
import { MockNotice } from '../../components/common/MockNotice';
import { SUPPORTED_LOCALES, setLocale, type LocaleCode } from '../../app/i18n';
import { cn } from '../../lib/utils';
import { markOnboardingDone } from './state';

/**
 * M-3 首启引导 —— **章程要求 2.1 / 2.2 的门面**。
 *
 * ## 为什么这是 🔴 而不是 nice-to-have
 *
 * 在这之前，新用户第一次打开看到的是一片**空的笔记列表**：
 * 没有任何东西告诉他"要先装一个语音模型"、"你的显卡可以装加速后端"。
 * 章程要求 2.1/2.2 写的是"不要求用户碰命令行" —— 而**没人告诉他要做什么**，
 * 比要他敲命令还糟：他连该找什么都不知道。这条链路在第一步就断了。
 *
 * ## 设计原则：每一步都能跳过
 *
 * R-04 §1.5 引述的竞品经验是"第一次不要让用户做任何配置决策"。
 * 所以四步都有跳过：L1 内置 CPU 后端永不失败（ADR-006 决策 3），
 * 跳过全部仍然能用，只是慢一些。**引导是帮忙，不是关卡。**
 */

type Step = 0 | 1 | 2 | 3;

export default function OnboardingPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);

  const finish = () => {
    markOnboardingDone();
    navigate('/notes', { replace: true });
  };

  const STEPS = [
    { icon: <Languages className="size-4" />, key: 'lang' },
    { icon: <Cpu className="size-4" />, key: 'hardware' },
    { icon: <Package className="size-4" />, key: 'model' },
    { icon: <PlayCircle className="size-4" />, key: 'try' },
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold text-ink">{t('onboarding.title')}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{t('onboarding.subtitle')}</p>
      </header>

      {/* 步骤条 */}
      <ol className="flex items-center gap-2" role="list">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs',
                i < step
                  ? 'border-good-solid bg-good-solid text-white'
                  : i === step
                    ? 'border-accent bg-accent text-accent-fg'
                    : 'border-line text-ink-muted',
              )}
            >
              {i < step ? <Check className="size-3.5" /> : s.icon}
            </span>
            <span
              className={cn('hidden text-xs sm:block', i === step ? 'text-ink' : 'text-ink-muted')}
            >
              {t(`onboarding.steps.${s.key}`)}
            </span>
            {i < STEPS.length - 1 ? <span className="h-px flex-1 bg-line" aria-hidden /> : null}
          </li>
        ))}
      </ol>

      <section className="rounded-lg border border-line bg-surface-1 p-5">
        {step === 0 ? (
          <div>
            <h2 className="text-sm font-medium text-ink">{t('onboarding.langTitle')}</h2>
            <div className="mt-3 flex gap-2">
              {SUPPORTED_LOCALES.map((l) => (
                <Button
                  key={l.code}
                  variant={i18n.language === l.code ? 'primary' : 'secondary'}
                  onClick={() => setLocale(l.code as LocaleCode)}
                >
                  {l.label}
                </Button>
              ))}
            </div>
          </div>
        ) : step === 1 ? (
          <div>
            <h2 className="text-sm font-medium text-ink">{t('onboarding.hardwareTitle')}</h2>
            <p className="mt-1 text-sm text-ink-secondary">{t('onboarding.hardwareBody')}</p>
            <MockNotice surface="runtime" className="mt-3" />
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={() => navigate('/runtime')}>
                {t('onboarding.openRuntime')}
              </Button>
            </div>
            {/* L1 内置 CPU 后端永不失败 —— 所以这一步真的可以跳过，不是客套话 */}
            <p className="mt-3 text-xs text-ink-muted">{t('onboarding.hardwareSkipNote')}</p>
          </div>
        ) : step === 2 ? (
          <div>
            <h2 className="text-sm font-medium text-ink">{t('onboarding.modelTitle')}</h2>
            <p className="mt-1 text-sm text-ink-secondary">{t('onboarding.modelBody')}</p>
            <MockNotice surface="models" className="mt-3" />
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={() => navigate('/models')}>
                {t('onboarding.openModels')}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <h2 className="text-sm font-medium text-ink">{t('onboarding.tryTitle')}</h2>
            <p className="mt-1 text-sm text-ink-secondary">{t('onboarding.tryBody')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  markOnboardingDone();
                  navigate('/capture');
                }}
              >
                {t('onboarding.goCapture')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  markOnboardingDone();
                  navigate('/record');
                }}
              >
                {t('onboarding.goRecord')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={finish}>
          {t('onboarding.skipAll')}
        </Button>
        <div className="flex gap-2">
          {step > 0 ? (
            <Button variant="secondary" onClick={() => setStep((s) => (s - 1) as Step)}>
              {t('onboarding.back')}
            </Button>
          ) : null}
          {step < 3 ? (
            <Button variant="primary" onClick={() => setStep((s) => (s + 1) as Step)}>
              {t('onboarding.next')}
            </Button>
          ) : (
            <Button variant="primary" onClick={finish}>
              {t('onboarding.done')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
