// Diagnostic: how long does Vercel actually let this function run?
// Hits sleep(120s) and reports elapsed; if Vercel kills earlier than 120s
// the response is cut off and we know the practical cap from the curl side.

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(request: NextRequest) {
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const sleepSec = Number(request.nextUrl.searchParams.get("sec") ?? 120);
  await new Promise((r) => setTimeout(r, sleepSec * 1000));
  return Response.json({
    sleptSec: sleepSec,
    actualMs: Date.now() - started,
    maxDurationDeclared: 800,
  });
}
