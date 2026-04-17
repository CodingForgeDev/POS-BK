import mongoose from "mongoose";
import { Response } from "express";

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

async function getNextSequence(id: string, date: string | null, startAt = 1): Promise<number> {
  const update: any = { $inc: { seq: 1 } };
  if (date !== null) update.$setOnInsert = { date };
  const counter = await SequenceCounter.findOneAndUpdate(
    { _id: id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  const current = counter?.seq ?? startAt;
  return current < startAt ? startAt : current;
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
