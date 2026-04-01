import mongoose from "mongoose";

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "price",
  "costPrice",
  "category",
  "image",
  "sku",
  "isAvailable",
  "isActive",
  "taxable",
  "taxRate",
  "preparationTime",
  "allergens",
  "sortOrder",
  "recipeLines",
]);

export function parseRecipeLines(raw: unknown): { inventoryItem: mongoose.Types.ObjectId; quantityPerUnit: number }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("recipeLines must be an array");
  const out: { inventoryItem: mongoose.Types.ObjectId; quantityPerUnit: number }[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") throw new Error("Invalid recipe line");
    const inv = (row as { inventoryItem?: unknown }).inventoryItem;
    const q = Number((row as { quantityPerUnit?: unknown }).quantityPerUnit);
    if (!mongoose.isValidObjectId(inv)) throw new Error("Invalid inventoryItem in recipe");
    if (!(q > 0) || !Number.isFinite(q)) throw new Error("quantityPerUnit must be a positive number");
    out.push({ inventoryItem: new mongoose.Types.ObjectId(String(inv)), quantityPerUnit: q });
  }
  return out;
}

/** Whitelist product fields from request body (avoids mass assignment). */
export function pickProductPayload(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    if (body[key] === undefined) continue;
    if (key === "recipeLines") {
      out.recipeLines = parseRecipeLines(body.recipeLines);
    } else {
      out[key] = body[key];
    }
  }
  return out;
}
