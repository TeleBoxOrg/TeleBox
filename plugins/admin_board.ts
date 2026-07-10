import { getPrefixes } from "@utils/pluginManager";
import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { JSONFilePreset } from "lowdb/node";
import { Api } from "teleproto";
import path from "path";
import { safeGetMessages } from "@utils/safeGetMessages";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const commandName = `${mainPrefix}admin_board`;
const MAX_MESSAGE_LENGTH = 3500;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ASSET_DIR_NAME = "admin_board";
const DB_PATH = path.join(
  createDirectoryInAssets(ASSET_DIR_NAME),
  "seat_locks.json",
);
const AVG_CACHE_PATH = path.join(
  createDirectoryInAssets(ASSET_DIR_NAME),
  "avg_cache.json",
);

type TargetChat = {
  entity: Api.Chat | Api.Channel;
  titleDisplay: string;
  username: string | null;
  isChannel: boolean;
  storageKey: string;
};

type AdminStat = {
  user: Api.User;
  userId: string;
  username: string | null;
  name: string;
  adminRankText: string;
  lastSeenDaysText: string;
  avgPerDayText: string;
  lastMessageText: string;
  lockedSeat: boolean;
  lockedSeatText: string;
  sortAvgPerDay: number;
  sortLastMessageTs: number;
};

type AdminCollection = {
  allAdmins: Api.User[];
  visibleAdmins: Api.User[];
  totalCount: number;
  botCount: number;
  nonBotCount: number;
};

type AdminStatsResult = {
  stats: AdminStat[];
  counts: {
    totalCount: number;
    botCount: number;
    nonBotCount: number;
  };
};

type SeatLockDB = {
  lockedSeats: Record<string, string[]>;
};

type AvgCacheEntry = {
  updatedAt: number;
  avgPerDay?: number;
  name?: string;
  username?: string | null;
};

type AvgCacheDB = {
  values: Record<string, AvgCacheEntry>;
};

const helpText = `👮 <b>管理员席位管理</b>

<b>排序简表</b>
• <code>${htmlEscape(commandName)} ls</code> - 查看当前对话管理员排序简表
• <code>${htmlEscape(commandName)} ls 对话id/@username</code>
• <code>${htmlEscape(commandName)} tail</code> - 查看未锁定席位的倒数 10 人
• <code>${htmlEscape(commandName)} tail 20</code> - 查看未锁定席位的倒数 20 人
• <code>${htmlEscape(commandName)} tail 20 对话id/@username</code>
• <code>${htmlEscape(commandName)} rm 3</code> - 一键下掉倒数 3 个未锁定席位管理员，人数参数必填
• <code>${htmlEscape(commandName)} rm 3 对话id/@username</code>

<b>席位锁定</b>
• <code>${htmlEscape(commandName)} lock @用户名/用户id [对话id/@username]</code> - 不传默认当前对话
• <code>${htmlEscape(commandName)} lock @u1,@u2 [对话id/@username]</code>
• <code>${htmlEscape(commandName)} unlock @用户名/用户id [对话id/@username]</code> - 不传默认当前对话
• <code>${htmlEscape(commandName)} unlock @u1，@u2 [对话id/@username]</code>

<b>缓存</b>
• <code>${htmlEscape(commandName)} clear</code> - 清当前对话的周日均/用户信息缓存
• <code>${htmlEscape(commandName)} clear 对话id/@username</code>

<b>ls 输出字段</b>
• 用户名 / 名称 / ID / 头衔 / 周日均 / 是否已锁定 / 娱乐文案

<b>说明</b>
• <code>ls</code> 是紧凑排行版，带娱乐文案
• <code>tail</code> 只列出未锁定席位的倒数 N 人，默认 <code>10</code>
• <code>rm</code> 只会下掉未锁定席位，且人数参数必填，必须是正整数
• <code>周日均</code> 和用户信息默认缓存 1 天
• 用户和对话都只支持 <code>@username</code> 或 <code>id</code>
• 多个用户请用英文逗号或中文逗号分隔`;

let dbPromise:
  | Promise<Awaited<ReturnType<typeof JSONFilePreset<SeatLockDB>>>>
  | undefined;
let avgCacheDbPromise:
  | Promise<Awaited<ReturnType<typeof JSONFilePreset<AvgCacheDB>>>>
  | undefined;

function htmlEscape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      })[m] || m,
  );
}

function getTextAfterTokens(text: string, count: number): string {
  if (count <= 0) return text.trim();
  return text
    .replace(
      new RegExp(
        `^\\S+${Array(count - 1)
          .fill("\\s+\\S+")
          .join("")}`,
      ),
      "",
    )
    .trim();
}

