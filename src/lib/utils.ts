import { Response } from "express";

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

export function generateOrderNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");
  return `ORD-${timestamp}${random}`;
}

export function generateInvoiceNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");
  return `INV-${timestamp}${random}`;
}
