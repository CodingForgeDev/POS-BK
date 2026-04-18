import mongoose from "mongoose";
import { Response } from "express";
import Invoice from "../models/Invoice";

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

async function getMaxInvoiceSequenceNumber(): Promise<number> {
  const latestInvoice = await Invoice.findOne({ invoiceNumber: /^INV-\d+$/ })
    .sort({ invoiceNumber: -1 })
    .lean();
  if (!latestInvoice || typeof latestInvoice.invoiceNumber !== "string") return 0;
  const match = latestInvoice.invoiceNumber.match(/^INV-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function getNextSequence(id: string, date: string | null, startAt = 1): Promise<number> {
  while (true) {
    const update: any = { $inc: { seq: 1 } };
    if (date !== null) update.$setOnInsert = { date };
    const counter = await SequenceCounter.findOneAndUpdate(
      { _id: id },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    const current = Number(counter?.seq ?? startAt);
    const maxExisting = await getMaxInvoiceSequenceNumber();
    const expected = Math.max(startAt, current, maxExisting + 1);
    if (expected === current) {
      return current < startAt ? startAt : current;
    }

    const updated = await SequenceCounter.findOneAndUpdate(
      { _id: id, seq: current },
      { seq: expected },
      { new: true }
    ).lean();
    if (updated) {
      return expected;
    }
  }
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
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dateCode = `${yy}${mm}${dd}`;
  const counterId = `ORD-${dateCode}`;

  const seq = await getNextSequence(counterId, dateCode, 1);
  return `ORD-${dateCode}-${String(seq).padStart(2, "0")}`;
}

export async function generateInvoiceNumber(): Promise<string> {
  const counterId = "INV";
  const seq = await getNextSequence(counterId, null, 1000);
  return `INV-${String(seq).padStart(4, "0")}`;
}