function splitLongText(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}<br>${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    for (let index = 0; index < line.length; index += maxLength) {
      chunks.push(line.slice(index, index + maxLength));
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendLongResult(msg: Api.Message, text: string): Promise<void> {
  const chunks = splitLongText(text);
  await msg.edit({
    text: chunks[0],
    parseMode: "html",
    linkPreview: false,
  });

  for (let index = 1; index < chunks.length; index++) {
    await msg.reply({
      message: `📋 <b>续 ${index}/${chunks.length - 1}</b><br><br>${chunks[index]}`,
      parseMode: "html",
      linkPreview: false,
    });
  }
}

function formatDaysAgo(date: Date): string {
  const diffDays = Math.floor((Date.now() - date.getTime()) / DAY_MS);
  return `${Math.max(0, diffDays)} 天前`;
}

function formatAvgPerDay(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function getLastOnlineDays(user: Api.User): number | null {
  if (!user.status) return null;
  if (
    user.status instanceof Api.UserStatusOnline ||
    user.status instanceof Api.UserStatusRecently
  ) {
    return 0;
  }
  if (user.status instanceof Api.UserStatusOffline) {
    if (!user.status.wasOnline) return null;
    const days = Math.floor(
      (Date.now() - Number(user.status.wasOnline) * 1000) / DAY_MS,
    );
    return Math.max(0, days);
  }
  if (user.status instanceof Api.UserStatusLastWeek) return 7;
  if (user.status instanceof Api.UserStatusLastMonth) return 30;
  return null;
}

function getUserIdString(user: Api.User): string {
  return String(user.id);
}

function getUserDisplayName(user: Api.User): string {
  const parts = [user.firstName || "", user.lastName || ""]
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (user.username) return user.username;
  return getUserIdString(user);
}

function buildTargetDisplay(target: TargetChat): string {
  return `目标对话: <b>${htmlEscape(target.titleDisplay)}</b>${
    target.username ? ` <code>${htmlEscape(target.username)}</code>` : ""
  }`;
}

function buildUserDisplay(user: Api.User): string {
  const parts: string[] = [];
  const userId = getUserIdString(user);
  const displayName = getUserDisplayName(user).trim();
  const usernameText = user.username || "";

  if (displayName && displayName !== userId && displayName !== usernameText) {
    parts.push(htmlEscape(displayName));
  }
  if (user.username) {
    parts.push(`<code>${htmlEscape(user.username)}</code>`);
  }
  parts.push(`<a href="tg://user?id=${userId}">${userId}</a>`);

  return parts.join(" ");
}

function buildUserDisplayFromId(userId: string): string {
  return `<a href="tg://user?id=${userId}">${htmlEscape(userId)}</a>`;
}

function buildUserDisplayFromCache(
  userId: string,
  cachedUser?: { name?: string; username?: string | null },
): string {
  if (!cachedUser) {
    return buildUserDisplayFromId(userId);
  }

  const parts: string[] = [];
  const displayName = (cachedUser.name || "").trim();
  const usernameText = cachedUser.username || "";

  if (displayName && displayName !== userId && displayName !== usernameText) {
    parts.push(htmlEscape(displayName));
  }
  if (cachedUser.username) {
    parts.push(`<code>${htmlEscape(cachedUser.username)}</code>`);
  }
  parts.push(
    `<a href="tg://user?id=${userId}">${htmlEscape(userId)}</a>`,
  );

  return parts.join(" ");
}

function normalizeErrorMessage(detail: string): string {
  if (detail.includes("CHAT_ADMIN_REQUIRED")) {
    return "需要管理员权限才能执行该操作";
  }
  if (detail.includes("CHANNEL_PRIVATE")) {
    return "无法访问该私有频道/群组";
  }
  if (detail.includes("USERNAME_NOT_OCCUPIED")) {
    return "指定的用户名不存在";
  }
  if (detail.includes("PEER_ID_INVALID")) {
    return "目标对话或用户无效，或当前账号无法访问";
  }
  if (detail.includes("USER_ID_INVALID")) {
    return "目标用户无效，或不在该对话中";
  }
  if (detail.includes("USER_NOT_PARTICIPANT")) {
    return "目标用户不在该对话中";
  }
  if (detail.includes("ADMINS_TOO_MUCH")) {
    return "管理员数量已达到 Telegram 限制";
  }
  if (detail.includes("RIGHT_FORBIDDEN")) {
    return "当前账号没有足够权限执行该操作";
  }
  if (detail.includes("USER_CREATOR")) {
    return "群主无法被下掉管理员";
  }
  if (detail.includes("BOT_GROUPS_BLOCKED")) {
    return "该目标无法被当前方式调整管理员权限";
  }
  return detail;
}

function toTargetChat(entity: Api.Chat | Api.Channel): TargetChat {
  return {
    entity,
    titleDisplay: entity.title || "未命名对话",
    username:
      entity instanceof Api.Channel && entity.username ? entity.username : null,
    isChannel: entity instanceof Api.Channel,
    storageKey: String(entity.id),
  };
}

async function resolveTargetChat(
  msg: Api.Message,
  rawTarget?: string,
): Promise<TargetChat> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  if (!rawTarget) {
    const entity = await msg.getChat();
    if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) {
      throw new Error("当前对话不是群组、超级群或频道");
    }
    return toTargetChat(entity);
  }

  const target = rawTarget.trim();
  if (!target) throw new Error("目标对话不能为空");

  if (/^-?\d+$/.test(target)) {
    const entity = await client.getEntity(Number(target));
    if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) {
      throw new Error("目标必须是群组、超级群或频道");
    }
    return toTargetChat(entity);
  }

  if (target.startsWith("@")) {
    const entity = await client.getEntity(target);
    if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) {
      throw new Error("目标必须是群组、超级群或频道");
    }
    return toTargetChat(entity);
  }

  throw new Error("目标对话仅支持 @username 或 对话 ID");
}

async function getAdminCollection(
  target: TargetChat,
): Promise<AdminCollection> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  let allAdmins: Api.User[];

  if (target.isChannel) {
    const users = await client.getParticipants(target.entity, {
      filter: new Api.ChannelParticipantsAdmins(),
      showTotal: false,
    });

    allAdmins = users.filter(
      (user): user is Api.User => user instanceof Api.User,
    );
  } else {
    const users = await client.getParticipants(target.entity, {
      showTotal: false,
    });

    allAdmins = users.filter((user): user is Api.User => {
      if (!(user instanceof Api.User)) return false;
      const participant = (user as any).participant;
      return (
        participant instanceof Api.ChatParticipantAdmin ||
        participant instanceof Api.ChatParticipantCreator
      );
    });
  }

  const visibleAdmins = allAdmins.filter((user) => !user.bot);

  return {
    allAdmins,
    visibleAdmins,
    totalCount: allAdmins.length,
    botCount: allAdmins.filter((user) => !!user.bot).length,
    nonBotCount: visibleAdmins.length,
  };
}

