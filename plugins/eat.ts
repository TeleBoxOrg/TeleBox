import { Plugin , type PanelSettingsAdapter, type PanelSettingField } from "@utils/pluginBase";
import sharp from "sharp";
import axios from "axios";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { JSONFilePreset } from "lowdb/node";
import * as path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const MAX_ASSET_CACHE_SIZE = 100;
const assetBufferCache = new Map<string, Buffer>();

function trimAssetCache(): void {
  if (assetBufferCache.size <= MAX_ASSET_CACHE_SIZE) return;
  const excess = assetBufferCache.size - MAX_ASSET_CACHE_SIZE;
  let count = 0;
  for (const key of Array.from(assetBufferCache.keys())) {
    if (count >= excess) break;
    assetBufferCache.delete(key);
    count++;
  }
}

interface RoleConfig {
  x: number;
  y: number;
  mask: string;
  brightness?: number;
  rotate?: number;
}

interface StampConfig {
  size?: number;
  scale?: number;
  rotate?: number;
  opacity?: number;
}

interface EntryConfig {
  name: string;
  url: string;
  me?: RoleConfig;
  you?: RoleConfig;
  stamp?: StampConfig;
}

interface EatConfig {
  [key: string]: EntryConfig;
}

let config: EatConfig = {};
let resourceBaseUrl = "";

let baseConfigURL =
  "https://raw.githubusercontent.com/TeleBoxOrg/TeleBox-Plugins/refs/heads/main/eat/config.json";

function resolveResourceUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${resourceBaseUrl}/${path}`;
}

async function loadConfigResource(url: string, forceUpdate = false) {
  const parseAndSetConfig = (content: string) => {
    const fullConfig = JSON.parse(content);
    if (!fullConfig.resources) {
      throw new Error("配置文件格式错误，缺少resources 字段");
    }
    const regex =
      /^https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/refs\/heads\/([^\/]+)\/(.+)$/;
    const match = url.match(regex);
    if (!match) throw new Error("URL格式不正确");
    const [, repo_owner, repo_name, branch] = match;
    const base_url_template =
      "https://github.com/${repo_owner}/${repo_name}/raw/${branch}";
    if (!repo_owner || !repo_name || !branch) {
      throw new Error("URL格式不正确, 缺少 repo_owner, repo_name, branch等信息");
    }

    resourceBaseUrl = base_url_template
      .replace("${repo_owner}", repo_owner)
      .replace("${repo_name}", repo_name)
      .replace("${branch}", branch);

    config = fullConfig.resources;
    console.log(
      `配置加载成功，当前分支: ${branch}, 资源基础URL: ${resourceBaseUrl}`
    );
  };

  if (!forceUpdate && Object.keys(config || {}).length > 0) {
    return;
  }

  const response = await axios.get(url, { responseType: "arraybuffer" });
  const content = Buffer.from(response.data).toString("utf-8");
  parseAndSetConfig(content);
}

loadConfigResource(baseConfigURL).catch(() => {
  console.log("初始配置加载失败，将在首次使用时重试");
});

async function sendStickerList(msg: Api.Message) {
  const stickerList = Object.keys(config)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key} - ${config[key].name}`)
    .join("\n");
  await msg.edit({
    text: `当前表情包：\n${stickerList}`,
  });
}

function getRandomEntry(): EntryConfig {
  const values = Object.values(config);
  const randomIndex = Math.floor(Math.random() * values.length);
  return values[randomIndex];
}

async function getAssetBuffer(url: string): Promise<Buffer> {
  const absoluteUrl = resolveResourceUrl(url);
  const cached = assetBufferCache.get(absoluteUrl);
  if (cached) return cached;

  const response = await axios.get(absoluteUrl, {
    responseType: "arraybuffer",
  });
  const buf = Buffer.from(response.data);
  assetBufferCache.set(absoluteUrl, buf);
  trimAssetCache();
  return buf;
}

