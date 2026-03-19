/**
 * 封禁/解封相关的通用工具函数
 */

import { Api, TelegramClient } from "teleproto";

/**
 * 解封用户 - 移除所有限制
 * @param client TelegramClient 实例
 * @param channel 群组/频道实体
 * @param user 用户实体或ID
 * @returns 是否成功
 */
export async function unbanUser(
  client: TelegramClient,
  channel: any,
  user: any
): Promise<boolean> {
  try {
    const userEntity = typeof user === 'number' 
      ? await client.getInputEntity(user)
      : user;
    
    await client.invoke(
      new Api.channels.EditBanned({
        channel: channel,
        participant: userEntity,
        bannedRights: new Api.ChatBannedRights({
          untilDate: 0,  // 0 = 解除所有限制
          viewMessages: false,  // false = 允许
          sendMessages: false,
          sendMedia: false,
          sendStickers: false,
          sendGifs: false,
          sendGames: false,
          sendInline: false,
          sendPolls: false,
          changeInfo: false,
          inviteUsers: false,
          pinMessages: false,
        }),
      })
    );
    return true;
  } catch (error) {
    console.error(`解封用户失败:`, error);
    return false;
  }
}

/**
 * 封禁用户
 * @param client TelegramClient 实例
 * @param channel 群组/频道实体
 * @param user 用户实体或ID
 * @param untilDate 封禁到期时间（秒），0 = 永久
 * @returns 是否成功
 */
export async function banUser(
  client: TelegramClient,
  channel: any,
  user: any,
  untilDate: number = 0
): Promise<boolean> {
  try {
    const userEntity = typeof user === 'number' 
      ? await client.getInputEntity(user)
      : user;
    
    await client.invoke(
      new Api.channels.EditBanned({
        channel: channel,
        participant: userEntity,
        bannedRights: new Api.ChatBannedRights({
          untilDate: untilDate,
          viewMessages: true,  // true = 禁止
          sendMessages: true,
          sendMedia: true,
          sendStickers: true,
          sendGifs: true,
          sendGames: true,
          sendInline: true,
          sendPolls: true,
          changeInfo: true,
          inviteUsers: true,
          pinMessages: true,
        }),
      })
    );
    return true;
  } catch (error) {
    console.error(`封禁用户失败:`, error);
    return false;
  }
}

/**
 * 踢出用户（封禁后立即解封）
 * @param client TelegramClient 实例
 * @param channel 群组/频道实体
 * @param user 用户实体或ID
 * @returns 是否成功
 */
export async function kickUser(
  client: TelegramClient,
  channel: any,
  user: any
): Promise<boolean> {
  try {
    // 先封禁
    const banned = await banUser(client, channel, user, Math.floor(Date.now() / 1000) + 60);
    if (!banned) return false;
    
    // 等待一下确保生效
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 立即解封
    return await unbanUser(client, channel, user);
  } catch (error) {
    console.error(`踢出用户失败:`, error);
    return false;
  }
}

/**
 * 获取被封禁的用户/频道/群组列表（使用正确的 Kicked 过滤器）
 * @param client TelegramClient 实例
 * @param channel 群组/频道实体
 * @param limit 获取数量限制
 * @returns 被封禁实体列表
 */
export async function getBannedUsers(
  client: TelegramClient,
  channel: any,
  limit: number = 200
): Promise<Array<{
  id: number;
  firstName: string;
  username?: string;
  kickedBy?: number;
  kickedDate?: number;
  type: 'user' | 'channel' | 'chat';
  title?: string; // 频道/群组标题
}>> {
  const bannedUsers: Array<{
    id: number;
    firstName: string;
    username?: string;
    kickedBy?: number;
    kickedDate?: number;
    type: 'user' | 'channel' | 'chat';
    title?: string;
  }> = [];
  
  try {
    // 使用 ChannelParticipantsKicked 而不是 ChannelParticipantsBanned
    // ChannelParticipantsBanned 返回被限制的用户
    // ChannelParticipantsKicked 返回被踢出/封禁的用户
    const result = await client.invoke(
      new Api.channels.GetParticipants({
        channel: channel,
        filter: new Api.ChannelParticipantsKicked({ q: "" }),
        offset: 0,
        limit: limit,
        hash: 0 as any,
      })
    );

    if ("participants" in result && result.participants) {
      for (const participant of result.participants) {
        if (participant instanceof Api.ChannelParticipantBanned) {
          // ChannelParticipantBanned 有 peer 和 kickedBy 属性
          let entityId: number | undefined;
          let entityType: 'user' | 'channel' | 'chat' = 'user';
          const peer = participant.peer;
          
          if (peer instanceof Api.PeerUser) {
            entityId = Number(peer.userId);
            entityType = 'user';
          } else if (peer instanceof Api.PeerChannel) {
            entityId = Number(peer.channelId);
            entityType = 'channel';
          } else if (peer instanceof Api.PeerChat) {
            entityId = Number(peer.chatId);
            entityType = 'chat';
          }
          
          if (entityId) {
            // 查找用户信息
            const user = (result as any).users?.find((u: any) => 
              Number(u.id) === entityId
            );
            
            // 查找频道/群组信息
            const chat = (result as any).chats?.find((c: any) => 
              Number(c.id) === entityId
            );
            
            const entity = user || chat;
            
            if (entity) {
              let displayName = "Unknown";
              let title: string | undefined;
              
              if (entityType === 'user') {
                displayName = entity.firstName || entity.username || "Unknown User";
              } else {
                displayName = entity.title || entity.username || "Unknown";
                title = entity.title;
              }
              
              bannedUsers.push({
                id: entityId,
                firstName: displayName,
                username: entity.username,
                kickedBy: participant.kickedBy ? Number(participant.kickedBy) : undefined,
                kickedDate: participant.date,
                type: entityType,
                title: title
              });
            }
          }
        } else if ('userId' in participant) {
          // 其他类型的参与者，直接使用 userId
          const userId = Number((participant as any).userId);
          const user = (result as any).users?.find((u: any) => 
            Number(u.id) === userId
          );
          
          if (user) {
            bannedUsers.push({
              id: userId,
              firstName: user.firstName || "Unknown",
              username: user.username,
              kickedBy: undefined,
              kickedDate: undefined,
              type: 'user'
            });
          }
        }
      }
    }
  } catch (error) {
    console.error("获取被封禁用户失败:", error);
  }
  
  return bannedUsers;
}

/**
 * 批量解封用户
 * @param client TelegramClient 实例
 * @param channel 群组/频道实体
 * @param userIds 用户ID数组
 * @param delayMs 每个操作之间的延迟（毫秒）
 * @returns 成功和失败的统计
 */
export async function batchUnbanUsers(
  client: TelegramClient,
  channel: any,
  userIds: number[],
  delayMs: number = 500
): Promise<{
  success: number[];
  failed: number[];
}> {
  const success: number[] = [];
  const failed: number[] = [];
  
  for (const userId of userIds) {
    const result = await unbanUser(client, channel, userId);
    if (result) {
      success.push(userId);
    } else {
      failed.push(userId);
    }
    
    // 添加延迟避免频率限制
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return { success, failed };
}
