// Parses the manually-tracked "Ecom Shops" spreadsheet exports (one tab per
// store: NOVA, NURA, KOVA, …). The tabs share the same header row but not the
// same column order — NURA and KOVA insert extra columns ("Blended Profit",
// "Blended BE ROAS") between VIP and Facebook — so we look up columns by name
// rather than by fixed position.
//
// Header row convention: the first row whose first field equals "Date" is the
// column-name row. Data rows follow it until EOF.
//
// Row-level rules:
//   - Only process rows whose date is in the English short form "DD-Mmm".
//     The French-abbreviation rows (e.g. "02-janv.") at the top of each sheet
//     are a template leftover and are all zeros; skip them.
//   - Skip rows where every numeric field is zero/empty.
//   - The sheet is a linear 1-day-per-row calendar that can cross the year
//     boundary. Start year = 2025, bump the year whenever the month index
//     decreases (i.e. Dec → Jan).

import { readFile } from "node:fs/promises";

const MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

const START_YEAR = 2025;

export type ShopCsvRow = {
  date: string; // YYYY-MM-DD
  adSpend: number;
  revenue: number;
  fees: number;
  orders: number;
  cogs: number;
  netProfit: number;
  vip: number;
  facebookSpend: number;
};

export async function loadShopCsv(path: string): Promise<ShopCsvRow[]> {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/);

  // Locate the header row (first field == "Date")
  let headerIdx = -1;
  let headerFields: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f[0]?.trim() === "Date") {
      headerIdx = i;
      headerFields = f.map((x) => x.trim());
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error('CSV header row not found (expected a row starting with "Date")');
  }

  const col = (name: string): number => {
    const idx = headerFields.indexOf(name);
    if (idx < 0) throw new Error(`CSV missing expected column: "${name}"`);
    return idx;
  };
  const colOrNull = (name: string): number => headerFields.indexOf(name);

  const DATE = col("Date");
  const ADS = col("TOTAL ADS");
  const REVENUE = col("Revenue");
  const FEES = col("7% fees");
  const ORDERS = col("Number of Orders");
  const COGS = col("Product Cost");
  const PROFIT = col("Daily Profit");
  const VIP = colOrNull("VIP");
  const FACEBOOK = col("Facebook"); // first occurrence (header) — not the subheader one

  const rows: ShopCsvRow[] = [];
  let year = START_YEAR;
  let prevMonth = -1;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = parseCsvLine(line);
    const rawDate = fields[DATE]?.trim();
    if (!rawDate) continue;

    const m = rawDate.match(/^(\d{2})-([A-Z][a-z]{2})$/);
    if (!m) continue; // skips French rows / subheader rows
    const day = Number(m[1]);
    const monthStr = m[2];
    const month = MONTHS[monthStr];
    if (!month) continue;

    if (prevMonth !== -1 && month < prevMonth) year += 1;
    prevMonth = month;

    const adSpend = parseNum(fields[ADS]);
    const revenue = parseNum(fields[REVENUE]);
    const fees = parseNum(fields[FEES]);
    const orders = parseInt0(fields[ORDERS]);
    const cogs = parseNum(fields[COGS]);
    const netProfit = parseNum(fields[PROFIT]);
    const vip = VIP >= 0 ? parseNum(fields[VIP]) : 0;
    const facebookSpend = parseNum(fields[FACEBOOK]);

    if (
      adSpend === 0 &&
      revenue === 0 &&
      orders === 0 &&
      cogs === 0 &&
      netProfit === 0
    ) {
      continue;
    }

    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    rows.push({
      date,
      adSpend,
      revenue,
      fees,
      orders,
      cogs,
      netProfit,
      vip,
      facebookSpend,
    });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseNum(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/"/g, "").replace(/,/g, "").trim();
  if (!cleaned || cleaned === "#DIV/0!") return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseInt0(raw: string | undefined): number {
  return Math.round(parseNum(raw));
}
