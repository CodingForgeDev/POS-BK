import mongoose, { ClientSession } from "mongoose";
import Inventory from "../models/Inventory";

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

function normalizeInventoryItemId(item: unknown): string {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (typeof item === "object") {
    const maybeId = (item as { _id?: unknown })._id ?? (item as { id?: unknown }).id;
    if (maybeId) return String(maybeId);
  }
  return String(item);
}

export type InventoryStockMap = Map<
  string,
  { currentStock: number; reservedStock: number; unit: string }
>;

export type RecipeLine = {
  inventoryItem: mongoose.Types.ObjectId | string;
  quantityPerUnit: number;
  unit?: string;
};

export type ProductWithRecipe = {
  _id: string | mongoose.Types.ObjectId;
  isReadyItem?: boolean;
  sku?: string;
  name?: string;
  recipeLines?: RecipeLine[];
};

function normalizeText(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeLookupKey(raw: unknown): string {
  return normalizeText(raw)
    .replace(/^ready-/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function findReadyInventoryMatch(
  product: ProductWithRecipe,
  inventoryMap: InventoryStockMap,
  readyProductInventoryId?: string
): number | null {
  if (!readyProductInventoryId) return null;
  const inventory = inventoryMap.get(readyProductInventoryId);
  if (!inventory) return null;
  return Math.max(0, inventory.currentStock - inventory.reservedStock);
}

/**
 * Calculate the maximum quantity of a product that can be made based on available inventory.
 * Returns Infinity for ready items without a mapped ready inventory or products with no recipe lines.
 * For products with recipes, returns the minimum quantity that can be made across all ingredients.
 */
export function calculateProductAvailableQuantity(
  product: ProductWithRecipe,
  inventoryMap: InventoryStockMap,
  readyInventoryId?: string
): number {
  if (product.isReadyItem) {
    const readyAvailability = findReadyInventoryMatch(product, inventoryMap, readyInventoryId);
    if (readyAvailability != null) {
      return readyAvailability;
    }
    // Fall back to recipe availability when no ready inventory link exists.
  }

  // Products without recipes are always available
  if (!product.recipeLines || product.recipeLines.length === 0) return Infinity;

  let minAvailable = Infinity;

  for (const line of product.recipeLines) {
    const qpu = Number(line.quantityPerUnit);
    if (!(qpu > 0)) continue;

    const invId = normalizeInventoryItemId(line.inventoryItem);
    const inventory = inventoryMap.get(invId);

    if (!inventory) {
      // If inventory item not found, assume 0 stock
      return 0;
    }

    const availableStock = inventory.currentStock - (inventory.reservedStock || 0);
    if (availableStock <= 0) {
      return 0;
    }

    const inventoryUnit = normalizeUnit(inventory.unit || "");
    const recipeUnit = normalizeUnit(line.unit || inventoryUnit);
    const adjustedQpu = convertBetweenUnits(qpu, recipeUnit, inventoryUnit);

    if (adjustedQpu <= 0) continue;

    const maxFromThisIngredient = Math.floor(availableStock / adjustedQpu);
    minAvailable = Math.min(minAvailable, maxFromThisIngredient);
  }

  return minAvailable === Infinity ? 0 : minAvailable;
}

/**
 * Determine stock status based on available quantity.
 * - "out": 0 available
 * - "low": 1-threshold available
 * - "available": > threshold available
 */
export function getStockStatus(
  availableQuantity: number,
  threshold: number = 5
): "available" | "low" | "out" {
  if (availableQuantity === 0) return "out";
  if (availableQuantity <= threshold) return "low";
  return "available";
}

/**
 * Fetch inventory items and build a stock map for quick lookup.
 * Optionally filter by specific inventory item IDs.
 */
export async function buildInventoryStockMap(
  inventoryItemIds?: string[],
  session?: ClientSession | null
): Promise<InventoryStockMap> {
  const query = inventoryItemIds?.length
    ? Inventory.find({ _id: { $in: inventoryItemIds } })
    : Inventory.find({ isActive: true });

  const inventoryQuery = query
    .select("currentStock reservedStock unit")
    .lean();

  if (session) inventoryQuery.session(session);

  const inventoryDocs = await inventoryQuery;

  const map: InventoryStockMap = new Map();
  for (const inv of inventoryDocs) {
    map.set(String(inv._id), {
      currentStock: Number(inv.currentStock || 0),
      reservedStock: Number(inv.reservedStock || 0),
      unit: String(inv.unit || "").toLowerCase(),
    });
  }

  return map;
}

/**
 * Calculate availability for multiple products at once.
 * Returns a map of productId -> {availableQuantity, stockStatus}
 */
async function buildReadyInventoryMap(
  products: Array<ProductWithRecipe | any>,
  session?: ClientSession | null
): Promise<Map<string, string>> {
  const readyProducts = products.filter(
    (product) => Boolean(product.isReadyItem) && (product.sku || product.name)
  );
  if (!readyProducts.length) return new Map();

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
  for (const product of readyProducts) {
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

export async function calculateProductsAvailability(
  products: Array<ProductWithRecipe | any>,
  session?: ClientSession | null
): Promise<Map<string, { availableQuantity: number; stockStatus: string }>> {
  // Collect all unique inventory item IDs from all products
  const inventoryItemIds = new Set<string>();
  for (const product of products) {
    if (product.recipeLines && !product.isReadyItem) {
      for (const line of product.recipeLines) {
        const invId = normalizeInventoryItemId(line.inventoryItem);
        if (invId) inventoryItemIds.add(invId);
      }
    }
  }

  const readyInventoryMap = await buildReadyInventoryMap(products, session);
  for (const product of products) {
    const productId = String(product._id);
    const readyInvId = readyInventoryMap.get(productId);
    if (readyInvId) inventoryItemIds.add(readyInvId);
  }

  // Build inventory map
  const inventoryMap = await buildInventoryStockMap(
    Array.from(inventoryItemIds),
    session
  );

  // Calculate availability for each product
  const result = new Map<string, { availableQuantity: number; stockStatus: string }>();
  for (const product of products) {
    const productId = String(product._id);
    const readyInventoryId = readyInventoryMap.get(productId);
    const availableQuantity = calculateProductAvailableQuantity(product, inventoryMap, readyInventoryId);
    // Use -1 to represent infinite availability (products without stock tracking)
    const reportedQuantity = availableQuantity === Infinity ? -1 : availableQuantity;
    const stockStatus = getStockStatus(availableQuantity);
    result.set(productId, { availableQuantity: reportedQuantity, stockStatus });
  }

  return result;
}