async function getSeatLockDb() {
  if (!dbPromise) {
    dbPromise = JSONFilePreset<SeatLockDB>(DB_PATH, { lockedSeats: {} });
  }
  return await dbPromise;
}

async function getAvgCacheDb() {
  if (!avgCacheDbPromise) {
    avgCacheDbPromise = JSONFilePreset<AvgCacheDB>(AVG_CACHE_PATH, {
      values: {},
    });
  }
  return await avgCacheDbPromise;
}

function getAvgCacheKey(target: TargetChat, userId: string): string {
  return `${target.storageKey}:${userId}`;
}

async function getCachedAvgEntry(
  target: TargetChat,
  userId: string,
): Promise<AvgCacheEntry | undefined> {
  const db = await getAvgCacheDb();
  const entry = db.data.values[getAvgCacheKey(target, userId)];
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > DAY_MS) return undefined;
  return entry;
}

async function setCachedEntry(
  target: TargetChat,
  userId: string,
  patch: Partial<AvgCacheEntry>,
): Promise<void> {
  const db = await getAvgCacheDb();
  const key = getAvgCacheKey(target, userId);
  const current = db.data.values[key] || { updatedAt: Date.now() };
  db.data.values[key] = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  await db.write();
}

async function setCachedAvgEntry(
  target: TargetChat,
  userId: string,
  avgPerDay: number,
): Promise<void> {
  await setCachedEntry(target, userId, {
    avgPerDay,
  });
}

async function setCachedUserInfo(
  target: TargetChat,
  user: Api.User,
): Promise<void> {
  await setCachedEntry(target, getUserIdString(user), {
    name: getUserDisplayName(user),
    username: user.username || null,
  });
}

async function getCachedUserInfo(
  target: TargetChat,
  userId: string,
): Promise<{ name?: string; username?: string | null } | undefined> {
  const entry = await getCachedAvgEntry(target, userId);
  if (!entry) return undefined;
  if (!entry.name && !entry.username) return undefined;
  return {
    name: entry.name,
    username: entry.username,
  };
}

async function clearAvgCache(target?: TargetChat): Promise<number> {
  const db = await getAvgCacheDb();

  if (!target) {
    const count = Object.keys(db.data.values).length;
    db.data.values = {};
    await db.write();
    return count;
  }

  const prefix = `${target.storageKey}:`;
  const keys = Object.keys(db.data.values).filter((key) =>
    key.startsWith(prefix),
  );

  for (const key of keys) {
    delete db.data.values[key];
  }

  await db.write();
  return keys.length;
}

async function getLockedSeatSet(target: TargetChat): Promise<Set<string>> {
  const db = await getSeatLockDb();
  return new Set(db.data.lockedSeats[target.storageKey] || []);
}

async function updateLockedSeats(
  target: TargetChat,
  userIds: string[],
  locked: boolean,
): Promise<void> {
  const db = await getSeatLockDb();
  const current = new Set(db.data.lockedSeats[target.storageKey] || []);

  for (const userId of userIds) {
    if (locked) current.add(userId);
    else current.delete(userId);
  }

  if (current.size > 0) {
    db.data.lockedSeats[target.storageKey] = Array.from(current).sort((a, b) =>
      a.localeCompare(b, "zh-CN"),
    );
  } else {
    delete db.data.lockedSeats[target.storageKey];
  }

  await db.write();
}

async function collectAdminStat(
  target: TargetChat,
  user: Api.User,
  lockedSeatSet: Set<string>,
): Promise<AdminStat> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const userId = getUserIdString(user);
  const lockedSeat = lockedSeatSet.has(userId);
  const name = getUserDisplayName(user);
  const onlineDays = getLastOnlineDays(user);
  const participant = (user as any).participant as
    | Api.ChatParticipantAdmin
    | Api.ChatParticipantCreator
    | Api.ChannelParticipantAdmin
    | Api.ChannelParticipantCreator
    | undefined;

  await setCachedUserInfo(target, user);

  const adminRankText = participant?.rank?.trim() || "无";
  const lastSeenDaysText = onlineDays === null ? "N/A" : `${onlineDays}`;

  let avgPerDayText = "N/A";
  let sortAvgPerDay = -1;

  try {
    const cachedEntry = await getCachedAvgEntry(target, userId);

    if (cachedEntry && typeof cachedEntry.avgPerDay === "number") {
      sortAvgPerDay = cachedEntry.avgPerDay;
      avgPerDayText = formatAvgPerDay(cachedEntry.avgPerDay);
    } else {
      const fromEntity = await client.getInputEntity(user as any);
      const searchResult: any = await client.invoke(
        new Api.messages.Search({
          peer: target.entity as any,
          q: "",
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: Math.floor(Date.now() / 1000) - WEEK_SECONDS,
          maxDate: undefined as any,
          offsetId: 0,
          addOffset: 0,
          limit: 1,
          maxId: 0,
          minId: 0,
          hash: 0 as any,
          fromId: fromEntity,
        }),
      );

      const count = Number(
        "count" in searchResult
          ? searchResult.count
          : searchResult.messages?.length || 0,
      );

      if (Number.isFinite(count)) {
        sortAvgPerDay = count / 7;
        avgPerDayText = formatAvgPerDay(sortAvgPerDay);
        await setCachedAvgEntry(target, userId, sortAvgPerDay);
      }
    }
  } catch (error) {
    console.warn(`[admin_board] 获取最近一周消息数失败: ${userId}`, error);
  }

  let lastMessageText = "无记录";
  let sortLastMessageTs = 0;

  try {
    const messages = await safeGetMessages(client, target.entity, {
      fromUser: user as any,
      limit: 1,
    });

    const dateValue = messages?.[0]?.date;
    if (dateValue) {
      const lastMessageDate = new Date(Number(dateValue) * 1000);
      sortLastMessageTs = lastMessageDate.getTime();
      lastMessageText = formatDaysAgo(lastMessageDate);
    }
  } catch (error) {
    console.warn(`[admin_board] 获取最后发言时间失败: ${userId}`, error);
  }

  return {
    user,
    userId,
    username: user.username || null,
    name,
    adminRankText,
    lastSeenDaysText,
    avgPerDayText,
    lastMessageText,
    lockedSeat,
    lockedSeatText: lockedSeat ? "是" : "否",
    sortAvgPerDay,
    sortLastMessageTs,
  };
}

