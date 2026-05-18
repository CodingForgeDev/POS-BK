/**
 * GST rate helpers for server-side tax calculation.
 * Supports per-payment-method rates (e.g. cash 16%, card 5%).
 * GST is calculated as EXCLUSIVE (added on top): tax = amount * rate / 100
 */
import Setting from "../models/Setting";

const DEFAULT_GST_RATE = 16; // Changed to 16% for Pakistan standard
const DEFAULT_GST_RATES: Record<string, number> = {
  default: 16, // Default to 16% (cash)
  cash: 16,
  card: 5,
  debit_card: 5,
  credit_card: 5,
  digital: 5,
};

export async function getGstRates(): Promise<Record<string, number>> {
  const doc = await (Setting as any).findOne({ key: "gstRates" }).lean();
  if (doc?.value && typeof doc.value === "object") {
    return { ...DEFAULT_GST_RATES, ...doc.value };
  }
  const legacyDoc = await (Setting as any).findOne({ key: "gstRate" }).lean();
  const legacyRate =
    legacyDoc?.value != null ? Math.max(0, Math.min(100, Number(legacyDoc.value))) : DEFAULT_GST_RATE;
  return { ...DEFAULT_GST_RATES, default: legacyRate };
}

export async function getGstRateForMethod(paymentMethod: string): Promise<number> {
  const rates = await getGstRates();
  const rate = rates[paymentMethod] ?? rates.default ?? DEFAULT_GST_RATE;
  return Math.max(0, Math.min(100, Number(rate)));
}
