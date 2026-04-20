import { supabaseAdmin } from "@/lib/supabase/admin";
import { isCogsAuthed } from "@/lib/auth/cogs";
import { fmtDate, fmtMoney } from "@/lib/format";
import { loginAction, logoutAction, submitAdSpendAction } from "./actions";

export const dynamic = "force-dynamic";

type Store = { id: string; name: string; currency: string };
type Entry = {
  id: string;
  store_id: string;
  date: string;
  amount: number;
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
    .from("ad_spend_entries")
    .select("id, store_id, date, amount, submitted_at")
    .order("submitted_at", { ascending: false })
    .limit(7);
  if (error) throw new Error(error.message);
  return (data ?? []) as Entry[];
}

export default async function AdsPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; ok?: string }>;
}) {
  const params = await searchParams;
  const authed = await isCogsAuthed();

  return (
    <main className="mx-auto min-h-screen w-full max-w-md px-4 py-6 sm:py-10">
      <header className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Falcon 37
        </div>
        <h1 className="mt-1 text-2xl font-semibold">Ad Spend Entry</h1>
      </header>

      {!authed ? (
        <LoginPanel err={params.err} />
      ) : (
        <AuthedPanel okMessage={params.ok} errMessage={params.err} />
      )}
    </main>
  );
}

function LoginPanel({ err }: { err?: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-sm">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Enter the shared password to access the ad spend entry form.
      </p>
      <form action={loginAction} className="mt-4 space-y-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Password
          </span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-3 text-base"
          />
        </label>
        {err === "bad" ? (
          <p className="text-sm text-rose-600">Incorrect password.</p>
        ) : null}
        <button
          type="submit"
          className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-3 text-base font-semibold text-white dark:text-zinc-900"
        >
          Continue
        </button>
      </form>
    </div>
  );
}

async function AuthedPanel({
  okMessage,
  errMessage,
}: {
  okMessage?: string;
  errMessage?: string;
}) {
  const [stores, recent] = await Promise.all([loadStores(), loadRecentEntries()]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {okMessage ? (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
          Saved: {okMessage}
        </div>
      ) : null}
      {errMessage && errMessage !== "bad" ? (
        <div className="rounded-lg border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-sm text-rose-800 dark:text-rose-200">
          Could not save — please try again or ask Joe.
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 shadow-sm">
        <form action={submitAdSpendAction} className="space-y-4">
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
              Ad spend (USD)
            </span>
            <input
              type="number"
              name="amount"
              required
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="e.g. 1,250.00"
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

      <section>
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
                    {fmtMoney(r.amount)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <form action={logoutAction}>
        <button
          type="submit"
          className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm text-zinc-600 dark:text-zinc-300"
        >
          Log out
        </button>
      </form>
    </div>
  );
}
