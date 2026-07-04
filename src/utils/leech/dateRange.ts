import type { LeechDateRange } from "./types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseInputDate(input: string, endOfDay: boolean): Date {
  const trimmed = input.trim();
  const dateOnly = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      endOfDay ? 23 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 59 : 0,
      endOfDay ? 999 : 0
    );
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return parsed;
}

/**
 * Parse user supplied range into Telegram seconds.
 * 解析用户传入的日期范围，并转换成 Telegram 使用的秒级时间戳。
 */
export function parseLeechDateRange(fromInput?: string, toInput?: string): LeechDateRange {
  if (!fromInput || !toInput) {
    throw new Error("Missing date range. Required: --from YYYY-MM-DD --to YYYY-MM-DD");
  }

  const from = parseInputDate(fromInput, false);
  const to = parseInputDate(toInput, true);
  if (from.getTime() > to.getTime()) {
    throw new Error("--from must be earlier than or equal to --to");
  }

  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  return {
    from,
    to,
    fromTs,
    toTs,
    label: `${formatLocal(from)} -> ${formatLocal(to)}`,
  };
}

export function isoFromUnixSeconds(ts?: number | null): string | null {
  if (typeof ts !== "number" || Number.isNaN(ts)) return null;
  return new Date(ts * 1000).toISOString();
}

