"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** Store filter chips for the Churn page (All / KOVA / NOVA / NURA). Pure
 *  links — switching a chip reloads the server component with ?store=. */
export function ChurnStoreFilter({
  stores,
  selected,
}: {
  stores: string[];
  selected: string | null;
}) {
  const pathname = usePathname();
  const params = useSearchParams();

  const hrefFor = (store: string | null) => {
    const q = new URLSearchParams(params.toString());
    if (store) q.set("store", store);
    else q.delete("store");
    const s = q.toString();
    return s ? `${pathname}?${s}` : pathname;
  };

  return (
    <div className="churn-filter seg" role="tablist" aria-label="Store filter">
      <Link
        href={hrefFor(null)}
        className={selected === null ? "active" : ""}
        role="tab"
        aria-selected={selected === null}
      >
        All
      </Link>
      {stores.map((s) => (
        <Link
          key={s}
          href={hrefFor(s)}
          className={selected === s ? "active" : ""}
          role="tab"
          aria-selected={selected === s}
        >
          {s}
        </Link>
      ))}
    </div>
  );
}
