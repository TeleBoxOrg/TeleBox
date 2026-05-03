import { Api } from "teleproto";

function isUndefinedDateCrash(error: any): boolean {
  const message = String(error?.message || error || "");
  return (
    message.includes("Cannot read properties of undefined") &&
    message.includes("reading 'date'")
  );
}

export async function safeGetMessages(
  client: any,
  entity: any,
  params: Record<string, any>,
): Promise<Api.Message[]> {
  try {
    const result = await client.getMessages(entity, params);
    if (Array.isArray(result)) return result as Api.Message[];
    return result ? [result as Api.Message] : [];
  } catch (error) {
    if (isUndefinedDateCrash(error)) {
      return [];
    }
    throw error;
  }
}
