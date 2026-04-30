export const LEGACY_TO_CANONICAL_STATUS: Record<string, string> = {
  open: "created",
  completed: "closed",
};

export const CANONICAL_TO_LEGACY_STATUS: Record<string, string> = {
  created: "open",
  closed: "completed",
};

export function normalizeOrderStatus(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  return LEGACY_TO_CANONICAL_STATUS[value] ?? value;
}

export function toLegacyStatus(statusRaw: string): string {
  const status = normalizeOrderStatus(statusRaw);
  return CANONICAL_TO_LEGACY_STATUS[status] ?? status;
}

export function canTransitionOrderStatus(roleRaw: string, fromRaw: string, toRaw: string): boolean {
  const role = String(roleRaw ?? "").trim().toLowerCase();
  const from = normalizeOrderStatus(fromRaw);
  const to = normalizeOrderStatus(toRaw);
  if (from === to) return true;
  if (role === "admin" || role === "manager") {
    return !["closed", "cancelled", "rejected"].includes(from);
  }
  if (role === "waiter") {
    return (from === "created" && to === "sent") || (from === "ready" && to === "served");
  }
  if (role === "kitchen" || role === "bar") {
    return (
      (from === "sent" && to === "accepted") ||
      (from === "accepted" && to === "preparing") ||
      (from === "preparing" && to === "ready")
    );
  }
  if (role === "cashier") {
    return from === "served" && to === "closed";
  }
  return false;
}
