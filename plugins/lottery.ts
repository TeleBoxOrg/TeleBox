import { Plugin } from "@utils/pluginBase";
import { getGlobalClient, getCurrentGeneration } from "@utils/globalClient";
import path from "path";
import Database from "better-sqlite3";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getEntityWithHash } from "@utils/entityHelpers";
import { Api } from "teleproto/tl";
import { TelegramClient } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import bigInt from "big-integer";

// Track pending setTimeout handles for safe cleanup on reload
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

// Get command prefixes
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// HTML escape function
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function codeTag(text: string | number): string {
  return `<code>${htmlEscape(String(text))}</code>`;
}

// Initialize database
let db = new Database(
  path.join(createDirectoryInAssets("lottery"), "lottery.db")
);

// Prize distribution status enum
enum PrizeStatus {
  SENT = "sent",        // ✅ 已发放
  PENDING = "pending",  // ⏳ 待领取
  EXPIRED = "expired"   // ❌ 已过期
}

// Lottery mode enum
enum LotteryMode {
  MANUAL = "manual",    // 手动开奖
  AUTO = "auto"         // 定时开奖
}

// Prize distribution mode enum
enum DistributionMode {
  CLAIM = "claim",      // 中奖者主动私聊领取
  AUTO_SEND = "auto"    // 发奖者主动派奖
}

