/**
 * 国际化（D-05 §6.1）。
 *
 * 选 `i18next` + `react-i18next` 的理由：**它是唯一零编译步骤的方案**。
 * lingui 与 typesafe-i18n 都需要 extract/generate 步骤 —— Wave 3 三个任务并行，
 * 多一个代码生成步骤就多一处"我本地能跑你那儿不行"。类型安全的收益抵不上这个代价。
 *
 * ⚠️ 版本联动：`react-i18next` 17 的 peer 硬性要求 `i18next >= 26.2.0`。装错组合会静默出错。
 *
 * 约定：
 * - key 命名 `<feature>.<区块>.<语义>`，**禁止用中文原文当 key**（改文案就得改所有引用）。
 * - 数字/日期/字节/相对时间**不进词条**，走 `lib/format/` 的 Intl 封装。
 * - 错误文案按 `code` 查 `errors.<CODE>`；服务端的 `message`/`messageZh` 只作未知 code 的兜底
 *   （D-05 §6.2，ADR-007 决策 3 已采纳）。
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';

export const SUPPORTED_LOCALES = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: 'English' },
] as const;

export type LocaleCode = (typeof SUPPORTED_LOCALES)[number]['code'];

const STORAGE_KEY = 'openmemo.locale';

function detectLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED_LOCALES.some((l) => l.code === saved)) return saved as LocaleCode;
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'zh-CN';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function initI18n() {
  const lng = detectLocale();
  void i18n.use(initReactI18next).init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
    },
    lng,
    // 产品面向中文用户 → 默认与兜底都是中文
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false }, // React 自己转义
    returnNull: false,
  });
  applyDocumentLang(lng);
  return i18n;
}

export function setLocale(code: LocaleCode) {
  void i18n.changeLanguage(code);
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  applyDocumentLang(code);
}

export function currentLocale(): LocaleCode {
  return (i18n.language as LocaleCode) || 'zh-CN';
}

/** `<html lang>` 必须随 locale 变（a11y 基线，D-05 §6.3）。 */
function applyDocumentLang(code: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

export default i18n;
