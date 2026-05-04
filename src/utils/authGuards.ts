import { TelegramClient, Api } from "teleproto";

export function isAuthKeyUnregisteredError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("AUTH_KEY_UNREGISTERED");
}

export async function safeGetMe(client: TelegramClient): Promise<Api.User | undefined> {
  try {
    const me = await client.getMe();
    return me instanceof Api.User ? me : undefined;
  } catch (error) {
    if (isAuthKeyUnregisteredError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function safeCheckAuthorization(client: TelegramClient): Promise<boolean> {
  try {
    return await client.checkAuthorization();
  } catch (error) {
    if (isAuthKeyUnregisteredError(error)) {
      return false;
    }
    throw error;
  }
}
