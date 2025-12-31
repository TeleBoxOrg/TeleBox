import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { getApiConfig } from "./apiConfig";
import { readAppName } from "./teleboxInfoHelper";
import { logger } from "./logger";

let client: TelegramClient | null = null;

// 事件处理器注册表，用于精确跟踪和清理
interface EventHandlerRecord {
  handler: any;
  event: any;
  pluginName: string;
  type: 'command' | 'listen' | 'event' | 'cron';
}

// 使用 Map 存储事件处理器，Key 为唯一ID
const eventHandlersRegistry = new Map<string, EventHandlerRecord>();
let eventHandlerCounter = 0;

/**
 * 初始化Telegram客户端
 */
async function initializeClient() {
  let api = await getApiConfig();
  const proxy = api.proxy;
  if (proxy) {
    console.log("使用代理连接 Telegram:", proxy);
  }
  
  let connectionRetries = 5; // 默认值
  const envValue = process.env.TB_CONNECTION_RETRIES;
  if (envValue) {
    const parsed = Number(envValue);
    connectionRetries = Number.isInteger(parsed) ? parsed : 5;
  }
  
  console.log(
    `连接重试次数: ${connectionRetries}, 可使用环境变量 TB_CONNECTION_RETRIES 设置`
  );
  
  client = new TelegramClient(
    new StringSession(api.session),
    api.api_id!,
    api.api_hash!,
    { connectionRetries, deviceModel: readAppName(), proxy }
  );
  
  client.setLogLevel(logger.getGramJSLogLevel() as any);
  
  // 存储到全局对象，用于同步访问
  (global as any).telegramClient = client;
  
  console.log('[GlobalClient] Client initialized successfully');
}

/**
 * 获取全局Telegram客户端
 * @returns {Promise<TelegramClient>} Telegram客户端实例
 */
export async function getGlobalClient(): Promise<TelegramClient> {
  if (!client) {
    await initializeClient();
    return client!;
  }
  return client;
}

/**
 * 同步获取全局Telegram客户端
 * @returns {TelegramClient | null} Telegram客户端实例或null
 */
export function getGlobalClientSync(): TelegramClient | null {
  return client || (global as any).telegramClient || null;
}

/**
 * 注册事件处理器
 * @param {any} handler - 事件处理器函数
 * @param {any} event - 事件类型
 * @param {string} pluginName - 插件名称
 * @param {'command' | 'listen' | 'event' | 'cron'} type - 事件类型
 * @returns {string} 事件处理器ID
 */
export function registerEventHandler(
  handler: any, 
  event: any, 
  pluginName: string, 
  type: 'command' | 'listen' | 'event' | 'cron'
): string {
  if (!client) {
    throw new Error('Telegram client not initialized');
  }
  
  // 生成唯一ID
  const handlerId = `handler_${eventHandlerCounter++}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  
  // 添加事件处理器
  client.addEventHandler(handler, event);
  
  // 记录到注册表
  eventHandlersRegistry.set(handlerId, {
    handler,
    event,
    pluginName,
    type
  });
  
  console.log(`[GlobalClient] Registered event handler ${handlerId} for plugin ${pluginName}`);
  return handlerId;
}

/**
 * 按插件名称移除所有相关事件处理器
 * @param {string} pluginName - 插件名称
 * @returns {number} 移除的事件处理器数量
 */
export function unregisterPluginEventHandlers(pluginName: string): number {
  let removedCount = 0;
  const remainingHandlers = new Map<string, EventHandlerRecord>();
  
  for (const [handlerId, record] of eventHandlersRegistry) {
    if (record.pluginName === pluginName) {
      try {
        if (client) {
          client.removeEventHandler(record.handler, record.event);
          removedCount++;
          console.log(`[GlobalClient] Removed event handler ${handlerId} for plugin ${pluginName}`);
        }
      } catch (error) {
        console.error(`[GlobalClient] Failed to remove event handler ${handlerId} for plugin ${pluginName}:`, error);
      }
    } else {
      remainingHandlers.set(handlerId, record);
    }
  }
  
  // 更新注册表
  eventHandlersRegistry.clear();
  for (const [handlerId, record] of remainingHandlers) {
    eventHandlersRegistry.set(handlerId, record);
  }
  
  console.log(`[GlobalClient] Unregistered ${removedCount} event handlers for plugin ${pluginName}`);
  return removedCount;
}

/**
 * 移除所有事件处理器
 * @returns {number} 移除的事件处理器数量
 */
export function unregisterAllEventHandlers(): number {
  let removedCount = 0;
  
  if (!client) return 0;
  
  try {
    // 1. 移除所有注册的事件处理器
    const handlers = client.listEventHandlers();
    for (const handler of handlers) {
      try {
        client.removeEventHandler(handler[1], handler[0]);
        removedCount++;
      } catch (error) {
        console.error('[GlobalClient] Error removing event handler:', error);
      }
    }
    
    // 2. 清理注册表
    const registryCount = eventHandlersRegistry.size;
    eventHandlersRegistry.clear();
    
    console.log(`[GlobalClient] Removed ${removedCount} client handlers and ${registryCount} registry handlers`);
    return removedCount + registryCount;
  } catch (error) {
    console.error('[GlobalClient] Error during event handler cleanup:', error);
    return removedCount;
  }
}

/**
 * 获取事件处理器统计信息
 * @returns {Object} 事件处理器统计信息
 */
export function getEventHandlerStats() {
  const stats: Record<string, number> = {
    total: eventHandlersRegistry.size,
    command: 0,
    listen: 0,
    event: 0,
    cron: 0
  };
  
  for (const record of eventHandlersRegistry.values()) {
    stats[record.type]++;
  }
  
  return stats;
}

/**
 * 清理客户端资源
 * @description 断开连接，清理事件处理器，释放资源
 */
export async function cleanupGlobalClient(): Promise<void> {
  console.log('[GlobalClient] Starting client cleanup...');
  
  if (client) {
    try {
      // 1. 移除所有事件处理器
      const removedHandlers = unregisterAllEventHandlers();
      console.log(`[GlobalClient] Removed ${removedHandlers} event handlers during cleanup`);
      
      // 2. 断开客户端连接
      await client.disconnect();
      console.log('[GlobalClient] Client disconnected');
      
      // 3. 清理引用
      client = null;
      delete (global as any).telegramClient;
      
      console.log('[GlobalClient] Client cleanup completed');
    } catch (error) {
      console.error('[GlobalClient] Error during client cleanup:', error);
    }
  }
}