/**
 * TeleBox Panel — WebApp initData validation + session tokens.
 */

import crypto from "crypto";
import type { PanelSession } from "./types";
import { readPanelConfig } from "./configStore";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Validate Telegram WebApp initData per official algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateWebAppInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 86400,
): { ok: true; user: PanelSession } | { ok: false; error: string } {
  if (!initData || !botToken) {
    return { ok: false, error: "缺少 initData 或 botToken" };
  }
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, error: "initData 缺少 hash" };

    const pairs: string[] = [];
    params.forEach((value, key) => {
      if (key === "hash") return;
      pairs.push(`${key}=${value}`);
    });
    pairs.sort();
    const dataCheckString = pairs.join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const calculated = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (!timingSafeEqualStr(calculated, hash)) {
      return { ok: false, error: "initData 签名无效" };
    }

    const authDateRaw = params.get("auth_date");
    const authDate = authDateRaw ? Number(authDateRaw) : 0;
    if (!authDate || Number.isNaN(authDate)) {
      return { ok: false, error: "initData 缺少 auth_date" };
    }
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > maxAgeSec) {
      return { ok: false, error: "initData 已过期，请重新打开小程序" };
    }

    const userRaw = params.get("user");
    if (!userRaw) return { ok: false, error: "initData 缺少 user" };
    const user = JSON.parse(userRaw) as {
      id: number;
      username?: string;
      first_name?: string;
    };
    if (!user?.id) return { ok: false, error: "user.id 无效" };

    return {
      ok: true,
      user: {
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
        exp: Date.now() + SESSION_TTL_MS,
      },
    };
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "initData 解析失败",
    };
  }
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export async function issueSessionToken(session: PanelSession): Promise<string> {
  const cfg = await readPanelConfig();
  const payload = b64url(
    JSON.stringify({
      uid: session.userId,
      u: session.username || "",
      n: session.firstName || "",
      exp: session.exp,
    }),
  );
  const sig = b64url(
    crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest(),
  );
  return `${payload}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<PanelSession | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const cfg = await readPanelConfig();
  const expect = b64url(
    crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest(),
  );
  if (!timingSafeEqualStr(expect, sig)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString("utf8")) as {
      uid: number;
      u?: string;
      n?: string;
      exp: number;
    };
    if (!data.uid || !data.exp || data.exp < Date.now()) return null;
    return {
      userId: data.uid,
      username: data.u || undefined,
      firstName: data.n || undefined,
      exp: data.exp,
    };
  } catch {
    return null;
  }
}

export async function isPanelAdminUser(userId: number): Promise<{
  allowed: boolean;
  isOwner: boolean;
  reason?: string;
}> {
  const { getOwnerId } = await import("./owner");
  const ownerId = await getOwnerId();
  if (ownerId != null && userId === ownerId) {
    return { allowed: true, isOwner: true };
  }
  const cfg = await readPanelConfig();
  if (cfg.admins.some((a) => a.userId === userId)) {
    return { allowed: true, isOwner: false };
  }
  return { allowed: false, isOwner: false, reason: "非 panel 管理员" };
}
