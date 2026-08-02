import { create } from 'zustand';

/**
 * 连接态本身就是应用状态（D-05 §2.3）——用户需要知道"实时更新还在不在"。
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'degraded';

interface ConnectionStore {
  state: ConnectionState;
  /** Web Locks 不可用 → 每标签各一条流（ADR-007 决策 5 的降级路径） */
  multiTabDegraded: boolean;
  /** 端口发生过漂移（ADR-006 决策 2）：必须提醒麦克风要重新授权 */
  portDrift: { expected: number; actual: number } | null;
  /** 前端与 daemon 的契约版本不一致 → 阻断对话框 */
  contractMismatch: { web: number; daemon: number } | null;

  setState: (s: ConnectionState) => void;
  setMultiTabDegraded: (v: boolean) => void;
  setPortDrift: (v: { expected: number; actual: number } | null) => void;
  setContractMismatch: (v: { web: number; daemon: number } | null) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  state: 'connecting',
  multiTabDegraded: false,
  portDrift: null,
  contractMismatch: null,

  setState: (state) => set({ state }),
  setMultiTabDegraded: (multiTabDegraded) => set({ multiTabDegraded }),
  setPortDrift: (portDrift) => set({ portDrift }),
  setContractMismatch: (contractMismatch) => set({ contractMismatch }),
}));
