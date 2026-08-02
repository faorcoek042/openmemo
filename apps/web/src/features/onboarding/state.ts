/**
 * 首启引导的完成标记。
 *
 * 存 localStorage 而不是服务端：它是**这台浏览器**的一次性引导状态，
 * 与账号/数据无关；放服务端反而会让"换个浏览器又被引导一遍"变成 bug 报告。
 */
const KEY = 'openmemo.onboarded';

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    // 隐私模式读不到 → 当作已完成，宁可少引导一次也不要每次都拦人
    return true;
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* ignore */
  }
}
