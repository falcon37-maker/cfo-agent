// Minimal shared-password gate for /cogs.
// Cookie holds the sha256 of the env password so the plaintext never persists
// and the cookie is invalidated automatically when the password is rotated.

import { cookies } from "next/headers";
import { createHash } from "node:crypto";

export const COGS_COOKIE = "cogs_session";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

function expectedHash(): string | null {
  const pw = process.env.COGS_PAGE_PASSWORD;
  if (!pw) return null;
  return createHash("sha256").update(pw).digest("hex");
}

export async function isCogsAuthed(): Promise<boolean> {
  const expected = expectedHash();
  if (!expected) return false; // fail-closed when env is unset
  const jar = await cookies();
  return jar.get(COGS_COOKIE)?.value === expected;
}

export async function setCogsCookie(): Promise<void> {
  const hash = expectedHash();
  if (!hash) return;
  const jar = await cookies();
  jar.set(COGS_COOKIE, hash, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}

export async function clearCogsCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COGS_COOKIE);
}

export function verifyPassword(input: string): boolean {
  const pw = process.env.COGS_PAGE_PASSWORD;
  if (!pw) return false;
  // constant-time-ish compare
  const a = Buffer.from(input);
  const b = Buffer.from(pw);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
