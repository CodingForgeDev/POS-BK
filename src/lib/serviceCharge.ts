import Setting from "../models/Setting";

export type ServiceChargeConfig = {
  type: "percentage" | "fixed";
  value: number;
};

function normalizeServiceChargeConfig(rawType: unknown, rawValue: unknown): ServiceChargeConfig {
  const typeString = String(rawType ?? "percentage").trim().toLowerCase();
  const type = typeString === "fixed" ? "fixed" : "percentage";
  const value = Number(rawValue ?? 0);
  return {
    type,
    value: Number.isFinite(value) && value > 0 ? value : 0,
  };
}

export async function getDineInServiceChargePercent(): Promise<number> {
  const doc = await (Setting as any).findOne({ key: "dineInServicePercent" }).lean();
  const raw = doc?.value;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

export async function getOrderServiceChargeConfig(orderType: string): Promise<ServiceChargeConfig> {
  const keys = [
    "dineInServicePercent",
    "takeawayServiceChargeType",
    "takeawayServiceChargeValue",
    "deliveryServiceChargeType",
    "deliveryServiceChargeValue",
  ];
  const docs = await (Setting as any).find({ key: { $in: keys } }).lean();
  const settings: Record<string, any> = {};
  for (const doc of docs) {
    if (doc && typeof doc.key === "string") {
      settings[doc.key] = doc.value;
    }
  }

  if (orderType === "dine-in") {
    const n = typeof settings.dineInServicePercent === "number" ? settings.dineInServicePercent : Number(settings.dineInServicePercent);
    return {
      type: "percentage",
      value: Number.isFinite(n) && n > 0 ? Math.min(100, n) : 0,
    };
  }

  if (orderType === "takeaway-service") {
    return normalizeServiceChargeConfig(
      settings.takeawayServiceChargeType,
      settings.takeawayServiceChargeValue
    );
  }

  if (orderType === "delivery") {
    return normalizeServiceChargeConfig(
      settings.deliveryServiceChargeType,
      settings.deliveryServiceChargeValue
    );
  }

  return { type: "percentage", value: 0 };
}
