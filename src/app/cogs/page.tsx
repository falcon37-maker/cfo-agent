import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fmtDate, fmtMoney } from "@/lib/format";
import { signOutAction } from "@/app/login/actions";
import { submitCogsAction } from "./actions";

export const dynamic = "force-dynamic";

type Store = { id: string; name: string; currency: string };
type Entry = {
  id: string;
  store_id: string;
  date: string;
  cogs: number;
  submitted_at: string;
};

async function loadStores(): Promise<Store[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("stores")
    .select("id, name, currency")
    .eq("is_active", true)
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as Store[];
}

async function loadRecentEntries(): Promise<Entry[]> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("cogs_entries")
    .select("id, store_id, date, cogs, submitted_at")
    .order("submitted_at", { ascending: false })
    .limit(7);
  if (error) throw new Error(error.message);
  return (data ?? []) as Entry[];
}

export default async function CogsPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; ok?: string }>;
}) {
  const params = await searchParams;

  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();

  const [stores, recent] = await Promise.all([loadStores(), loadRecentEntries()]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 py-6 sm:py-10">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Falcon 37
          </div>
          <h1 className="mt-1 text-2xl font-semibold">COGS Entry</h1>
          {user?.email ? (
            <div className="mt-1 text-xs text-zinc-500">Signed in as {user.email}</div>
          ) : null}
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-300"
          >
            Sign out
          </button>
        </form>
      </header>

      {params.ok ? (
        <div className="mb-4 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          Saved: {params.ok}
        </div>
      ) : null}
      {params.err ? (
        <div className="mb-4 rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          Could not save — check your inputs or try again.
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-sm">
        <form action={submitCogsAction} className="space-y-4">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Store
            </span>
            <select
              name="store"
              required
              defaultValue={stores[0]?.id ?? ""}
              className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-3 text-base"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} — {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Date
            </span>
            <input
              type="date"
              name="date"
              required
              defaultValue={today}
              max={today}
              className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-3 text-base"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              COGS amount (USD)
            </span>
            <input
              type="number"
              name="cogs"
              required
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="e.g. 423.80"
              className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-3 text-base"
            />
          </label>

          <button
            type="submit"
            className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-3 text-base font-semibold text-white dark:text-zinc-900"
          >
            Save
          </button>
        </form>
      </section>

      <section className="mt-6">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Last 7 submissions
        </h2>
        <div className="mt-2 overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
          {recent.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-zinc-500">
              No submissions yet.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {recent.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between px-4 py-3 text-sm"
                >
                  <div>
                    <div className="font-medium">{fmtDate(r.date)}</div>
                    <div className="text-xs text-zinc-500">{r.store_id}</div>
                  </div>
                  <div className="font-semibold tabular-nums">
                    {fmtMoney(r.cogs)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <div className="mt-6 text-center text-xs text-zinc-500">
        <Link href="/ads" className="underline underline-offset-2">
          Ad spend entry →
        </Link>
      </div>
    </main>
  );
}