function sortAdminStats(stats: AdminStat[]): AdminStat[] {
  return stats.sort((left, right) => {
    if (right.sortAvgPerDay !== left.sortAvgPerDay) {
      return right.sortAvgPerDay - left.sortAvgPerDay;
    }
    if (right.sortLastMessageTs !== left.sortLastMessageTs) {
      return right.sortLastMessageTs - left.sortLastMessageTs;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function pickStableText(seed: string, options: string[]): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 33 + seed.charCodeAt(index)) >>> 0;
  }
  return options[hash % options.length];
}

function buildSortComment(
  stat: AdminStat,
  index: number,
  total: number,
): string {
  const avg = stat.sortAvgPerDay;
  const isFirst = index === 0;
  const isTopThree = index < 3;
  const isBottom = index === total - 1;
  const isTopHalf = index < Math.ceil(total / 2);
  const hasLockedSeat = stat.lockedSeat;
  const hasNoMessages = avg <= 0;
  const recentDays =
    stat.sortLastMessageTs > 0
      ? Math.floor((Date.now() - stat.sortLastMessageTs) / DAY_MS)
      : Number.POSITIVE_INFINITY;
  const seed = `${stat.userId}:${index}:${total}:${Math.round(avg * 100)}`;

  if (total === 1) {
    return "一人撑起全场";
  }
  if (isFirst && avg >= 20) {
    return pickStableText(seed, ["水王本王", "群聊永动机", "打字机成精"]);
  }
  if (isFirst) {
    return pickStableText(seed, ["水王", "榜一大哥", "稳坐龙椅"]);
  }
  if (isTopThree && hasLockedSeat) {
    return pickStableText(seed, ["前排带编", "稳坐泰山", "头部玩家"]);
  }
  if (!isTopHalf && hasLockedSeat && hasNoMessages) {
    return pickStableText(seed, ["PY 交易", "占坑选手", "席位焊死"]);
  }
  if (!isTopHalf && hasLockedSeat) {
    return pickStableText(seed, ["PY 交易", "关系户发力", "编制护体"]);
  }
  if (hasLockedSeat && avg >= 8) {
    return pickStableText(seed, ["带编劳模", "既有席位也有输出", "稳中带卷"]);
  }
  if (hasLockedSeat) {
    return pickStableText(seed, ["席位保送", "内定嘉宾", "VIP 通道"]);
  }
  if (avg >= 12) {
    return pickStableText(seed, ["高强度输出", "劳模发言机", "持续火力覆盖"]);
  }
  if (avg >= 6) {
    return pickStableText(seed, ["稳定营业", "手感正热", "状态在线"]);
  }
  if (avg >= 2 && recentDays <= 1) {
    return pickStableText(seed, ["今天也没闲着", "在线上分", "还在持续发电"]);
  }
  if (avg >= 1) {
    return pickStableText(seed, ["偶尔冒泡", "佛系开麦", "低频输出"]);
  }
  if (hasNoMessages && recentDays <= 3) {
    return pickStableText(seed, ["只上线不说话", "在线潜水", "围观群众"]);
  }
  if (hasNoMessages && isBottom) {
    return pickStableText(seed, ["垫底保级", "佛系挂机", "查无发言"]);
  }
  if (isBottom) {
    return pickStableText(seed, ["后排看戏", "边缘试探", "末位观察员"]);
  }

  return pickStableText(seed, [
    "安静围观",
    "主打陪伴",
    "默默潜伏",
    "随机掉落",
    "随缘发言",
  ]);
}

function buildTailComment(
  stat: AdminStat,
  index: number,
  total: number,
): string {
  const avg = stat.sortAvgPerDay;
  const reverseRank = total - index;
  const isBottom = reverseRank === 1;
  const isBottomThree = reverseRank <= 3;
  const isBottomFive = reverseRank <= 5;
  const hasNoMessages = avg <= 0;
  const recentDays =
    stat.sortLastMessageTs > 0
      ? Math.floor((Date.now() - stat.sortLastMessageTs) / DAY_MS)
      : Number.POSITIVE_INFINITY;
  const seed = `tail:${stat.userId}:${index}:${total}:${Math.round(avg * 100)}`;

  if (total === 1) {
    return "全场就你一个，尾榜也只能你来站岗";
  }
  if (isBottom && hasNoMessages) {
    return pickStableText(seed, [
      "尾王登基，发言记录比头发还稀",
      "喜提垫底，群聊存在感约等于空气",
      "本群静音代言人，查无发言",
    ]);
  }
  if (isBottom) {
    return pickStableText(seed, [
      "稳居榜尾，主打一个陪伴不发言",
      "尾榜状元，今天也把字省下来了",
      "发言效率感人，成功拿下最后一名",
    ]);
  }
  if (isBottomThree && hasNoMessages && recentDays > 7) {
    return pickStableText(seed, [
      "长期失踪人口，像是顺手加进来的管理员",
      "潜水深度过高，群消息已经追不上你",
      "上次开口像在上个版本",
    ]);
  }
  if (isBottomThree && avg < 1) {
    return pickStableText(seed, [
      "尾部常驻嘉宾，发言全靠缘分刷新",
      "输入法像是包月到期了",
      "平时不说话，一说话可能是手滑",
    ]);
  }
  if (isBottomFive && recentDays > 3) {
    return pickStableText(seed, [
      "最近略显安静，像是把群折叠了",
      "看得出来人在群里，魂不一定在",
      "出勤勉强合格，输出接近请假",
    ]);
  }
  if (avg < 1) {
    return pickStableText(seed, [
      "低频营业，惜字如金到像在收费",
      "主打沉默管理，发言像限量发售",
      "在线旁听专家，开口次数相当克制",
    ]);
  }
  if (avg < 2 && recentDays <= 1) {
    return pickStableText(seed, [
      "今天象征性冒了个泡，任务算完成",
      "刚打完卡就准备继续潜水",
      "有在努力，但不多",
    ]);
  }
  if (avg < 3) {
    return pickStableText(seed, [
      "在卷王堆里显得格外佛系",
      "不是完全不说，只是存在感很节能",
      "稳定尾部，压力全给前排扛了",
    ]);
  }

  return pickStableText(seed, [
    "虽然在尾部，但至少还算偶尔出声",
    "尾榜里算是比较有求生欲的",
    "再努努力，至少能先脱离倒数区",
  ]);
}

function getRankDisplay(index: number): string {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return `${index + 1}.`;
}

function buildCompactSortLine(
  stat: AdminStat,
  index: number,
  total: number,
  options?: {
    commentText?: string;
    commentPrefix?: string;
    rankLabel?: string;
  },
): string {
  const identityParts: string[] = [];
  if (stat.adminRankText !== "无") {
    identityParts.push(`<code>${htmlEscape(stat.adminRankText)}</code>`);
  }

  const displayName = stat.name.trim();
  const usernameText = stat.username || "";
  if (
    displayName &&
    displayName !== stat.userId &&
    displayName !== usernameText
  ) {
    identityParts.push(htmlEscape(displayName));
  }
  if (stat.username) {
    identityParts.push(`<code>${htmlEscape(stat.username)}</code>`);
  }
  identityParts.push(`<code>${stat.userId}</code>`);

  const tailParts = [`<code>${htmlEscape(stat.avgPerDayText)}</code>`];
  if (stat.lockedSeat) {
    tailParts.push("🔒");
  }

  const commentText = htmlEscape(
    options?.commentText || buildSortComment(stat, index, total),
  );
  const commentPrefix = options?.commentPrefix
    ? `${htmlEscape(options.commentPrefix)}：`
    : "";
  const rankLabel = options?.rankLabel || getRankDisplay(index);
  return `${rankLabel} ${identityParts.join(" ")} | ${tailParts.join(
    " | ",
  )}<br>   └ <i>${commentPrefix}${commentText}</i><br>`;
}

async function collectAdminStats(
  msg: Api.Message,
  target: TargetChat,
): Promise<AdminStatsResult> {
  await msg.edit({
    text: `🔍 正在获取 <b>${htmlEscape(target.titleDisplay)}</b> 的管理员列表...`,
    parseMode: "html",
    linkPreview: false,
  });

  const adminCollection = await getAdminCollection(target);
  if (adminCollection.nonBotCount === 0) {
    throw new Error("当前对话没有可统计的非 Bot 管理员，或无法获取管理员列表");
  }

  const lockedSeatSet = await getLockedSeatSet(target);
  const stats: AdminStat[] = [];
  const admins = adminCollection.visibleAdmins;

  for (let index = 0; index < admins.length; index++) {
    if (index === 0 || (index + 1) % 5 === 0 || index === admins.length - 1) {
      await msg.edit({
        text: `📊 正在统计管理员排序简表...<br>目标: <b>${htmlEscape(
          target.titleDisplay,
        )}</b><br>进度: <code>${index + 1}/${admins.length}</code>`,
        parseMode: "html",
        linkPreview: false,
      });
    }

    stats.push(await collectAdminStat(target, admins[index], lockedSeatSet));
  }

  return {
    stats: sortAdminStats(stats),
    counts: {
      totalCount: adminCollection.totalCount,
      botCount: adminCollection.botCount,
      nonBotCount: adminCollection.nonBotCount,
    },
  };
}

function buildSortText(
  target: TargetChat,
  stats: AdminStat[],
  counts: { totalCount: number; botCount: number; nonBotCount: number },
): string {
  const headerLines = [
    `📊 <b>管理员排序简表</b>`,
    buildTargetDisplay(target),
    `管理员数量: 总 <code>${counts.totalCount}</code> | Bot <code>${counts.botCount}</code> | 非 Bot <code>${counts.nonBotCount}</code>`,
    `排序: <code>周日均消息数 ↓</code>`,
    "",
  ];

  const bodyLines: string[] = [];

  for (let index = 0; index < stats.length; index++) {
    const stat = stats[index];
    bodyLines.push(buildCompactSortLine(stat, index, stats.length));
  }

  return [...headerLines, ...bodyLines].join("<br>").trim();
}

function buildTailText(
  target: TargetChat,
  stats: AdminStat[],
  counts: { totalCount: number; botCount: number; nonBotCount: number },
  limit: number,
): string {
  const unlockedStats = stats.filter((stat) => !stat.lockedSeat);
  const visibleStats = unlockedStats.slice(-limit).reverse();

  const headerLines = [
    `📉 <b>未锁席位倒数榜</b>`,
    buildTargetDisplay(target),
    `管理员数量: 总 <code>${counts.totalCount}</code> | Bot <code>${counts.botCount}</code> | 非 Bot <code>${counts.nonBotCount}</code>`,
    `未锁席位: <code>${unlockedStats.length}</code> | 展示: <code>${visibleStats.length}</code> | 倒数范围: <code>${limit}</code>`,
    `排序: <code>未锁席位的周日均消息数倒数 ${limit} 人</code>`,
    "",
  ];

  if (unlockedStats.length === 0) {
    return [...headerLines, `暂无未锁定席位的管理员。`].join("<br>").trim();
  }

  const bodyLines: string[] = [];
  for (const stat of visibleStats) {
    const originalIndex = unlockedStats.findIndex(
      (candidate) => candidate.userId === stat.userId,
    );
    bodyLines.push(
      buildCompactSortLine(
        stat,
        originalIndex >= 0 ? originalIndex : 0,
        unlockedStats.length,
        {
          commentText: buildTailComment(
            stat,
            originalIndex >= 0 ? originalIndex : 0,
            unlockedStats.length,
          ),
        },
      ),
    );
  }

  return [...headerLines, ...bodyLines].join("<br>").trim();
}

function parseTailArgs(remainder: string): {
  limit: number;
  targetArg?: string;
} {
  const trimmed = remainder.trim();
  if (!trimmed) {
    return { limit: 10 };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] || "";

  if (/^[1-9]\d*$/.test(firstToken)) {
    const limit = Number(firstToken);
    const targetArg = tokens.slice(1).join(" ").trim();
    return {
      limit,
      targetArg: targetArg || undefined,
    };
  }

  return {
    limit: 10,
    targetArg: trimmed,
  };
}

function parseTrimArgs(remainder: string): {
  limit?: number;
  targetArg?: string;
} {
  const trimmed = remainder.trim();
  if (!trimmed) {
    return {};
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0] || "";
  if (!/^[1-9]\d*$/.test(firstToken)) {
    return {};
  }

  const targetArg = tokens.slice(1).join(" ").trim();
  return {
    limit: Number(firstToken),
    targetArg: targetArg || undefined,
  };
}

function isCreatorUser(user: Api.User): boolean {
  const participant = (user as any).participant;
  return (
    participant instanceof Api.ChatParticipantCreator ||
    participant instanceof Api.ChannelParticipantCreator
  );
}

async function demoteAdminInTarget(
  target: TargetChat,
  user: Api.User,
): Promise<void> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const inputUser = await client.getInputEntity(user as any);

  if (target.isChannel) {
    const inputChannel = await client.getInputEntity(target.entity as any);
    await client.invoke(
      new Api.channels.EditAdmin({
        channel: inputChannel as any,
        userId: inputUser as any,
        adminRights: new Api.ChatAdminRights({}),
        rank: "",
      }),
    );
    return;
  }

  await client.invoke(
    new Api.messages.EditChatAdmin({
      chatId: (target.entity as any).id,
      userId: inputUser as any,
      isAdmin: false as any,
    }),
  );
}

