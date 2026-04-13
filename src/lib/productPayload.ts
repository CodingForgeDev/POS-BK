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
  "modifierGroups",
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

type ParsedModifierOption = { name: string; priceDelta: number };
type ParsedModifierGroup = {
  name: string;
  required: boolean;
  multiSelect: boolean;
  options: ParsedModifierOption[];
};

function sanitizeName(value: unknown, field: string): string {
  const out = String(value ?? "").trim();
  if (!out) throw new Error(`${field} is required`);
  return out.slice(0, 80);
}

export function parseModifierGroups(raw: unknown): ParsedModifierGroup[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("modifierGroups must be an array");
  const groups: ParsedModifierGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") throw new Error("Invalid modifier group");
    const name = sanitizeName((g as { name?: unknown }).name, "modifier group name");
    const required = Boolean((g as { required?: unknown }).required);
    const multiSelect = Boolean((g as { multiSelect?: unknown }).multiSelect);
    const optionsRaw = (g as { options?: unknown }).options;
    if (!Array.isArray(optionsRaw) || optionsRaw.length === 0) {
      throw new Error(`modifier group "${name}" must have at least one option`);
    }
    const options: ParsedModifierOption[] = optionsRaw.map((o) => {
      if (!o || typeof o !== "object") throw new Error(`Invalid option in modifier group "${name}"`);
      const optionName = sanitizeName((o as { name?: unknown }).name, `option name in "${name}"`);
      const priceDelta = Number((o as { priceDelta?: unknown }).priceDelta ?? 0);
      if (!Number.isFinite(priceDelta)) {
        throw new Error(`Invalid priceDelta in modifier group "${name}"`);
      }
      return { name: optionName, priceDelta };
    });
    groups.push({ name, required, multiSelect, options });
  }
  return groups;
}

/** Whitelist product fields from request body (avoids mass assignment). */
export function pickProductPayload(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    if (body[key] === undefined) continue;
    if (key === "recipeLines") {
      out.recipeLines = parseRecipeLines(body.recipeLines);
    } else if (key === "modifierGroups") {
      out.modifierGroups = parseModifierGroups(body.modifierGroups);
    } else {
      out[key] = body[key];
    }
  }
  return out;
}
