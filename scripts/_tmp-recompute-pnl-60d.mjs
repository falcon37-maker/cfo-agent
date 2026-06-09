import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";

const src = await readFile("scripts/recompute-daily-pnl-90d.mjs", "utf8");
const patched = src.replace("const DAYS = 90;", "const DAYS = 60;");
const tmp = "scripts/_tmp-recompute-pnl-60d-runner.mjs";
await writeFile(tmp, patched);

const child = spawn(process.execPath, ["--env-file=.env", tmp], { stdio: "inherit" });
child.on("exit", async (code) => {
  await unlink(tmp).catch(() => {});
  process.exit(code ?? 0);
});
