import { create } from "zustand";
//#region src/lib/stores/connection.store.ts
var useConnectionStore = create((set) => ({
	state: "connecting",
	multiTabDegraded: false,
	portDrift: null,
	contractMismatch: null,
	setState: (state) => set({ state }),
	setMultiTabDegraded: (multiTabDegraded) => set({ multiTabDegraded }),
	setPortDrift: (portDrift) => set({ portDrift }),
	setContractMismatch: (contractMismatch) => set({ contractMismatch })
}));
//#endregion
export { useConnectionStore as t };
