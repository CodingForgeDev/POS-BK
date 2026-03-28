import Setting from "../models/Setting";

/**
 * Admin-configured dine-in service charge percent (0–100). Stored as Setting key `dineInServicePercent`.
 */
export async function getDineInServiceChargePercent(): Promise<number> {
  const doc = await (Setting as any).findOne({ key: "dineInServicePercent" }).lean();
  const raw = doc?.value;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}
