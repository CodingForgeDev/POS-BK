export const INSUFFICIENT_STOCK = "INSUFFICIENT_STOCK";

export type ShortageDetail = {
  inventoryId: string;
  name: string;
  required: number;
  available: number;
};

export class InsufficientStockError extends Error {
  readonly code = INSUFFICIENT_STOCK;
  readonly shortages: ShortageDetail[];

  constructor(shortages: ShortageDetail[]) {
    super("Insufficient stock for one or more ingredients");
    this.shortages = shortages;
    this.name = "InsufficientStockError";
  }
}
