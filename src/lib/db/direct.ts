// Direct Postgres connection pool — used by Phase 2 edit tools.
//
// Why we need this alongside the Supabase client:
//   - Edit tools fetch CURRENT values + write NEW values in one
//     transaction. The Supabase REST client doesn't support transactions.
//   - We want statement_timeout to apply per-query so a runaway AI
//     query can't hold a connection forever.
//
// Connection target:
//   - DATABASE_URL (currently pointing at LOCAL Postgres for dev).
//   - When ready to ship, swap DATABASE_URL to the Supabase pooler URL.
//
// Safety:
//   - Pool size capped low (10) — appropriate for a dev / single-instance
//     Vercel function.
//   - Statement timeout on every connection (5s).
//   - Every query goes through `withClient` which releases on failure.

import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env — see scripts/migrate-live-to-local.mjs for the local format.",
    );
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({
    connectionString: url,
    // Supabase requires SSL; localhost doesn't.
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Statement timeout per connection — kills runaway queries.
  pool.on("connect", (client) => {
    client.query("SET statement_timeout = 5000").catch(() => {
      // Non-fatal — connection still usable.
    });
  });
  pool.on("error", (err) => {
    // Idle client errors shouldn't crash the process.
    console.error("[pg pool] idle client error:", err.message);
  });
  return pool;
}

/** Run a function with a checked-out client, releasing it afterwards
 *  (even if the function throws). For transactions wrap the queries
 *  inside BEGIN / COMMIT / ROLLBACK yourself — see `withTransaction`. */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Wraps fn in BEGIN/COMMIT — rolls back on any throw. Use this for
 *  edit tools where we need to see-current-then-write atomically. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return await withClient(async (client) => {
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Swallow rollback errors — the original error matters more.
      }
      throw e;
    }
  });
}

/** Convenience wrapper for one-shot SELECT queries that don't need
 *  the transaction handling above. Returns rows[]. */
export async function query<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return await withClient(async (client) => {
    const result = await client.query<T>(text, params);
    return result.rows;
  });
}
