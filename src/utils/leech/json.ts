export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return undefined;
      if (key === "client" || key === "_client") return undefined;
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    },
    0
  );
}

export function toIdString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return String(value);
  } catch {
    return null;
  }
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