async function iconMaskedFor(params: {
  role: RoleConfig;
  avatar: Buffer;
}): Promise<sharp.OverlayOptions> {
  const { role, avatar } = params;

  const maskBuffer = await getAssetBuffer(role.mask);
  const { width: maskWidth, height: maskHeight } = await sharp(
    maskBuffer
  ).metadata();

  let iconRotate = await sharp(avatar).resize(maskWidth, maskHeight).toBuffer();

  if (role.rotate) {
    iconRotate = await sharp(iconRotate).rotate(role.rotate).toBuffer();
  }
  if (role.brightness) {
    iconRotate = await sharp(iconRotate)
      .modulate({ brightness: role.brightness })
      .toBuffer();
  }

  let iconSharp = sharp(iconRotate);

  const { width: iconWidth, height: iconHeight } = await iconSharp.metadata();

  const left = Math.max(0, Math.floor((iconWidth - maskWidth) / 2));
  const top = Math.max(0, Math.floor((iconHeight - maskHeight) / 2));

  let cropped = iconSharp.extract({
    left,
    top,
    width: maskWidth,
    height: maskHeight,
  });

  let iconMasked = await cropped
    .composite([
      {
        input: maskBuffer,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();

  return {
    input: iconMasked,
    top: role.y,
    left: role.x,
  };
}

async function downloadProfilePhoto(msg: Api.Message): Promise<Buffer | null> {
  const replied = await safeGetReplyMessage(msg);
  const fromId = replied?.senderId;
  if (!fromId) {
    await msg.edit({ text: "无法获取对方头像" });
    return null;
  }

  const buf = (await msg.client?.downloadProfilePhoto(fromId, {
    isBig: false,
  })) as Buffer | undefined;
  if (!buf) return null;
  return buf;
}

async function downloadMedia(msg: Api.Message): Promise<Buffer | null> {
  const replied = await safeGetReplyMessage(msg);
  if (!replied) {
    await msg.edit({ text: "请回复一条图片消息" });
    return null;
  }
  if (!replied.media) {
    await msg.edit({ text: "请回复一条图片消息" });
    return null;
  }
  const mimeType = (replied.media as any).document?.mimeType;
  const buf = (await msg.client?.downloadMedia(replied, {
    thumb: ["video/webm"].includes(mimeType) ? 0 : 1,
  })) as Buffer | undefined;
  if (!buf) return null;
  return buf;
}

async function downloadAvatar(
  msg: Api.Message,
  isEat2: Boolean
): Promise<Buffer | null> {
  return isEat2 ? await downloadMedia(msg) : await downloadProfilePhoto(msg);
}

async function compositeWithEntryConfig(parmas: {
  entry: EntryConfig;
  msg: Api.Message;
  isEat2: boolean;
  trigger?: Api.Message;
}): Promise<void> {
  const { entry, msg, isEat2, trigger } = parmas;

  const youAvatarBuffer = await downloadAvatar(msg, isEat2);
  if (!youAvatarBuffer) return;

  if (entry.stamp) {
    const stampCfg = entry.stamp || {};
    const size = stampCfg.size ?? 512;
    const scale = stampCfg.scale ?? 0.9;
    const rotate = stampCfg.rotate ?? -12;
    const opacity = stampCfg.opacity ?? 0.6;

    const stampBuf = await getAssetBuffer(entry.url);

    const base = await sharp(youAvatarBuffer)
      .resize(size, size, { fit: "cover" })
      .png()
      .toBuffer();

    const stampRotated = await sharp(stampBuf)
      .resize({ width: Math.round(size * scale) })
      .rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .linear([1, 1, 1, opacity], [0, 0, 0, 0])
      .png()
      .toBuffer();

    const stampFinal = await sharp(stampRotated)
      .resize({ width: size, height: size, fit: "inside" })
      .png()
      .toBuffer();

    const outBuffer = await sharp(base)
      .composite([{ input: stampFinal, gravity: "center" }])
      .webp({ lossless: true })
      .toBuffer();

    const file = new CustomFile("output.webp", outBuffer.length, "", outBuffer);
    const { width = size, height = size } = await sharp(outBuffer).metadata();

    const stickerAttr = new Api.DocumentAttributeSticker({
      alt: entry.name,
      stickerset: new Api.InputStickerSetEmpty(),
    });

    const imageSizeAttr = new Api.DocumentAttributeImageSize({
      w: width,
      h: height,
    });

    const filenameAttr = new Api.DocumentAttributeFilename({
      fileName: "output.webp",
    });

    await msg.client?.sendFile(msg.peerId, {
      file,
      forceDocument: false,
      attributes: [stickerAttr, imageSizeAttr, filenameAttr],
      replyTo: await safeGetReplyMessage(msg),
    });
    return;
  }

  const baseBuffer = await getAssetBuffer(entry.url);

  let composite: sharp.OverlayOptions[] = [];
  if (entry.you) {
    const iconMasked = await iconMaskedFor({
      role: entry.you,
      avatar: youAvatarBuffer,
    });
    composite.push(iconMasked);
  }

  if (entry.me) {
    const meId = trigger?.fromId || msg.fromId;
    if (!meId) {
      await msg.edit({ text: "无法获取自己的头像" });
      return;
    }
    const meAvatarBuffer = (await msg.client?.downloadProfilePhoto(meId, {
      isBig: false,
    })) as Buffer | undefined;
    if (!meAvatarBuffer) {
      await msg.edit({ text: "无法获取自己的头像" });
      return;
    }
    const iconMasked = await iconMaskedFor({
      role: entry.me,
      avatar: meAvatarBuffer,
    });
    composite.push(iconMasked);
  }

  const outBuffer = await sharp(baseBuffer)
    .composite(composite)
    .webp({ quality: 100 })
    .toBuffer();

  const file = new CustomFile("output.webp", outBuffer.length, "", outBuffer);
  const { width = 512, height = 512 } = await sharp(outBuffer).metadata();

  const stickerAttr = new Api.DocumentAttributeSticker({
    alt: entry.name,
    stickerset: new Api.InputStickerSetEmpty(),
  });

  const imageSizeAttr = new Api.DocumentAttributeImageSize({
    w: width,
    h: height,
  });

  const filenameAttr = new Api.DocumentAttributeFilename({
    fileName: "output.webp",
  });

  await msg.client?.sendFile(msg.peerId, {
    file,
    forceDocument: false,
    attributes: [stickerAttr, imageSizeAttr, filenameAttr],
    replyTo: await safeGetReplyMessage(msg),
  });
}

async function sendSticker(params: {
  entry: EntryConfig;
  msg: Api.Message;
  trigger?: Api.Message;
  isEat2: boolean;
}) {
  const { entry, msg, trigger, isEat2 } = params;
  const cmd = msg.message.slice(1).split(" ")[0];
  await msg.edit({ text: `正在生成 ${entry.name} 表情包···` });
  await compositeWithEntryConfig({ entry, msg, isEat2, trigger });
  await msg.delete();
}

async function ensureConfigLoaded(msg?: Api.Message): Promise<void> {
  if (!config || Object.keys(config).length === 0) {
    if (msg) {
      await msg.edit({ text: "正在加载表情包配置..." });
    }
    await loadConfigResource(baseConfigURL);
  }
}

async function handleSetCommand(params: {
  msg: Api.Message;
  url: string;
}): Promise<void> {
  const { msg, url } = params;
  await msg.edit({
    text: "强制更新表情包配置中，请稍等...",
  });
  await loadConfigResource(url, true);
  const stickerList = Object.keys(config)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key} - ${config[key].name}`)
    .join("\n");
  await msg.edit({
    text: `✅ 已强制更新表情包配置\n当前表情包：\n${stickerList}`,
  });
}

const fn = async (
  msg: Api.Message,
  trigger?: Api.Message,
  isEat2: boolean = false
) => {
  const [, ...args] = msg.message.split(" ");

  if (!msg.isReply) {
    if (args[0] == "set") {
      let url = args[1] || baseConfigURL;
      await handleSetCommand({ msg, url });
      return;
    }

    await ensureConfigLoaded(msg);
    await sendStickerList(msg);
    return;
  }

  await ensureConfigLoaded(msg);

  if (args.length == 0) {
    const entry = getRandomEntry();
    await sendSticker({ entry, msg, trigger, isEat2 });
  } else {
    const stickerName = args[0];
    const entrys = Object.keys(config);
    if (!entrys.includes(stickerName)) {
      const stickerList = entrys
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${key} - ${config[key].name}`)
        .join("\n");
      await msg.edit({
        text: `找不到 ${stickerName} 该表情包，目前可用表情包如下:\n${stickerList}`,
      });
      return;
    }
    let entry = config[stickerName];
    await sendSticker({ entry, msg, trigger, isEat2 });
  }
};

