/**
 * 安全上下文（secure context）能力探测 —— **本地部署工具最容易踩、最难自查的一类坑**。
 *
 * ## 这个文件因为一个真实事故而存在
 *
 * 用户从 `http://100.64.135.105:10000` 访问（NAT 环境下他唯一能用的地址），
 * 看到一条横幅说「**当前浏览器不支持标签页选主**」。
 * 这句话把用户引向"换个浏览器"，而换任何浏览器都没有用 ——
 * 真因是 `http://<IP>` **不是安全上下文**，`navigator.locks` 在任何浏览器下都是 `undefined`。
 *
 * 更糟的是它掩盖了另一件事：`getUserMedia` **同样只在安全上下文可用**，
 * 于是**录音转文字在这个地址下根本用不了**，而产品里没有任何地方说过这件事。
 *
 * ## 为什么全员都没发现
 *
 * **开发与测试全在 `127.0.0.1` 上，而 localhost 恰好被规范定义为安全上下文。**
 * 也就是说：开发环境**恰好满足了**生产环境不满足的前提。
 * 这和"ffmpeg 自检一直绿，是因为本机装了 `/usr/bin/ffmpeg`"是同一族的错误 ——
 * 本机测试不可能暴露它，只能靠**显式建模这个前提**。这个文件就是那个显式建模。
 *
 * ⚠️ 判定一律用 `window.isSecureContext`，**不要自己解析 URL**：
 * 规范里的可信来源不止 https 与 localhost（还有 `file:`、部分扩展页、
 * 以及被策略显式标记为可信的来源），自己写正则必然与浏览器不一致。
 */

export interface SecureContextCapability {
  /** i18n key 后缀，见 `secureContext.caps.*`。 */
  readonly key: string;
  /** 这项能力是否被 secure context 挡住了。 */
  readonly blocked: boolean;
  /** 挡住之后用户具体失去什么功能。 */
  readonly featureKey: string;
}

/** 当前是否处于安全上下文。SSR / 测试环境下无 `window` 时按"是"处理，避免误报。 */
export function isSecureContext(): boolean {
  if (typeof window === 'undefined') return true;
  // 老浏览器没有 isSecureContext 时不猜 —— 缺这个属性本身就说明它非常旧，
  // 但我们没有依据判定不安全，误报一条横幅比漏报更烦人
  return window.isSecureContext !== false;
}

/**
 * 逐项列出被安全上下文挡住的能力。
 *
 * **逐项检测而不是"非安全上下文就全灭"**：`isSecureContext === false` 是充分条件，
 * 但浏览器还可能因为别的原因缺某个 API（比如 Firefox 的隐私模式）。
 * 按实际 `undefined` 来报，用户看到的才是他真正失去的那几项。
 */
export function detectBlockedCapabilities(): SecureContextCapability[] {
  if (typeof navigator === 'undefined') return [];

  const nav = navigator as Navigator & {
    locks?: unknown;
    mediaDevices?: unknown;
    clipboard?: unknown;
  };

  return [
    {
      key: 'microphone',
      // F3 录音转文字的入口。这是本次事故里**唯一功能级不可用**的一项
      blocked: !nav.mediaDevices || typeof navigator.mediaDevices?.getUserMedia !== 'function',
      featureKey: 'recorder',
    },
    {
      key: 'webLocks',
      // 只影响多标签页选主，功能仍可用（每标签各开一条 SSE），属体验降级
      blocked: !nav.locks,
      featureKey: 'multiTab',
    },
    {
      key: 'storage',
      /*
       * 不是 secure context 的锅（见 `isSessionStorageAvailable` 的说明），
       * 但放在同一张"能力清单"里，用户排查时只需要看一个地方。
       */
      blocked: !isSessionStorageAvailable(),
      featureKey: 'storage',
    },
    {
      key: 'clipboard',
      // "复制路径" / "复制诊断信息" 会静默失效 —— 静默是这里最坏的部分
      blocked: !nav.clipboard,
      featureKey: 'copy',
    },
  ].filter((c) => c.blocked);
}

/**
 * `sessionStorage` 能不能用。
 *
 * ⚠️ **它不是 secure-context-gated 的** —— 这一点必须说准，否则会把排查引向错误方向。
 * `http://<IP>` 下 `sessionStorage` **照常可用**；挡住它的是无痕模式、
 * "阻止所有 Cookie 和站点数据"这类设置、或被分区的第三方上下文。
 *
 * 之所以仍然纳入这套检测：CSRF 令牌曾经**只**存在这里，
 * 存不进去就等于所有写操作静默失败。现在令牌的权威副本在内存里，
 * 这一项已降级为"少一点便利"，但仍然值得**显式可见**——
 * 诊断页能一眼看出"是不是存储被拦了"，比让人猜强。
 */
export function isSessionStorageAvailable(): boolean {
  try {
    const k = '__om_probe__';
    sessionStorage.setItem(k, '1');
    sessionStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

/** 麦克风是否可用。录音页在**点击之前**就要知道，而不是点了报 `undefined` 错误。 */
export function isMicrophoneAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * 把当前地址换成 localhost 的等价地址，供"用 localhost 打开"按钮直接跳转。
 *
 * 只有在**本来就是本机**的情况下这条路才走得通；远程访问的用户换成 localhost
 * 只会打开他自己机器上的空端口。所以调用方要同时给出 https 那条路。
 */
export function localhostEquivalent(): string | null {
  if (typeof window === 'undefined') return null;
  const { protocol, port, pathname, search, hash } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return `${protocol}//127.0.0.1${port ? `:${port}` : ''}${pathname}${search}${hash}`;
}

/** 把当前地址换成 https 的等价地址（daemon 支持自签 TLS 之后可直接用）。 */
export function httpsEquivalent(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.location.protocol === 'https:') return null;
  const { hostname, port, pathname, search, hash } = window.location;
  return `https://${hostname}${port ? `:${port}` : ''}${pathname}${search}${hash}`;
}

/**
 * 复制文本 —— 在非安全上下文下**仍然尽力做成**，做不成如实返回 `false`。
 *
 * `navigator.clipboard` 要求安全上下文，`http://<IP>` 下是 `undefined`。
 * 原来的写法是 `navigator.clipboard?.writeText(t)` —— 可选链会让整条链短路，
 * 不报错、也不复制，按钮**静默失效**。静默是这里最坏的部分：
 * 用户以为复制成功了，去粘贴才发现是上一次的剪贴板内容。
 *
 * 回退用 `document.execCommand('copy')`：它确实已废弃，但**在非安全上下文里可用**，
 * 而这正是我们需要它的唯一场景。对一个本地部署工具来说，
 * "能用的废弃 API" 胜过 "规范正确但在用户的地址下不工作"。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 用户拒绝授权或文档失焦 —— 继续走回退，不直接判负
    }
  }

  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 移出视口而不是 display:none —— 后者无法选中，选不中就复制不了
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
