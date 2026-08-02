import { i as api, m as qk } from "./ErrorBlock-NhqIUn2X.js";
import { useQuery } from "@tanstack/react-query";
//#region src/features/search/api.ts
function useSearchQuery(q, mode) {
	return useQuery({
		queryKey: qk.search(q, mode),
		queryFn: () => api("notes", `/search?q=${encodeURIComponent(q)}&mode=${mode}`),
		enabled: q.trim().length > 0,
		select: (d) => d.hits
	});
}
//#endregion
export { useSearchQuery as t };