function isPotentialUserIdentifier(text: string): boolean {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) || /^@[A-Za-z0-9_]{3,}$/.test(trimmed);
}

function parseUserIdentifiers(raw: string): string[] | null {
  const parts = raw
    .split(/[，,]/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return null;
  if (parts.some((part) => !isPotentialUserIdentifier(part))) return null;

  const deduped = new Map<string, string>();
  for (const part of parts) {
    const key = /^-?\d+$/.test(part)
      ? String(Number(part))
      : part.replace(/^@/, "").toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, part);
    }
  }

  return Array.from(deduped.values());
}

function parseSeatActionArgs(remainder: string): {
  identifiers: string[];
  targetArg?: string;
} {
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  const identifiers = parseUserIdentifiers(remainder);
  if (identifiers) {
    return { identifiers };
  }

  if (tokens.length > 1) {
    const targetArg = tokens[tokens.length - 1];
    const targetlessIdentifiers = parseUserIdentifiers(
      tokens.slice(0, -1).join(" "),
    );
    if (targetlessIdentifiers) {
      return {
        identifiers: targetlessIdentifiers,
        targetArg,
      };
    }
  }

  return { identifiers: [] };
}

async function findUserInChatParticipants(
  target: TargetChat,
  identifier: string,
): Promise<Api.User | undefined> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const isNumeric = /^-?\d+$/.test(identifier);
  const username = isNumeric ? "" : identifier.replace(/^@/, "").toLowerCase();
  const participants = await client.getParticipants(target.entity, {
    showTotal: false,
    ...(username ? { search: username } : {}),
  });

  return participants.find((user): user is Api.User => {
    if (!(user instanceof Api.User)) return false;
    if (isNumeric) return String(user.id) === String(Number(identifier));
    return (user.username || "").toLowerCase() === username;
  });
}

