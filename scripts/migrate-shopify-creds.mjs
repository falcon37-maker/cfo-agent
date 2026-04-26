// One-shot: encrypt every Shopify store's env-var credentials into the
// stores table for the seed tenant.
//
// Usage:
//   CREDENTIAL_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
//   node scripts/migrate-shopify-creds.mjs
//
// Requires:
//   - .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//   - CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64 or hex). Same value must
//     land in Vercel env so the deployed app can decrypt.
//
// Idempotent: re-running just re-encrypts the same env values into the
// same rows. Existing DB-only stores (without env vars) are untouched.

import { createCipheriv, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return {};
  const out = {};
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = loadEnvFile(".env.local");
const env = { ...fileEnv, ...process.env };

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const RAW_KEY = env.CREDENTIAL_ENCRYPTION_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
if (!RAW_KEY) {
  console.error(
    "CREDENTIAL_ENCRYPTION_KEY not set. Generate one with:\n" +
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
      "Then export it and re-run this script. Same value must land in Vercel env.",
  );
  process.exit(1);
}

function loadKey(raw) {
  let key;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error(`key must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

const KEY = loadKey(RAW_KEY);

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: stores, error: storesErr } = await sb
  .from("stores")
  .select("id, tenant_id, shopify_domain, shopify_token_encrypted, shopify_client_id, shopify_client_secret_encrypted")
  .neq("id", "PORTFOLIO")
  .neq("id", "__BACKFILL_DEDUPE__")
  .order("id");
if (storesErr) {
  console.error("loadStores:", storesErr.message);
  process.exit(1);
}

let migrated = 0;
let skipped = 0;
const report = [];

for (const store of stores) {
  const code = store.id.toUpperCase();
  const domain = env[`${code}_DOMAIN`];
  const rawToken = env[`${code}_TOKEN`];
  const clientId = env[`${code}_CLIENT_ID`];

  if (!domain || !rawToken) {
    skipped++;
    report.push(`  SKIP  ${code.padEnd(8)} (no env vars)`);
    continue;
  }

  /** @type {Record<string, unknown>} */
  const update = { shopify_domain: domain };

  if (rawToken.startsWith("shpat_")) {
    update.shopify_token_encrypted = encrypt(rawToken);
    update.shopify_client_id = null;
    update.shopify_client_secret_encrypted = null;
  } else if (rawToken.startsWith("shpss_")) {
    if (!clientId) {
      skipped++;
      report.push(
        `  SKIP  ${code.padEnd(8)} (shpss_ needs ${code}_CLIENT_ID — none set)`,
      );
      continue;
    }
    update.shopify_client_id = clientId;
    update.shopify_client_secret_encrypted = encrypt(rawToken);
    update.shopify_token_encrypted = null;
  } else {
    skipped++;
    report.push(`  SKIP  ${code.padEnd(8)} (token has unexpected prefix)`);
    continue;
  }

  const { error: upErr } = await sb
    .from("stores")
    .update(update)
    .eq("tenant_id", store.tenant_id)
    .eq("id", store.id);
  if (upErr) {
    report.push(`  FAIL  ${code.padEnd(8)} ${upErr.message}`);
    continue;
  }
  migrated++;
  const mode = update.shopify_token_encrypted ? "static" : "oauth";
  report.push(`  OK    ${code.padEnd(8)} domain=${domain.padEnd(32)} mode=${mode}`);
}

console.log(report.join("\n"));
console.log(`\nmigrated=${migrated} skipped=${skipped} total=${stores.length}`);
