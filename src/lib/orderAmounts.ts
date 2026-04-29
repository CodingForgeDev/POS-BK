/**
 * Single place for order subtotal → discount → dine-in service charge → GST → total.
 * Matches POS cart: GST applies to (subtotal − discount + service charge).
 */

export type DiscountInput = { type: string; value: number } | null | undefined;

export function computeDiscountAmount(subtotal: number, discount: DiscountInput): number {
  if (!discount || subtotal <= 0) return 0;
  if (discount.type === "percentage") {
    return Math.min(subtotal, (subtotal * discount.value) / 100);
  }
  return Math.min(subtotal, discount.value);
}

export type ServiceChargeConfig = {
  type: "percentage" | "fixed";
  value: number;
};

export interface OrderFinancialsInput {
  subtotal: number;
  /** Use when updating items on an existing order (discount already stored). */
  discountAmountFixed?: number;
  discount?: DiscountInput;
  orderType: string;
  /** Percent of (subtotal − discount), e.g. 5 for 5%. Only applied when orderType is dine-in. */
  serviceChargePercent?: number;
  serviceChargeConfig?: ServiceChargeConfig;
  gstRatePct: number;
}

export function computeOrderFinancials(input: OrderFinancialsInput) {
  const discountAmount =
    input.discountAmountFixed != null
      ? Math.min(input.subtotal, Math.max(0, input.discountAmountFixed))
      : computeDiscountAmount(input.subtotal, input.discount);

  const afterDiscount = Math.max(0, input.subtotal - discountAmount);
  const config: ServiceChargeConfig =
    input.serviceChargeConfig ?? {
      type: "percentage",
      value: Number.isFinite(input.serviceChargePercent || 0)
        ? Math.max(0, Math.min(100, input.serviceChargePercent || 0))
        : 0,
    };

  const serviceChargeAmount =
    (input.orderType === "dine-in" || input.orderType === "takeaway-service") && config.value > 0
      ? config.type === "percentage"
        ? (afterDiscount * config.value) / 100
        : Math.max(0, config.value)
      : 0;

  const taxableBase = afterDiscount + serviceChargeAmount;
  const rate = Math.max(0, Math.min(100, input.gstRatePct || 0));
  const taxAmount = (taxableBase * rate) / 100;
  const total = taxableBase + taxAmount;

  return {
    subtotal: input.subtotal,
    discountAmount,
    serviceChargeAmount,
    taxAmount,
    total,
  };
}