const help_text =
  `表情包插件，智能缓存机制，首次使用自动下载配置\n` +
  `• eat - 获取表情包列表（优先使用缓存）\n` +
  `• eat set [url] - 强制更新配置（覆盖缓存）\n` +
  `• 回复消息 + eat &lt;名称&gt; - 发送指定表情包\n` +
  `• 回复消息 + eat - 随机发送表情包\n\n` +
  `若想实现定时更新表情包配置, 可安装并使用 <code>${mainPrefix}tpm i acron</code>  
每天2点自动更新 <code>eat</code> 的表情包配置(调用 <code>${mainPrefix}eat set</code> 命令)  

<pre>${mainPrefix}acron cmd 0 0 2 * * * me 定时更新表情包  
${mainPrefix}eat set</pre>  
`;

class EatPlugin extends Plugin {

  description: string = `${help_text}`;

  cleanup(): void {
    assetBufferCache.clear();
  }

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    eat: async (msg, trigger?: Api.Message) => {
      await fn(msg, trigger);
    },
    eat2: async (msg: Api.Message, trigger?: Api.Message) => {
      await fn(msg, trigger, true);
    },
  };

  // Panel Settings Adapter
  panelAdapter: PanelSettingsAdapter = {
    id: "eat",
    title: "吃表情",
    description: "吃表情配置",
    category: "插件配置",
    icon: "😋",
    getSchema: (): PanelSettingField[] => [
      {
            "key": "x",
            "label": "X 坐标偏移",
            "type": "number",
            "min": -100,
            "max": 100,
            "default": 0
      },
      {
            "key": "y",
            "label": "Y 坐标偏移",
            "type": "number",
            "min": -100,
            "max": 100,
            "default": 0
      },
      {
            "key": "mask",
            "label": "遮罩形状",
            "type": "string",
            "default": "circle"
      },
      {
            "key": "brightness",
            "label": "亮度",
            "type": "number",
            "min": 0,
            "max": 200,
            "default": 100
      },
      {
            "key": "rotate",
            "label": "旋转角度",
            "type": "number",
            "min": -360,
            "max": 360,
            "default": 0
      }
],
    getValues: async (): Promise<Record<string, unknown>> => {
      const db = await JSONFilePreset<RoleConfig>(path.join(createDirectoryInAssets("eat"), "config.json"), {} as any);
      return db.data as unknown as Record<string, unknown>;
    },
    setValues: async (patch: Record<string, unknown>): Promise<void> => {
      const db = await JSONFilePreset<RoleConfig>(path.join(createDirectoryInAssets("eat"), "config.json"), {} as any);
      Object.assign(db.data, patch);
      await db.write();
    },
  };
}

export default new EatPlugin();
