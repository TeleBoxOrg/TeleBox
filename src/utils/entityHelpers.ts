import { TelegramClient } from "teleproto";
import { Api } from "teleproto/tl";
import { Entity } from "teleproto/define";

/**
 * 安全获取实体，确保包含正确的access hash
 * @param client - Telegram客户端实例
 * @param entityId - 实体ID (可以是数字ID、用户名或实体对象)
 * @returns 返回完整的实体对象
 */
export async function getEntityWithHash(
  client: TelegramClient,
  entityId: string | number | Entity
): Promise<Entity> {
  try {
    // 如果已经是实体对象，直接返回
    if (typeof entityId === "object" && "className" in entityId) {
      return entityId;
    }

    // 使用getEntity获取完整实体信息
    const entity = await client.getEntity(entityId);
    return entity;
  } catch (error) {
    console.error(`[EntityHelper] 获取实体失败: ${entityId}`, error);
    throw new Error(`无法获取实体: ${entityId}`);
  }
}

/**
 * 安全转发消息，自动处理access hash和错误重试
 * @param client - Telegram客户端实例
 * @param fromChatId - 源聊天ID
 * @param toChatId - 目标聊天ID
 * @param messageId - 消息ID
 * @param options - 转发选项
 */
export async function safeForwardMessage(
  client: TelegramClient,
  fromChatId: string | number,
  toChatId: string | number,
  messageId: number,
  options?: {
    replyTo?: number;
    silent?: boolean;
    dropAuthor?: boolean;
    maxRetries?: number;
  }
): Promise<Api.Message[]> {
  const maxRetries = options?.maxRetries || 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 获取完整实体信息
      const fromEntity = await getEntityWithHash(client, fromChatId);
      const toEntity = await getEntityWithHash(client, toChatId);

      // 执行转发
      // const result = await client.forwardMessages(toEntity, {
      //   messages: [messageId],
      //   fromPeer: fromEntity,
      //   silent: options?.silent,
      //   dropAuthor: options?.dropAuthor,
      // });
      // gramjs 转发不够完善 换底层方法 但是返回类型不同
      const result = await client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer: fromEntity,
          id: [messageId!],
          toPeer: toEntity,
          silent: options?.silent,
          dropAuthor: options?.dropAuthor,
          // 如果在论坛话题中，指定话题的顶层消息 ID
          ...(options?.replyTo ? { topMsgId: options.replyTo } : {}),
        })
      );

      // 从 Updates 中提取消息
      const messages: Api.Message[] = [];
      if ("updates" in result) {
        for (const update of result.updates) {
          if (
            update instanceof Api.UpdateNewMessage ||
            update instanceof Api.UpdateNewChannelMessage
          ) {
            if (update.message instanceof Api.Message) {
              messages.push(update.message);
            }
          }
        }
      }
      return messages;
    } catch (error: any) {
      lastError = error;
      console.warn(
        `[EntityHelper] 转发尝试 ${attempt}/${maxRetries} 失败: ${fromChatId} -> ${toChatId}`,
        error
      );

      // 处理 FLOOD_WAIT 错误
      if (error.message && error.message.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        console.log(`[EntityHelper] FloodWait ${waitTime}s, 等待重试`);
        await new Promise((resolve) =>
          setTimeout(resolve, (waitTime + 1) * 1000)
        );
        continue;
      }

      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
    }
  }

  console.error(
    `[EntityHelper] 转发最终失败: ${fromChatId} -> ${toChatId}`,
    lastError
  );
  throw lastError;
}

/**
 * 批量获取实体，确保包含正确的access hash
 * @param client - Telegram客户端实例
 * @param entityIds - 实体ID数组
 * @returns 返回实体对象数组
 */
export async function getBatchEntitiesWithHash(
  client: TelegramClient,
  entityIds: (string | number)[]
): Promise<Entity[]> {
  const entities: Entity[] = [];

  for (const entityId of entityIds) {
    try {
      const entity = await getEntityWithHash(client, entityId);
      entities.push(entity);
    } catch (error) {
      console.warn(`[EntityHelper] 跳过无效实体: ${entityId}`, error);
    }
  }

  return entities;
}

/**
 * 解析实体ID，支持多种格式
 * @param input - 输入的实体标识 (@username, -100123456, 123456, "me", "here")
 * @param currentChatId - 当前聊天ID（用于处理"me"/"here"）
 * @returns 标准化的实体ID
 */
export function parseEntityId(
  input: string,
  currentChatId?: number
): string | number {
  if (!input) throw new Error("实体ID不能为空");

  const trimmed = input.trim();

  // 处理特殊关键词
  if (trimmed === "me" || trimmed === "here") {
    if (!currentChatId) throw new Error("当前聊天ID未提供");
    return currentChatId;
  }

  // 处理用户名格式 @username
  if (trimmed.startsWith("@")) {
    return trimmed;
  }

  // 处理数字ID
  const numId = parseInt(trimmed);
  if (!isNaN(numId)) {
    return numId;
  }

  // 直接返回字符串（可能是用户名）
  return trimmed;
}

/**
 * 通用的实体操作包装器，自动处理access hash
 * @param client - Telegram客户端实例
 * @param operation - 要执行的操作函数
 * @param entities - 需要解析的实体ID数组
 * @param maxRetries - 最大重试次数
 */
export async function withEntityAccess<T>(
  client: TelegramClient,
  operation: (resolvedEntities: Entity[]) => Promise<T>,
  entities: (string | number)[],
  maxRetries: number = 3
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 批量解析实体
      const resolvedEntities = await getBatchEntitiesWithHash(client, entities);

      // 执行操作
      return await operation(resolvedEntities);
    } catch (error: any) {
      lastError = error;
      console.warn(
        `[EntityHelper] 操作尝试 ${attempt}/${maxRetries} 失败:`,
        error
      );

      // 处理 FLOOD_WAIT 错误
      if (error.message && error.message.includes("FLOOD_WAIT")) {
        const waitTime = parseInt(error.message.match(/\d+/)?.[0] || "60");
        console.log(`[EntityHelper] FloodWait ${waitTime}s, 等待重试`);
        await new Promise((resolve) =>
          setTimeout(resolve, (waitTime + 1) * 1000)
        );
        continue;
      }

      // 如果不是最后一次尝试，等待后重试
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
    }
  }

  console.error(`[EntityHelper] 操作最终失败:`, lastError);
  throw lastError;
}
