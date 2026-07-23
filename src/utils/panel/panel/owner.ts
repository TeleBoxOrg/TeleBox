/**
 * TeleBox Panel — resolve userbot owner id (cached).
 */

import { logger } from "@utils/logger";
import { getGlobalClient } from "@utils/runtimeManager";
import { safeGetMe } from "@utils/authGuards";

let cachedOwnerId: number | null = null;
let cachedAt = 0;
const TTL = 60_000;

export async function getOwnerId(): Promise<number | null> {
  if (cachedOwnerId != null && Date.now() - cachedAt < TTL) {
    return cachedOwnerId;
  }
  try {
    const client = await getGlobalClient();
    if (!client) return cachedOwnerId;
    const me = await safeGetMe(client);
    if (me?.id != null) {
      cachedOwnerId = Number(me.id);
      cachedAt = Date.now();
    }
  } catch (e: unknown) {
    logger.warn("[panel] getOwnerId failed", e);
  }
  return cachedOwnerId;
}

export function setOwnerIdForTests(id: number | null): void {
  cachedOwnerId = id;
  cachedAt = Date.now();
}
