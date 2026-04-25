import mongoose, { ClientSession } from "mongoose";
import Order from "../models/Order";
import Product from "../models/Product";
import Inventory from "../models/Inventory";
import Invoice from "../models/Invoice";
import InventoryConsumption from "../models/InventoryConsumption";
import InventoryReservation from "../models/InventoryReservation";
import { InsufficientStockError } from "./inventoryErrors";
import { deductInventoryFifo, type FifoAllocation } from "./inventoryFifo";

const UNIT_GROUP: Record<string, string> = {
  ml: "volume",
  l: "volume",
  g: "weight",
  kg: "weight",
};

const UNIT_FACTOR: Record<string, number> = {
  ml: 1,
  l: 1000,
  g: 1,
  kg: 1000,
};

function normalizeUnit(unit: string): string {
  return String(unit ?? "").trim().toLowerCase();
}

function isConvertibleUnit(unit: string): boolean {
  const normalized = normalizeUnit(unit);
  return Boolean(UNIT_GROUP[normalized]);
}

function convertBetweenUnits(quantity: number, fromUnit: string, toUnit: string): number {
  const fromNormalized = normalizeUnit(fromUnit);
  const toNormalized = normalizeUnit(toUnit);
  if (!quantity || fromNormalized === toNormalized) return quantity;
  const fromGroup = UNIT_GROUP[fromNormalized];
  const toGroup = UNIT_GROUP[toNormalized];
  if (fromGroup && toGroup && fromGroup === toGroup) {
    const fromFactor = UNIT_FACTOR[fromNormalized] ?? 1;
    const toFactor = UNIT_FACTOR[toNormalized] ?? 1;
    return (quantity * fromFactor) / toFactor;
  }
  return quantity;
}

export async function calculateRecipeCostPriceForRecipe(
  recipeLines: Array<{ inventoryItem: mongoose.Types.ObjectId; quantityPerUnit: number; unit?: string }>,
  session?: ClientSession | null
): Promise<number> {
  if (!recipeLines?.length) return 0;
  const invIds = Array.from(new Set(recipeLines.map((line) => String(line.inventoryItem))));
  const inventoryQuery = Inventory.find({ _id: { $in: invIds } }).select("unit costPerUnit").lean();
  if (session) inventoryQuery.session(session);
  const inventoryDocs = await inventoryQuery;
  const inventoryMap = new Map<string, { unit?: string; costPerUnit?: number }>(
    inventoryDocs.map((inv: any) => [String(inv._id), { unit: String(inv.unit || "").toLowerCase(), costPerUnit: Number(inv.costPerUnit || 0) }])
  );

  return recipeLines.reduce((sum, line) => {
    const inv = inventoryMap.get(String(line.inventoryItem));
    if (!inv) return sum;
    const inventoryUnit = inv.unit || "";
    const recipeUnit = normalizeUnit(line.unit || inventoryUnit);
    const adjustedQuantity = convertBetweenUnits(line.quantityPerUnit, recipeUnit, inventoryUnit);
    return sum + adjustedQuantity * (inv.costPerUnit ?? 0);
  }, 0);
}

export async function recalculateProductCostPriceForInventoryItem(
  inventoryItemId: string,
  session?: ClientSession | null
): Promise<void> {
  const products = await Product.find({ "recipeLines.inventoryItem": inventoryItemId })
    .select("recipeLines")
    .lean();

  if (!products.length) return;

  const productIds = products.map((product: any) => String(product._id));
  const recipeLinesByProduct = new Map<string, any[]>(
    products.map((product: any) => [String(product._id), product.recipeLines || []])
  );

  const inventoryItemIds = Array.from(
    new Set(products.flatMap((product: any) => (product.recipeLines || []).map((line: any) => String(line.inventoryItem))))
  );

  const inventoryQuery = Inventory.find({ _id: { $in: inventoryItemIds } }).select("unit costPerUnit").lean();
  if (session) inventoryQuery.session(session);
  const inventoryDocs = await inventoryQuery;
  const inventoryMap = new Map<string, { unit?: string; costPerUnit?: number }>(
    inventoryDocs.map((inv: any) => [String(inv._id), { unit: String(inv.unit || "").toLowerCase(), costPerUnit: Number(inv.costPerUnit || 0) }])
  );

  for (const productId of productIds) {
    const recipeLines = recipeLinesByProduct.get(productId) || [];
    const newCostPrice = recipeLines.reduce((sum, line: any) => {
      const inv = inventoryMap.get(String(line.inventoryItem));
      if (!inv) return sum;
      const inventoryUnit = inv.unit || "";
      const recipeUnit = normalizeUnit(line.unit || inventoryUnit);
      const adjustedQuantity = convertBetweenUnits(Number(line.quantityPerUnit), recipeUnit, inventoryUnit);
      return sum + adjustedQuantity * (inv.costPerUnit ?? 0);
    }, 0);

    await Product.updateOne(
      { _id: productId },
      { $set: { costPrice: newCostPrice } },
      session ? { session } : undefined
    );
  }
}

