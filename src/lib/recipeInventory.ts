import mongoose, { ClientSession } from "mongoose";
import Order from "../models/Order";
import Product from "../models/Product";
import Inventory from "../models/Inventory";
import Invoice from "../models/Invoice";
import InventoryConsumption from "../models/InventoryConsumption";
import InventoryReservation from "../models/InventoryReservation";

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

export type OrderItemLike = { product: mongoose.Types.ObjectId; quantity: number };

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
  orderItems: Array<{ product: unknown; quantity: number }>,
  session?: ClientSession | null
): Promise<Map<string, number>> {
  if (!orderItems?.length) return new Map();

  const normalized = orderItems.map((i) => ({
    product: normalizeProductRef(i.product),
    quantity: Number(i.quantity) || 0,
  }));

  const productIds = [...new Set(normalized.map((i) => i.product.toString()))];
  const q = Product.find({ _id: { $in: productIds } }).select("recipeLines").lean();
  if (session) q.session(session);
  const products = await q;
  const byId = new Map(products.map((p: any) => [p._id.toString(), p]));

  const totals = new Map<string, number>();
  for (const line of normalized) {
    const pid = line.product.toString();
    const p = byId.get(pid) as { recipeLines?: Array<{ inventoryItem: unknown; quantityPerUnit: number }> } | undefined;
    if (!p) {
      throw new Error(`Product ${pid} not found for order line`);
    }
    for (const r of p.recipeLines || []) {
      const qpu = Number(r.quantityPerUnit);
      if (!r.inventoryItem || !(qpu > 0)) continue;
      const invId = String(r.inventoryItem);
      totals.set(invId, (totals.get(invId) || 0) + qpu * line.quantity);
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
  gstRatePct: number;
  invoiceNumber: string;
  discountAmount: number;
  serviceChargeAmount: number;
  taxAmount: number;
  total: number;
};

async function runBillingInSession(s: ClientSession, input: BillingRecipeInput) {
  const {
    orderId,
    userId,
    paymentMethod,
    amountPaid,
    discountType,
    discountValue,
    notes,
    gstRatePct,
    invoiceNumber,
    discountAmount,
    serviceChargeAmount,
    taxAmount,
    total,
  } = input;

  const changeGiven = Math.max(0, amountPaid - total);

  const order = await Order.findById(orderId).session(s);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.status === "completed") throw new Error("ORDER_ALREADY_BILLED");

  const requirements = await aggregateRecipeRequirements(order.items as any[], s);
  const linesForLedger: { inventoryItem: mongoose.Types.ObjectId; quantityConsumed: number }[] = [];

  // Prefer consuming an active kitchen reservation (reserve on preparing, consume on billing).
  const activeReservation = await InventoryReservation.findOne({ order: orderId, status: "active" }).session(s);

  if (activeReservation) {
    const shortages: ShortageDetail[] = [];
    for (const line of (activeReservation.lines as any[]) || []) {
      const qty = Number(line.quantityReserved || 0);
      if (!(qty > 0)) continue;

      const updated = await Inventory.findOneAndUpdate(
        {
          _id: line.inventoryItem,
          isActive: true,
          currentStock: { $gte: qty },
          reservedStock: { $gte: qty },
        },
        { $inc: { currentStock: -qty, reservedStock: -qty } },
        { session: s, new: true }
      ).lean();

      if (!updated) {
        const current = await Inventory.findById(line.inventoryItem)
          .session(s)
          .select("name currentStock")
          .lean();
        shortages.push({
          inventoryId: String(line.inventoryItem),
          name: (current as { name?: string } | null)?.name || "Unknown",
          required: qty,
          available: (current as { currentStock?: number } | null)?.currentStock ?? 0,
        });
        continue;
      }

      linesForLedger.push({
        inventoryItem: new mongoose.Types.ObjectId(String(line.inventoryItem)),
        quantityConsumed: qty,
      });
    }

    if (shortages.length) throw new InsufficientStockError(shortages);

    activeReservation.status = "consumed";
    (activeReservation as any).consumedAt = new Date();
    await activeReservation.save({ session: s });
  } else {
    // Backwards compatible path (no reservation): deduct directly at billing time.
    for (const [invId, qty] of requirements) {
      const updated = await Inventory.findOneAndUpdate(
        { _id: invId, isActive: true, currentStock: { $gte: qty } },
        { $inc: { currentStock: -qty } },
        { session: s, new: true }
      ).lean();

      if (!updated) {
        const current = await Inventory.findById(invId).session(s).select("name currentStock").lean();
        throw new InsufficientStockError([
          {
            inventoryId: invId,
            name: (current as { name?: string } | null)?.name || "Unknown",
            required: qty,
            available: (current as { currentStock?: number } | null)?.currentStock ?? 0,
          },
        ]);
      }
      linesForLedger.push({
        inventoryItem: new mongoose.Types.ObjectId(invId),
        quantityConsumed: qty,
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
        })),
        subtotal: order.subtotal,
        taxRate: gstRatePct,
        taxAmount,
        discountType: discountType || "none",
        discountValue: discountValue || 0,
        discountAmount,
        serviceChargeAmount,
        total,
        paymentMethod,
        amountPaid,
        changeGiven,
        notes: notes || "",
        issuedBy: userId,
      },
    ],
    { session: s }
  );

  await Order.findByIdAndUpdate(orderId, { status: "completed", taxAmount, total }, { session: s });

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
      { session: s }
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
    if (code === 20 || /replica set/i.test(msg) || /Transaction numbers/i.test(msg)) {
      throw new Error(
        "MongoDB transactions require a replica set. Use MongoDB Atlas or run mongod with --replSet (see server/MONGODB-TRANSACTIONS.md)."
      );
    }
    throw e;
  } finally {
    session.endSession();
  }
}