async function findUserInChannelParticipants(
  target: TargetChat,
  identifier: string,
): Promise<Api.User | undefined> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const isNumeric = /^-?\d+$/.test(identifier);
  const username = isNumeric ? "" : identifier.replace(/^@/, "").toLowerCase();

  if (username) {
    try {
      const users = await client.getParticipants(target.entity, {
        search: username,
        showTotal: false,
      });
      const matched = users.find((user): user is Api.User => {
        return (
          user instanceof Api.User &&
          (user.username || "").toLowerCase() === username
        );
      });
      if (matched) return matched;
    } catch {
      // Ignore and continue to other fallbacks.
    }
  }

  if (!isNumeric) return undefined;

  const inputChannel = await client.getInputEntity(target.entity as any);
  let offset = 0;
  const limit = 200;

  for (let index = 0; index < 5; index++) {
    const result: any = await client.invoke(
      new Api.channels.GetParticipants({
        channel: inputChannel as any,
        filter: new Api.ChannelParticipantsRecent(),
        offset,
        limit,
        hash: 0 as any,
      }),
    );

    const users: Api.User[] = (result?.users || []).filter(
      (user: any): user is Api.User => user instanceof Api.User,
    );
    const matched = users.find(
      (user) => String(user.id) === String(Number(identifier)),
    );
    if (matched) return matched;

    const participants: any[] = result?.participants || [];
    if (!participants.length) break;
    offset += participants.length;
  }

  return undefined;
}

