import mongoose, { ClientSession } from "mongoose";
import Order from "../models/Order";
import Product from "../models/Product";
import Inventory from "../models/Inventory";
import Invoice from "../models/Invoice";
import InventoryConsumption from "../models/InventoryConsumption";
import InventoryReservation from "../models/InventoryReservation";
import StockLayer from "../models/StockLayer";
import WasteLog from "../models/WasteLog";
import { InsufficientStockError } from "./inventoryErrors";
import { deductInventoryFifo, type FifoAllocation } from "./inventoryFifo";
import {
  createJournalEntryRecord,
  resolvePosPostingAccounts,
} from "./journalPosting";

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

/**
 * Calculate current cost prices for multiple products based on their recipes and current inventory costs.
 * Returns a map of productId -> calculated cost price.
 */
export async function calculateProductsCostPrices(
  products: Array<any>,
  session?: ClientSession | null
): Promise<Map<string, number>> {
  // Collect all unique inventory item IDs from all products with recipes
  const inventoryItemIds = new Set<string>();
  for (const product of products) {
    if (product.recipeLines && product.recipeLines.length > 0) {
      for (const line of product.recipeLines) {
        const invId = String(line.inventoryItem?._id || line.inventoryItem);
        if (invId) inventoryItemIds.add(invId);
      }
    }
  }

  // Fetch all inventory costs at once
  const inventoryQuery = Inventory.find({ _id: { $in: Array.from(inventoryItemIds) } })
    .select("unit costPerUnit")
    .lean();
  if (session) inventoryQuery.session(session);
  const inventoryDocs = await inventoryQuery;
  
  const inventoryMap = new Map<string, { unit?: string; costPerUnit?: number }>(
    inventoryDocs.map((inv: any) => [
      String(inv._id), 
      { 
        unit: String(inv.unit || "").toLowerCase(), 
        costPerUnit: Number(inv.costPerUnit || 0) 
      }
    ])
  );

  // Calculate cost price for each product
  const result = new Map<string, number>();
  
  for (const product of products) {
    const productId = String(product._id);
    
    // Skip products without recipes
    if (!product.recipeLines || product.recipeLines.length === 0) {
      // Use stored costPrice or 0
      result.set(productId, Number(product.costPrice || 0));
      continue;
    }

    // Calculate cost from recipe
    const costPrice = product.recipeLines.reduce((sum: number, line: any) => {
      const invId = String(line.inventoryItem?._id || line.inventoryItem);
      const inv = inventoryMap.get(invId);
      if (!inv) return sum;
      
      const inventoryUnit = inv.unit || "";
      const recipeUnit = normalizeUnit(line.unit || inventoryUnit);
      const adjustedQuantity = convertBetweenUnits(
        Number(line.quantityPerUnit || 0), 
        recipeUnit, 
        inventoryUnit
      );
      
      return sum + adjustedQuantity * (inv.costPerUnit ?? 0);
    }, 0);

    result.set(productId, costPrice);
  }

  return result;
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

function normalizeText(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeLookupKey(raw: unknown): string {
  return normalizeText(raw)
    .replace(/^ready-/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeProductRef(product: unknown): mongoose.Types.ObjectId {
  if (product && typeof product === "object" && (product as { _id?: unknown })._id) {
    return new mongoose.Types.ObjectId(String((product as { _id: unknown })._id));
  }
  return new mongoose.Types.ObjectId(String(product));
}

async function findReadyInventoryForProducts(
  products: Array<{ _id: unknown; sku?: string; name?: string }>,
  session?: ClientSession | null
): Promise<Map<string, string>> {
  if (!products.length) return new Map();

  const readyInventoryQuery = Inventory.find({
    isActive: true,
    $or: [{ inventoryType: "ready" }, { isForReadyMenu: true }],
  }).select("sku name");
  if (session) readyInventoryQuery.session(session);
  const readyInventories = await readyInventoryQuery.lean();

  const keyMap = new Map<string, string>();
  for (const inv of readyInventories as any[]) {
    const skuKey = normalizeLookupKey(inv.sku);
    if (skuKey) keyMap.set(skuKey, String(inv._id));
    const nameKey = normalizeLookupKey(inv.name);
    if (nameKey) keyMap.set(nameKey, String(inv._id));
  }

  const result = new Map<string, string>();
  for (const product of products) {
    const productId = String(product._id);
    const skuKey = normalizeLookupKey(product.sku);
    const nameKey = normalizeLookupKey(product.name);
    if (skuKey && keyMap.has(skuKey)) {
      result.set(productId, keyMap.get(skuKey)!);
    } else if (nameKey && keyMap.has(nameKey)) {
      result.set(productId, keyMap.get(nameKey)!);
    }
  }

  return result;
}

async function postPOSOrderJournalEntry(
  order: any,
  invoice: any,
  allocations: Array<{ inventoryItem: mongoose.Types.ObjectId; quantityConsumed: number; fifoAllocations: FifoAllocation[] }>,
  session: ClientSession | null
) {
  if (!order || !invoice || !order._id) return;

  const total = Number(invoice.total || 0);
  const subtotal = Number(invoice.subtotal ?? order.subtotal ?? 0);
  const taxAmount = Number(invoice.taxAmount || 0);
  const serviceChargeAmount = Number(invoice.serviceChargeAmount || 0);
  // invoice.discountAmount = order-level + billing-dialog discount (combined at checkout).
  // Must use invoice field so the debit side matches the already-reduced invoice.total.
  const discountAmount = Number(invoice.discountAmount ?? order.discountAmount ?? 0);
  const paymentAccountDiscountAmount = Number(invoice.paymentAccountDiscountAmount || 0);
  const combinedDiscountAmount = discountAmount + paymentAccountDiscountAmount;
  const netAfterDiscount = Math.max(0, subtotal - combinedDiscountAmount);
  const grandTotal = netAfterDiscount + serviceChargeAmount + taxAmount;
  if (!total || total <= 0) return;

  const {
    paymentAccount,
    revenueAccount,
    taxAccount,
    serviceAccount,
    discountAccount: resolvedDiscountAccount,
    cogsAccount: resolvedCogsAccount,
    inventoryAccount: resolvedInventoryAccount,
  } = await resolvePosPostingAccounts(String(invoice?.paymentMethod || ""));

  const costAmount = allocations.reduce((sum, line) => {
    return (
      sum +
      (line.fifoAllocations || []).reduce(
        (inner, allocation) => inner + Number(allocation.unitCost || 0) * Number(allocation.quantity || 0),
        0
      )
    );
  }, 0);

  let cogsAccount: any = null;
  let inventoryAccount: any = null;
  if (costAmount > 0) {
    cogsAccount = resolvedCogsAccount;
    inventoryAccount = resolvedInventoryAccount;
  }

  let discountAccount = null as any;
  if (discountAmount > 0 || paymentAccountDiscountAmount > 0) {
    discountAccount = resolvedDiscountAccount;
    if (!discountAccount) {
      discountAccount = revenueAccount;
    }
  }

  if (!paymentAccount || !revenueAccount || !taxAccount) {
    throw new Error(
      "POS posting configuration is incomplete. Please configure payment, sales revenue, and GST accounts in Settings."
    );
  }

  const lines: any[] = [
    {
      account: paymentAccount._id,
      accountName: paymentAccount.title,
      debit: total,
      credit: 0,
      note: `POS order ${order.orderNumber}`,
    },
  ];

  if (discountAmount > 0) {
    const discountName = invoice.discountName || "";
    const discountCode = invoice.discountCode || "";
    const namePart = discountName ? ` (${discountName}${discountCode ? ` - ${discountCode}` : ""})` : "";

    lines.push({
      account: discountAccount?._id || revenueAccount._id,
      accountName: discountAccount?.title || revenueAccount.title,
      debit: discountAmount,
      credit: 0,
      note: `Order discount${namePart} for ${order.orderNumber}`,
    });
  }

  if (paymentAccountDiscountAmount > 0) {
    lines.push({
      account: discountAccount?._id || revenueAccount._id,
      accountName: discountAccount?.title || revenueAccount.title,
      debit: paymentAccountDiscountAmount,
      credit: 0,
      note: `Payment account discount for ${order.orderNumber}`,
    });
  }

  if (subtotal > 0) {
    lines.push({
      account: revenueAccount._id,
      accountName: revenueAccount.title,
      debit: 0,
      credit: subtotal,
      note: `POS sales revenue for ${order.orderNumber}`,
    });
  }

  if (taxAmount > 0) {
    lines.push({
      account: taxAccount._id,
      accountName: taxAccount.title,
      debit: 0,
      credit: taxAmount,
      note: `GST for ${order.orderNumber}`,
    });
  }

  if (serviceChargeAmount > 0) {
    lines.push({
      account: serviceAccount?._id || revenueAccount._id,
      accountName: serviceAccount?.title || revenueAccount.title,
      debit: 0,
      credit: serviceChargeAmount,
      note: `Service charge for ${order.orderNumber}`,
    });
  }

  if (costAmount > 0) {
    if (!cogsAccount || !inventoryAccount) {
      console.warn("Skipped COGS journal lines: missing COGS or inventory account mapping");
    } else {
      lines.push(
        {
          account: cogsAccount._id,
          accountName: cogsAccount.title,
          debit: costAmount,
          credit: 0,
          note: `COGS for ${order.orderNumber}`,
        },
        {
          account: inventoryAccount._id,
          accountName: inventoryAccount.title,
          debit: 0,
          credit: costAmount,
          note: `Inventory reduction for ${order.orderNumber}`,
        }
      );
    }
  }

  try {
    await createJournalEntryRecord({
      date: new Date(),
      reference: invoice.invoiceNumber,
      description: `POS sale invoice ${invoice.invoiceNumber}`,
      lines,
      source: "POS",
      sourceId: order._id,
      postedBy: invoice.issuedBy || order.servedBy || null,
      grossSubtotal: subtotal,
      discountAmount: combinedDiscountAmount,
      netAfterDiscount,
      gstAmount: taxAmount,
      serviceChargeAmount,
      grandTotal,
      session,
    });
  } catch (err: any) {
    if (err?.message === "Journal entry already exists for this source") return;
    throw err;
  }
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
    .map((i) => ({
      product: normalizeProductRef(i.product),
      quantity: Number(i.quantity) || 0,
      isReadyItem: Boolean((i as { isReadyItem?: unknown }).isReadyItem),
    }))
    .filter((item) => item.quantity > 0);

  const productIds = [...new Set(normalized.map((i) => i.product.toString()))];
  const q = Product.find({ _id: { $in: productIds } })
    .select("recipeLines sku name isReadyItem")
    .lean();
  if (session) q.session(session);
  const products = await q;
  const byId = new Map(products.map((p: any) => [String(p._id), p]));

  const readyInventoryMap = await findReadyInventoryForProducts(products, session);

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
    const product = byId.get(pid) as {
      recipeLines?: Array<{ inventoryItem: unknown; quantityPerUnit: number; unit?: string }>;
      isReadyItem?: boolean;
    } | undefined;
    const isReadyProduct = line.isReadyItem || Boolean(product?.isReadyItem);

    if (isReadyProduct) {
      const readyInventoryId = readyInventoryMap.get(pid);
      if (readyInventoryId) {
        totals.set(readyInventoryId, (totals.get(readyInventoryId) || 0) + line.quantity);
        continue;
      }
      // If a ready product has no linked ready inventory, fall back to its raw recipe so stock usage is still recorded.
    }

    if (!product) {
      continue;
    }
    for (const r of product.recipeLines || []) {
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
  discountCode?: string;
  discountName?: string;
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
    discountCode,
    discountName,
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

  const orderNumberLabel = (order as any).orderNumber || order._id.toString().slice(-6);
  const createdByOid = userId ? new mongoose.Types.ObjectId(userId) : null;

  if (activeReservation) {
    for (const line of (activeReservation.lines as any[]) || []) {
      const qty = Number(line.quantityReserved || 0);
      if (!(qty > 0)) continue;

      const { allocations } = await deductInventoryFifo({
        inventoryItemId: String(line.inventoryItem),
        quantity: qty,
        session: s,
        releaseReserved: qty,
        createTrackingLayer: {
          sourceType: "pos",
          actionLabel: `POS Order #${orderNumberLabel}`,
          createdBy: createdByOid,
        },
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
        createTrackingLayer: {
          sourceType: "pos",
          actionLabel: `POS Order #${orderNumberLabel}`,
          createdBy: createdByOid,
        },
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
        gstRatePct,
        discountType: discountType || "none",
        discountValue: discountValue || 0,
        discountAmount,
        discountCode: discountCode || "",
        discountName: discountName || "",
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

  await postPOSOrderJournalEntry(order, invoice, linesForLedger, s);

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

/**
 * Processes inventory impact when a POS refund is approved.
 *
 * Behaviour depends on the item type stored on each order line:
 *
 *  • isReadyItem = true  (packaged/pre-made goods — cake, canned drink, biscuit)
 *    → Ingredients/stock added back via the product's recipe lines.
 *      These items can be returned to the shelf, so inventory is restored.
 *
 *  • isReadyItem = false (made-to-order — burger, milkshake, pizza)
 *    → Ingredients are already consumed during preparation.
 *      A WasteLog entry is created instead; no inventory reversal.
 *      This keeps COGS accurate and feeds the manager waste report.
 *
 * @param invoiceId     - The Invoice._id being refunded.
 * @param refundItems   - Items from refundRequest (partial refund) or null (full refund).
 * @param postedBy      - User ID of the person who approved the refund.
 */
export async function restockInventoryForRefund(
  invoiceId: string,
  refundItems: Array<{ name: string; refundQuantity?: number; quantity?: number }> | null,
  postedBy: string | null
): Promise<void> {
  const safeId = String(invoiceId).trim();
  if (!mongoose.Types.ObjectId.isValid(safeId)) return;

  const invoice = await Invoice.findById(safeId).lean() as any;
  if (!invoice?.order) return;

  const order = await Order.findById(String(invoice.order)).lean() as any;
  if (!order?.items?.length) return;

  const createdByOid =
    postedBy && mongoose.Types.ObjectId.isValid(postedBy)
      ? new mongoose.Types.ObjectId(postedBy)
      : null;

  // Build the list of (orderItem, qty) pairs to process
  const toProcess: Array<{ orderItem: any; refundQty: number }> = [];

  if (!refundItems) {
    // Full refund — every item in the order
    for (const item of order.items as any[]) {
      toProcess.push({ orderItem: item, refundQty: Number(item.quantity || 0) });
    }
  } else {
    // Partial — match each refund line to an order item by name
    for (const ri of refundItems) {
      const match = (order.items as any[]).find(
        (oi: any) =>
          String(oi.name || "").trim().toLowerCase() ===
          String(ri.name || "").trim().toLowerCase()
      );
      if (!match) continue;
      const qty = Math.min(
        Number(ri.refundQuantity ?? ri.quantity ?? 0),
        Number(match.quantity || 0)
      );
      if (qty > 0) toProcess.push({ orderItem: match, refundQty: qty });
    }
  }

  for (const { orderItem, refundQty } of toProcess) {
    if (!(refundQty > 0)) continue;

    // Fetch product to get isReadyItem flag, recipe lines, and cost
    const product = orderItem.product
      ? (await Product.findById(String(orderItem.product))
          .select("isReadyItem recipeLines costPrice")
          .lean() as any)
      : null;

    const isReady =
      Boolean(orderItem.isReadyItem) || Boolean(product?.isReadyItem);

    if (isReady) {
      // ── Ready/packaged item → restock ingredient inventory ──────────────
      const recipeLines: any[] = product?.recipeLines ?? [];
      for (const line of recipeLines) {
        const qty =
          Math.round(Number(line.quantityPerUnit || 0) * refundQty * 10000) / 10000;
        if (!(qty > 0)) continue;

        const invId = new mongoose.Types.ObjectId(String(line.inventoryItem));
        const inv = await Inventory.findById(invId)
          .select("costPerUnit")
          .lean() as any;
        if (!inv) continue;

        await StockLayer.create([{
          sourceType: "adjustment",
          actionLabel: `Refund return — ${String(orderItem.name || "")}`,
          purchase: null,
          lineIndex: 0,
          inventoryItem: invId,
          supplier: null,
          createdBy: createdByOid,
          adjustmentType: "add",
          receivedAt: new Date(),
          quantityOriginal: qty,
          quantityRemaining: qty,
          unitCost: Number(inv.costPerUnit) || 0,
        }]);

        await Inventory.updateOne(
          { _id: invId },
          { $inc: { currentStock: qty } }
        );
      }
    } else {
      // ── Prepared item → log as waste, no ingredient reversal ────────────
      await WasteLog.create({
        order: order._id,
        invoice: invoice._id,
        product: orderItem.product || null,
        itemName: String(orderItem.name || ""),
        quantity: refundQty,
        cost: Math.round(Number(product?.costPrice || 0) * refundQty * 100) / 100,
        reason: "refund",
        loggedBy: createdByOid,
      });
    }
  }
}
