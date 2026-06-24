"use client";

// Shared client-side search state for the Subscriptions Daily P&L table.
// The search INPUT lives in the page filter bar while the TABLE lives further
// down the page, so the query is lifted into a context both can read. Purely
// front-end — it only filters rows already rendered; no data is re-fetched.

import { createContext, useContext, useState } from "react";
import { Search, X } from "lucide-react";

type SearchCtx = { query: string; setQuery: (q: string) => void };

const Ctx = createContext<SearchCtx>({ query: "", setQuery: () => {} });

/** Read the shared search query. Safe outside a provider (returns ""). */
export function useSubsSearch(): SearchCtx {
  return useContext(Ctx);
}

export function SubsSearchProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  return <Ctx.Provider value={{ query, setQuery }}>{children}</Ctx.Provider>;
}

/** The search box itself — placed on the left of the filter bar. */
export function SubsSearchInput() {
  const { query, setQuery } = useSubsSearch();
  return (
    <div className="table-search">
      <Search size={15} strokeWidth={2} />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search data in current page…"
        aria-label="Search table"
      />
      {query ? (
        <button
          type="button"
          className="table-search-clear"
          onClick={() => setQuery("")}
          aria-label="Clear search"
        >
          <X size={14} strokeWidth={2.25} />
        </button>
      ) : null}
    </div>
  );
}
