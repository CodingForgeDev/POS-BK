import mongoose from "mongoose";
import { Router, Response } from "express";
import { authenticate, AuthenticatedRequest } from "../middleware/auth";
import { connectDB } from "../lib/mongodb";
import { sendSuccess, sendError } from "../lib/utils";
import Setting from "../models/Setting";
import LedgerAccount from "../models/LedgerAccount";
import { getCoaBaseCode, extractSubDetailCode, getNextCoaAccountCode } from "../lib/coaConstants";

const router: Router = Router();

function normalizePaymentAccounts(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Generates the next available account code for a given subcategory using COA hierarchy.
 * Uses 5-segment format: BASE-0000-SUBDETAIL
 * Example: 1-02-070-0000-00001 for the first cash account
 */
async function getNextAccountCodeForSubcategory(subcategory: string = "cash"): Promise<string> {
  const baseCode = getCoaBaseCode(subcategory);
  if (!baseCode) {
    throw new Error(`Unknown subcategory for COA mapping: ${subcategory}. Cannot generate account code.`);
  }

  // Query all existing accounts with the same base code
  const escapedBaseCode = baseCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const accounts = await LedgerAccount.find({
    code: { $regex: `^${escapedBaseCode}-` },
    isActive: true,
  })
    .select("code")
    .lean();

  // Extract sub-detail codes (5th segment) from existing accounts
  const usedSubDetailCodes = accounts
    .map((acc: any) => extractSubDetailCode(acc.code))
    .filter((code: number | null): code is number => code !== null);

  // Find next available sub-detail code using COA helper
  const nextCode = getNextCoaAccountCode(subcategory, usedSubDetailCodes);
  return nextCode;
}

function shouldUsePaymentLedgerAccount(method: string): boolean {
  const normalized = String(method || "").toLowerCase();
  return ["cash", "card", "bank_transfer", "credit_card", "debit_card", "upi", "digital", "wallet"].includes(normalized);
}

function getLedgerAccountMetadata(paymentAccountId: string, paymentMethod: string): Record<string, unknown> {
  return {
    paymentAccountId,
    syncedFromSettings: true,
    paymentMethod,
  };
}

router.get("/", authenticate, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    const settings = await (Setting as any).find({}).lean();
    const result: Record<string, any> = {};
    for (const s of settings as any[]) {
      result[s.key] = s.value;
    }
    return sendSuccess(res, result);
  } catch (error) {
    return sendError(res, "Failed to fetch settings", 500);
  }
});

router.post("/", authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await connectDB();
    if (!["admin", "manager"].includes(req.user.role)) {
      return sendError(res, "Unauthorized", 403);
    }

    const payload = { ...req.body } as Record<string, unknown>;
    const paymentAccounts = normalizePaymentAccounts(payload.paymentAccounts);

    if (paymentAccounts.length > 0) {
      for (const account of paymentAccounts) {
        try {
          const accountId = String(account?.id || "").trim();
          if (!accountId || !shouldUsePaymentLedgerAccount(String(account.method))) {
            continue;
          }

          let ledgerAccount: any | null = null;
          const existingLedgerId = String(account.ledgerAccountId || "").trim();
          if (mongoose.Types.ObjectId.isValid(existingLedgerId)) {
            ledgerAccount = await LedgerAccount.findOne({ _id: new mongoose.Types.ObjectId(existingLedgerId), isActive: true }).lean();
          }

          if (!ledgerAccount) {
            ledgerAccount = await LedgerAccount.findOne({
              "metadata.paymentAccountId": accountId,
              isActive: true,
            }).lean();
          }

          if (!ledgerAccount) {
            const nextCode = await getNextAccountCodeForSubcategory("cash");
            ledgerAccount = await LedgerAccount.create({
              code: nextCode,
              title: String(account.name || "").trim() || `Payment Account ${accountId}`,
              type: "asset",
              subcategory: "cash",
              currency: "PKR",
              isReconcilable: true,
              currentBalance: 0,
              openingBalance: 0,
              metadata: getLedgerAccountMetadata(accountId, String(account.method || "").toLowerCase()),
            });
          } else {
            const updatedTitle = String(account.name || "").trim();
            const shouldUpdateTitle = updatedTitle && updatedTitle !== String(ledgerAccount.title || "").trim();
            if (shouldUpdateTitle) {
              await LedgerAccount.updateOne(
                { _id: ledgerAccount._id },
                {
                  $set: {
                    title: updatedTitle,
                    metadata: {
                      ...ledgerAccount.metadata,
                      ...getLedgerAccountMetadata(accountId, String(account.method || "").toLowerCase()),
                    },
                  },
                }
              );
            }
          }

          if (ledgerAccount) {
            account.ledgerAccountId = String(ledgerAccount._id);
          }
        } catch (syncError) {
          console.error(`Failed to sync ledger for payment account ${String(account?.id || "")}:`, syncError);
        }
      }

      payload.paymentAccounts = paymentAccounts;
    }

    const ops = Object.entries(payload).map(([key, value]) => ({
      updateOne: {
        filter: { key },
        update: { $set: { key, value } },
        upsert: true,
      },
    }));
    if (ops.length > 0) await (Setting as any).bulkWrite(ops);

    return sendSuccess(res, { paymentAccounts: payload.paymentAccounts || null }, "Settings saved successfully");
  } catch (error) {
    console.error("Settings save error:", error);
    return sendError(res, "Failed to save settings", 500);
  }
});

export default router;