export { INSUFFICIENT_STOCK, InsufficientStockError, type ShortageDetail } from "./inventoryErrors";

export type OrderItemLike = { product: mongoose.Types.ObjectId; quantity: number; isReadyItem?: boolean };

function normalizeProductRef(product: unknown): mongoose.Types.ObjectId {
  if (product && typeof product === "object" && (product as { _id?: unknown })._id) {
    return new mongoose.Types.ObjectId(String((product as { _id: unknown })._id));
  }
  return new mongoose.Types.ObjectId(String(product));
}

/**
 * Sum inventory needs for all order lines from product recipeLines (per-unit × line quantity).
 */
export async function aggregateRecipeRequirements(
  orderItems: Array<{ product: unknown; quantity: number; isReadyItem?: unknown }>,
  session?: ClientSession | null
): Promise<Map<string, number>> {
  if (!orderItems?.length) return new Map();

  const normalized = orderItems
    .filter((i) => !Boolean((i as { isReadyItem?: unknown }).isReadyItem))
    .map((i) => ({
      product: normalizeProductRef(i.product),
      quantity: Number(i.quantity) || 0,
    }))
    .filter((item) => item.quantity > 0);

  const productIds = [...new Set(normalized.map((i) => i.product.toString()))];
  const q = Product.find({ _id: { $in: productIds } }).select("recipeLines").lean();
  if (session) q.session(session);
  const products = await q;
  const byId = new Map(products.map((p: any) => [p._id.toString(), p]));

  const inventoryIds = Array.from(
    new Set(
      products.flatMap((p: any) =>
        (p.recipeLines || []).map((line: any) => String(line.inventoryItem))
      )
    )
  );
  const invQuery = Inventory.find({ _id: { $in: inventoryIds } }).select("unit").lean();
  if (session) invQuery.session(session);
  const inventoryDocs = await invQuery;
  const inventoryUnitMap = new Map<string, string>(
    inventoryDocs.map((inv: any) => [String(inv._id), String(inv.unit || "").toLowerCase()])
  );

  const totals = new Map<string, number>();
  for (const line of normalized) {
    const pid = line.product.toString();
    const p = byId.get(pid) as {
      recipeLines?: Array<{ inventoryItem: unknown; quantityPerUnit: number; unit?: string }>;
    } | undefined;
    if (!p) {
      // If the product no longer exists in the catalog, skip its recipe.
      // We can still create the invoice; there is simply no inventory recipe data available.
      continue;
    }
    for (const r of p.recipeLines || []) {
      const qpu = Number(r.quantityPerUnit);
      if (!r.inventoryItem || !(qpu > 0)) continue;
      const invId = String(r.inventoryItem);
      const inventoryUnit = inventoryUnitMap.get(invId) || "";
      const recipeUnit = normalizeUnit(String(r.unit || inventoryUnit));
      const adjustedQpu = convertBetweenUnits(qpu, recipeUnit, inventoryUnit);
      totals.set(invId, (totals.get(invId) || 0) + adjustedQpu * line.quantity);
    }
  }
  return totals;
}

export type BillingRecipeInput = {
  orderId: string;
  userId: string;
  paymentMethod: string;
  amountPaid: number;
  discountType?: string;
  discountValue?: number;
  notes?: string;
  paymentAccountName?: string;
  paymentAccountDiscountType?: string;
  paymentAccountDiscountValue?: number;
  paymentAccountDiscountAmount?: number;
  gstRatePct: number;
  invoiceNumber: string;
  discountAmount: number;
  serviceChargeAmount: number;
  taxAmount: number;
  total: number;
};

