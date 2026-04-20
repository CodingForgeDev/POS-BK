import mongoose from "mongoose";
import { Response } from "express";
import Invoice from "../models/Invoice";
import Order from "../models/Order";
import { startOfBusinessDay } from "./appTimezone";

const SequenceCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    date: { type: String, default: null },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: "sequence_counters" }
);

const SequenceCounter =
  mongoose.models.SequenceCounter ||
  mongoose.model("SequenceCounter", SequenceCounterSchema);

function extractInvoiceSequence(invoiceNumber: string): number | null {
  const match = invoiceNumber.match(/^INV-(\d+)$/);
  if (!match) return null;
  const seq = Number(match[1]);
  if (!Number.isFinite(seq)) return null;
  return seq;
}

async function getMaxInvoiceSequenceNumber(): Promise<number> {
  const invoices = await Invoice.find({ invoiceNumber: /^INV-\d+$/ })
    .select("invoiceNumber")
    .lean();
  let max = 0;
  for (const invoice of invoices) {
    if (typeof invoice.invoiceNumber !== "string") continue;
    const seq = extractInvoiceSequence(invoice.invoiceNumber);
    if (seq === null) continue;
    if (seq < 1000 || seq > 999999) continue;
    max = Math.max(max, seq);
  }
  return max;
}

async function getNextSequence(id: string, startAt = 1): Promise<number> {
  const counter = await SequenceCounter.findOneAndUpdate(
    { _id: id },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  let current = Number(counter?.seq ?? startAt);
  if (current < startAt) {
    current = startAt;
  }

  if (id.startsWith("ORD-") && current >= 100000) {
    const orderCount = await Order.countDocuments({ orderNumber: new RegExp(`^${id}-\\d+$`) });
    const expected = Math.max(startAt, orderCount + 1);
    if (expected < current) {
      const updated = await SequenceCounter.findOneAndUpdate(
        { _id: id },
        { seq: expected },
        { new: true }
      ).lean();
      current = Number(updated?.seq ?? expected);
    }
  }

  if (id === "INV" && current >= 100000) {
    const maxExisting = await getMaxInvoiceSequenceNumber();
    const expected = Math.max(startAt, maxExisting + 1);
    if (expected < current) {
      const updated = await SequenceCounter.findOneAndUpdate(
        { _id: id },
        { seq: expected },
        { new: true }
      ).lean();
      current = Number(updated?.seq ?? expected);
    }
  }

  return current;
}

export function sendSuccess(
  res: Response,
  data: unknown,
  message = "Success",
  status = 200
): Response {
  return res.status(status).json({ success: true, message, data });
}

export function sendError(
  res: Response,
  message: string,
  status = 500,
  data?: unknown
): Response {
  const body: Record<string, unknown> = { success: false, message };
  if (data !== undefined) body.data = data;
  return res.status(status).json(body);
}

export async function generateOrderNumber(): Promise<string> {
  const now = startOfBusinessDay(new Date());
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dateCode = `${yy}${mm}${dd}`;
  const counterId = `ORD-${dateCode}`;

  const seq = await getNextSequence(counterId, 1);
  return `ORD-${dateCode}-${String(seq).padStart(2, "0")}`;
}

export async function generateInvoiceNumber(): Promise<string> {
  const counterId = "INV";
  const seq = await getNextSequence(counterId, 1000);
  return `INV-${String(seq).padStart(4, "0")}`;
}