async function resolveUserForSeatAction(
  target: TargetChat,
  identifier: string,
): Promise<Api.User | undefined> {
  const client = await getGlobalClient();
  if (!client) throw new Error("Telegram 客户端未初始化");

  const trimmed = identifier.trim();
  if (!trimmed) return undefined;
  if (!isPotentialUserIdentifier(trimmed)) return undefined;

  const candidates = /^-?\d+$/.test(trimmed) ? [Number(trimmed)] : [trimmed];

  for (const candidate of candidates) {
    try {
      const entity = await client.getEntity(candidate as any);
      if (entity instanceof Api.User) {
        return entity;
      }
    } catch {
      // Ignore and continue to target-specific fallback.
    }
  }

  return target.isChannel
    ? await findUserInChannelParticipants(target, trimmed)
    : await findUserInChatParticipants(target, trimmed);
}

async function handleSeatAction(
  msg: Api.Message,
  action: "lock" | "unlock",
  rawText: string,
): Promise<void> {
  const remainder = getTextAfterTokens(rawText, 2);
  const { identifiers, targetArg } = parseSeatActionArgs(remainder);

  if (identifiers.length === 0) {
    await msg.edit({
      text: `❌ 参数不足<br><br>用法:<br><code>${htmlEscape(
        commandName,
      )} ${action} 用户1,用户2 [对话id/@username]</code>`,
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  const target = await resolveTargetChat(msg, targetArg);
  await msg.edit({
    text: `🔍 正在解析要${action === "lock" ? "锁定" : "取消锁定"}席位的用户...<br>${buildTargetDisplay(
      target,
    )}`,
    parseMode: "html",
    linkPreview: false,
  });

  const resolvedUsers = new Map<string, Api.User>();
  const rawResolvedIds = new Set<string>();
  const failures: string[] = [];

  for (const identifier of identifiers) {
    try {
      const user = await resolveUserForSeatAction(target, identifier);
      if (!user) {
        if (/^-?\d+$/.test(identifier.trim())) {
          rawResolvedIds.add(String(Number(identifier.trim())));
        } else {
          failures.push(`${identifier}（未找到用户）`);
        }
        continue;
      }
      resolvedUsers.set(getUserIdString(user), user);
    } catch (error: any) {
      if (/^-?\d+$/.test(identifier.trim())) {
        rawResolvedIds.add(String(Number(identifier.trim())));
      } else {
        failures.push(
          `${identifier}（${normalizeErrorMessage(error?.message || "解析失败")}）`,
        );
      }
    }
  }

  const resolvedList = Array.from(resolvedUsers.values());
  const storedUserIds = Array.from(
    new Set([
      ...resolvedList.map((user) => getUserIdString(user)),
      ...Array.from(rawResolvedIds),
    ]),
  );

  if (storedUserIds.length > 0) {
    await updateLockedSeats(target, storedUserIds, action === "lock");
  }

  const lines = [
    `${action === "lock" ? "🔒" : "🔓"} <b>席位${
      action === "lock" ? "锁定" : "取消锁定"
    }完成</b>`,
    buildTargetDisplay(target),
    `成功: <code>${storedUserIds.length}</code>`,
    `失败: <code>${failures.length}</code>`,
  ];

  if (storedUserIds.length > 0) {
    lines.push("");
    lines.push(`<b>成功用户</b>`);
    for (const user of resolvedList) {
      lines.push(`• ${buildUserDisplay(user)}`);
    }
    for (const userId of Array.from(rawResolvedIds)) {
      if (!resolvedUsers.has(userId)) {
        const cachedUser = await getCachedUserInfo(target, userId);
        lines.push(
          `• ${buildUserDisplayFromCache(userId, cachedUser)} <code>（按 ID 直接记录）</code>`,
        );
      }
    }
  }

  if (failures.length > 0) {
    lines.push("");
    lines.push(`<b>失败项</b>`);
    failures.forEach((failure) => lines.push(`• ${htmlEscape(failure)}`));
  }

  await sendLongResult(msg, lines.join("<br>"));
}

async function handleClearCacheAction(
  msg: Api.Message,
  rawText: string,
): Promise<void> {
  const targetArg = getTextAfterTokens(rawText, 2) || undefined;
  const target = await resolveTargetChat(msg, targetArg);

  await msg.edit({
    text: `🧹 正在清理周日均缓存...<br>${buildTargetDisplay(target)}`,
    parseMode: "html",
    linkPreview: false,
  });

  const removedCount = await clearAvgCache(target);

  await msg.edit({
    text: [
      `🧹 <b>缓存已清理</b>`,
      buildTargetDisplay(target),
      `清理条目: <code>${removedCount}</code>`,
      `说明: <code>已清理周日均和用户信息缓存，席位锁定数据不受影响</code>`,
    ].join("<br>"),
    parseMode: "html",
    linkPreview: false,
  });
}

async function handleTrimAction(
  msg: Api.Message,
  rawText: string,
): Promise<void> {
  const remainder = getTextAfterTokens(rawText, 2);
  const { limit, targetArg } = parseTrimArgs(remainder);

  if (!limit) {
    await msg.edit({
      text: `❌ 参数不足<br><br><code>rm</code> 的人数参数是必填项。<br><br>用法:<br><code>${htmlEscape(
        commandName,
      )} rm 正整数 [对话id/@username]</code>`,
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  const target = await resolveTargetChat(msg, targetArg);
  const { stats, counts } = await collectAdminStats(msg, target);
  const candidates = stats.filter(
    (stat) => !stat.lockedSeat && !isCreatorUser(stat.user),
  );
  const selected = candidates.slice(-limit).reverse();

  if (selected.length === 0) {
    await msg.edit({
      text: [
        `✂️ <b>无需处理</b>`,
        buildTargetDisplay(target),
        `说明: <code>没有可下掉的未锁定席位管理员</code>`,
      ].join("<br>"),
      parseMode: "html",
      linkPreview: false,
    });
    return;
  }

  const successLines: string[] = [];
  const failureLines: string[] = [];

  for (let index = 0; index < selected.length; index++) {
    const stat = selected[index];
    await msg.edit({
      text: `✂️ 正在下掉倒数管理员...<br>${buildTargetDisplay(
        target,
      )}<br>进度: <code>${index + 1}/${selected.length}</code>`,
      parseMode: "html",
      linkPreview: false,
    });

    try {
      await demoteAdminInTarget(target, stat.user);
      successLines.push(
        `• ${buildUserDisplay(stat.user)} | <code>${htmlEscape(
          stat.avgPerDayText,
        )}</code>`,
      );
    } catch (error: any) {
      failureLines.push(
        `• ${buildUserDisplay(stat.user)}（${htmlEscape(
          normalizeErrorMessage(error?.message || "执行失败"),
        )}）`,
      );
    }
  }

  const lines = [
    `✂️ <b>尾部管理员清理完成</b>`,
    buildTargetDisplay(target),
    `目标人数: <code>${limit}</code>`,
    `实际候选: <code>${selected.length}</code>`,
    `成功: <code>${successLines.length}</code>`,
    `失败: <code>${failureLines.length}</code>`,
  ];

  if (successLines.length > 0) {
    lines.push("");
    lines.push(`<b>已下掉</b>`);
    lines.push(...successLines);
  }

  if (failureLines.length > 0) {
    lines.push("");
    lines.push(`<b>失败项</b>`);
    lines.push(...failureLines);
  }

  await sendLongResult(msg, lines.join("<br>"));
}

class AdminBoardPlugin extends Plugin {


  description: string = helpText;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    admin_board: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({
          text: "❌ Telegram 客户端未初始化",
          parseMode: "html",
        });
        return;
      }

      const rawText = (msg.message || msg.text || "").trim();
      const parts = rawText.split(/\s+/);
      const action = (parts[1] || "").toLowerCase();

      if (!action || action === "help" || action === "h") {
        await msg.edit({
          text: helpText,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      try {
        if (action === "ls") {
          const targetArg = getTextAfterTokens(rawText, 2) || undefined;
          const target = await resolveTargetChat(msg, targetArg);
          const { stats, counts } = await collectAdminStats(msg, target);
          const resultText = buildSortText(target, stats, counts);
          await sendLongResult(msg, resultText);
          return;
        }

        if (action === "tail") {
          const remainder = getTextAfterTokens(rawText, 2);
          const firstToken =
            remainder.trim().split(/\s+/).filter(Boolean)[0] || "";
          if (
            firstToken &&
            /^\d+$/.test(firstToken) &&
            !/^[1-9]\d*$/.test(firstToken)
          ) {
            await msg.edit({
              text: `❌ 参数错误<br><br><code>tail</code> 的人数参数必须是正整数`,
              parseMode: "html",
              linkPreview: false,
            });
            return;
          }

          const { limit, targetArg } = parseTailArgs(remainder);
          const target = await resolveTargetChat(msg, targetArg);
          const { stats, counts } = await collectAdminStats(msg, target);
          const resultText = buildTailText(target, stats, counts, limit);
          await sendLongResult(msg, resultText);
          return;
        }

        if (action === "rm") {
          await handleTrimAction(msg, rawText);
          return;
        }

        if (action === "lock" || action === "unlock") {
          await handleSeatAction(msg, action, rawText);
          return;
        }

        if (action === "clear") {
          await handleClearCacheAction(msg, rawText);
          return;
        }

        await msg.edit({
          text: `❌ 不支持的动作: <code>${htmlEscape(action)}</code><br><br>${helpText}`,
          parseMode: "html",
          linkPreview: false,
        });
      } catch (error: any) {
        console.error(`[admin_board] ${action} failed:`, error);

        const detail = normalizeErrorMessage(error?.message || String(error));

        await msg.edit({
          text: `❌ <b>执行失败</b><br><br>${htmlEscape(detail)}`,
          parseMode: "html",
          linkPreview: false,
        });
      }
    },
  };
}

export default new AdminBoardPlugin();