async function runBillingInSession(s: ClientSession | null, input: BillingRecipeInput) {
  const {
    orderId,
    userId,
    paymentMethod,
    amountPaid,
    discountType,
    discountValue,
    notes,
    paymentAccountName,
    paymentAccountDiscountType,
    paymentAccountDiscountValue,
    paymentAccountDiscountAmount,
    gstRatePct,
    invoiceNumber,
    discountAmount,
    serviceChargeAmount,
    taxAmount,
    total,
  } = input;

  const changeGiven = Math.max(0, amountPaid - total);

  const orderQuery = Order.findById(orderId);
  if (s) orderQuery.session(s);
  const order = await orderQuery;
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.status === "completed") throw new Error("ORDER_ALREADY_BILLED");

  const requirements = await aggregateRecipeRequirements(order.items as any[], s);
  const linesForLedger: {
    inventoryItem: mongoose.Types.ObjectId;
    quantityConsumed: number;
    fifoAllocations: FifoAllocation[];
  }[] = [];

  // Prefer consuming an active kitchen reservation (reserve on preparing, consume on billing).
  const reservationQuery = InventoryReservation.findOne({ order: orderId, status: "active" });
  if (s) reservationQuery.session(s);
  const activeReservation = await reservationQuery;

  if (activeReservation) {
    for (const line of (activeReservation.lines as any[]) || []) {
      const qty = Number(line.quantityReserved || 0);
      if (!(qty > 0)) continue;

      const { allocations } = await deductInventoryFifo({
        inventoryItemId: String(line.inventoryItem),
        quantity: qty,
        session: s,
        releaseReserved: qty,
      });

      linesForLedger.push({
        inventoryItem: new mongoose.Types.ObjectId(String(line.inventoryItem)),
        quantityConsumed: qty,
        fifoAllocations: allocations,
      });
    }

    activeReservation.status = "consumed";
    (activeReservation as any).consumedAt = new Date();
    await activeReservation.save({ session: s ?? undefined });
  } else {
    for (const [invId, qty] of requirements) {
      const { allocations } = await deductInventoryFifo({
        inventoryItemId: invId,
        quantity: qty,
        session: s,
        releaseReserved: 0,
      });

      linesForLedger.push({
        inventoryItem: new mongoose.Types.ObjectId(invId),
        quantityConsumed: qty,
        fifoAllocations: allocations,
      });
    }
  }

  const [invoice] = await Invoice.create(
    [
      {
        invoiceNumber,
        order: orderId,
        customer: order.customer,
        customerName: order.customerName,
        items: order.items.map(({ name, quantity, price, subtotal }: any) => ({
          name,
          quantity,
          price,
          subtotal,
          discount: 0,
          tax: 0,
          total: subtotal,
          cost: 0,
        })),
        subtotal: order.subtotal,
        taxRate: gstRatePct,
        taxAmount,
        discountType: discountType || "none",
        discountValue: discountValue || 0,
        discountAmount,
        serviceChargeAmount,
        paymentAccountName: String(paymentAccountName ?? ""),
        paymentAccountDiscountType: paymentAccountDiscountType || "none",
        paymentAccountDiscountValue: paymentAccountDiscountValue || 0,
        paymentAccountDiscountAmount: paymentAccountDiscountAmount || 0,
        total,
        paymentMethod,
        amountPaid,
        changeGiven,
        notes: notes || "",
        issuedBy: userId,
      },
    ],
    { session: s ?? undefined }
  );

  await Order.findByIdAndUpdate(orderId, { status: "completed", taxAmount, total }, { session: s ?? undefined });

  if (linesForLedger.length > 0) {
    await InventoryConsumption.create(
      [
        {
          order: orderId,
          invoice: invoice._id,
          lines: linesForLedger,
          createdBy: userId,
        },
      ],
      { session: s ?? undefined }
    );
  }

  return invoice;
}

/**
 * Creates invoice, completes order, decrements inventory from recipes, writes consumption ledger — atomically.
 * Requires MongoDB replica set (e.g. Atlas or local rs.initiate()).
 */
export async function executeBillingWithRecipeConsumption(input: BillingRecipeInput) {
  const session = await mongoose.startSession();
  try {
    const invoice = await session.withTransaction(() => runBillingInSession(session, input));
    return { invoice };
  } catch (e: unknown) {
    if (e instanceof InsufficientStockError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: number })?.code;
    const isTransactionUnavailable = code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg);
    if (isTransactionUnavailable) {
      console.warn("Transactions unavailable, falling back to non-transactional billing.");
      const invoice = await runBillingInSession(null, input);
      return { invoice };
    }
    throw e;
  } finally {
    session.endSession();
  }
}