// Initialize enhanced database tables
if (db) {
  // Ensure database schema is up to date
  try {
    // Check and migrate lottery_config table
    const tableInfo = db.prepare("PRAGMA table_info(lottery_config)").all() as any[];
    const hasWarehouseColumn = tableInfo.some(col => col.name === 'prize_warehouse');
    const hasMessageIdColumn = tableInfo.some(col => col.name === 'message_id');
    
    if (!hasWarehouseColumn) {
      db.exec(`ALTER TABLE lottery_config ADD COLUMN prize_warehouse TEXT DEFAULT 'default'`);
    }
    if (!hasMessageIdColumn) {
      db.exec(`ALTER TABLE lottery_config ADD COLUMN message_id TEXT`);
    }
  } catch (error) {
    // Table doesn't exist yet, will be created below
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS lottery_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL,
      keyword TEXT NOT NULL,
      max_participants INTEGER NOT NULL,
      winner_count INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual',
      distribution_mode TEXT NOT NULL DEFAULT 'claim',
      claim_timeout INTEGER DEFAULT 86400,
      delete_delay INTEGER DEFAULT 5,
      require_avatar BOOLEAN DEFAULT 0,
      require_username BOOLEAN DEFAULT 0,
      required_channel TEXT,
      prize_warehouse TEXT DEFAULT 'default',
      allow_bots BOOLEAN DEFAULT 0,
      member_filter TEXT,
      auto_draw_time INTEGER,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      creator_id TEXT NOT NULL,
      unique_id TEXT NOT NULL UNIQUE,
      message_id TEXT
    );
    

    CREATE TABLE IF NOT EXISTS lottery_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lottery_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      joined_at INTEGER NOT NULL,
      FOREIGN KEY (lottery_id) REFERENCES lottery_config (id),
      UNIQUE(lottery_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS lottery_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lottery_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      prize_id INTEGER,
      prize_text TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_at INTEGER NOT NULL,
      claimed_at INTEGER,
      expires_at INTEGER,
      FOREIGN KEY (lottery_id) REFERENCES lottery_config (id),
      FOREIGN KEY (prize_id) REFERENCES prize_warehouse (id)
    );

    CREATE TABLE IF NOT EXISTS prize_warehouse (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_name TEXT NOT NULL,
      prize_text TEXT NOT NULL,
      stock_count INTEGER NOT NULL DEFAULT 1,
      order_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lottery_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}


// Prize warehouse management functions
function createPrizeWarehouse(name: string): boolean {
  if (!db) return false;
  
  // Check if warehouse already exists
  const existingWarehouse = db.prepare(`
    SELECT warehouse_name FROM prize_warehouse 
    WHERE warehouse_name = ? 
    LIMIT 1
  `).get(name);
  
  if (existingWarehouse) {
    return false; // Warehouse already exists
  }
  
  const stmt = db.prepare(`
    INSERT INTO prize_warehouse (warehouse_name, prize_text, stock_count, order_index, created_at)
    VALUES (?, '', 0, 0, ?)
  `);
  stmt.run(name, Date.now());
  return true; // Successfully created
}

function addPrizeToWarehouse(warehouseName: string, prizeText: string, stock: number): void {
  if (!db) return;
  
  // Check if the same prize already exists in the warehouse
  const existingPrize = db.prepare(`
    SELECT id, stock_count FROM prize_warehouse 
    WHERE warehouse_name = ? AND prize_text = ?
  `).get(warehouseName, prizeText) as any;
  
  if (existingPrize) {
    // Update existing prize stock
    const updateStmt = db.prepare(`
      UPDATE prize_warehouse 
      SET stock_count = stock_count + ? 
      WHERE id = ?
    `);
    updateStmt.run(stock, existingPrize.id);
  } else {
    // Get next order index for new prize
    const maxOrderStmt = db.prepare(`
      SELECT COALESCE(MAX(order_index), 0) + 1 as next_order 
      FROM prize_warehouse WHERE warehouse_name = ?
    `);
    const nextOrder = (maxOrderStmt.get(warehouseName) as any)?.next_order || 1;
    
    // Insert new prize
    const stmt = db.prepare(`
      INSERT INTO prize_warehouse (warehouse_name, prize_text, stock_count, order_index, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(warehouseName, prizeText, stock, nextOrder, Date.now());
  }
}

function getPrizeWarehouses(): string[] {
  if (!db) return [];
  
  const stmt = db.prepare(`
    SELECT DISTINCT warehouse_name FROM prize_warehouse 
    ORDER BY warehouse_name
  `);
  return stmt.all().map((row: any) => row.warehouse_name);
}

function getAllWarehousesWithPrizes(): any[] {
  if (!db) return [];
  
  const stmt = db.prepare(`
    SELECT warehouse_name, COUNT(*) as prize_count, SUM(stock_count) as total_stock
    FROM prize_warehouse 
    WHERE stock_count > 0
    GROUP BY warehouse_name 
    ORDER BY warehouse_name
  `);
  return stmt.all();
}

function getWarehouseByNameOrIndex(identifier: string, warehouses: string[]): string | null {
  // Try as index first (1-based)
  const index = parseInt(identifier);
  if (!isNaN(index) && index >= 1 && index <= warehouses.length) {
    return warehouses[index - 1];
  }
  
  // Try as name
  if (warehouses.includes(identifier)) {
    return identifier;
  }
  
  return null;
}

function getWarehousePrizes(warehouseName: string): any[] {
  if (!db) return [];
  
  const stmt = db.prepare(`
    SELECT * FROM prize_warehouse 
    WHERE warehouse_name = ? AND stock_count > 0 
    ORDER BY order_index
  `);
  return stmt.all(warehouseName);
}

function getNextAvailablePrize(warehouseName: string): any | null {
  if (!db) return null;
  
  const stmt = db.prepare(`
    SELECT * FROM prize_warehouse 
    WHERE warehouse_name = ? AND stock_count > 0 
    ORDER BY order_index 
    LIMIT 1
  `);
  return stmt.get(warehouseName) || null;
}

function consumePrize(prizeId: number): boolean {
  if (!db) return false;
  
  const stmt = db.prepare(`
    UPDATE prize_warehouse 
    SET stock_count = stock_count - 1 
    WHERE id = ? AND stock_count > 0
  `);
  const result = stmt.run(prizeId);
  return result.changes > 0;
}

function clearWarehouse(warehouseName: string): number {
  if (!db) return 0;
  
  const stmt = db.prepare(`
    DELETE FROM prize_warehouse 
    WHERE warehouse_name = ?
  `);
  const result = stmt.run(warehouseName);
  return result.changes;
}

function clearAllWarehouses(): number {
  if (!db) return 0;
  
  const stmt = db.prepare(`DELETE FROM prize_warehouse`);
  const result = stmt.run();
  return result.changes;
}

function deleteLotteryActivity(lotteryId: number): boolean {
  if (!db) return false;
  
  try {
    // Use transaction to ensure all related data is deleted
    const transaction = db.transaction(() => {
      // Delete participants
      const deleteParticipants = db.prepare(`DELETE FROM lottery_participants WHERE lottery_id = ?`);
      deleteParticipants.run(lotteryId);
      
      // Delete winners
      const deleteWinners = db.prepare(`DELETE FROM lottery_winners WHERE lottery_id = ?`);
      deleteWinners.run(lotteryId);
      
      // Delete lottery config
      const deleteLottery = db.prepare(`DELETE FROM lottery_config WHERE id = ?`);
      deleteLottery.run(lotteryId);
    });
    
    transaction();
    return true;
  } catch (error) {
    console.error("Failed to delete lottery activity:", error);
    return false;
  }
}

// Enhanced lottery management functions
function createLotteryConfig(config: any): number {
  if (!db) return 0;
  
  const stmt = db.prepare(`
    INSERT INTO lottery_config (
      chat_id, title, keyword, max_participants, winner_count, mode, 
      distribution_mode, claim_timeout, delete_delay, require_avatar, 
      require_username, required_channel, prize_warehouse, allow_bots, 
      member_filter, auto_draw_time, created_at, creator_id, unique_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    config.chat_id, config.title, config.keyword, config.max_participants,
    config.winner_count, config.mode, config.distribution_mode, config.claim_timeout,
    config.delete_delay, config.require_avatar ? 1 : 0, config.require_username ? 1 : 0,
    config.required_channel || null, config.prize_warehouse || 'default', config.allow_bots ? 1 : 0,
    config.member_filter || null, config.auto_draw_time || null, Date.now(), config.creator_id,
    config.unique_id
  );
  
  return result.lastInsertRowid as number;
}

function getActiveLottery(chatId: string): any | null {
  if (!db) return null;
  
  const stmt = db.prepare(`
    SELECT * FROM lottery_config 
    WHERE chat_id = ? AND status = 'active' 
    ORDER BY created_at DESC LIMIT 1
  `);
  return stmt.get(chatId) as any;
}

function addParticipantToLottery(lotteryId: number, participant: any): boolean {
  if (!db) return false;
  
  try {
    // Use transaction for concurrent safety
    const transaction = db.transaction(() => {
      // Check current participant count
      const countStmt = db.prepare(`SELECT COUNT(*) as count FROM lottery_participants WHERE lottery_id = ?`);
      const countResult = countStmt.get(lotteryId) as { count: number } | undefined;
      const currentCount = countResult?.count || 0;
      
      // Check lottery max participants
      const lotteryStmt = db.prepare(`SELECT max_participants FROM lottery_config WHERE id = ?`);
      const lottery = lotteryStmt.get(lotteryId) as { max_participants: number } | undefined;
      
      if (!lottery || currentCount >= lottery.max_participants) {
        throw new Error("Lottery full or not found");
      }
      
      // Check if user already participated
      const existsStmt = db.prepare(`SELECT 1 FROM lottery_participants WHERE lottery_id = ? AND user_id = ?`);
      const exists = existsStmt.get(lotteryId, participant.user_id);
      
      if (exists) {
        throw new Error("User already participated");
      }
      
      // Add participant
      const insertStmt = db.prepare(`
        INSERT INTO lottery_participants (lottery_id, user_id, username, first_name, last_name, joined_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(lotteryId, String(participant.user_id), participant.username || null, participant.first_name || null, participant.last_name || null, Date.now());
    });
    
    transaction();
    return true;
  } catch (error) {
    console.error("Failed to add participant:", error);
    return false;
  }
}

function getLotteryParticipants(lotteryId: number): any[] {
  if (!db) return [];
  
  const stmt = db.prepare(`
    SELECT * FROM lottery_participants 
    WHERE lottery_id = ? ORDER BY joined_at
  `);
  return stmt.all(lotteryId);
}

function getLotteryWinners(lotteryId: number): any[] {
  if (!db) return [];
  
  const stmt = db.prepare(`
    SELECT w.*, p.username, p.first_name, p.last_name 
    FROM lottery_winners w
    LEFT JOIN lottery_participants p ON w.user_id = p.user_id AND w.lottery_id = p.lottery_id
    WHERE w.lottery_id = ?
    ORDER BY w.assigned_at
  `);
  return stmt.all(lotteryId);
}


// User validation functions
async function validateUserConditions(client: TelegramClient, user: any, lottery: any, chatId: string): Promise<{ valid: boolean; reason?: string }> {
  try {
    // Check if user is a bot
    if (!lottery.allow_bots && user.bot) {
      return { valid: false, reason: "机器人不允许参与抽奖" };
    }

    // Check avatar requirement
    if (lottery.require_avatar) {
      const userId = user.id || user;
      const userEntity = await getEntityWithHash(client, userId);
      if (userEntity && "photo" in userEntity && !userEntity.photo) {
        return { valid: false, reason: "需要设置头像才能参与抽奖" };
      }
    }

    // Check username requirement
    if (lottery.require_username && !user.username) {
      return { valid: false, reason: "需要设置用户名才能参与抽奖" };
    }

    // Check channel subscription requirement
    if (lottery.required_channel) {
      try {
        const userId = user.id || user;
        const channelEntity = await client.getEntity(lottery.required_channel);
        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: channelEntity,
            participant: userId,
          })
        );
        if (!participant) {
          return { valid: false, reason: `需要关注频道 ${lottery.required_channel} 才能参与抽奖` };
        }
      } catch (error) {
        return { valid: false, reason: `需要关注指定频道才能参与抽奖` };
      }
    }

    return { valid: true };
  } catch (error) {
    console.error("Error validating user conditions:", error);
    return { valid: true }; // Default to allow if validation fails
  }
}

// Prize distribution status functions
function updateWinnerStatus(winnerId: number, status: PrizeStatus, claimedAt?: number): void {
  if (!db) return;
  
  const stmt = db.prepare(`
    UPDATE lottery_winners 
    SET status = ?, claimed_at = ? 
    WHERE id = ?
  `);
  stmt.run(status, claimedAt || null, winnerId);
}

function updateWinnerStatusByUser(lotteryId: number, userId: string, status: PrizeStatus, claimedAt?: number): boolean {
  if (!db) return false;
  
  const stmt = db.prepare(`
    UPDATE lottery_winners 
    SET status = ?, claimed_at = ? 
    WHERE lottery_id = ? AND user_id = ?
  `);
  const result = stmt.run(status, claimedAt || Date.now(), lotteryId, userId);
  return result.changes > 0;
}

function getWinnerStatusIcon(status: string): string {
  switch (status) {
    case PrizeStatus.SENT:
      return "✅";
    case PrizeStatus.PENDING:
      return "⏳";
    case PrizeStatus.EXPIRED:
      return "❌";
    default:
      return "❓";
  }
}

function expireOldClaims(): number {
  if (!db) return 0;
  
  const stmt = db.prepare(`
    UPDATE lottery_winners 
    SET status = ? 
    WHERE status = ? AND expires_at < ?
  `);
  const result = stmt.run(PrizeStatus.EXPIRED, PrizeStatus.PENDING, Date.now());
  return result.changes;
}

// Enhanced prize distribution
async function distributePrizes(client: TelegramClient, lottery: any, winners: any[]): Promise<void> {
  if (!db) return;
  
  try {
    // Use transaction for concurrent safety during prize distribution
    const transaction = db.transaction(() => {
      for (const winner of winners) {
        // Get available prize from warehouse
        const prize = getNextAvailablePrize(lottery.prize_warehouse || "default");
        const prizeText = prize ? prize.prize_text : "恭喜中奖！";
        
        const now = Date.now();
        const expiresAt = now + (lottery.claim_timeout * 1000);
        
        // Insert winner record using standard schema
        const stmt = db.prepare(`
          INSERT INTO lottery_winners (lottery_id, user_id, username, first_name, last_name, prize_text, status, assigned_at, expires_at) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run(
          lottery.id,
          String(winner.user_id),
          winner.username || null,
          winner.first_name || null,
          winner.last_name || null,
          prizeText,
          PrizeStatus.PENDING,
          now,
          expiresAt
        );
        
        // Consume prize stock if from warehouse
        if (prize) {
          consumePrize(prize.id);
        }
      }
    });
    
    transaction();
    
    // Send prizes after transaction completes (if auto-send mode)
    if (lottery.distribution_mode === DistributionMode.AUTO_SEND) {
      for (const winner of winners) {
        const winnerRecord = getLotteryWinners(lottery.id).find(w => w.user_id === winner.user_id);
        if (winnerRecord) {
          await sendPrizeToWinner(client, winner, winnerRecord.prize_text, lottery);
          await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
        }
      }
    }
  } catch (error) {
    console.error("Failed to distribute prizes:", error);
    throw error;
  }
}

// Send prize message to winner
async function sendPrizeToWinner(client: TelegramClient, winner: any, prizeText: string, lottery: any): Promise<boolean> {
  try {
    const displayName = winner.username ? `@${winner.username}` : 
                       (winner.first_name || winner.last_name || `用户 ${winner.user_id}`);

    const prizeMessage =
      `🎉 <b>恭喜中奖!</b><br><br>` +
      `🏆 <b>活动名称:</b> ${htmlEscape(lottery.title)}<br>` +
      `🎁 <b>奖品内容:</b> ${htmlEscape(prizeText)}<br><br>` +
      `📝 <b>中奖详情:</b><br>` +
      `• 活动: ${htmlEscape(lottery.title)}<br>` +
      `• 中奖用户: ${htmlEscape(displayName)}<br>` +
      `• 中奖时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}<br><br>` +
      `🎊 <b>感谢您的参与，祝您好运!</b><br>` +
      `💡 <b>提示:</b> 如有疑问请联系活动发起者`;

    await client.sendMessage(winner.user_id, {
      message: prizeMessage,
      parseMode: "html",
    });

    // Update status to sent
    const updateStmt = db.prepare(`
      UPDATE lottery_winners 
      SET status = ?, claimed_at = ? 
      WHERE lottery_id = ? AND user_id = ?
    `);
    updateStmt.run(PrizeStatus.SENT, Date.now(), lottery.id, String(winner.user_id));

    console.log(`Prize sent to user ${winner.user_id} (${displayName})`);
    return true;
  } catch (error) {
    console.error(`Failed to send prize to user ${winner.user_id}:`, error);
    return false;
  }
}

// Format user line for display
function formatUserLine(uid: number, userObj?: any): string {
  let displayName = "";
  let username = "";
  
  if (userObj) {
    if (userObj.firstName && userObj.lastName) {
      displayName = `${userObj.firstName} ${userObj.lastName}`;
    } else if (userObj.firstName) {
      displayName = userObj.firstName;
    } else if (userObj.lastName) {
      displayName = userObj.lastName;
    }
    
    if (userObj.username) {
      username = `@${userObj.username}`;
    }
  }

  if (displayName && username) {
    return `• <a href="tg://user?id=${uid}">${htmlEscape(displayName)} ${htmlEscape(username)}</a>`;
  } else if (displayName) {
    return `• <a href="tg://user?id=${uid}">${htmlEscape(displayName)}</a>`;
  } else if (username) {
    return `• <a href="tg://user?id=${uid}">${htmlEscape(username)}</a>`;
  }

  return `• <a href="tg://user?id=${uid}">${uid}</a>`;
}

async function isUserAdmin(client: TelegramClient, chatId: string, userId: string): Promise<boolean> {
  try {
    const chatEntity = await client.getEntity(chatId);
    
    // 检查是否为超级群或频道
    if (chatEntity.className === 'Channel' || (chatEntity as any).megagroup) {
      try {
        const participant = await client.invoke(
          new Api.channels.GetParticipant({
            channel: chatEntity,
            participant: userId,
          })
        );
        
        if (participant && participant.participant) {
          const participantType = participant.participant.className;
          return participantType === 'ChannelParticipantAdmin' || 
                 participantType === 'ChannelParticipantCreator';
        }
      } catch (e) {
        // 如果GetParticipant失败，可能是普通群组，尝试其他方法
        console.warn("GetParticipant failed, trying alternative method:", e);
      }
    }
    
    // 对于普通群组，尝试获取消息发送者的权限
    try {
      const chatAdmins = await client.invoke(
        new Api.channels.GetParticipants({
          channel: chatEntity,
          filter: new Api.ChannelParticipantsAdmins(),
          offset: 0,
          limit: 200,
          hash: bigInt(0)
        })
      );
      
      if (chatAdmins && (chatAdmins as any).participants) {
        return (chatAdmins as any).participants.some((p: any) => 
          String(p.userId || p.user_id) === String(userId)
        );
      }
    } catch (e) {
      // 如果仍然失败，返回false
      console.warn("Alternative admin check failed:", e);
    }
    
    return false;
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

async function performLotteryDraw(client: TelegramClient, lottery: any): Promise<void> {
  try {
    // Delete original lottery message
    if (lottery.message_id) {
      try {
        await client.deleteMessages(lottery.chat_id, [parseInt(lottery.message_id)], { revoke: true });
        console.log(`[lottery] Deleted original lottery message ${lottery.message_id}`);
      } catch (error) {
        console.warn("Failed to delete original lottery message:", error);
      }
    }

    const participants = getLotteryParticipants(lottery.id);
    
    if (participants.length === 0) {
      await client.sendMessage(lottery.chat_id, {
        message: `🎊 <b>开奖结果</b><br><br>🏆 <b>活动名称:</b> ${htmlEscape(lottery.title)}<br><br>😅 <b>很遗憾，没有用户参与抽奖</b><br>🙏 感谢大家的关注!`,
        parseMode: "html",
      });
      
      // Mark lottery as completed
      const stmt = db.prepare(`UPDATE lottery_config SET status = 'completed' WHERE id = ?`);
      stmt.run(lottery.id);
      return;
    }

    const winnerCount = Math.min(lottery.winner_count, participants.length);
    const shuffled = [...participants];
    
    // Fisher-Yates shuffle
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    const winners = shuffled.slice(0, winnerCount);
    
    // Distribute prizes and create winner records
    await distributePrizes(client, lottery, winners);
    
    // Generate winner display list with status
    const winnerLines: string[] = [];
    const updatedWinners = getLotteryWinners(lottery.id);
    
    for (const winner of updatedWinners) {
      const statusIcon = getWinnerStatusIcon(winner.status);
      let displayName = "";
      let username = "";
      
      if (winner.first_name || winner.last_name) {
        displayName = [winner.first_name, winner.last_name].filter(Boolean).join(" ");
      }
      if (winner.username) {
        username = `@${winner.username}`;
      }
      
      let formattedName = "";
      if (displayName && username) {
        formattedName = `${htmlEscape(displayName)} ${htmlEscape(username)}`;
      } else if (displayName) {
        formattedName = htmlEscape(displayName);
      } else if (username) {
        formattedName = htmlEscape(username);
      } else {
        formattedName = `用户 ${winner.user_id}`;
      }
      
      let statusText = "";
      if (winner.status === PrizeStatus.PENDING && lottery.distribution_mode === DistributionMode.CLAIM) {
        statusText = ` - 请私聊 @${htmlEscape(lottery.creator_id)} 领取奖品`;
      }
      
      winnerLines.push(`${statusIcon} ${formattedName}${statusText}`);
    }
    
    const winUsersText = winnerLines.join("<br>");
    
    const endText = 
      `🎊 <b>开奖结果</b><br><br>` +
      `🏆 <b>活动名称:</b> ${htmlEscape(lottery.title)}<br>` +
      `🎁 <b>中奖用户:</b><br><br>${winUsersText}<br><br>` +
      `🎉 <b>恭喜以上用户中奖!</b><br>` +
      `📞 ${lottery.distribution_mode === DistributionMode.AUTO_SEND ? '奖品已自动发送到私聊' : '请按提示私聊领取奖品'}<br>` +
      `⏰ <b>领奖时效:</b> ${Math.floor(lottery.claim_timeout / 3600)} 小时<br>` +
      `🙏 感谢所有用户的参与!`;

    const resultMsg = await client.sendMessage(lottery.chat_id, {
      message: endText,
      parseMode: "html",
    });

    // 不再自动置顶开奖结果，让用户自己决定是否置顶
    console.log(`[lottery] Draw result sent, message ID: ${resultMsg.id}`);

    // Mark lottery as completed
    const stmt = db.prepare(`UPDATE lottery_config SET status = 'completed' WHERE id = ?`);
    stmt.run(lottery.id);
    
    
  } catch (error) {
    console.error("Failed to perform lottery draw:", error);
    await client.sendMessage(lottery.chat_id, {
      message: `❌ <b>开奖失败</b><br><br>发生错误，请稍后重试。`,
      parseMode: "html",
    });
  }
}


// Enhanced message listener for lottery participation
async function handleEnhancedLotteryJoin(msg: any): Promise<void> {
  if (!msg.message || !msg.senderId || !msg.client) return;
  
  let chatId: string;
  try {
    if (msg.chat?.id) {
      chatId = String(msg.chat.id);
    } else if (msg.peerId) {
      chatId = String(msg.peerId);
    } else if (msg.chatId) {
      chatId = String(msg.chatId);
    } else {
      return;
    }
  } catch {
    return;
  }

  const activeLottery = getActiveLottery(chatId);
  if (!activeLottery || msg.message.trim() !== activeLottery.keyword) {
    return;
  }

  const sender = await msg.getSender();
  if (!sender || sender.bot) {
    return;
  }

  // Check if user already participated
  const participants = getLotteryParticipants(activeLottery.id);
  const alreadyParticipated = participants.some(p => p.user_id === String(sender.id || sender));
  
  if (alreadyParticipated) {
    try {
      const replyMsg = await msg.reply({
        message: `⚠️ <b>重复参与</b><br><br>您已参加过抽奖，请勿重复参加`,
        parseMode: "html",
      });
      
      // Delete both messages after delay (generation-safe)
      const gen1 = getCurrentGeneration();
      const t1 = setTimeout(async () => {
        pendingTimers.delete(t1);
        if (getCurrentGeneration() !== gen1) return;
        try {
          await replyMsg.delete();
          await msg.delete();
        } catch (error) {
          console.warn("Failed to delete duplicate participation messages:", error);
        }
      }, activeLottery.delete_delay * 1000);
      pendingTimers.add(t1);
    } catch (error) {
      console.warn("Failed to handle duplicate participation:", error);
    }
    return;
  }

  // Validate user conditions
  const validation = await validateUserConditions(msg.client, sender, activeLottery, chatId);
  if (!validation.valid) {
    try {
      await msg.delete(); // Silently delete invalid participation
    } catch (error) {
      console.warn("Failed to delete invalid participation message:", error);
    }
    return;
  }

  // Add participant
  const userInfo = {
    user_id: String(sender.id || sender),
    username: sender.username || null,
    first_name: sender.firstName || null,
    last_name: sender.lastName || null
  };

  const added = addParticipantToLottery(activeLottery.id, userInfo);
  if (!added) return;

  const updatedParticipants = getLotteryParticipants(activeLottery.id);
  const currentCount = updatedParticipants.length;

  const joinText =
    `✅ <b>参与成功</b><br><br>` +
    `🎯 <b>活动:</b> ${htmlEscape(activeLottery.title)}<br>` +
    `🎁 <b>中奖名额:</b> <b>${activeLottery.winner_count}</b> 个<br>` +
    `👥 <b>参与上限:</b> <b>${activeLottery.max_participants}</b> 人<br>` +
    `📊 <b>当前进度:</b> <b>${currentCount}</b>/<b>${activeLottery.max_participants}</b> 人<br><br>` +
    `🍀 <b>祝你好运!</b>`;

  try {
    const replyMsg = await msg.reply({
      message: joinText,
      parseMode: "html",
    });
    
    // Delete messages after delay (generation-safe)
    const gen2 = getCurrentGeneration();
    const t2 = setTimeout(async () => {
      pendingTimers.delete(t2);
      if (getCurrentGeneration() !== gen2) return;
      try {
        await replyMsg.delete();
        await msg.delete();
      } catch (error) {
        console.warn("Failed to delete participation messages:", error);
      }
    }, activeLottery.delete_delay * 1000);
    pendingTimers.add(t2);
  } catch (error) {
    console.warn("Failed to send join confirmation:", error);
  }

  // Auto-draw if max participants reached
  if (currentCount >= activeLottery.max_participants) {
    await performLotteryDraw(msg.client, activeLottery);
  }
}


// Help text with dynamic prefix
const help_text = `🎰 <b>智能抽奖插件 - 完整功能指南</b>

🎯 <b>抽奖管理:</b>
• <code>${mainPrefix}lottery create [标题] [关键词] [人数] [中奖数] [仓库名/序号]</code> - 创建抽奖活动
  <b>参数说明：</b>
  · <b>标题</b> - 抽奖活动名称（支持中文、英文、表情）
  · <b>关键词</b> - 用户参与抽奖需要发送的文字（建议简短易记）
  · <b>人数</b> - 参与人数上限（达到后自动开奖，数字）
  · <b>中奖数</b> - 中奖名额数量（不能大于参与人数，数字）
  · <b>仓库名/序号</b> - 奖品仓库名称或序号（需先创建仓库并添加奖品）
  · <b>通知</b>（可选） - 置顶时是否通知，添加 notify 参数会发送通知
• <code>${mainPrefix}lottery create list</code> - 查看可用奖品仓库列表
• <code>${mainPrefix}lottery draw</code> - 手动开奖（创建者或群组管理员）
• <code>${mainPrefix}lottery status</code> - 查看当前抽奖状态
• <code>${mainPrefix}lottery list</code> - 查看参与用户列表（超长自动生成文件）
• <code>${mainPrefix}lottery delete</code> - 强制删除抽奖活动（创建者或群组管理员）
• <code>${mainPrefix}lottery init</code> - 初始化数据库（修复抽奖失败问题）

⚠️ <b>重要提示:</b>
• 开奖后原抽奖消息会被自动删除
• 开奖结果消息不会自动置顶，如需置顶请手动操作
• 创建抽奖前必须先创建奖品仓库并添加奖品

🎁 <b>奖品仓库管理（仅私聊）:</b>
• <code>${mainPrefix}lottery prize create [仓库名]</code> - 创建新的奖品仓库
• <code>${mainPrefix}lottery prize add [仓库名] [奖品内容] [数量]</code> - 添加奖品到仓库
• <code>${mainPrefix}lottery prize list [仓库名]</code> - 查看指定仓库奖品列表
• <code>${mainPrefix}lottery prize clear [仓库名]</code> - 清空指定仓库
• <code>${mainPrefix}lottery prize clear all</code> - 清空所有仓库

📊 <b>中奖管理:</b>
• <code>${mainPrefix}lottery winners</code> - 查看中奖名单和领奖状态
• <code>${mainPrefix}lottery claim [用户ID/@用户名]</code> - 手动标记用户已领奖
• <code>${mainPrefix}lottery expire</code> - 处理过期未领取的奖品

⚙️ <b>参与条件设置:</b>
• 头像验证 - 要求用户设置头像才能参与
• 用户名验证 - 要求用户设置用户名才能参与  
• 频道关注 - 要求关注指定频道才能参与
• 机器人过滤 - 自动排除机器人账户

🔧 <b>系统特性:</b>
• 自动奖品分发 - 开奖后自动发送私聊消息通知中奖者
• 库存管理 - 奖品仓库支持库存追踪和自动消耗
• 并发安全 - 使用数据库事务确保数据一致性
• 过期处理 - 24小时领奖时效，过期自动标记
• 权限控制 - 奖品管理仅限私聊，保护敏感操作
• 消息管理 - 开奖时自动删除原抽奖消息，保持群组整洁

💡 <b>使用示例:</b>

<b>创建抽奖（完整流程）:</b>
1️⃣ 首先创建奖品仓库：
<code>${mainPrefix}lottery prize create myprizes</code>

2️⃣ 添加奖品到仓库：
<code>${mainPrefix}lottery prize add myprizes "iPhone 15 Pro" 1</code>
<code>${mainPrefix}lottery prize add myprizes "现金红包100元" 5</code>

3️⃣ 查看可用仓库：
<code>${mainPrefix}lottery create list</code>

4️⃣ 创建抽奖活动：
<code>${mainPrefix}lottery create "新年抽奖" 抽奖 100 5 myprizes</code>
  · 活动名称：新年抽奖
  · 参与关键词：抽奖
  · 参与人数上限：100人
  · 中奖名额：5个
  · 使用仓库：myprizes

<b>带通知的创建（置顶时会通知所有人）:</b>
<code>${mainPrefix}lottery create "新年抽奖" 抽奖 100 5 myprizes notify</code>

<b>其他创建示例:</b>
<code>${mainPrefix}lottery create "iPhone大奖" 888 50 1 1</code> - 使用1号仓库
<code>${mainPrefix}lottery create "红包雨" 💰 200 20 cash</code> - 关键词可以是表情

<b>奖品管理（必须在私聊中操作）:</b>
<code>${mainPrefix}lottery prize create [仓库名]</code> - 创建奖品仓库
<code>${mainPrefix}lottery prize add [仓库名] [奖品描述] [数量]</code> - 添加奖品
<code>${mainPrefix}lottery prize list [仓库名]</code> - 查看仓库奖品
<code>${mainPrefix}lottery prize clear [仓库名]</code> - 清空指定仓库
<code>${mainPrefix}lottery prize clear all</code> - 清空所有仓库

<b>奖品管理示例:</b>
<code>${mainPrefix}lottery prize create vip</code> - 创建VIP仓库
<code>${mainPrefix}lottery prize add vip "VIP会员1个月" 10</code> - 添加10个月卡
<code>${mainPrefix}lottery prize add vip "VIP会员1年" 1</code> - 添加1个年卡
<code>${mainPrefix}lottery prize list vip</code> - 查看VIP仓库内容

<b>状态查询:</b>
<code>${mainPrefix}lottery status</code> - 查看进度
<code>${mainPrefix}lottery winners</code> - 查看中奖情况
<code>${mainPrefix}lottery claim @username</code> - 标记用户已领奖
<code>${mainPrefix}lottery delete</code> - 强制删除抽奖活动

🎮 <b>参与方式:</b>
用户在群组中发送抽奖关键词即可参与，达到人数上限自动开奖，中奖者将收到私聊通知。

📝 <b>注意事项:</b>
• 每个群组同时只能有一个进行中的抽奖活动
• 参与关键词区分大小写，请准确发送
• 每个用户只能参与一次，重复发送无效
• 达到人数上限会立即自动开奖
• 管理员可使用 <code>${mainPrefix}lottery draw</code> 提前手动开奖`;

const lottery = async (msg: Api.Message) => {
  const client = await getGlobalClient();
  if (!client) {
    await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
    return;
  }

  try {
    // 严格按照acron.ts模式进行参数解析
    const lines = msg.text?.trim()?.split(/\r?<br>/g) || [];
    const parts = lines?.[0]?.split(/\s+/) || [];
    const [, ...args] = parts; // 跳过命令本身
    const sub = (args[0] || "").toLowerCase();

    // Get chat ID
    let chatId: string;
    try {
      if (msg.chat?.id) {
        chatId = String(msg.chat.id);
      } else if (msg.peerId) {
        chatId = String(msg.peerId);
      } else if (msg.chatId) {
        chatId = String(msg.chatId);
      } else {
        throw new Error("无法获取聊天ID");
      }
    } catch (error) {
      await msg.edit({
        text: `❌ <b>获取聊天ID失败:</b> ${htmlEscape(String(error))}`,
        parseMode: "html"
      });
      return;
    }

    // 无参数时显示错误提示，不自动显示帮助
    if (!sub) {
      await msg.edit({
        parseMode: "html"
      });
      return;
    }

    // 明确请求帮助时才显示
    if (sub === "help" || sub === "h") {
      await msg.edit({
        text: help_text,
        parseMode: "html",
        linkPreview: false,
      });
      return;
    }

    if (sub === "init" || sub === "initialize") {
      await msg.edit({
        text: "🔄 <b>正在初始化数据库...</b>",
        parseMode: "html"
      });

      try {
        // Recreate lottery_winners table with correct schema
        db.exec(`DROP TABLE IF EXISTS lottery_winners;`);
        db.exec(`
          CREATE TABLE lottery_winners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lottery_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            prize_id INTEGER,
            prize_text TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            assigned_at INTEGER NOT NULL,
            claimed_at INTEGER,
            expires_at INTEGER,
            FOREIGN KEY (lottery_id) REFERENCES lottery_config (id),
            FOREIGN KEY (prize_id) REFERENCES prize_warehouse (id)
          );
        `);

        await msg.edit({
          text: "✅ <b>数据库初始化完成</b><br><br>已重建 lottery_winners 表结构，现在可以正常进行抽奖了。",
          parseMode: "html"
        });
        return;
      } catch (error: any) {
        await msg.edit({
          text: `❌ <b>错误:</b> 数据库初始化失败 - ${htmlEscape(error.message || String(error))}`,
          parseMode: "html"
        });
        return;
      }
    }

    // Create lottery
    if (sub === "create") {
      await msg.edit({ text: "🔄 <b>处理中...</b>", parseMode: "html" });
      // Allow "list" command in saved messages for viewing warehouses
      const isListCommand = args.length === 1 || (args.length === 2 && args[1].toLowerCase() === "list");
      
      // Check if in saved messages (forbidden for actual creation, but allow list)
      const isSavedMessages = chatId === String(msg.senderId);
      if (isSavedMessages && !isListCommand) {
        await msg.edit({
          text: `❌ <b>错误:</b> 收藏夹中不能创建抽奖活动<br><br>💡 请在群组中创建抽奖活动`,
          parseMode: "html"
        });
        return;
      }
      
      if (args.length < 2) {
        await msg.edit({
          text: `❌ <b>参数不足</b><br><br><b>用法:</b> <code>${mainPrefix}lottery create [标题] [关键词] [人数] [中奖数] [仓库名或序号]</code><br><br>💡 使用 <code>${mainPrefix}lottery create list</code> 查看可用仓库<br><br><b>示例:</b> <code>${mainPrefix}lottery create "新年抽奖" 抽奖 100 5 default</code>`,
          parseMode: "html"
        });
        return;
      }

      // Show warehouse list if no parameters or "list" parameter
      if (args.length === 1 || (args.length === 2 && args[1].toLowerCase() === "list")) {
        await msg.edit({ text: "🔄 <b>获取仓库列表...</b>", parseMode: "html" });
        const warehouses = getAllWarehousesWithPrizes();
        
        if (warehouses.length === 0) {
          await msg.edit({
            text: `📦 <b>奖品仓库列表</b><br><br>暂无可用的奖品仓库<br><br>💡 请先使用 <code>${mainPrefix}lottery prize create [仓库名]</code> 创建仓库并添加奖品`,
            parseMode: "html"
          });
          return;
        }

        const warehouseList = warehouses.map((w, index) => 
          `${index + 1}. <b>${htmlEscape(w.warehouse_name)}</b> - ${w.prize_count}种奖品，库存${w.total_stock}个`
        ).join("<br>");

        await msg.edit({
          text: `📦 <b>可用奖品仓库</b><br><br>${warehouseList}<br><br><b>创建抽奖用法:</b><br><code>${mainPrefix}lottery create [标题] [关键词] [人数] [中奖数] [仓库名或序号]</code><br><br><b>示例:</b><br><code>${mainPrefix}lottery create "新年抽奖" 抽奖 100 5 1</code><br><code>${mainPrefix}lottery create "新年抽奖" 抽奖 100 5 default</code>`,
          parseMode: "html"
        });
        return;
      }

      if (args.length < 5) {
        await msg.edit({
          text: `❌ <b>参数不足</b><br><br><b>用法:</b> <code>${mainPrefix}lottery create [标题] [关键词] [人数] [中奖数] [仓库名或序号]</code><br><br>💡 使用 <code>${mainPrefix}lottery create list</code> 查看可用仓库<br><br><b>示例:</b> <code>${mainPrefix}lottery create "新年抽奖" 抽奖 100 5 default</code>`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({ text: "🔄 <b>创建抽奖活动...</b>", parseMode: "html" });

      const title = args[1];
      const keyword = args[2];
      const maxParticipants = parseInt(args[3]);
      const winnerCount = parseInt(args[4]);
      const warehouseIdentifier = args[5] || "default";
      const shouldNotify = args[6]?.toLowerCase() === "notify";

      if (isNaN(maxParticipants) || isNaN(winnerCount) || winnerCount > maxParticipants) {
        await msg.edit({
          text: `❌ <b>错误:</b> 人数和中奖数必须是有效数字，且中奖数不能大于总人数`,
          parseMode: "html"
        });
        return;
      }

      // Validate warehouse selection
      const availableWarehouses = getPrizeWarehouses();
      const selectedWarehouse = getWarehouseByNameOrIndex(warehouseIdentifier, availableWarehouses);
      
      if (!selectedWarehouse) {
        const warehouseList = availableWarehouses.map((w, index) => 
          `${index + 1}. ${htmlEscape(w)}`
        ).join("<br>");
        
        await msg.edit({
          text: `❌ <b>错误:</b> 奖品仓库不存在<br><br>可用仓库:<br>${warehouseList}<br><br>💡 请使用正确的仓库名称或序号`,
          parseMode: "html"
        });
        return;
      }

      // Check if warehouse has prizes
      const warehousePrizes = getWarehousePrizes(selectedWarehouse);
      if (warehousePrizes.length === 0) {
        await msg.edit({
          text: `❌ <b>错误:</b> 仓库 ${codeTag(selectedWarehouse)} 中没有可用的奖品<br><br>💡 请先添加奖品或选择其他仓库`,
          parseMode: "html"
        });
        return;
      }

      const existingLottery = getActiveLottery(chatId);
      if (existingLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组已有进行中的抽奖活动<br><br>💡 请先使用 <code>${mainPrefix}lottery draw</code> 开奖或取消当前活动`,
          parseMode: "html"
        });
        return;
      }

      const uniqueId = `${chatId}_${Date.now()}`;
      const config = {
        chat_id: chatId,
        title,
        keyword,
        max_participants: maxParticipants,
        winner_count: winnerCount,
        mode: LotteryMode.MANUAL,
        distribution_mode: DistributionMode.AUTO_SEND,
        claim_timeout: 86400, // 24 hours
        delete_delay: 5,
        require_avatar: false,
        require_username: false,
        required_channel: null,
        allow_bots: false,
        member_filter: null,
        auto_draw_time: null,
        creator_id: String(msg.senderId),
        unique_id: uniqueId,
        prize_warehouse: selectedWarehouse
      };

      const lotteryId = createLotteryConfig(config);
      
      await msg.edit({ text: "🔄 <b>发布抽奖活动...</b>", parseMode: "html" });
      
      const createText =
        `🎉 <b>抽奖活动已创建</b><br><br>` +
        `🏆 <b>活动名称:</b> ${htmlEscape(title)}<br>` +
        `🎁 <b>中奖名额:</b> <b>${winnerCount}</b> 个<br>` +
        `👥 <b>参与上限:</b> <b>${maxParticipants}</b> 人<br>` +
        `🔑 <b>参与关键词:</b> ${codeTag(keyword)}<br>` +
        `📦 <b>奖品仓库:</b> ${htmlEscape(selectedWarehouse)}<br>` +
        `🎁 <b>可用奖品:</b> ${warehousePrizes.length} 种<br>` +
        `🆔 <b>抽奖ID:</b> ${codeTag(uniqueId)}<br><br>` +
        `💡 <b>提示:</b> 发送关键词即可参与抽奖`;

      const sentMsg = await msg.client?.sendMessage(chatId, {
        message: createText,
        parseMode: "html",
      });

      // Save message ID to database
      if (sentMsg) {
        const updateStmt = db.prepare(`UPDATE lottery_config SET message_id = ? WHERE id = ?`);
        updateStmt.run(String(sentMsg.id), lotteryId);
        
        try {
          await msg.client?.pinMessage(chatId, sentMsg.id, { notify: shouldNotify });
          if (shouldNotify) {
            console.log(`[lottery] Pinned lottery message with notification`);
          } else {
            console.log(`[lottery] Pinned lottery message silently`);
          }
        } catch (error) {
          console.warn("Failed to pin lottery message:", error);
        }
      }

      await msg.delete();
      return;
    }

    // Draw lottery
    if (sub === "draw") {
      await msg.edit({ text: "🔄 <b>检查抽奖状态...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组没有进行中的抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      const isCreator = String(msg.senderId) === activeLottery.creator_id;
      const isAdmin = await isUserAdmin(client, chatId, String(msg.senderId));
      
      if (!isCreator && !isAdmin) {
        await msg.edit({
          text: `❌ <b>权限不足</b><br><br>只有抽奖创建者或群组管理员可以手动开奖`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({
        text: `🔄 <b>开奖中...</b><br><br>正在为 "${htmlEscape(activeLottery.title)}" 进行开奖`,
        parseMode: "html"
      });

      await performLotteryDraw(client, activeLottery);
      return;
    }

    // Force delete lottery
    if (sub === "delete" || sub === "cancel") {
      await msg.edit({ text: "🔄 <b>检查权限...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组没有进行中的抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      const isCreator = String(msg.senderId) === activeLottery.creator_id;
      const isAdmin = await isUserAdmin(client, chatId, String(msg.senderId));
      
      if (!isCreator && !isAdmin) {
        await msg.edit({
          text: `❌ <b>权限不足</b><br><br>只有抽奖创建者或群组管理员可以删除活动`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({ text: "🔄 <b>删除抽奖活动...</b>", parseMode: "html" });
      
      const success = deleteLotteryActivity(activeLottery.id);
      
      if (success) {
        await msg.edit({
          text: `✅ <b>删除成功</b><br><br>抽奖活动 "${htmlEscape(activeLottery.title)}" 已被强制删除<br><br>📝 所有相关数据已清除`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: `❌ <b>错误:</b> 删除过程中发生错误，请稍后重试`,
          parseMode: "html"
        });
      }
      return;
    }

    // Status check
    if (sub === "status") {
      await msg.edit({ text: "🔄 <b>获取状态...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `📋 <b>抽奖状态</b><br><br>当前群组没有进行中的抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      const participants = getLotteryParticipants(activeLottery.id);
      const statusText =
        `📋 <b>抽奖状态</b><br><br>` +
        `🏆 <b>活动:</b> ${htmlEscape(activeLottery.title)}<br>` +
        `🔑 <b>关键词:</b> ${codeTag(activeLottery.keyword)}<br>` +
        `👥 <b>参与情况:</b> ${participants.length}/${activeLottery.max_participants}<br>` +
        `🎁 <b>中奖名额:</b> ${activeLottery.winner_count}<br>` +
        `⏰ <b>创建时间:</b> ${htmlEscape(new Date(activeLottery.created_at).toLocaleString("zh-CN"))}<br>` +
        `🆔 <b>抽奖ID:</b> ${codeTag(activeLottery.unique_id)}`;

      await msg.edit({
        text: statusText,
        parseMode: "html"
      });
      return;
    }

    // Prize management (restricted to saved messages or configured admin chats)
    if (sub === "prize") {
      await msg.edit({ text: "🔄 <b>验证权限...</b>", parseMode: "html" });
      
      // Check if in private chat (only allow prize management in private chats)
      const isPrivateChat = chatId === String(msg.senderId);
      
      if (!isPrivateChat) {
        await msg.edit({
          text: `🔒 <b>权限限制</b><br><br>奖品仓库管理只能在私聊或收藏夹中进行<br><br>💡 请私聊机器人或在收藏夹中使用此功能`,
          parseMode: "html"
        });
        return;
      }
      
      const prizeCmd = args[1]?.toLowerCase();
      
      if (prizeCmd === "create") {
        const warehouseName = args[2] || "default";
        
        await msg.edit({ text: "🔄 <b>创建仓库...</b>", parseMode: "html" });
        
        const isCreated = createPrizeWarehouse(warehouseName);
        
        if (isCreated) {
          await msg.edit({
            text: `✅ <b>奖品仓库已创建</b><br><br>仓库名称: ${codeTag(warehouseName)}`,
            parseMode: "html"
          });
        } else {
          await msg.edit({
            text: `⚠️ <b>仓库已存在</b><br><br>仓库 ${codeTag(warehouseName)} 已经存在，无需重复创建<br><br>💡 可以使用 <code>${mainPrefix}lottery prize add ${warehouseName} [奖品内容] [数量]</code> 添加奖品`,
            parseMode: "html"
          });
        }
        return;
      }

      if (prizeCmd === "add") {
        // Parse parameters with quote support
        const fullCommand = lines[0];
        const match = fullCommand.match(/lottery\s+prize\s+add\s+(\S+)\s+"([^"]+)"\s+(\d+)/i) || 
                     fullCommand.match(/lottery\s+prize\s+add\s+(\S+)\s+(\S+)\s+(\d+)/i);
        
        if (!match) {
          await msg.edit({
            text: `❌ <b>错误:</b> 参数格式错误<br><br><b>用法:</b> <code>${mainPrefix}lottery prize add [仓库名] [奖品内容] [数量]</code>`,
            parseMode: "html"
          });
          return;
        }

        const warehouseName = match[1];
        const prizeText = match[2];
        const stock = parseInt(match[3]) || 1;

        await msg.edit({ text: "🔄 <b>添加奖品...</b>", parseMode: "html" });
        
        addPrizeToWarehouse(warehouseName, prizeText, stock);
        await msg.edit({
          text: `✅ <b>奖品已添加</b><br><br>仓库: ${codeTag(warehouseName)}<br>奖品: ${htmlEscape(prizeText)}<br>数量: ${stock}`,
          parseMode: "html"
        });
        return;
      }

      if (prizeCmd === "list") {
        const warehouseName = args[2] || "default";
        
        await msg.edit({ text: "🔄 <b>获取奖品列表...</b>", parseMode: "html" });
        
        const prizes = getWarehousePrizes(warehouseName);
        
        if (prizes.length === 0) {
          await msg.edit({
            text: `📦 <b>奖品仓库</b><br><br>仓库 ${codeTag(warehouseName)} 暂无奖品`,
            parseMode: "html"
          });
          return;
        }

        const prizeList = prizes.map((prize, index) => 
          `${index + 1}. ${htmlEscape(prize.prize_text)} (库存: ${prize.stock_count})`
        ).join("<br>");

        await msg.edit({
          text: `📦 <b>奖品仓库: ${htmlEscape(warehouseName)}</b><br><br>${prizeList}`,
          parseMode: "html"
        });
        return;
      }

      if (prizeCmd === "clear") {
        const target = args[2];
        
        if (!target) {
          await msg.edit({
            text: `❌ <b>错误:</b> 参数不足<br><br><b>用法:</b><br><code>${mainPrefix}lottery prize clear [仓库名]</code> - 清空指定仓库<br><code>${mainPrefix}lottery prize clear all</code> - 清空所有仓库`,
            parseMode: "html"
          });
          return;
        }

        await msg.edit({ text: "🔄 <b>清空仓库...</b>", parseMode: "html" });
        
        if (target.toLowerCase() === "all") {
          const deletedCount = clearAllWarehouses();
          await msg.edit({
            text: `✅ <b>清空完成</b><br><br>已清空所有奖品仓库<br>删除了 ${deletedCount} 个奖品`,
            parseMode: "html"
          });
        } else {
          const deletedCount = clearWarehouse(target);
          if (deletedCount > 0) {
            await msg.edit({
              text: `✅ <b>清空完成</b><br><br>仓库 ${codeTag(target)} 已清空<br>删除了 ${deletedCount} 个奖品`,
              parseMode: "html"
            });
          } else {
            await msg.edit({
              text: `❌ <b>错误:</b> 仓库 ${codeTag(target)} 不存在或已为空`,
              parseMode: "html"
            });
          }
        }
        return;
      }
    }

    // Winners management
    if (sub === "winners") {
      await msg.edit({ text: "🔄 <b>获取中奖名单...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组没有抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      const winners = getLotteryWinners(activeLottery.id);
      if (winners.length === 0) {
        await msg.edit({
          text: `🏆 <b>中奖名单</b><br><br>暂无中奖用户`,
          parseMode: "html"
        });
        return;
      }

      expireOldClaims(); // Update expired claims

      const winnerList = winners.map(winner => {
        const icon = getWinnerStatusIcon(winner.status);
        const name = winner.username ? `@${winner.username}` : 
                    (winner.first_name || winner.last_name || `用户${winner.user_id}`);
        return `${icon} ${htmlEscape(name)} - ${htmlEscape(winner.prize_text || "奖品")}`;
      }).join("<br>");

      await msg.edit({
        text: `🏆 <b>中奖名单</b><br><br>${winnerList}<br><br>✅ 已发放 | ⏳ 待领取 | ❌ 已过期`,
        parseMode: "html"
      });
      return;
    }

    // Participants list
    if (sub === "list") {
      await msg.edit({ text: "🔄 <b>获取参与名单...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组没有抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      const participants = getLotteryParticipants(activeLottery.id);
      const currentCount = participants.length;
      
      if (currentCount === 0) {
        await msg.edit({
          text: `👥 <b>参与名单</b><br><br>🎯 <b>活动:</b> ${htmlEscape(activeLottery.title)}<br>📊 <b>进度:</b> ${currentCount}/${activeLottery.max_participants} 人<br><br>暂无参与用户`,
          parseMode: "html"
        });
        return;
      }

      // Generate full participants list
      const fullList = participants.map((p, index) => {
        const displayName = p.username ? `@${p.username}` : 
                           (p.first_name || p.last_name || `用户 ${p.user_id}`);
        return `${index + 1}. ${displayName}`;
      }).join("<br>");

      const headerText = `参与名单 - ${activeLottery.title}<br>进度: ${currentCount}/${activeLottery.max_participants} 人<br>生成时间: ${new Date().toLocaleString("zh-CN")}<br><br>`;
      const fullContent = headerText + fullList;

      // Check if content exceeds Telegram message limit (approximately 4000 characters)
      if (fullContent.length > 3500) {
        try {
          // Create txt file content
          const txtContent = Buffer.from(fullContent, 'utf8');
          const fileName = `参与名单_${activeLottery.title}_${new Date().toISOString().slice(0, 10)}.txt`;
          
          await msg.edit({
            text: `👥 <b>参与名单</b><br><br>🎯 <b>活动:</b> ${htmlEscape(activeLottery.title)}<br>📊 <b>进度:</b> ${currentCount}/${activeLottery.max_participants} 人<br><br>📄 <b>参与用户过多，已生成文件发送</b>`,
            parseMode: "html"
          });

          // Send as file - use simpler approach
          await msg.client?.sendMessage(chatId, {
            file: txtContent,
            message: `📋 <b>完整参与名单</b><br><br>🎯 活动: ${htmlEscape(activeLottery.title)}<br>👥 总计: ${currentCount} 人`,
            parseMode: "html"
          });
        } catch (error) {
          console.error("Failed to send participants file:", error);
          // Fallback to truncated list
          const displayList = participants.slice(0, 30).map((p, index) => {
            const displayName = p.username ? `@${p.username}` : 
                               (p.first_name || p.last_name || `用户 ${p.user_id}`);
            return `${index + 1}. ${htmlEscape(displayName)}`;
          }).join("<br>");
          
          await msg.edit({
            text: `👥 <b>参与名单</b><br><br>🎯 <b>活动:</b> ${htmlEscape(activeLottery.title)}<br>📊 <b>进度:</b> ${currentCount}/${activeLottery.max_participants} 人<br><br>${displayList}<br><br>... 还有 ${currentCount - 30} 人（文件发送失败，仅显示前30人）`,
            parseMode: "html"
          });
        }
      } else {
        // Send as regular message
        await msg.edit({
          text: `👥 <b>参与名单</b>\n\n🎯 <b>活动:</b> ${htmlEscape(activeLottery.title)}\n📊 <b>进度:</b> ${currentCount}/${activeLottery.max_participants} 人\n\n${fullList.split('\n').map(line => htmlEscape(line)).join('\n')}`,
          parseMode: "html"
        });
      }
      return;
    }

    // Manual claim marking
    if (sub === "claim") {
      if (args.length < 2) {
        await msg.edit({
          text: `❌ <b>错误:</b> 参数错误<br><br>用法: <code>${mainPrefix}lottery claim [用户ID或@用户名]</code>`,
          parseMode: "html"
        });
        return;
      }

      await msg.edit({ text: "🔄 <b>查找用户...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组没有抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      let targetUserId = args[1];
      if (targetUserId.startsWith("@")) {
        targetUserId = targetUserId.substring(1);
        // Find user by username
        const winners = getLotteryWinners(activeLottery.id);
        const winner = winners.find(w => w.username === targetUserId);
        if (!winner) {
          await msg.edit({
            text: `❌ <b>错误:</b> 未找到用户名为 ${htmlEscape(`@${targetUserId}`)} 的中奖用户`,
            parseMode: "html"
          });
          return;
        }
        targetUserId = winner.user_id;
      }

      await msg.edit({ text: "🔄 <b>更新状态...</b>", parseMode: "html" });
      
      const success = updateWinnerStatusByUser(activeLottery.id, targetUserId, PrizeStatus.SENT);
      if (success) {
        await msg.edit({
          text: `✅ <b>操作成功</b><br><br>已将用户标记为已领奖`,
          parseMode: "html"
        });
      } else {
        await msg.edit({
          text: `❌ <b>错误:</b> 未找到该中奖用户或状态更新失败`,
          parseMode: "html"
        });
      }
      return;
    }

    // Process expired claims
    if (sub === "expire") {
      await msg.edit({ text: "🔄 <b>处理过期奖品...</b>", parseMode: "html" });
      
      const activeLottery = getActiveLottery(chatId);
      if (!activeLottery) {
        await msg.edit({
          text: `❌ <b>错误:</b> 当前群组没有抽奖活动`,
          parseMode: "html"
        });
        return;
      }

      const expiredCount = expireOldClaims();
      await msg.edit({
        text: `✅ <b>过期处理完成</b><br><br>已处理 ${expiredCount} 个过期未领奖品`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({
      parseMode: "html"
    });

  } catch (error: any) {
    console.error("[lottery] 插件执行失败:", error);
    await msg.edit({
      text: `❌ <b>错误:</b> ${htmlEscape(error.message || String(error))}`,
      parseMode: "html"
    });
  }
};

class LotteryPlugin extends Plugin {
  cleanup(): void {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    if (db) {
      try {
        db.close();
      } catch {}
      db = null as any;
    }
  }

  description: string = help_text;
  
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    lottery,
  };
  
  listenMessageHandler?: ((msg: Api.Message) => Promise<void>) | undefined =
    handleEnhancedLotteryJoin;
}

export default new LotteryPlugin();
