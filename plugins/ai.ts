import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { TelegramFormatter } from "@utils/telegramFormatter";
import { TelegraphFormatter } from "@utils/telegraphFormatter";
import { execFile } from "child_process";
import fs from "fs";
import * as path from "path";
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import sharp from "sharp";
import http from "http";
import https from "https";
import { promisify } from "util";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

interface ProviderConfig {
  tag: string;
  url: string;
  key: string;
  type?: ProviderType;
  stream: boolean;
  responses: boolean;
}

interface TelegraphItem {
  url: string;
  title: string;
  createdAt: string;
}

interface DB {
  configs: Record<string, ProviderConfig>;
  currentChatTag: string;
  currentChatModel: string;
  currentSearchTag: string;
  currentSearchModel: string;
  currentImageTag: string;
  currentImageModel: string;
  currentVideoTag: string;
  currentVideoModel: string;
  imagePreview: boolean;
  videoPreview: boolean;
  videoAudio: boolean;
  videoDuration: number;
  prompt: string;
  collapse: boolean;
  timeout: number;
  telegraphToken: string;
  telegraph: {
    enabled: boolean;
    limit: number;
    list: TelegraphItem[];
  };
}

type AIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface AIImage {
  data?: Buffer;
  url?: string;
  mimeType: string;
}

interface AIVideo {
  data?: Buffer;
  url?: string;
  mimeType: string;
}

type ResolvedImageData = {
  data: Buffer;
  mimeType: string;
};

interface AbortToken {
  readonly aborted: boolean;
  readonly reason?: string;
  readonly signal: AbortSignal;
  abort(reason?: string): void;
  throwIfAborted(): void;
}

interface FeatureHandler {
  readonly name: string;
  readonly command: string;
  readonly description: string;
  execute(msg: Api.Message, args: string[], prefixes: string[]): Promise<void>;
}

interface Middleware {
  process<T>(
    input: T,
    next: (input: T, token?: AbortToken) => Promise<any>,
    token?: AbortToken,
  ): Promise<any>;
}

const execFileAsync = promisify(execFile);

type AuthMode = "bearer" | "query-key";

type ProviderMode = "chat" | "search" | "image" | "video";

const PROVIDER_TYPES = [
  "openai-compatible",
  "openai",
  "gemini",
  "doubao",
  "moonshot",
  "local-cliproxy",
] as const;

type ProviderType = (typeof PROVIDER_TYPES)[number];
const PROVIDER_TYPE_OPTIONS = PROVIDER_TYPES.join("/");

type ProviderStrategy =
  | "openai-rest"
  | "gemini-rest"
  | "doubao-rest"
  | "gemini-image-rest"
  | "gemini-video-rest";

type ModelMatchRule = {
  type: "prefix" | "exact" | "includes" | "regex";
  value: string;
};

type ImageDefaults = {
  size?: string;
  quality?: string;
  responseFormat?: "b64_json" | "url";
  extraParams?: Record<string, any>;
};

type VideoDefaults = {
  responseFormat?: "b64_json" | "url";
  extraParams?: Record<string, any>;
};

type ProviderModelRule = {
  match: ModelMatchRule;
  override: Partial<ProviderModeConfig>;
};

type ProviderModeConfig = {
  strategy: ProviderStrategy;
  endpoint?: string;
  authMode?: AuthMode;
  baseUrlType?: "origin" | "openai" | "gemini" | "raw";
  imageDefaults?: ImageDefaults;
  videoDefaults?: VideoDefaults;
  imageUrlPolicy?: "any" | "data-only";
  supportsEdit?: boolean;
  modelRules?: ProviderModelRule[];
};

type ProviderProfile = {
  id: ProviderType;
  authMode?: AuthMode;
  modes: Partial<Record<ProviderMode, ProviderModeConfig>>;
};

type VideoImageMode = "auto" | "reference" | "first" | "firstlast";

type ChatContext = {
  providerConfig: ProviderConfig;
  model: string;
  config: DB;
  modeConfig: ProviderModeConfig;
  question: string;
  images: AIContentPart[];
  token?: AbortToken;
};

type ImageContext = {
  providerConfig: ProviderConfig;
  model: string;
  config: DB;
  modeConfig: ProviderModeConfig;
  prompt: string;
  image?: AIImage;
  token?: AbortToken;
};

type VideoContext = {
  providerConfig: ProviderConfig;
  model: string;
  config: DB;
  modeConfig: ProviderModeConfig;
  prompt: string;
  images: AIContentPart[];
  imageMode: VideoImageMode;
  token?: AbortToken;
};

type StrategyHandler = {
  chat?: (ctx: ChatContext) => Promise<{ text: string; images: AIImage[] }>;
  search?: (ctx: ChatContext) => Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
  }>;
  image?: (ctx: ImageContext) => Promise<AIImage[]>;
  video?: (ctx: VideoContext) => Promise<AIVideo[]>;
};

const DEFAULT_PROVIDER_TYPE: ProviderType = "openai";

const mapHostsToProviderType = (
  hostList: string[],
  providerType: ProviderType,
): Record<string, ProviderType> => {
  const out: Record<string, ProviderType> = {};
  for (const h of hostList) {
    const host = h.trim();
    if (!host) continue;
    out[host] = providerType;
  }
  return out;
};

const createProviderProfile = (
  id: ProviderType,
  options: Omit<ProviderProfile, "id">,
): ProviderProfile => ({
  id,
  ...options,
});

const createOpenAIProfile = (
  id: "openai-compatible" | "openai",
): ProviderProfile =>
  createProviderProfile(id, {
    authMode: "bearer",
    modes: {
      chat: { strategy: "openai-rest" },
      search: { strategy: "openai-rest" },
      image: { strategy: "openai-rest", supportsEdit: true },
      video: { strategy: "openai-rest", endpoint: "chat/completions" },
    },
  });

const PROVIDER_PROFILES: Record<ProviderType, ProviderProfile> = {
  "openai-compatible": createOpenAIProfile("openai-compatible"),
  openai: createOpenAIProfile("openai"),
  gemini: createProviderProfile("gemini", {
    authMode: "query-key",
    modes: {
      chat: { strategy: "gemini-rest" },
      search: { strategy: "gemini-rest" },
      image: { strategy: "gemini-rest" },
      video: {
        strategy: "gemini-video-rest",
        baseUrlType: "gemini",
        endpoint: "v1beta/models/{model}:generateVideos",
      },
    },
  }),
  doubao: createProviderProfile("doubao", {
    authMode: "bearer",
    modes: {
      chat: {
        strategy: "openai-rest",
        baseUrlType: "origin",
        endpoint: "api/v3/chat/completions",
        imageUrlPolicy: "data-only",
      },
      image: {
        strategy: "doubao-rest",
        baseUrlType: "origin",
        endpoint: "api/v3/images/generations",
        imageDefaults: {
          size: "2K",
          responseFormat: "url",
          extraParams: {
            sequential_image_generation: "disabled",
            watermark: true,
          },
        },
        supportsEdit: true,
      },
      video: {
        strategy: "doubao-rest",
        baseUrlType: "origin",
        endpoint: "api/v3/contents/generations/tasks",
        videoDefaults: {
          extraParams: {},
        },
      },
    },
  }),
  moonshot: createProviderProfile("moonshot", {
    authMode: "bearer",
    modes: {
      chat: { strategy: "openai-rest" },
    },
  }),
  "local-cliproxy": createProviderProfile("local-cliproxy", {
    authMode: "query-key",
    modes: {
      chat: { strategy: "openai-rest", baseUrlType: "openai" },
      search: {
        strategy: "openai-rest",
        baseUrlType: "openai",
        modelRules: [
          {
            match: { type: "includes", value: "gemini" },
            override: {
              strategy: "gemini-rest",
              baseUrlType: "gemini",
            },
          },
        ],
      },
      image: {
        strategy: "gemini-image-rest",
        baseUrlType: "gemini",
        endpoint: "models/{model}:generateContent",
        authMode: "query-key",
        supportsEdit: true,
      },
      video: {
        strategy: "openai-rest",
        baseUrlType: "openai",
        endpoint: "chat/completions",
      },
    },
  }),
};

const PROVIDER_HOST_TYPES: Record<string, ProviderType> = {
  "generativelanguage.googleapis.com": "gemini",
  "ark.cn-beijing.volces.com": "doubao",
  "api.openai.com": "openai",
  "api.moonshot.cn": "moonshot",
  ...mapHostsToProviderType(["127.0.0.1", "api.abjj.de"], "local-cliproxy"),
};

const DEFAULT_PROVIDER_PROFILE: ProviderProfile =
  PROVIDER_PROFILES[DEFAULT_PROVIDER_TYPE];

const getProviderHost = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const isProviderType = (value: string): value is ProviderType =>
  (PROVIDER_TYPES as readonly string[]).includes(value);

const normalizeProviderType = (value: unknown): ProviderType | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isProviderType(normalized) ? normalized : undefined;
};

const resolveProviderType = (
  providerConfig?: Pick<ProviderConfig, "url" | "type"> | null,
): ProviderType => {
  const configuredType = normalizeProviderType(providerConfig?.type);
  if (configuredType) return configuredType;
  const host = providerConfig?.url ? getProviderHost(providerConfig.url) : null;
  if (!host) return DEFAULT_PROVIDER_TYPE;
  return PROVIDER_HOST_TYPES[host] ?? DEFAULT_PROVIDER_TYPE;
};

const getProviderProfile = (
  providerConfig?: Pick<ProviderConfig, "url" | "type"> | null,
): ProviderProfile => PROVIDER_PROFILES[resolveProviderType(providerConfig)];

const isOpenAIProviderType = (providerType: ProviderType): boolean =>
  providerType === "openai" || providerType === "openai-compatible";

const formatProviderTypeLabel = (
  providerConfig: Pick<ProviderConfig, "url" | "type">,
): string => {
  const configuredType = normalizeProviderType(providerConfig.type);
  if (configuredType) return configuredType;
  return `auto -> ${resolveProviderType(providerConfig)}`;
};

const mergeDefaults = <T extends { extraParams?: Record<string, any> }>(
  a?: T,
  b?: T,
): T | undefined => {
  if (!a && !b) return undefined;
  return {
    ...(a || {}),
    ...(b || {}),
    extraParams: { ...(a?.extraParams || {}), ...(b?.extraParams || {}) },
  } as T;
};

const matchModelRule = (model: string, rule: ModelMatchRule): boolean => {
  if (!model) return false;
  if (rule.type === "exact") return model === rule.value;
  if (rule.type === "prefix") return model.startsWith(rule.value);
  if (rule.type === "includes") return model.includes(rule.value);
  if (rule.type === "regex") {
    try {
      return new RegExp(rule.value).test(model);
    } catch {
      return false;
    }
  }
  return false;
};

const resolveModeConfig = (
  profile: ProviderProfile,
  mode: ProviderMode,
  model: string,
): ProviderModeConfig | undefined => {
  const base = profile.modes[mode];
  if (!base) return undefined;
  const rules = base.modelRules || [];
  const matchedRule = rules.find((rule) => matchModelRule(model, rule.match));
  if (!matchedRule) return { ...base };
  const ruleOverrides = matchedRule.override || {};
  return {
    ...base,
    ...ruleOverrides,
    imageDefaults: mergeDefaults(
      base.imageDefaults,
      ruleOverrides.imageDefaults,
    ),
    videoDefaults: mergeDefaults(
      base.videoDefaults,
      ruleOverrides.videoDefaults,
    ),
  };
};

const resolveBaseUrl = (
  providerConfig: ProviderConfig,
  modeConfig: ProviderModeConfig,
): string => {
  const baseType = modeConfig.baseUrlType ?? "raw";
  if (baseType === "origin") {
    return new URL(providerConfig.url).origin;
  }
  if (baseType === "openai") {
    return normalizeOpenAIBaseUrl(providerConfig.url);
  }
  if (baseType === "gemini") {
    return normalizeGeminiBaseUrl(providerConfig.url);
  }
  return providerConfig.url;
};

const resolveEndpointUrl = (baseUrl: string, endpoint?: string): string => {
  if (!endpoint) return baseUrl;
  if (/^https?:\/\//.test(endpoint)) return endpoint;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const cleaned = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return new URL(cleaned, base).toString();
};

const resolveResponsesEndpointUrl = (
  providerConfig: ProviderConfig,
  modeConfig: ProviderModeConfig,
): string => {
  const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
  const currentUrl = modeConfig.endpoint
    ? resolveEndpointUrl(baseUrl, modeConfig.endpoint)
    : baseUrl;
  const responsesBaseUrl = normalizeOpenAIBaseUrl(currentUrl);
  return resolveEndpointUrl(responsesBaseUrl, "responses");
};

const getMessageText = (m?: Api.Message | null): string => {
  if (!m) return "";
  const text = (m as any).message ?? (m as any).text ?? "";
  return typeof text === "string" ? text : "";
};

const htmlEscape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const buildUserContent = (
  text: string,
  images: AIContentPart[],
): string | AIContentPart[] => {
  if (images.length === 0) return text;
  const parts: AIContentPart[] = [];
  if (text.trim()) parts.push({ type: "text", text });
  parts.push(...images);
  return parts;
};

const buildResponsesInputContent = (
  text: string,
  images: AIContentPart[],
): Array<
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
    }
> => {
  const parts: Array<
    | { type: "input_text"; text: string }
    | {
        type: "input_image";
        image_url: string;
      }
  > = [];

  if (text.trim()) {
    parts.push({ type: "input_text", text: text.trim() });
  }

  for (const part of images) {
    if (part.type !== "image_url") continue;
    parts.push({
      type: "input_image",
      image_url: part.image_url.url,
    });
  }

  return parts;
};

const extractErrorMessage = (error: any): string => {
  const msgText = typeof error?.message === "string" ? error.message : "";
  const reasonText =
    typeof error?.cause === "string"
      ? error.cause
      : error?.cause
        ? String(error.cause)
        : error?.config?.signal?.reason
          ? String(error.config.signal.reason)
          : "";

  if ((msgText + reasonText).includes("请求超时")) return "请求超时";
  if (error?.name === "AbortError" || msgText.toLowerCase().includes("aborted"))
    return "操作已取消";
  if (error?.code === "ECONNABORTED") return "请求超时";
  if (error?.response?.status === 429) return "请求过于频繁，请稍后重试";
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    msgText ||
    "未知错误"
  );
};

class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

const requireUser = (condition: any, message: string): void => {
  if (!condition) throw new UserError(message);
};

type ProcessingKind = "chat" | "search" | "image" | "video";

const PROCESSING_TEXT: Record<ProcessingKind, string> = {
  chat: "💬 <b>正在处理 chat 任务</b>",
  search: "🔎 <b>正在处理 search 任务</b>",
  image: "🖼️ <b>正在处理 image 任务</b>",
  video: "🎬 <b>正在处理 video 任务</b>",
};

const formatErrorForDisplay = (error: any): string => {
  if (
    error instanceof UserError ||
    error?.name === "AbortError" ||
    (typeof error?.message === "string" &&
      error.message.toLowerCase().includes("aborted"))
  ) {
    const extracted = extractErrorMessage(error);
    if (extracted === "请求超时") return `❌ <b>错误:</b> 请求超时`;
    const msg = error instanceof UserError ? error.message : "操作已取消";
    return `🚫 ${msg}`;
  }
  return `❌ <b>错误:</b> ${extractErrorMessage(error)}`;
};

const sendProcessing = async (
  msg: Api.Message,
  kind: ProcessingKind,
): Promise<void> => {
  await MessageSender.sendOrEdit(msg, PROCESSING_TEXT[kind], {
    parseMode: "html",
  });
};

const sendErrorMessage = async (
  msg: Api.Message,
  error: any,
  trigger?: Api.Message,
): Promise<void> => {
  await MessageSender.sendOrEdit(trigger || msg, formatErrorForDisplay(error), {
    parseMode: "html",
  });
};

const parseDataUrl = (
  url: string,
): { mimeType: string; data: Buffer } | null => {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: Buffer.from(match[2], "base64") };
};

const normalizeDownloadedMedia = async (
  downloaded: any,
): Promise<Buffer | null> => {
  if (!downloaded) return null;
  if (Buffer.isBuffer(downloaded)) return downloaded;
  if (typeof downloaded === "string" && downloaded.length > 0) {
    try {
      const stat = await fs.promises.stat(downloaded);
      if (!stat.isFile()) return null;
      return await fs.promises.readFile(downloaded);
    } catch {
      return null;
    }
  }
  return null;
};

const getImageExtensionForMime = (mimeType: string): string => {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
};

const extractFirstFrame = async (buffer: Buffer): Promise<Buffer | null> => {
  try {
    return await sharp(buffer, { animated: true }).png().toBuffer();
  } catch {
    return null;
  }
};

const getDocumentThumb = (doc: Api.Document): Api.TypePhotoSize | undefined => {
  const thumbs = doc.thumbs || [];
  if (thumbs.length === 0) return undefined;
  return thumbs[thumbs.length - 1];
};

const resolveImageInputs = async (
  parts: AIContentPart[],
  httpClient: HttpClient,
  token?: AbortToken,
  options?: { allowFailures?: boolean },
): Promise<ResolvedImageData[]> => {
  const resolved: ResolvedImageData[] = [];
  const allowFailures = options?.allowFailures ?? false;
  for (const part of parts) {
    if (part.type !== "image_url") continue;
    const dataUrl = parseDataUrl(part.image_url.url);
    if (dataUrl) {
      resolved.push({ data: dataUrl.data, mimeType: dataUrl.mimeType });
      if (!allowFailures) break;
      continue;
    }
    try {
      const image = await resolveAIImageData(
        { url: part.image_url.url, mimeType: "image/jpeg" },
        httpClient,
        token,
      );
      if (image?.data) {
        resolved.push({ data: image.data, mimeType: image.mimeType });
        if (!allowFailures) break;
      }
    } catch (error) {
      if (!allowFailures) throw error;
    }
  }
  return resolved;
};

const resolveImagePart = async (
  parts: AIContentPart[],
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<AIImage | null> => {
  const resolved = await resolveImageInputs(parts, httpClient, token, {
    allowFailures: false,
  });
  if (!resolved.length) return null;
  return { data: resolved[0].data, mimeType: resolved[0].mimeType };
};

const collectImagePartsFromSingleMessage = async (
  msg: Api.Message,
  out: AIContentPart[],
): Promise<void> => {
  if (!msg.media || !msg.client) return;

  if (msg.media instanceof Api.MessageMediaPhoto) {
    const downloaded = await msg.client.downloadMedia(msg);
    const buffer = await normalizeDownloadedMedia(downloaded);
    if (!buffer) return;
    const dataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    out.push({ type: "image_url", image_url: { url: dataUrl } });
    return;
  }

  if (
    msg.media instanceof Api.MessageMediaDocument &&
    msg.media.document instanceof Api.Document
  ) {
    const doc = msg.media.document;
    const docMime = doc.mimeType || "";
    const isAnimated =
      docMime === "image/gif" ||
      docMime === "video/webm" ||
      docMime === "application/x-tgsticker" ||
      docMime === "application/x-tg-sticker" ||
      doc.attributes?.some(
        (attr) => attr instanceof Api.DocumentAttributeAnimated,
      );

    const thumb = getDocumentThumb(doc);

    if (!isAnimated && docMime.startsWith("image/")) {
      const downloaded = await msg.client.downloadMedia(msg);
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (!buffer) return;
      const dataUrl = `data:${docMime};base64,${buffer.toString("base64")}`;
      out.push({ type: "image_url", image_url: { url: dataUrl } });
      return;
    }

    let frameBuffer: Buffer | null = null;

    if (thumb) {
      const downloaded = await msg.client.downloadMedia(msg, { thumb });
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (buffer) {
        try {
          frameBuffer = await sharp(buffer).png().toBuffer();
        } catch {
          frameBuffer = buffer;
        }
      }
    }

    if (!frameBuffer) {
      const downloaded = await msg.client.downloadMedia(msg);
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (buffer) {
        try {
          frameBuffer = await extractFirstFrame(buffer);
        } catch {
          frameBuffer = null;
        }
      }
    }

    if (!frameBuffer) return;

    const dataUrl = `data:image/png;base64,${frameBuffer.toString("base64")}`;
    out.push({ type: "image_url", image_url: { url: dataUrl } });
  }
};

const getMessageImageParts = async (
  msg?: Api.Message,
): Promise<AIContentPart[]> => {
  if (!msg?.client) return [];

  const parts: AIContentPart[] = [];

  const rawGroupedId = (msg as any).groupedId;
  const groupedId = rawGroupedId ? rawGroupedId.toString() : undefined;

  if (!groupedId) {
    await collectImagePartsFromSingleMessage(msg, parts);
    return parts;
  }

  const peer = msg.chatId || msg.peerId;
  const sameGroupMessages: Api.Message[] = [];

  for await (const m of msg.client.iterMessages(peer, { limit: 50 })) {
    if (!(m instanceof Api.Message)) continue;

    const g = (m as any).groupedId;
    if (!g) continue;

    if (g.toString() !== groupedId) continue;

    sameGroupMessages.push(m);
  }

  sameGroupMessages.sort((a, b) => Number(a.id) - Number(b.id));

  for (const m of sameGroupMessages) {
    await collectImagePartsFromSingleMessage(m, parts);
  }

  return parts;
};

const getGroupedMessageIds = async (msg: Api.Message): Promise<number[]> => {
  if (!msg?.client) return [];
  const rawGroupedId = (msg as any).groupedId;
  const groupedId = rawGroupedId ? rawGroupedId.toString() : undefined;
  if (!groupedId) return [];

  const peer = msg.chatId || msg.peerId;
  const ids: number[] = [];

  for await (const m of msg.client.iterMessages(peer, { limit: 50 })) {
    if (!(m instanceof Api.Message)) continue;
    const g = (m as any).groupedId;
    if (!g) continue;
    if (g.toString() !== groupedId) continue;
    ids.push(Number(m.id));
  }

  if (!ids.includes(Number(msg.id))) ids.push(Number(msg.id));

  return Array.from(new Set(ids)).sort((a, b) => a - b);
};

const deleteMessageOrGroup = async (msg: Api.Message): Promise<void> => {
  try {
    if (!msg?.client) return;
    const peer = msg.chatId || msg.peerId;
    const ids = await getGroupedMessageIds(msg);

    if (ids.length > 1) {
      await msg.client.deleteMessages(peer, ids, { revoke: true });
      return;
    }
    await msg.delete();
  } catch {}
};

const getHeaderContentType = (headers: unknown): string | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  const contentType = (headers as Record<string, unknown>)["content-type"];
  if (typeof contentType === "string") {
    return contentType.split(";")[0];
  }
  if (Array.isArray(contentType)) {
    const first = contentType.find((value) => typeof value === "string");
    if (typeof first === "string") {
      return first.split(";")[0];
    }
  }
  return undefined;
};

const resolveAIImageData = async (
  image: AIImage,
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<AIImage | null> => {
  if (image.data) return image;
  if (!image.url) return null;
  const response = await httpClient.request(
    {
      url: image.url,
      method: "GET",
      responseType: "arraybuffer",
    },
    token,
  );
  const contentType =
    getHeaderContentType(response.headers) ||
    image.mimeType ||
    "image/jpeg";
  return { data: Buffer.from(response.data), mimeType: contentType };
};

const getVideoExtensionForMime = (mimeType: string): string => {
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  return ".mp4";
};

const resolveAIVideoData = async (
  video: AIVideo,
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<AIVideo | null> => {
  if (video.data) return video;
  if (!video.url) return null;
  const response = await httpClient.request(
    {
      url: video.url,
      method: "GET",
      responseType: "arraybuffer",
    },
    token,
  );
  const contentType =
    getHeaderContentType(response.headers) ||
    video.mimeType ||
    "video/mp4";
  return { data: Buffer.from(response.data), mimeType: contentType };
};

const videoHasAudioTrack = async (filePath: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-select_streams",
      "a:0",
      "-of",
      "json",
      filePath,
    ]);

    const info = JSON.parse(stdout);
    const streams = info.streams || [];
    return streams.length > 0;
  } catch {
    return false;
  }
};

const ensureVideoHasAudio = async (
  inputPath: string,
  outputPath: string,
): Promise<string> => {
  try {
    const hasAudio = await videoHasAudioTrack(inputPath);
    if (hasAudio) {
      return inputPath;
    }

    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v",
      "copy",
      "-shortest",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputPath,
    ]);

    return outputPath;
  } catch {
    return inputPath;
  }
};

const createAbortToken = (): AbortToken => {
  const controller = new AbortController();
  return {
    get aborted() {
      return controller.signal.aborted;
    },
    get reason() {
      return controller.signal.reason?.toString();
    },
    get signal() {
      return controller.signal;
    },
    abort(reason?: string) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    throwIfAborted() {
      if (controller.signal.aborted) {
        throw new UserError(
          controller.signal.reason?.toString() || "操作已取消",
        );
      }
    },
  };
};

const sleep = (ms: number, token?: AbortToken): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    token?.throwIfAborted();
    let settled = false;
    const cleanup = () => {
      if (!token?.signal) return;
      token.signal.removeEventListener("abort", abortHandler);
    };
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      reject(new UserError(token?.reason?.toString() || "操作已取消"));
    };
    if (token?.signal)
      token.signal.addEventListener("abort", abortHandler, { once: true });
  });
};

const retryWithFixedDelay = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 2,
  delayMs: number = 1000,
  token?: AbortToken,
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    token?.throwIfAborted();
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (token?.aborted) throw error;
      if (!isRetryableError(error)) throw error;
      if (i === maxRetries - 1) break;
      await sleep(delayMs, token);
    }
  }
  throw lastError;
};

const isRetryableError = (error: any): boolean => {
  if (!error) return false;
  if (error.name === "AbortError") return false;
  if (
    typeof error.message === "string" &&
    error.message.toLowerCase().includes("aborted")
  )
    return false;

  const status = error.response?.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }

  if (error.isAxiosError && !error.response) return true;
  if (typeof error.code === "string") return true;

  return false;
};

type TaskStatus = "pending" | "running" | "succeeded" | "failed";

interface TaskPollResult<T> {
  status: TaskStatus;
  result?: T;
  errorMessage?: string;
}

interface TaskPollOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

type TaskFetchFn = (token?: AbortToken) => Promise<any>;
type TaskParseFn<T> = (data: any) => TaskPollResult<T>;

const pollTask = async <T>(
  fetchJob: TaskFetchFn,
  parseResult: TaskParseFn<T>,
  options: TaskPollOptions = {},
  token?: AbortToken,
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 303;
  const intervalMs = options.intervalMs ?? 2000;

  for (let i = 0; i < maxAttempts; i++) {
    token?.throwIfAborted();

    const data = await retryWithFixedDelay(
      () => fetchJob(token),
      2,
      1000,
      token,
    );
    const result = parseResult(data);

    if (result.status === "failed") {
      throw new Error(result.errorMessage || "任务执行失败");
    }

    if (result.status === "succeeded") {
      if (result.result === undefined) {
        throw new Error("任务成功但未返回结果");
      }
      return result.result;
    }

    await sleep(intervalMs, token);
  }

  throw new Error("任务执行超时");
};

interface MessageOptions {
  parseMode?: string;
  linkPreview?: boolean;
}

const getEditErrorText = (error: any): string => {
  const parts = [
    typeof error?.errorMessage === "string" ? error.errorMessage : "",
    typeof error?.message === "string" ? error.message : "",
  ].filter(Boolean);
  return parts.join(" ");
};

const isMessageNotModifiedError = (error: any): boolean =>
  getEditErrorText(error).includes("MESSAGE_NOT_MODIFIED");

const shouldFallbackToReplyOnEditError = (error: any): boolean => {
  const text = getEditErrorText(error);
  return (
    text.includes("MESSAGE_ID_INVALID") ||
    text.includes("MESSAGE_AUTHOR_REQUIRED")
  );
};

const getTopicRootId = (msg: Api.Message): number | undefined => {
  const typedMsg = msg as Api.Message & {
    replyTo?: { replyToTopId?: number; replyToMsgId?: number };
    replyToMsgId?: number;
  };
  return typedMsg.replyTo?.replyToTopId ?? typedMsg.replyTo?.replyToMsgId ?? typedMsg.replyToMsgId;
};

class MessageSender {
  static async sendOrEdit(
    msg: Api.Message,
    text: string,
    options?: MessageOptions,
  ): Promise<Api.Message> {
    try {
      const edited = await msg.edit({ text, ...options });
      if (edited) return edited;
    } catch (error: any) {
      if (isMessageNotModifiedError(error)) {
        return msg;
      }
      if (shouldFallbackToReplyOnEditError(error)) {
        const replied = await msg.reply({ message: text, ...options });
        if (replied) return replied;
      }
      throw error;
    }

    const replied = await msg.reply({ message: text, ...options });
    if (replied) return replied;
    throw new Error("消息发送失败");
  }

  static async sendNew(
    msg: Api.Message,
    text: string,
    options?: MessageOptions,
    replyToId?: number,
  ): Promise<Api.Message> {
    if (!msg.client) {
      throw new Error("客户端未初始化");
    }

    const topicRootId = getTopicRootId(msg);
    const replyTo = replyToId ?? topicRootId;
    return await msg.client.sendMessage(msg.chatId || msg.peerId, {
      message: text,
      ...(options || {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }
}

class MessageUtils {
  private configManagerPromise: Promise<ConfigManager>;
  private httpClient: HttpClient;
  private telegraphTokenPromise: Promise<string> | null = null;

  constructor(
    configManagerPromise: Promise<ConfigManager>,
    httpClient: HttpClient,
  ) {
    this.configManagerPromise = configManagerPromise;
    this.httpClient = httpClient;
  }

  async createTelegraphPage(
    markdown: string,
    titleSource?: string,
    token?: AbortToken,
  ): Promise<TelegraphItem> {
    const configManager = await this.configManagerPromise;
    const config = configManager.getConfig();

    const tgToken = await this.ensureTGToken(config, token);
    const rawTitle = (titleSource || "").replace(/\s+/g, " ").trim();
    const shortTitle =
      rawTitle.length > 24 ? `${rawTitle.slice(0, 24)}…` : rawTitle;
    const title = shortTitle || `Telegraph - ${new Date().toLocaleString()}`;
    const nodes = TelegraphFormatter.toNodes(markdown);

    const response = await this.httpClient.request(
      {
        url: "https://api.telegra.ph/createPage",
        method: "POST",
        data: {
          access_token: tgToken,
          title,
          content: nodes,
          return_content: false,
        },
      },
      token,
    );

    const url = response.data?.result?.url;
    if (!url) throw new Error(response.data?.error || "Telegraph 页面创建失败");

    return { url, title, createdAt: new Date().toISOString() };
  }

  async sendLongMessage(
    msg: Api.Message,
    text: string,
    replyToId?: number,
    token?: AbortToken,
    options?: { poweredByTag?: string },
  ): Promise<Api.Message> {
    token?.throwIfAborted();

    const configManager = await this.configManagerPromise;
    const config = configManager.getConfig();

    const poweredByTag = (options?.poweredByTag ?? config.currentChatTag) || "";
    const poweredByText = poweredByTag
      ? `<br><i>🍀Powered by ${poweredByTag}</i>`
      : "";

    if (text.length <= 4050) {
      token?.throwIfAborted();

      const parts = text.split(/(?=A:\n)/);
      if (parts.length === 2) {
        const questionPart = parts[0];
        const answerPart = parts[1];
        const cleanAnswer = answerPart.replace(/^A:\n/, "");
        const cleanQuestion = questionPart
          .replace(/^Q:\n/, "")
          .replace(/\n\n$/, "");
        const questionBlock = `Q:<br>${this.wrapHtmlWithCollapseIfNeeded(cleanQuestion, config.collapse)}<br>`;
        const answerBlock = `A:<br>${this.wrapHtmlWithCollapseIfNeeded(cleanAnswer, config.collapse)}`;
        const finalText = questionBlock + answerBlock + poweredByText;

        return await this.sendHtml(msg, finalText, replyToId, false);
      }
      const finalText =
        this.wrapHtmlWithCollapseIfNeeded(text, config.collapse) +
        poweredByText;
      return await this.sendHtml(msg, finalText, replyToId, false);
    }

    const qa = text.match(/Q:\n([\s\S]+?)\n\nA:\n([\s\S]+)/);
    if (!qa) {
      token?.throwIfAborted();
      const finalText =
        this.wrapHtmlWithCollapseIfNeeded(text, config.collapse) +
        poweredByText;
      return await this.sendHtml(msg, finalText, replyToId, false);
    }

    const [, question, answer] = qa;
    const answerText = answer.replace(/^A:\n/, "");
    const chunks: string[] = [];
    let current = "";

    for (const line of answerText.split("\n")) {
      token?.throwIfAborted();
      const testLength = (current + line + "<br>").length;
      if (testLength > 4050 && current) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? "<br>" : "") + line;
      }
    }
    if (current) chunks.push(current);

    token?.throwIfAborted();

    const firstMessageContent =
      `Q:<br>${this.wrapHtmlWithCollapseIfNeeded(question, config.collapse)}<br>` +
      `A:<br>${this.wrapHtmlWithCollapseIfNeeded(chunks[0], config.collapse)}`;

    const firstMessage = await this.sendHtml(
      msg,
      firstMessageContent,
      replyToId,
    );

    for (let idx = 1; idx < chunks.length; idx++) {
      if (token?.aborted) break;
      await sleep(500, token);
      if (token?.aborted) break;

      const isLast = idx === chunks.length - 1;
      const wrapped = this.wrapHtmlWithCollapseIfNeeded(
        chunks[idx],
        config.collapse,
      );
      const prefix = `📋 <b>续 (${idx}/${chunks.length - 1}):</b><br><br>`;
      const finalMessage = prefix + wrapped + (isLast ? poweredByText : "");

      await this.sendHtml(msg, finalMessage, firstMessage.id, false);
    }

    return firstMessage;
  }

  async sendImages(
    msg: Api.Message,
    images: AIImage[],
    prompt: string,
    replyToId?: number,
    token?: AbortToken,
  ): Promise<void> {
    const config = (await this.configManagerPromise).getConfig();
    await this.sendMedia(msg, images, prompt, replyToId, token, {
      previewEnabled: config.imagePreview,
      poweredByTag: config.currentImageTag,
      collapse: config.collapse,
      directory: "ai_images",
      filePrefix: "ai",
      getExtension: getImageExtensionForMime,
      resolve: (image, mediaToken) =>
        resolveAIImageData(image, this.httpClient, mediaToken),
    });
  }

  async sendVideos(
    msg: Api.Message,
    videos: AIVideo[],
    prompt: string,
    replyToId?: number,
    token?: AbortToken,
  ): Promise<void> {
    const config = (await this.configManagerPromise).getConfig();
    await this.sendMedia(msg, videos, prompt, replyToId, token, {
      previewEnabled: config.videoPreview,
      poweredByTag: config.currentVideoTag,
      collapse: config.collapse,
      directory: "ai_videos",
      filePrefix: "ai_video",
      rawFilePrefix: "ai_video_raw",
      getExtension: getVideoExtensionForMime,
      resolve: (video, mediaToken) =>
        resolveAIVideoData(video, this.httpClient, mediaToken),
      prepareForSend: (rawPath, finalPath) =>
        ensureVideoHasAudio(rawPath, finalPath),
    });
  }

  private async sendMedia<T extends AIImage | AIVideo>(
    msg: Api.Message,
    mediaItems: T[],
    prompt: string,
    replyToId: number | undefined,
    token: AbortToken | undefined,
    options: {
      previewEnabled: boolean;
      poweredByTag: string;
      collapse: boolean;
      directory: string;
      filePrefix: string;
      rawFilePrefix?: string;
      getExtension: (mimeType: string) => string;
      resolve: (
        item: T,
        mediaToken?: AbortToken,
      ) => Promise<{ data?: Buffer; mimeType: string } | null>;
      prepareForSend?: (rawPath: string, finalPath: string) => Promise<string>;
    },
  ): Promise<void> {
    if (!mediaItems.length) return;

    const peerId = msg.chatId || msg.peerId;
    const promptText = htmlEscape(prompt);
    const promptBlock = options.collapse
      ? `<blockquote expandable>${promptText}</blockquote>`
      : promptText;
    const poweredByText = `<br><i>🍀Powered by ${options.poweredByTag}</i>`;
    const caption = promptBlock + poweredByText;
    const mediaDir = createDirectoryInAssets(options.directory);
    const timestamp = Date.now();

    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      token?.throwIfAborted();

      const resolved = await options.resolve(item, token);
      if (!resolved?.data) continue;

      const extension = options.getExtension(resolved.mimeType);
      const rawPrefix = options.rawFilePrefix ?? options.filePrefix;
      const rawName = `${rawPrefix}_${timestamp}_${i}${extension}`;
      const finalName = `${options.filePrefix}_${timestamp}_${i}${extension}`;
      const rawPath = path.join(mediaDir, rawName);
      const finalPath = path.join(mediaDir, finalName);

      try {
        await fs.promises.writeFile(rawPath, resolved.data);
        const pathToSend = options.prepareForSend
          ? await options.prepareForSend(rawPath, finalPath)
          : rawPath;

        if (!msg.client) {
          throw new Error("客户端未初始化");
        }

        const topicRootId = getTopicRootId(msg);
        const replyTo = replyToId ?? topicRootId;
        await msg.client.sendFile(peerId, {
          file: pathToSend,
          forceDocument: !options.previewEnabled,
          caption,
          parseMode: "html",
          ...(replyTo ? { replyTo } : {}),
        });
      } finally {
        const cleanupTargets = options.prepareForSend
          ? [rawPath, finalPath]
          : [rawPath];
        for (const p of cleanupTargets) {
          fs.unlink(p, () => {});
        }
      }
    }
  }

  private async ensureTGToken(config: DB, token?: AbortToken): Promise<string> {
    if (config.telegraphToken) return config.telegraphToken;
    if (this.telegraphTokenPromise) return this.telegraphTokenPromise;

    this.telegraphTokenPromise = (async () => {
      const response = await this.httpClient.request(
        {
          url: "https://api.telegra.ph/createAccount",
          method: "POST",
          data: { short_name: "TeleBoxAI", author_name: "TeleBox" },
        },
        token,
      );

      const tgToken = response.data?.result?.access_token;
      if (!tgToken) throw new Error("Telegraph 账户创建失败");

      const configManager = await this.configManagerPromise;
      await configManager.updateConfig((cfg) => {
        cfg.telegraphToken = tgToken;
      });

      return tgToken;
    })();

    try {
      return await this.telegraphTokenPromise;
    } finally {
      this.telegraphTokenPromise = null;
    }
  }

  private wrapHtmlWithCollapseIfNeeded(
    html: string,
    collapse: boolean,
  ): string {
    return collapse ? `<blockquote expandable>${html}</blockquote>` : html;
  }

  private async sendHtml(
    msg: Api.Message,
    html: string,
    replyToId?: number,
    linkPreview?: boolean,
  ): Promise<Api.Message> {
    return await MessageSender.sendNew(
      msg,
      html,
      {
        parseMode: "html",
        ...(linkPreview === undefined ? {} : { linkPreview }),
      },
      replyToId,
    );
  }
}

interface ConfigChangeListener {
  onConfigChanged(config: DB): void | Promise<void>;
}

class ConfigManager {
  private static instancePromise: Promise<ConfigManager> | null = null;
  private listeners: ConfigChangeListener[] = [];
  private currentConfig: DB;
  private db: Low<DB> | null = null;
  private baseDir: string = "";
  private file: string = "";

  private writeQueue: Promise<void> = Promise.resolve();

  private constructor() {
    this.currentConfig = this.getDefaultConfig();
  }

  private getDefaultConfig(): DB {
    return {
      configs: {},
      currentChatTag: "",
      currentChatModel: "",
      currentSearchTag: "",
      currentSearchModel: "",
      currentImageTag: "",
      currentImageModel: "",
      currentVideoTag: "",
      currentVideoModel: "",
      imagePreview: true,
      videoPreview: true,
      videoAudio: false,
      videoDuration: 5,
      prompt: "",
      collapse: true,
      timeout: 30,
      telegraphToken: "",
      telegraph: { enabled: false, limit: 5, list: [] },
    };
  }

  static getInstance(): Promise<ConfigManager> {
    if (ConfigManager.instancePromise) {
      return ConfigManager.instancePromise;
    }

    ConfigManager.instancePromise = (async () => {
      const instance = new ConfigManager();
      await instance.init();
      return instance;
    })();

    return ConfigManager.instancePromise;
  }

  private async init(): Promise<void> {
    if (this.db) return;

    this.baseDir = createDirectoryInAssets("ai");
    this.file = path.join(this.baseDir, "config.json");
    this.db = await JSONFilePreset<DB>(this.file, this.getDefaultConfig());

    await this.writeQueue;
    await this.db.read();
    this.currentConfig = { ...this.db.data };
    const before = JSON.stringify(this.currentConfig);
    this.ensureDefaults();
    const after = JSON.stringify(this.currentConfig);
    if (before !== after) {
      this.db.data = { ...this.currentConfig };
      await this.db.write();
    }
  }

  getConfig(): DB {
    return { ...this.currentConfig };
  }

  async updateConfig(updater: (config: DB) => void): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const oldSnapshot: DB = JSON.parse(JSON.stringify(this.currentConfig));
      updater(this.currentConfig);

      const hasChanged =
        JSON.stringify(oldSnapshot) !== JSON.stringify(this.currentConfig);

      if (!hasChanged) {
        return;
      }

      if (this.db) {
        this.db.data = { ...this.currentConfig };
        await this.db.write();
      }
      await this.notifyListeners(this.currentConfig);
    }).catch((err: unknown) => {
      console.error("[ai] writeQueue error:", err);
    });
    return this.writeQueue;
  }

  registerListener(listener: ConfigChangeListener): void {
    this.listeners.push(listener);
  }

  unregisterListener(listener: ConfigChangeListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx > -1) this.listeners.splice(idx, 1);
  }

  async destroy(): Promise<void> {
    this.listeners = [];
    ConfigManager.instancePromise = null;
    this.db = null;
  }

  private ensureDefaults(): void {
    const cfg = this.currentConfig;

    if (!cfg.configs || typeof cfg.configs !== "object") {
      cfg.configs = {};
    } else {
      for (const provider of Object.values(cfg.configs)) {
        provider.type = normalizeProviderType(provider.type);
        if (typeof provider.stream !== "boolean") provider.stream = false;
        if (typeof provider.responses !== "boolean") provider.responses = false;
      }
    }

    if (!cfg.currentSearchTag && cfg.currentChatTag)
      cfg.currentSearchTag = cfg.currentChatTag;
    if (!cfg.currentSearchModel && cfg.currentChatModel)
      cfg.currentSearchModel = cfg.currentChatModel;
    if (!cfg.currentImageTag && cfg.currentChatTag)
      cfg.currentImageTag = cfg.currentChatTag;
    if (!cfg.currentImageModel && cfg.currentChatModel)
      cfg.currentImageModel = cfg.currentChatModel;
    if (!cfg.currentVideoTag && cfg.currentChatTag)
      cfg.currentVideoTag = cfg.currentChatTag;
    if (!cfg.currentVideoModel && cfg.currentChatModel)
      cfg.currentVideoModel = cfg.currentChatModel;

    if (typeof cfg.imagePreview !== "boolean") cfg.imagePreview = true;
    if (typeof cfg.videoPreview !== "boolean") cfg.videoPreview = true;
    if (typeof cfg.videoAudio !== "boolean") cfg.videoAudio = false;
    if (
      typeof cfg.videoDuration !== "number" ||
      !Number.isFinite(cfg.videoDuration)
    )
      cfg.videoDuration = 5;
    if (cfg.videoDuration < 5 || cfg.videoDuration > 20) cfg.videoDuration = 5;
    if (typeof cfg.collapse !== "boolean") cfg.collapse = true;
    if (
      typeof cfg.timeout !== "number" ||
      !Number.isFinite(cfg.timeout) ||
      cfg.timeout <= 0
    ) {
      cfg.timeout = 30;
    }

    if (!cfg.telegraph || typeof cfg.telegraph !== "object") {
      cfg.telegraph = { enabled: false, limit: 5, list: [] };
    } else {
      if (typeof cfg.telegraph.enabled !== "boolean")
        cfg.telegraph.enabled = false;
      if (typeof cfg.telegraph.limit !== "number" || cfg.telegraph.limit <= 0)
        cfg.telegraph.limit = 5;
      if (!Array.isArray(cfg.telegraph.list)) {
        cfg.telegraph.list = [];
      } else {
        cfg.telegraph.list = cfg.telegraph.list.filter(
          (item): item is TelegraphItem =>
            !!item &&
            typeof item.url === "string" &&
            typeof item.title === "string" &&
            typeof item.createdAt === "string",
        );
      }
    }
  }

  private async notifyListeners(newConfig: DB): Promise<void> {
    for (const listener of this.listeners)
      await listener.onConfigChanged(newConfig);
  }
}

const resolveAuthMode = (
  profile: ProviderProfile,
  modeConfig: ProviderModeConfig,
  config?: ProviderConfig,
): AuthMode => {
  if (modeConfig.authMode) return modeConfig.authMode;
  if (profile.authMode) return profile.authMode;
  if (config && resolveProviderType(config) === "gemini") return "query-key";
  return "bearer";
};

const applyAuthConfig = (
  authMode: AuthMode,
  config: ProviderConfig,
  url: string,
  headers: Record<string, string>,
): { url: string; headers: Record<string, string> } => {
  if (authMode === "query-key") {
    try {
      const u = new URL(url);
      if (!u.searchParams.has("key")) u.searchParams.set("key", config.key);
      return { url: u.toString(), headers };
    } catch {
      return { url, headers };
    }
  }
  return {
    url,
    headers: {
      ...headers,
      Authorization: `Bearer ${config.key}`,
    },
  };
};

const normalizeOpenAIBaseUrl = (url: string): string => {
  try {
    const u = new URL(url);

    if (u.hostname.includes("gateway.ai.cloudflare.com")) {
      const openAiIndex = u.pathname.indexOf("/openai");
      if (openAiIndex >= 0) {
        u.pathname = u.pathname.slice(0, openAiIndex + "/openai".length);
      }
      u.search = "";
      return u.toString();
    }

    const stripSuffixes = [
      "/chat/completions",
      "/completions",
      "/responses",
      "/messages",
      "/images/generations",
    ];
    for (const s of stripSuffixes) {
      if (u.pathname.endsWith(s)) {
        u.pathname = u.pathname.slice(0, -s.length);
        break;
      }
    }

    const apiV1Index = u.pathname.indexOf("/api/v1");
    if (apiV1Index >= 0) {
      u.pathname = u.pathname.slice(0, apiV1Index + "/api/v1".length);
      u.search = "";
      return u.toString();
    }

    const v1Index = u.pathname.indexOf("/v1");
    if (v1Index >= 0) {
      u.pathname = u.pathname.slice(0, v1Index + "/v1".length);
      u.search = "";
      return u.toString();
    }

    u.pathname = "/v1";
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
};

const normalizeGeminiBaseUrl = (url: string): string => {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/+$/, "");
    if (u.pathname === "" || u.pathname === "/") {
      u.pathname = "/v1beta";
    }
    if (!u.pathname.startsWith("/v1beta")) {
      u.pathname = "/v1beta";
    }
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
};

const parseOpenAIChatResponse = (
  data: any,
): { text: string; images: AIImage[] } => {
  const parseContent = (content: any): { text: string; images: AIImage[] } => {
    if (typeof content === "string") {
      return { text: content || "AI 回复为空", images: [] };
    }

    const parts = Array.isArray(content)
      ? content
      : content && typeof content === "object"
        ? [content]
        : [];

    if (parts.length === 0) return { text: "AI 回复为空", images: [] };

    const textSegments: string[] = [];
    const images: AIImage[] = [];
    for (const part of parts) {
      if (
        (part.type === "text" || part.type === "output_text") &&
        typeof part.text === "string"
      ) {
        textSegments.push(part.text);
      }
      if (part.type === "image_url" && part.image_url?.url) {
        const dataUrl = parseDataUrl(part.image_url.url);
        if (dataUrl)
          images.push({ data: dataUrl.data, mimeType: dataUrl.mimeType });
        else images.push({ url: part.image_url.url, mimeType: "image/jpeg" });
      }
    }

    return {
      text: textSegments.join("<br>").trim() || "AI 回复为空",
      images,
    };
  };

  const message = data?.choices?.[0]?.message;
  if (!message) return { text: "AI 回复为空", images: [] };
  return parseContent(message.content);
};

const parseOpenAIStyleImageResponse = (data: any): AIImage[] => {
  const images: AIImage[] = [];
  const list = data?.data || [];
  for (const item of list) {
    if (item?.b64_json) {
      images.push({
        data: Buffer.from(item.b64_json, "base64"),
        mimeType: "image/png",
      });
    } else if (item?.url) {
      images.push({ url: item.url, mimeType: "image/png" });
    }
  }
  return images;
};

const isAsyncIterable = (value: any): value is AsyncIterable<any> =>
  !!value && typeof value[Symbol.asyncIterator] === "function";

const readResponseBodyAsText = async (data: any): Promise<string> => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (!isAsyncIterable(data)) return "";

  let body = "";
  for await (const chunk of data) {
    if (typeof chunk === "string") {
      body += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      body += chunk.toString("utf8");
    } else if (chunk instanceof Uint8Array) {
      body += Buffer.from(chunk).toString("utf8");
    } else if (chunk !== undefined && chunk !== null) {
      body += String(chunk);
    }
  }

  return body;
};

const collectOpenAISources = (
  data: any,
): Array<{ url: string; title?: string }> => {
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();

  const appendEntries = (entries: any[] | undefined, isAnnotation = false) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const url = isAnnotation
        ? entry?.url_citation?.url || entry?.url
        : entry?.url;
      const title = isAnnotation
        ? entry?.url_citation?.title || entry?.title
        : entry?.title;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title });
    }
  };

  const choice = data?.choices?.[0];

  appendEntries(data?.citations);
  appendEntries(choice?.citations);
  appendEntries(choice?.message?.citations);
  appendEntries(choice?.delta?.citations);

  appendEntries(
    (data?.annotations || []).filter(
      (entry: any) => entry?.type === "url_citation" || entry?.url_citation,
    ),
    true,
  );
  appendEntries(
    (choice?.message?.annotations || []).filter(
      (entry: any) => entry?.type === "url_citation" || entry?.url_citation,
    ),
    true,
  );
  appendEntries(
    (choice?.delta?.annotations || []).filter(
      (entry: any) => entry?.type === "url_citation" || entry?.url_citation,
    ),
    true,
  );

  return sources;
};

const aggregateOpenAIResponses = (
  payloads: any[],
): {
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
} => {
  const deltaTexts: string[] = [];
  const deltaImages: AIImage[] = [];
  let fallbackText = "";
  let fallbackImages: AIImage[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const seenSources = new Set<string>();

  const appendSources = (entries: Array<{ url: string; title?: string }>) => {
    for (const entry of entries) {
      if (seenSources.has(entry.url)) continue;
      seenSources.add(entry.url);
      sources.push(entry);
    }
  };

  for (const payload of payloads) {
    const choice = payload?.choices?.[0];

    if (choice?.delta?.content !== undefined) {
      const parsedDelta = parseOpenAIChatResponse({
        choices: [{ message: { content: choice.delta.content } }],
      });
      if (parsedDelta.text && parsedDelta.text !== "AI 回复为空") {
        deltaTexts.push(parsedDelta.text);
      }
      if (parsedDelta.images.length > 0) {
        deltaImages.push(...parsedDelta.images);
      }
    }

    const fallbackContent =
      choice?.message?.content ?? choice?.content ?? payload?.content;
    if (fallbackContent !== undefined) {
      const parsedFallback = parseOpenAIChatResponse({
        choices: [{ message: { content: fallbackContent } }],
      });
      if (parsedFallback.text && parsedFallback.text !== "AI 回复为空") {
        fallbackText = parsedFallback.text;
      }
      if (parsedFallback.images.length > 0) {
        fallbackImages = parsedFallback.images;
      }
    } else if (typeof choice?.text === "string" && choice.text.trim()) {
      fallbackText = choice.text.trim();
      fallbackImages = [];
    } else if (typeof payload?.text === "string" && payload.text.trim()) {
      fallbackText = payload.text.trim();
      fallbackImages = [];
    }

    appendSources(collectOpenAISources(payload));
  }

  const text =
    (deltaTexts.length > 0
      ? deltaTexts.join("").trim()
      : fallbackText.trim()) || "AI 回复为空";
  const images = deltaImages.length > 0 ? deltaImages : fallbackImages;

  return { text, images, sources };
};

const collectResponsesSources = (
  item: any,
): Array<{ url: string; title?: string }> => {
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();

  const appendSource = (url?: string, title?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, title });
  };

  const appendAnnotations = (annotations: any[] | undefined) => {
    if (!Array.isArray(annotations)) return;
    for (const entry of annotations) {
      if (entry?.type !== "url_citation") continue;
      appendSource(entry?.url, entry?.title);
    }
  };

  const appendActionSources = (action: any) => {
    const sourceList = Array.isArray(action?.sources)
      ? action.sources
      : Array.isArray(action)
        ? action
        : [];
    for (const entry of sourceList) {
      if (typeof entry?.url !== "string") continue;
      appendSource(entry.url, entry.title);
    }
  };

  if (item?.type === "message") {
    for (const part of item.content || []) {
      appendAnnotations(part?.annotations);
    }
  }

  if (item?.type === "web_search_call") {
    if (Array.isArray(item?.action)) {
      for (const action of item.action) appendActionSources(action);
    } else {
      appendActionSources(item?.action);
    }
  }

  return sources;
};

const parseResponsesOutputContent = (
  item: any,
): {
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
} => {
  const textSegments: string[] = [];
  const images: AIImage[] = [];
  const sources = collectResponsesSources(item);

  if (item?.type !== "message") {
    return { text: "", images, sources };
  }

  for (const part of item.content || []) {
    if (part?.type === "output_text" && typeof part.text === "string") {
      textSegments.push(part.text);
      continue;
    }
    if (part?.type === "image_url" && part.image_url?.url) {
      const dataUrl = parseDataUrl(part.image_url.url);
      if (dataUrl) {
        images.push({ data: dataUrl.data, mimeType: dataUrl.mimeType });
      } else {
        images.push({ url: part.image_url.url, mimeType: "image/jpeg" });
      }
    }
  }

  return {
    text: textSegments.join("<br>").trim(),
    images,
    sources,
  };
};

const aggregateResponsesApiPayloads = (
  payloads: any[],
): {
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
} => {
  const deltaTexts: string[] = [];
  let fallbackText = "";
  let fallbackImages: AIImage[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const seenSources = new Set<string>();

  const appendSources = (entries: Array<{ url: string; title?: string }>) => {
    for (const entry of entries) {
      if (seenSources.has(entry.url)) continue;
      seenSources.add(entry.url);
      sources.push(entry);
    }
  };

  const appendItem = (item: any) => {
    const parsed = parseResponsesOutputContent(item);
    if (parsed.text) fallbackText = parsed.text;
    if (parsed.images.length > 0) fallbackImages = parsed.images;
    appendSources(parsed.sources);
  };

  for (const payload of payloads) {
    if (
      payload?.type === "response.output_text.delta" &&
      typeof payload.delta === "string"
    ) {
      deltaTexts.push(payload.delta);
    }

    if (
      payload?.type === "response.output_text.done" &&
      typeof payload.text === "string" &&
      deltaTexts.length === 0
    ) {
      fallbackText = payload.text.trim();
    }

    if (payload?.type === "response.content_part.done") {
      appendSources(
        collectResponsesSources({
          type: "message",
          content: [payload.part],
        }),
      );
    }

    if (payload?.item) appendItem(payload.item);

    const response =
      payload?.response?.object === "response"
        ? payload.response
        : payload?.object === "response"
          ? payload
          : null;
    if (!response?.output || !Array.isArray(response.output)) continue;

    for (const item of response.output) {
      appendItem(item);
    }
  }

  return {
    text:
      (deltaTexts.length > 0
        ? deltaTexts.join("").trim()
        : fallbackText.trim()) || "AI 回复为空",
    images: fallbackImages,
    sources,
  };
};

const parseOpenAIResponsePayloads = (raw: string): any[] => {
  const payloads: any[] = [];
  let sawDataLine = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    sawDataLine = true;

    const body = trimmed.slice(5).trim();
    if (!body || body === "[DONE]") continue;

    try {
      payloads.push(JSON.parse(body));
    } catch {}
  }

  if (payloads.length > 0 || sawDataLine) return payloads;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
};

const parseOpenAIResponseData = async (
  data: any,
): Promise<{
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
}> => {
  if (
    data &&
    typeof data === "object" &&
    !Buffer.isBuffer(data) &&
    !(data instanceof Uint8Array) &&
    !isAsyncIterable(data)
  ) {
    if (data?.object === "response") {
      return aggregateResponsesApiPayloads([data]);
    }
    return aggregateOpenAIResponses([data]);
  }

  const raw = await readResponseBodyAsText(data);
  const payloads = parseOpenAIResponsePayloads(raw);
  if (payloads.length > 0) {
    const hasResponsesPayload = payloads.some(
      (payload) =>
        payload?.object === "response" ||
        payload?.response?.object === "response" ||
        (typeof payload?.type === "string" &&
          payload.type.startsWith("response.")),
    );
    return hasResponsesPayload
      ? aggregateResponsesApiPayloads(payloads)
      : aggregateOpenAIResponses(payloads);
  }

  return { text: raw.trim() || "AI 回复为空", images: [], sources: [] };
};

const buildDoubaoVideoUrl = (data: any): string | null => {
  return (
    data?.data?.result?.video_url ||
    data?.data?.output?.video_url ||
    data?.data?.video_url ||
    data?.video_url ||
    data?.content?.video_url ||
    data?.data?.content?.video_url ||
    null
  );
};

const buildGeminiVideoApiUrl = (
  baseUrl: string,
  model: string,
  key: string,
  endpoint?: string,
): string => {
  const urlObj = new URL(baseUrl);
  const finalModel = model || "veo-2.0-generate-001";
  const endpointTemplate = endpoint || "v1beta/models/{model}:generateVideos";
  urlObj.pathname = endpointTemplate
    .replace("{model}", finalModel)
    .replace(/^\/+/, "/");
  urlObj.searchParams.set("key", key);
  return urlObj.toString();
};

const buildGeminiOperationUrl = (
  baseOrigin: string,
  name: string,
  key: string,
): string => {
  const urlObj = new URL(baseOrigin);
  const cleanName = name.replace(/^\/+/, "");
  const path = cleanName.startsWith("v1beta/")
    ? cleanName
    : `v1beta/${cleanName}`;
  urlObj.pathname = `/${path}`;
  urlObj.searchParams.set("key", key);
  return urlObj.toString();
};

const extractGeminiOperationError = (data: any): string => {
  const err = data?.error || data?.data?.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  if (typeof err.status === "string") return err.status;
  if (Array.isArray(err.details) && err.details.length > 0) {
    const detail = err.details[0];
    if (typeof detail?.message === "string") return detail.message;
  }
  return "视频生成失败";
};

const extractGeminiVideoResult = (
  data: any,
): { uri?: string; bytes?: string } | null => {
  const response = data?.response ?? data?.data?.response ?? data;
  const sampleUri =
    response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    response?.generate_video_response?.generated_samples?.[0]?.video?.uri;
  if (sampleUri) return { uri: sampleUri };

  const videoBytes =
    response?.generatedVideos?.[0]?.video?.videoBytes ||
    response?.generated_videos?.[0]?.video?.video_bytes ||
    response?.generatedVideos?.[0]?.video?.video_bytes ||
    response?.generated_videos?.[0]?.video?.videoBytes;
  if (videoBytes) return { bytes: videoBytes };

  return null;
};

const buildGeminiParts = async (
  prompt: string,
  images: AIContentPart[],
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<Array<Record<string, any>>> => {
  const parts: Array<Record<string, any>> = [];
  if (prompt.trim()) parts.push({ text: prompt });

  const resolvedImages = await resolveImageInputs(images, httpClient, token, {
    allowFailures: true,
  });
  for (const image of resolvedImages) {
    parts.push({
      inlineData: {
        data: image.data.toString("base64"),
        mimeType: image.mimeType,
      },
    });
  }

  return parts;
};

class FeatureRegistry {
  private features = new Map<string, FeatureHandler>();

  register(handler: FeatureHandler): void {
    this.features.set(handler.command.toLowerCase(), handler);
  }

  getHandler(command: string): FeatureHandler | undefined {
    return this.features.get(command.toLowerCase());
  }
}

class MiddlewarePipeline {
  private middlewares: Middleware[] = [];

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  async execute<T>(
    input: T,
    finalHandler: (input: T, token?: AbortToken) => Promise<any>,
    token?: AbortToken,
  ): Promise<any> {
    const exec = async (
      idx: number,
      curInput: T,
      curToken?: AbortToken,
    ): Promise<any> => {
      if (idx >= this.middlewares.length)
        return await finalHandler(curInput, curToken);
      const mw = this.middlewares[idx];
      return await mw.process(
        curInput,
        (nextInput, nextToken) => exec(idx + 1, nextInput, nextToken),
        curToken,
      );
    };
    return await exec(0, input, token);
  }
}

class TimeoutMiddleware implements Middleware {
  private configManagerPromise: Promise<ConfigManager>;

  constructor(configManagerPromise: Promise<ConfigManager>) {
    this.configManagerPromise = configManagerPromise;
  }

  async process<T>(
    input: T,
    next: (input: T, token?: AbortToken) => Promise<any>,
    token?: AbortToken,
  ): Promise<any> {
    const config = (await this.configManagerPromise).getConfig();
    const timeoutMs = config.timeout * 1000;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(`请求超时: ${timeoutMs}ms`),
      timeoutMs,
    );

    try {
      const combined = this.combine(timeoutController, token);
      combined.signal.addEventListener("abort", () => clearTimeout(timeoutId), {
        once: true,
      });
      return await next(input, combined);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private combine(
    timeoutController: AbortController,
    externalToken?: AbortToken,
  ): AbortToken {
    const controller = new AbortController();

    if (timeoutController.signal.aborted)
      controller.abort(timeoutController.signal.reason);
    else
      timeoutController.signal.addEventListener(
        "abort",
        () => controller.abort(timeoutController.signal.reason),
        {
          once: true,
        },
      );

    if (externalToken) {
      if (externalToken.aborted) controller.abort(externalToken.reason);
      else
        externalToken.signal.addEventListener(
          "abort",
          () => controller.abort(externalToken.reason),
          {
            once: true,
          },
        );
    }

    return {
      get aborted() {
        return controller.signal.aborted;
      },
      get reason() {
        return controller.signal.reason?.toString();
      },
      get signal() {
        return controller.signal;
      },
      abort(reason?: string) {
        controller.abort(reason);
      },
      throwIfAborted() {
        if (controller.signal.aborted) {
          throw new UserError(
            controller.signal.reason?.toString() || "操作已取消",
          );
        }
      },
    };
  }
}

class HttpClient {
  private axiosInstance: AxiosInstance;
  private middlewarePipeline: MiddlewarePipeline;
  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;

  constructor(configManagerPromise: Promise<ConfigManager>) {
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
    const keepAliveAgent = {
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
    };
    this.axiosInstance = axios.create(keepAliveAgent);

    this.middlewarePipeline = new MiddlewarePipeline();
    this.middlewarePipeline.use(new TimeoutMiddleware(configManagerPromise));
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  async request<T = any>(
    requestConfig: AxiosRequestConfig,
    token?: AbortToken,
  ): Promise<AxiosResponse<T>> {
    return await this.middlewarePipeline.execute(
      requestConfig,
      async (config: AxiosRequestConfig, pipelineToken?: AbortToken) => {
        const finalConfig: AxiosRequestConfig = {
          ...config,
          signal: pipelineToken?.signal ?? config.signal,
        };
        return await this.axiosInstance(finalConfig);
      },
      token,
    );
  }
}

class AIService implements ConfigChangeListener {
  private configManager?: ConfigManager;
  private configManagerPromise: Promise<ConfigManager>;
  private activeTokens: Set<AbortToken> = new Set();
  private httpClient: HttpClient;
  private strategyHandlers: Record<ProviderStrategy, StrategyHandler>;

  constructor(
    configManagerPromise: Promise<ConfigManager>,
    httpClient: HttpClient,
  ) {
    this.configManagerPromise = configManagerPromise;
    this.httpClient = httpClient;
    this.strategyHandlers = this.createStrategyHandlers();

    this.initConfigListener();
  }

  private async initConfigListener(): Promise<void> {
    this.configManager = await this.configManagerPromise;
    this.configManager.registerListener(this);
  }

  private async getConfigManager(): Promise<ConfigManager> {
    if (this.configManager) return this.configManager;
    this.configManager = await this.configManagerPromise;
    return this.configManager;
  }

  async onConfigChanged(_config: DB): Promise<void> {}

  private async getCurrentProviderConfig(
    type: "chat" | "search" | "image" | "video",
  ): Promise<{ providerConfig: ProviderConfig; model: string; config: DB }> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    const tag =
      type === "chat"
        ? config.currentChatTag
        : type === "search"
          ? config.currentSearchTag
          : type === "image"
            ? config.currentImageTag
            : config.currentVideoTag;

    const model =
      type === "chat"
        ? config.currentChatModel
        : type === "search"
          ? config.currentSearchModel
          : type === "image"
            ? config.currentImageModel
            : config.currentVideoModel;

    if (!tag || !model || !config.configs[tag]) {
      throw new UserError("请先配置 API 并设置模型");
    }

    return { providerConfig: config.configs[tag], model, config };
  }

  private resolveMode(
    providerConfig: ProviderConfig,
    mode: ProviderMode,
    model: string,
  ): { profile: ProviderProfile; modeConfig: ProviderModeConfig } {
    const profile = getProviderProfile(providerConfig);
    const modeConfig = resolveModeConfig(profile, mode, model);
    if (!modeConfig) {
      throw new UserError(`当前 ${profile.id} 提供商不支持 ${mode} 模式`);
    }
    return { profile, modeConfig };
  }

  private applyImageDefaults(
    request: Record<string, any>,
    providerConfig: ProviderConfig,
    model: string,
    modeConfig: ProviderModeConfig,
  ): void {
    if (modeConfig.imageDefaults?.size)
      request.size = modeConfig.imageDefaults.size;
    if (modeConfig.imageDefaults?.quality)
      request.quality = modeConfig.imageDefaults.quality;
    if (modeConfig.imageDefaults?.responseFormat) {
      request.responseFormat = modeConfig.imageDefaults.responseFormat;
      request.response_format = modeConfig.imageDefaults.responseFormat;
    }
    if (modeConfig.imageDefaults?.extraParams)
      Object.assign(request, modeConfig.imageDefaults.extraParams);

    if (isOpenAIProviderType(resolveProviderType(providerConfig))) {
      if (!model.startsWith("gpt-") && !model.includes("chatgpt-image")) {
        request.responseFormat = "b64_json";
        request.response_format = "b64_json";
      }
      if (!request.size) request.size = "auto";
      if (model.startsWith("dall-e-3")) {
        request.quality = "hd";
      } else if (model.startsWith("gpt-image")) {
        request.quality = "high";
      }
    }
  }

  private applyVideoDefaults(
    request: Record<string, any>,
    modeConfig: ProviderModeConfig,
  ): void {
    if (modeConfig.videoDefaults?.responseFormat) {
      request.responseFormat = modeConfig.videoDefaults.responseFormat;
      request.response_format = modeConfig.videoDefaults.responseFormat;
    }
    if (modeConfig.videoDefaults?.extraParams)
      Object.assign(request, modeConfig.videoDefaults.extraParams);
  }

  private createStrategyHandlers(): Record<ProviderStrategy, StrategyHandler> {
    return {
      "openai-rest": {
        chat: async (ctx) =>
          this.callOpenAIChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
          ),
        search: async (ctx) =>
          this.callOpenAIChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
            true,
          ),
        image: async (ctx) =>
          this.generateImageWithOpenAIRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.image,
            ctx.modeConfig,
            ctx.token,
          ),
        video: async (ctx) =>
          this.generateVideoWithOpenAIRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.images,
            ctx.imageMode,
            ctx.modeConfig,
            ctx.token,
          ),
      },
      "gemini-rest": {
        chat: async (ctx) =>
          this.callGeminiChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
          ),
        search: async (ctx) =>
          this.callGeminiChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
            true,
          ),
        image: async (ctx) =>
          this.generateGeminiImageRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.modeConfig,
            ctx.image,
            ctx.token,
          ),
      },
      "doubao-rest": {
        image: async (ctx) =>
          this.generateImageWithDoubao(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.image,
            ctx.modeConfig,
            ctx.token,
          ),
        video: async (ctx) =>
          this.generateVideoWithDoubao(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.images,
            ctx.imageMode,
            ctx.config.videoAudio,
            ctx.config.videoDuration,
            ctx.modeConfig,
            ctx.token,
          ),
      },
      "gemini-image-rest": {
        image: async (ctx) =>
          this.generateGeminiImageRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.modeConfig,
            ctx.image,
            ctx.token,
          ),
      },
      "gemini-video-rest": {
        video: async (ctx) =>
          this.generateGeminiVideo(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.images,
            ctx.config.videoAudio,
            ctx.config.videoDuration,
            ctx.modeConfig,
            ctx.token,
          ),
      },
    };
  }

  private async callOpenAIChatOrSearch(
    providerConfig: ProviderConfig,
    model: string,
    question: string,
    images: AIContentPart[],
    modeConfig: ProviderModeConfig,
    systemPrompt: string,
    token?: AbortToken,
    isSearch = false,
  ): Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
    images: AIImage[];
  }> {
    const url = providerConfig.responses
      ? resolveResponsesEndpointUrl(providerConfig, modeConfig)
      : resolveEndpointUrl(
          resolveBaseUrl(providerConfig, modeConfig),
          modeConfig.endpoint || "chat/completions",
        );
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );

    const imageUrlPolicy = modeConfig.imageUrlPolicy ?? "any";
    const safeImages =
      imageUrlPolicy === "data-only"
        ? images.filter(
            (part) =>
              part.type === "image_url" && !!parseDataUrl(part.image_url.url),
          )
        : images;

    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const sys = (systemPrompt || "").trim();
    let data: any;

    if (providerConfig.responses) {
      const inputContent = buildResponsesInputContent(question, safeImages);
      data = {
        model,
        input:
          inputContent.length > 0
            ? [{ role: "user", content: inputContent }]
            : question,
        stream: providerConfig.stream,
      };
      if (sys) data.instructions = sys;
      if (isSearch) {
        data.tools = [{ type: "web_search" }];
        data.include = ["web_search_call.action.sources"];
      }
    } else {
      const messages: any[] = [];
      if (sys) messages.push({ role: "system", content: sys });

      let userContent: any = [];
      if (question.trim())
        userContent.push({ type: "text", text: question.trim() });

      for (const img of safeImages) {
        if (img.type === "image_url") {
          userContent.push(img);
        }
      }

      if (userContent.length === 0) userContent = question;
      else if (userContent.length === 1 && userContent[0].type === "text")
        userContent = userContent[0].text;

      messages.push({
        role: "user",
        content: userContent,
      });

      data = {
        model,
        messages,
        stream: providerConfig.stream,
      };

      if (isSearch) {
        data.tools = [
          {
            type: "web_search",
            web_search: {
              searchContextSize: "high",
            },
          },
        ];
        data.web_search_options = { search_context_size: "high" };
      }
    }

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
        ...(providerConfig.stream ? { responseType: "stream" } : {}),
      },
      token,
    );

    const parsed = await parseOpenAIResponseData(response.data);
    return {
      text: parsed.text,
      images: parsed.images,
      sources: isSearch ? parsed.sources : [],
    };
  }

  private async callGeminiChatOrSearch(
    providerConfig: ProviderConfig,
    model: string,
    question: string,
    images: AIContentPart[],
    modeConfig: ProviderModeConfig,
    systemPrompt: string,
    token?: AbortToken,
    isSearch = false,
  ): Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
    images: AIImage[];
  }> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    const endpoint = (
      modeConfig.endpoint || "models/{model}:generateContent"
    ).replace("{model}", model);
    const url = resolveEndpointUrl(baseUrl, endpoint);

    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const parts = await buildGeminiParts(
      question,
      images,
      this.httpClient,
      token,
    );

    const data: any = {
      contents: [{ role: "user", parts }],
    };

    if (systemPrompt?.trim()) {
      data.systemInstruction = {
        role: "system",
        parts: [{ text: systemPrompt.trim() }],
      };
    }

    if (isSearch) {
      data.tools = [{ googleSearch: {} }];
    }

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    const root =
      response.data?.response ?? response.data?.data ?? response.data;
    const candidate = root?.candidates?.[0];
    const cparts = candidate?.content?.parts ?? [];

    let text = "";
    let extractedImages: AIImage[] = [];

    for (const p of cparts) {
      if (p.text) text += p.text;
      const inline = p.inlineData || p.inline_data;
      if (inline?.data) {
        extractedImages.push({
          data: Buffer.from(inline.data, "base64"),
          mimeType: inline.mimeType || inline.mime_type || "image/png",
        });
      }
    }

    let sources: Array<{ url: string; title?: string }> = [];
    if (isSearch) {
      const groundingMetadata =
        candidate?.groundingMetadata || candidate?.grounding_metadata;
      const groundingChunks =
        groundingMetadata?.groundingChunks ||
        groundingMetadata?.grounding_chunks ||
        [];
      for (const chunk of groundingChunks) {
        const web = chunk.web || chunk.web_chunk;
        if (web?.uri) {
          sources.push({ url: web.uri, title: web.title });
        }
      }
    }

    return {
      text: text.trim() || "AI 回复为空",
      images: extractedImages,
      sources,
    };
  }

  private async generateImageWithDoubao(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    image: AIImage | undefined,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);

    const data: Record<string, any> = {
      prompt,
      model,
    };
    if (image) {
      if (!image.data) throw new Error("无法解析图片数据");
      data.image = `data:${image.mimeType};base64,${image.data.toString("base64")}`;
    }
    if (modeConfig.imageDefaults?.size)
      data.size = modeConfig.imageDefaults.size;
    if (modeConfig.imageDefaults?.responseFormat)
      data.response_format = modeConfig.imageDefaults.responseFormat;
    if (modeConfig.imageDefaults?.extraParams)
      Object.assign(data, modeConfig.imageDefaults.extraParams);

    const endpoint = modeConfig.endpoint || "api/v3/images/generations";
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(
      authMode,
      providerConfig,
      resolveEndpointUrl(baseUrl, endpoint),
      {
        "Content-Type": "application/json",
      },
    );
    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    return parseOpenAIStyleImageResponse(response.data);
  }

  private async generateImageWithOpenAIRest(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    image: AIImage | undefined,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    let endpoint = modeConfig.endpoint || "images/generations";
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );

    const requestModel = model;

    let data: any;
    let headers: Record<string, string> = {};

    if (image && image.data) {
      const dataUri = `data:${image.mimeType};base64,${image.data.toString("base64")}`;

      if (
        model.includes("gpt-image") ||
        model.includes("chatgpt-image") ||
        model.includes("dall-e")
      ) {
        endpoint = modeConfig.endpoint || "images/edits";
        data = {
          model: requestModel,
          prompt,
          images: [
            {
              image_url: dataUri,
            },
          ],
        };
        this.applyImageDefaults(data, providerConfig, requestModel, modeConfig);
        headers["Content-Type"] = "application/json";
      } else {
        endpoint = modeConfig.endpoint || "images/edits";
        const fields: Record<string, any> = {
          model: requestModel,
          prompt,
        };
        this.applyImageDefaults(
          fields,
          providerConfig,
          requestModel,
          modeConfig,
        );

        const boundary =
          "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        const chunks: Buffer[] = [];

        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined && value !== null) {
            chunks.push(Buffer.from(`--${boundary}\r\n`));
            chunks.push(
              Buffer.from(
                `Content-Disposition: form-data; name="${key}"\r\n\r\n`,
              ),
            );
            chunks.push(Buffer.from(`${value}\r\n`));
          }
        }

        chunks.push(Buffer.from(`--${boundary}\r\n`));
        chunks.push(
          Buffer.from(
            `Content-Disposition: form-data; name="image"; filename="image.png"\r\n`,
          ),
        );
        chunks.push(
          Buffer.from(`Content-Type: ${image.mimeType || "image/png"}\r\n\r\n`),
        );
        chunks.push(image.data);
        chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        data = Buffer.concat(chunks);
        headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
      }
    } else {
      endpoint = modeConfig.endpoint || "images/generations";
      data = {
        model: requestModel,
        prompt,
      };
      this.applyImageDefaults(data, providerConfig, requestModel, modeConfig);
      headers["Content-Type"] = "application/json";
    }

    const authConfig = applyAuthConfig(
      authMode,
      providerConfig,
      resolveEndpointUrl(baseUrl, endpoint),
      headers,
    );

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    return parseOpenAIStyleImageResponse(response.data);
  }

  private async generateVideoWithOpenAIRest(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    const url = resolveEndpointUrl(
      baseUrl,
      modeConfig.endpoint || "chat/completions",
    );
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );

    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const content: any[] = [];
    if (prompt.trim()) {
      content.push({ type: "text", text: prompt.trim() });
    }

    const safeImages = images.filter(
      (part) => part.type === "image_url" && !!parseDataUrl(part.image_url.url),
    );
    for (const img of safeImages) {
      content.push(img);
    }

    let userContent: any = content;
    if (content.length === 1 && content[0].type === "text") {
      userContent = content[0].text;
    } else if (content.length === 0) {
      userContent = prompt || "Generate a video";
    }

    const data: any = {
      model,
      messages: [{ role: "user", content: userContent }],
      stream: providerConfig.stream,
    };

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
        ...(providerConfig.stream ? { responseType: "stream" } : {}),
      },
      token,
    );

    const parsed = await parseOpenAIResponseData(response.data);
    const replyText = parsed.text;

    if (!replyText) {
      throw new Error("视频生成失败，AI 返回为空");
    }

    const match = replyText.match(/(https?:\/\/[^\s"'>]+\.(?:mp4|webm))/i);
    if (match && match[1]) {
      const isWebm = match[1].toLowerCase().endsWith(".webm");
      return [{ url: match[1], mimeType: isWebm ? "video/webm" : "video/mp4" }];
    }

    throw new Error(`未能从返回结果中提取到视频链接。<br>AI 返回: ${replyText}`);
  }

  private buildDoubaoVideoContent(
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode,
  ): Array<Record<string, any>> {
    const content: Array<Record<string, any>> = [];
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt) {
      content.push({ type: "text", text: trimmedPrompt });
    }

    const imageParts = images.filter(
      (part) => part.type === "image_url" && !!parseDataUrl(part.image_url.url),
    );
    const imageCount = imageParts.length;

    for (const [index, part] of imageParts.entries()) {
      if (part.type !== "image_url") continue;
      const item: Record<string, any> = {
        type: "image_url",
        image_url: { url: part.image_url.url },
      };
      if (imageMode === "first") {
        item.role = "first_frame";
      } else if (imageMode === "firstlast") {
        item.role = index === 0 ? "first_frame" : "last_frame";
      } else if (imageMode === "reference") {
        item.role = "reference_image";
      } else if (imageCount === 2) {
        item.role = index === 0 ? "first_frame" : "last_frame";
      } else if (imageCount > 2) {
        item.role = "reference_image";
      }
      content.push(item);
    }

    return content;
  }

  private async generateGeminiImageRest(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    modeConfig: ProviderModeConfig,
    image?: AIImage,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);

    if (model.includes("imagen")) {
      const endpoint = `v1beta/models/${model}:predict`;
      const url = resolveEndpointUrl(baseUrl, endpoint);
      const authMode = resolveAuthMode(
        getProviderProfile(providerConfig),
        modeConfig,
        providerConfig,
      );
      const authConfig = applyAuthConfig(authMode, providerConfig, url, {
        "Content-Type": "application/json",
      });

      const data: any = {
        instances: [{ prompt: prompt || "" }],
        parameters: {
          sampleCount: 1,
          outputOptions: { mimeType: "image/png" },
        },
      };

      const response = await this.httpClient.request(
        {
          url: authConfig.url,
          method: "POST",
          headers: authConfig.headers,
          data,
        },
        token,
      );

      const predictions = response.data?.predictions || [];
      const images: AIImage[] = [];
      for (const p of predictions) {
        if (p.bytesBase64Encoded) {
          images.push({
            data: Buffer.from(p.bytesBase64Encoded, "base64"),
            mimeType: p.mimeType || "image/png",
          });
        }
      }
      if (images.length === 0) throw new Error("图片生成失败");
      return images;
    }

    const endpoint = (
      modeConfig.endpoint || "models/{model}:generateContent"
    ).replace("{model}", model);
    const url = resolveEndpointUrl(baseUrl, endpoint);

    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const parts: any[] = [];
    if (prompt?.trim()) parts.push({ text: prompt.trim() });

    if (image?.data) {
      parts.push({
        inlineData: {
          data: image.data.toString("base64"),
          mimeType: image.mimeType || "image/png",
        },
      });
    }

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data: {
          contents: [{ parts }],
        },
      },
      token,
    );

    const root =
      response.data?.response ?? response.data?.data ?? response.data;
    const candidates = root?.candidates ?? [];
    const images: AIImage[] = [];

    for (const c of candidates) {
      const cparts = c?.content?.parts ?? [];
      for (const p of cparts) {
        const inline = p?.inlineData || p?.inline_data;
        if (inline?.data) {
          images.push({
            data: Buffer.from(inline.data, "base64"),
            mimeType: inline.mimeType || inline.mime_type || "image/png",
          });
        }
      }
    }

    if (images.length === 0) {
      throw new Error(
        "未在 candidates[].content.parts[].inlineData 中找到图片数据",
      );
    }

    return images;
  }

  private async generateGeminiVideo(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    images: AIContentPart[],
    videoAudio: boolean,
    videoDuration: number,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    const apiUrl = buildGeminiVideoApiUrl(
      baseUrl,
      model,
      providerConfig.key,
      modeConfig.endpoint,
    );
    const parts = await buildGeminiParts(
      prompt,
      images,
      this.httpClient,
      token,
    );

    const response = await this.httpClient.request(
      {
        url: apiUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        data: {
          contents: [
            {
              parts,
            },
          ],
          videoGenerationConfig: {
            numberOfVideos: 1,
            durationSeconds: videoDuration,
            enableAudio: videoAudio,
          },
        },
      },
      token,
    );

    const directResult = extractGeminiVideoResult(response.data);
    if (directResult?.bytes) {
      return [
        {
          data: Buffer.from(directResult.bytes, "base64"),
          mimeType: "video/mp4",
        },
      ];
    }

    if (directResult?.uri) {
      const download = await this.httpClient.request(
        {
          url: directResult.uri,
          method: "GET",
          responseType: "arraybuffer",
        },
        token,
      );
      const contentType = getHeaderContentType(download.headers) || "video/mp4";
      return [{ data: Buffer.from(download.data), mimeType: contentType }];
    }

    const operationName = response.data?.name;
    if (!operationName || typeof operationName !== "string") {
      throw new Error("视频生成失败");
    }

    const baseOrigin = normalizeGeminiBaseUrl(providerConfig.url);
    const operation = await pollTask<any>(
      async (abortToken) => {
        const url = buildGeminiOperationUrl(
          baseOrigin,
          operationName,
          providerConfig.key,
        );
        const opResponse = await this.httpClient.request(
          {
            url,
            method: "GET",
            headers: { "Content-Type": "application/json" },
          },
          abortToken,
        );
        return opResponse.data;
      },
      (data): TaskPollResult<any> => {
        if (!data || data.done !== true) {
          return { status: "pending" };
        }
        if (data.error) {
          return {
            status: "failed",
            errorMessage: extractGeminiOperationError(data),
          };
        }
        return { status: "succeeded", result: data };
      },
      {
        maxAttempts: 303,
        intervalMs: 2000,
      },
      token,
    );

    const finalResult = extractGeminiVideoResult(operation);
    if (finalResult?.bytes) {
      return [
        {
          data: Buffer.from(finalResult.bytes, "base64"),
          mimeType: "video/mp4",
        },
      ];
    }
    if (finalResult?.uri) {
      const download = await this.httpClient.request(
        {
          url: finalResult.uri,
          method: "GET",
          responseType: "arraybuffer",
        },
        token,
      );
      const contentType = getHeaderContentType(download.headers) || "video/mp4";
      return [{ data: Buffer.from(download.data), mimeType: contentType }];
    }

    throw new Error("视频生成失败");
  }

  private async generateVideoWithDoubao(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode,
    videoAudio: boolean,
    videoDuration: number,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);

    const content = this.buildDoubaoVideoContent(prompt, images, imageMode);
    const data: Record<string, any> = {
      model,
      content,
      generateAudio: videoAudio,
      duration: videoDuration,
    };
    this.applyVideoDefaults(data, modeConfig);

    const endpoint = modeConfig.endpoint || "api/v3/contents/generations/tasks";
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(
      authMode,
      providerConfig,
      resolveEndpointUrl(baseUrl, endpoint),
      {
        "Content-Type": "application/json",
      },
    );
    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    const taskId =
      response.data?.task_id ||
      response.data?.data?.task_id ||
      response.data?.data?.id ||
      response.data?.id;
    if (!taskId) throw new Error("视频生成任务创建失败");

    const videoUrl = await pollTask<string>(
      async (abortToken) => {
        const pollUrl = resolveEndpointUrl(baseUrl, `${endpoint}/${taskId}`);
        const authConfig = applyAuthConfig(
          authMode,
          providerConfig,
          pollUrl,
          {},
        );
        const pollResponse = await this.httpClient.request(
          {
            url: authConfig.url,
            method: "GET",
            headers: authConfig.headers,
          },
          abortToken,
        );
        return pollResponse.data;
      },
      (data): TaskPollResult<string> => {
        const statusRaw = data?.status || data?.data?.status;
        if (statusRaw === "failed") {
          return { status: "failed", errorMessage: "视频生成失败" };
        }

        const url = buildDoubaoVideoUrl(data);
        if (url) {
          return { status: "succeeded", result: url };
        }

        return { status: "pending" };
      },
      {
        maxAttempts: 303,
        intervalMs: 2000,
      },
      token,
    );

    return [{ url: videoUrl, mimeType: "video/mp4" }];
  }

  createAbortToken(): AbortToken {
    const token = createAbortToken();
    this.activeTokens.add(token);
    token.signal.addEventListener(
      "abort",
      () => this.activeTokens.delete(token),
      { once: true },
    );
    return token;
  }

  releaseToken(token: AbortToken): void {
    this.activeTokens.delete(token);
  }

  cancelAllOperations(reason?: string): void {
    const tokens = Array.from(this.activeTokens);
    this.activeTokens.clear();
    for (const token of tokens) {
      if (!token.aborted) token.abort(reason || "操作已取消");
    }
  }

  async destroy(): Promise<void> {
    this.cancelAllOperations("服务已停止");
    if (this.configManager) this.configManager.unregisterListener(this);
  }

  async callAI(
    question: string,
    images: AIContentPart[] = [],
    token?: AbortToken,
  ): Promise<{ text: string; images: AIImage[] }> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("chat");
    const { modeConfig } = this.resolveMode(providerConfig, "chat", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.chat;
    if (!handler) throw new UserError("当前提供商不支持聊天");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      question,
      images,
      token,
    });
  }

  async callSearch(
    question: string,
    images: AIContentPart[] = [],
    token?: AbortToken,
  ): Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
  }> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("search");
    const { modeConfig } = this.resolveMode(providerConfig, "search", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.search;
    if (!handler) throw new UserError("当前提供商不支持搜索模式");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      question,
      images,
      token,
    });
  }

  async generateImage(prompt: string, token?: AbortToken): Promise<AIImage[]> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("image");
    const { modeConfig } = this.resolveMode(providerConfig, "image", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.image;
    if (!handler) throw new UserError("当前提供商不支持图片生成");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      prompt,
      token,
    });
  }

  async editImage(
    prompt: string,
    image: AIImage,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("image");
    const { modeConfig } = this.resolveMode(providerConfig, "image", model);

    if (!modeConfig.supportsEdit) {
      throw new UserError("当前提供商未启用图片编辑支持");
    }

    if (!image.data) {
      throw new Error("无法解析图片数据");
    }

    const handler = this.strategyHandlers[modeConfig.strategy]?.image;
    if (!handler) throw new UserError("当前提供商不支持图片编辑");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      prompt,
      image,
      token,
    });
  }

  async generateVideo(
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode = "auto",
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("video");
    const { modeConfig } = this.resolveMode(providerConfig, "video", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.video;
    if (!handler) throw new UserError("当前提供商不支持视频生成");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      prompt,
      images,
      imageMode,
      token,
    });
  }
}

abstract class BaseFeatureHandler implements FeatureHandler {
  abstract readonly name: string;
  abstract readonly command: string;
  abstract readonly description: string;
  abstract execute(
    msg: Api.Message,
    args: string[],
    prefixes: string[],
  ): Promise<void>;

  protected configManagerPromise: Promise<ConfigManager>;

  protected constructor(configManagerPromise: Promise<ConfigManager>) {
    this.configManagerPromise = configManagerPromise;
  }

  protected async getConfigManager(): Promise<ConfigManager> {
    return await this.configManagerPromise;
  }

  protected async getConfig(): Promise<DB> {
    const configManager = await this.getConfigManager();
    return configManager.getConfig();
  }

  protected async editMessage(
    msg: Api.Message,
    text: string,
    parseMode: string = "html",
  ): Promise<void> {
    await MessageSender.sendOrEdit(msg, text, { parseMode });
  }
}

class ConfigFeature extends BaseFeatureHandler {
  readonly name = "配置管理";
  readonly command = "config";
  readonly description = "管理 API 配置";

  constructor(configManagerPromise: Promise<ConfigManager>) {
    super(configManagerPromise);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      const list =
        Object.values(config.configs)
          .map(
            (c) =>
              `🏷️ <code>${c.tag}</code> - ${c.url}<br>🧩 Type: <code>${formatProviderTypeLabel(c)}</code><br>🌊 Stream: <code>${c.stream ? "on" : "off"}</code><br>🧠 Responses(chat/search): <code>${c.responses ? "on" : "off"}</code>`,
          )
          .join("<br>") || "暂无配置";
      await this.editMessage(
        msg,
        `📋 <b>API 配置列表:</b><br><br>⚙️ 配置:<br>${list}`,
      );
      return;
    }

    const action = args[1].toLowerCase();
    if (action === "add") {
      requireUser(args.length >= 5, "参数格式错误");
      await this.addConfig(msg, args, configManager);
      return;
    }
    if (action === "del") {
      requireUser(args.length >= 3, "参数格式错误");
      await this.deleteConfig(msg, args, configManager);
      return;
    }
    if (action === "stream") {
      requireUser(args.length >= 4, "参数不足");
      await this.setStream(msg, args, configManager);
      return;
    }
    if (action === "responses") {
      requireUser(args.length >= 4, "参数不足");
      await this.setResponses(msg, args, configManager);
      return;
    }
    if (action === "type") {
      requireUser(args.length >= 4, "参数不足");
      await this.setProviderType(msg, args, configManager);
      return;
    }
    throw new UserError("参数格式错误");
  }

  private parseProviderType(value: string): ProviderType {
    const providerType = normalizeProviderType(value);
    requireUser(!!providerType, `type 必须是 ${PROVIDER_TYPE_OPTIONS}`);
    if (!providerType) throw new UserError("无效的 provider type");
    return providerType;
  }

  private parseAddConfigArgs(args: string[]): {
    tag: string;
    url: string;
    key: string;
    type?: ProviderType;
  } {
    const rawArgs = args.slice(2);
    let urlIndex = -1;
    for (let i = rawArgs.length - 2; i >= 1; i--) {
      const trailingCount = rawArgs.length - i - 1;
      if (trailingCount > 2) continue;
      if (!isHttpUrl(rawArgs[i])) continue;
      urlIndex = i;
      break;
    }

    requireUser(urlIndex > 0, "参数格式错误");

    const tag = rawArgs.slice(0, urlIndex).join(" ").trim();
    const url = rawArgs[urlIndex];
    const tail = rawArgs.slice(urlIndex + 1);
    requireUser(
      !!tag && (tail.length === 1 || tail.length === 2),
      "参数格式错误",
    );

    return {
      tag,
      url,
      key: tail[0],
      type: tail[1] ? this.parseProviderType(tail[1]) : undefined,
    };
  }

  private async addConfig(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    requireUser(
      !!(msg as any).savedPeerId,
      "出于安全考虑，禁止在公开场景添加/修改 API 密钥",
    );
    const { tag, url, key, type } = this.parseAddConfigArgs(args);

    requireUser(!!key.trim(), "API 密钥不能为空");
    requireUser(key.length >= 10, "API 密钥长度过短");

    await configManager.updateConfig((cfg) => {
      cfg.configs[tag] = {
        tag,
        url,
        key,
        type,
        stream: false,
        responses: false,
      };
    });

    await this.editMessage(
      msg,
      "✅ API 配置已添加:\n\n" +
        `🏷️ 标签: <code>${tag}</code><br>` +
        `🔗 地址: <code>${url}</code><br>` +
        `🧩 Type: <code>${formatProviderTypeLabel({ url, type })}</code><br>` +
        `🔑 密钥: <code>${key}</code><br>` +
        `🌊 Stream: <code>off</code><br>` +
        `🧠 Responses(chat/search): <code>off</code>`,
    );
  }

  private async setStream(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const state = args[args.length - 1]?.toLowerCase();
    const tag = args.slice(2, -1).join(" ").trim();
    const config = configManager.getConfig();

    requireUser(!!tag, "参数格式错误");
    requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
    requireUser(!!config.configs[tag], "配置不存在");

    const enabled = state === "on";
    await configManager.updateConfig((cfg) => {
      cfg.configs[tag].stream = enabled;
    });

    await this.editMessage(
      msg,
      `✅ 已将配置 <code>${tag}</code> 的 Stream 设置为 <code>${enabled ? "on" : "off"}</code>`,
    );
  }

  private async setResponses(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const state = args[args.length - 1]?.toLowerCase();
    const tag = args.slice(2, -1).join(" ").trim();
    const config = configManager.getConfig();

    requireUser(!!tag, "参数格式错误");
    requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
    requireUser(!!config.configs[tag], "配置不存在");

    const enabled = state === "on";
    await configManager.updateConfig((cfg) => {
      cfg.configs[tag].responses = enabled;
    });

    await this.editMessage(
      msg,
      `✅ 已将配置 <code>${tag}</code> 的 Responses(chat/search) 模式设置为 <code>${enabled ? "on" : "off"}</code>`,
    );
  }

  private async setProviderType(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const type = this.parseProviderType(args[args.length - 1] || "");
    const tag = args.slice(2, -1).join(" ").trim();
    const config = configManager.getConfig();

    requireUser(!!tag, "参数格式错误");
    requireUser(!!config.configs[tag], "配置不存在");

    await configManager.updateConfig((cfg) => {
      cfg.configs[tag].type = type;
    });

    await this.editMessage(
      msg,
      `✅ 已将配置 <code>${tag}</code> 的 Type 设置为 <code>${type}</code>`,
    );
  }

  private async deleteConfig(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const delTag = args[2];
    const config = configManager.getConfig();

    requireUser(!!config.configs[delTag], "配置不存在");

    await configManager.updateConfig((cfg) => {
      delete cfg.configs[delTag];
      if (cfg.currentChatTag === delTag) {
        cfg.currentChatTag = "";
        cfg.currentChatModel = "";
      }
      if (cfg.currentImageTag === delTag) {
        cfg.currentImageTag = "";
        cfg.currentImageModel = "";
      }
      if (cfg.currentVideoTag === delTag) {
        cfg.currentVideoTag = "";
        cfg.currentVideoModel = "";
      }
    });

    await this.editMessage(msg, `✅ 已删除配置: ${delTag}`);
  }
}

class ModelFeature extends BaseFeatureHandler {
  readonly name = "模型管理";
  readonly command = "model";
  readonly description = "设置 AI 模型";

  constructor(configManagerPromise: Promise<ConfigManager>) {
    super(configManagerPromise);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `🤖 <b>当前 AI 配置:</b><br><br>` +
          `💬 chat 配置: <code>${config.currentChatTag || "未设置"}</code><br>` +
          `🧠 chat 模型: <code>${config.currentChatModel || "未设置"}</code><br>` +
          `🔎 search 配置: <code>${config.currentSearchTag || "未设置"}</code><br>` +
          `📚 search 模型: <code>${config.currentSearchModel || "未设置"}</code><br>` +
          `🖼️ image 配置: <code>${config.currentImageTag || "未设置"}</code><br>` +
          `🎨 image 模型: <code>${config.currentImageModel || "未设置"}</code><br>` +
          `🎬 video 配置: <code>${config.currentVideoTag || "未设置"}</code><br>` +
          `📹 video 模型: <code>${config.currentVideoModel || "未设置"}</code>`,
      );
      return;
    }

    const mode = args[1]?.toLowerCase();
    requireUser(
      mode === "chat" ||
        mode === "search" ||
        mode === "image" ||
        mode === "video",
      "参数格式错误",
    );
    requireUser(args.length >= 4, "参数不足");

    const model = args[args.length - 1];
    const tag = args.slice(2, -1).join(" ").trim();
    requireUser(!!config.configs[tag], `配置标签 "${tag}" 不存在`);

    await configManager.updateConfig((cfg) => {
      if (mode === "chat") {
        cfg.currentChatTag = tag;
        cfg.currentChatModel = model;
      } else if (mode === "search") {
        cfg.currentSearchTag = tag;
        cfg.currentSearchModel = model;
      } else if (mode === "video") {
        cfg.currentVideoTag = tag;
        cfg.currentVideoModel = model;
      } else {
        cfg.currentImageTag = tag;
        cfg.currentImageModel = model;
      }
    });

    const modeLabel =
      mode === "chat"
        ? "chat 模型"
        : mode === "search"
          ? "search 模型"
          : mode === "image"
            ? "image 模型"
            : "video 模型";
    await this.editMessage(
      msg,
      `✅ ${modeLabel} 已切换到:<br><br>🏷️ 配置: <code>${tag}</code><br>🧠 模型: <code>${model}</code>`,
    );
  }
}

class PromptFeature extends BaseFeatureHandler {
  readonly name = "提示词管理";
  readonly command = "prompt";
  readonly description = "管理提示词";

  constructor(configManagerPromise: Promise<ConfigManager>) {
    super(configManagerPromise);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `💭 <b>当前提示词:</b><br><br>📝 内容: <code>${config.prompt || "未设置"}</code>`,
      );
      return;
    }

    const action = args[1].toLowerCase();
    if (action === "set") {
      requireUser(args.length >= 3, "参数格式错误");
      await configManager.updateConfig((cfg) => {
        cfg.prompt = args.slice(2).join(" ");
      });
      await this.editMessage(
        msg,
        `✅ 提示词已设置:<br><br><code>${args.slice(2).join(" ")}</code>`,
      );
      return;
    }

    if (action === "del") {
      await configManager.updateConfig((cfg) => {
        cfg.prompt = "";
      });
      await this.editMessage(msg, "✅ 提示词已删除");
      return;
    }

    throw new UserError("参数格式错误");
  }
}

class CollapseFeature extends BaseFeatureHandler {
  readonly name = "折叠设置";
  readonly command = "collapse";
  readonly description = "设置消息折叠";

  constructor(configManagerPromise: Promise<ConfigManager>) {
    super(configManagerPromise);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `📖 <b>消息折叠状态:</b><br><br>📄 当前状态: ${config.collapse ? "开启" : "关闭"}`,
      );
      return;
    }

    const state = args[1].toLowerCase();
    requireUser(state === "on" || state === "off", "参数必须是 on 或 off");

    await configManager.updateConfig((cfg) => {
      cfg.collapse = state === "on";
    });

    await this.editMessage(
      msg,
      `✅ 引用折叠已${state === "on" ? "开启" : "关闭"}`,
    );
  }
}

class TelegraphFeature extends BaseFeatureHandler {
  readonly name = "Telegraph 管理";
  readonly command = "telegraph";
  readonly description = "管理 Telegraph";

  constructor(configManagerPromise: Promise<ConfigManager>) {
    super(configManagerPromise);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.showTelegraphStatus(msg, config);
      return;
    }

    const action = args[1].toLowerCase();
    if (action === "on") {
      await this.enableTelegraph(msg, configManager);
      return;
    }
    if (action === "off") {
      await this.disableTelegraph(msg, configManager);
      return;
    }
    if (action === "limit") {
      requireUser(args.length >= 3, "参数格式错误");
      await this.setTelegraphLimit(msg, args, configManager);
      return;
    }
    if (action === "del") {
      requireUser(args.length >= 3, "参数格式错误");
      await this.deleteTelegraphItem(msg, args, configManager);
      return;
    }
    await this.showTelegraphStatus(msg, config);
  }

  private async showTelegraphStatus(
    msg: Api.Message,
    config: DB,
  ): Promise<void> {
    let status =
      `📰 <b>Telegraph 状态:</b><br><br>` +
      `🌐 当前状态: ${config.telegraph.enabled ? "开启" : "关闭"}<br>` +
      `📊 限制数量: <code>${config.telegraph.limit}</code><br>` +
      `📈 记录数量: <code>${config.telegraph.list.length}/${config.telegraph.limit}</code>`;

    if (config.telegraph.list.length > 0) {
      status += "\n\n";
      config.telegraph.list.forEach((item, index) => {
        status += `${index + 1}. <a href="${item.url}">🔗 ${item.title}</a><br>`;
      });
    }

    await this.editMessage(msg, status);
  }

  private async enableTelegraph(
    msg: Api.Message,
    configManager: ConfigManager,
  ): Promise<void> {
    await configManager.updateConfig((cfg) => {
      cfg.telegraph.enabled = true;
    });
    await this.editMessage(msg, "✅ Telegraph 已开启");
  }

  private async disableTelegraph(
    msg: Api.Message,
    configManager: ConfigManager,
  ): Promise<void> {
    await configManager.updateConfig((cfg) => {
      cfg.telegraph.enabled = false;
    });
    await this.editMessage(msg, "✅ Telegraph 已关闭");
  }

  private async setTelegraphLimit(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const limit = parseInt(args[2]);
    requireUser(!isNaN(limit) && limit > 0, "限制数量必须大于 0");

    await configManager.updateConfig((cfg) => {
      cfg.telegraph.limit = limit;
    });

    await this.editMessage(msg, `✅ Telegraph 限制已设置为 ${limit}`);
  }

  private async deleteTelegraphItem(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const del = args[2];
    const config = configManager.getConfig();

    if (del.toLowerCase() === "all") {
      await configManager.updateConfig((cfg) => {
        cfg.telegraph.list = [];
      });
      await this.editMessage(msg, "✅ 已删除所有记录");
      return;
    }

    const idx = parseInt(del) - 1;
    requireUser(
      !isNaN(idx) && idx >= 0 && idx < config.telegraph.list.length,
      `序号超出范围 (1-${config.telegraph.list.length})`,
    );

    await configManager.updateConfig((cfg) => {
      cfg.telegraph.list.splice(idx, 1);
    });

    await this.editMessage(msg, `✅ 已删除第 ${idx + 1} 项`);
  }
}

class TimeoutFeature extends BaseFeatureHandler {
  readonly name = "超时设置";
  readonly command = "timeout";
  readonly description = "设置请求超时";

  constructor(configManagerPromise: Promise<ConfigManager>) {
    super(configManagerPromise);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `⏱️ <b>当前超时设置:</b><br><br>⏰ 超时时间: <code>${config.timeout} 秒</code>`,
      );
      return;
    }

    const timeout = parseInt(args[1]);
    requireUser(
      !isNaN(timeout) && timeout >= 1 && timeout <= 600,
      "超时时间必须在 1 到 600 秒之间",
    );

    await configManager.updateConfig((cfg) => {
      cfg.timeout = timeout;
    });

    await this.editMessage(msg, `✅ 超时时间已设置为 ${timeout} 秒`);
  }
}

class QuestionFeature extends BaseFeatureHandler {
  readonly name = "AI 提问";
  readonly command = "";
  readonly description = "向 AI 提问";

  private aiService: AIService;
  private messageUtils: MessageUtils;
  private activeToken?: AbortToken;

  constructor(
    aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    httpClient: HttpClient,
  ) {
    super(configManagerPromise);
    this.aiService = aiService;
    this.messageUtils = new MessageUtils(configManagerPromise, httpClient);
  }

  cancelCurrentOperation(): void {
    if (this.activeToken && !this.activeToken.aborted)
      this.activeToken.abort("操作被取消");
    this.activeToken = undefined;
  }

  private async runQuestion(
    msg: Api.Message,
    question: string,
    trigger?: Api.Message,
  ): Promise<void> {
    this.cancelCurrentOperation();

    const token = this.aiService.createAbortToken();
    this.activeToken = token;

    try {
      await this.handleQuestion(msg, question, trigger, token);
    } finally {
      this.activeToken = undefined;
      this.aiService.releaseToken(token);
    }
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const question = args.join(" ").trim();
    await this.runQuestion(msg, question);
  }

  async askFromReply(msg: Api.Message, trigger?: Api.Message): Promise<void> {
    const replyMsg = await safeGetReplyMessage(msg);
    requireUser(!!replyMsg, "至少需要一条提示");
    const question = getMessageText(replyMsg).trim();
    await this.runQuestion(msg, question, trigger);
  }

  async handleQuestion(
    msg: Api.Message,
    question: string,
    trigger?: Api.Message,
    token?: AbortToken,
  ): Promise<void> {
    const config = await this.getConfig();

    if (
      !config.currentChatTag ||
      !config.currentChatModel ||
      !config.configs[config.currentChatTag]
    ) {
      const prefixes = getPrefixes();
      throw new UserError(
        `请先配置 API 并设置模型<br>使用 ${prefixes[0]}ai config add <tag> <url> <key> [type] 和 ${prefixes[0]}ai model chat <tag> <model-path>`,
      );
    }

    token?.throwIfAborted();

    await sendProcessing(msg, "chat");

    const replyMsg = await safeGetReplyMessage(msg);
    let context = getMessageText(replyMsg);
    const replyToId = replyMsg?.id;
    const imageParts = [
      ...(await getMessageImageParts(replyMsg)),
      ...(await getMessageImageParts(msg)),
    ];

    const normalizedQuestion = question.trim();
    const normalizedContext = context.trim();
    if (
      normalizedQuestion &&
      normalizedContext &&
      normalizedQuestion === normalizedContext
    ) {
      context = "";
    }

    const userText = context
      ? `上下文:<br>${context}<br><br>问题:<br>${question}`
      : question;

    const response = await this.aiService.callAI(userText, imageParts, token);
    const answer = response.text || "AI 回复为空";

    const collapseSafe = config.collapse;
    const htmlAnswer = TelegramFormatter.markdownToHtml(answer, {
      collapseSafe,
    });
    const safeQuestion = htmlEscape(question);
    const formattedAnswer = `Q:<br>${safeQuestion}<br><br>A:<br>${htmlAnswer}`;

    token?.throwIfAborted();

    if (config.telegraph.enabled && formattedAnswer.length > 4050) {
      await this.handleLongContentWithTelegraph(
        msg,
        question,
        answer,
        replyToId,
        token,
      );
    } else {
      await this.messageUtils.sendLongMessage(
        msg,
        formattedAnswer,
        replyToId,
        token,
        {
          poweredByTag: config.currentChatTag,
        },
      );
    }
    await deleteMessageOrGroup(msg);
  }

  private async handleLongContentWithTelegraph(
    msg: Api.Message,
    question: string,
    rawAnswer: string,
    replyToId?: number,
    token?: AbortToken,
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    const telegraphMarkdown = `**Q:**<br>${question}<br><br>**A:**<br>${rawAnswer}<br>`;
    const telegraphResult = await this.messageUtils.createTelegraphPage(
      telegraphMarkdown,
      question,
      token,
    );

    const poweredByText = `<br><i>🍀Powered by ${config.currentChatTag}</i>`;
    const safeQuestion = htmlEscape(question);
    const questionBlock = config.collapse
      ? `Q:<br><blockquote expandable>${safeQuestion}</blockquote><br>`
      : `Q:<br>${safeQuestion}<br>`;
    const answerBlock = config.collapse
      ? `A:<br><blockquote expandable>📰内容比较长，Telegraph 观感更好喔:<br>🔗 <a href="${telegraphResult.url}">点我阅读内容</a></blockquote>${poweredByText}`
      : `A:<br>📰内容比较长，Telegraph 观感更好喔:<br>🔗 <a href="${telegraphResult.url}">点我阅读内容</a>${poweredByText}`;

    await MessageSender.sendNew(
      msg,
      questionBlock + answerBlock,
      { parseMode: "html", linkPreview: false },
      replyToId,
    );

    await configManager.updateConfig((cfg) => {
      cfg.telegraph.list.push(telegraphResult);
      if (cfg.telegraph.list.length > cfg.telegraph.limit)
        cfg.telegraph.list.shift();
    });
  }
}

class SearchFeature extends BaseFeatureHandler {
  readonly name = "联网搜索";
  readonly command = "search";
  readonly description = "使用联网能力搜索并回答";

  private aiService: AIService;
  private messageUtils: MessageUtils;

  constructor(
    aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    httpClient: HttpClient,
  ) {
    super(configManagerPromise);
    this.aiService = aiService;
    this.messageUtils = new MessageUtils(configManagerPromise, httpClient);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const prefixes = getPrefixes();
    const config = await this.getConfig();

    const promptInput = args.slice(1).join(" ").trim();

    const replyMsg = await safeGetReplyMessage(msg);
    requireUser(!!promptInput || !!replyMsg, "至少需要一条提示");

    if (
      !config.currentSearchTag ||
      !config.currentSearchModel ||
      !config.configs[config.currentSearchTag]
    ) {
      throw new UserError(
        `请先配置 API 并设置模型<br>使用 ${prefixes[0]}ai config add <tag> <url> <key> [type] 和 ${prefixes[0]}ai model search <tag> <model-path>`,
      );
    }

    await sendProcessing(msg, "search");

    const replyToId = replyMsg?.id;

    let context = getMessageText(replyMsg);
    const imageParts = [
      ...(await getMessageImageParts(replyMsg)),
      ...(await getMessageImageParts(msg)),
    ];

    const normalizedPrompt = promptInput.trim();
    const normalizedContext = (context || "").trim();

    if (
      normalizedPrompt &&
      normalizedContext &&
      normalizedPrompt === normalizedContext
    ) {
      context = "";
    }

    const userText = context
      ? `上下文:<br>${context}<br><br>问题:<br>${promptInput}`
      : promptInput;

    const token = this.aiService.createAbortToken();
    try {
      const { text, sources } = await this.aiService.callSearch(
        userText,
        imageParts,
        token,
      );

      const sourcesText =
        sources && sources.length > 0
          ? "\n\n<b>🔗 Sources</b>\n" +
            sources
              .slice(0, 8)
              .map((s, i) => {
                const safeUrl = htmlEscape(s.url);
                const safeTitle = htmlEscape(s.title || s.url);
                return `${i + 1}. <a href="${safeUrl}">${safeTitle}</a>`;
              })
              .join("<br>")
          : "";

      const collapseSafe = config.collapse;
      const htmlAnswer = TelegramFormatter.markdownToHtml(
        text || "AI 回复为空",
        { collapseSafe },
      );

      const safeQuestion = htmlEscape(promptInput);
      const formatted = `Q:<br>${safeQuestion}<br><br>A:<br>${htmlAnswer}${sourcesText}`;

      if (config.telegraph.enabled && formatted.length > 4050) {
        const telegraphMarkdown =
          `**Q:**<br>${promptInput}<br><br>**A:**<br>${text || "AI 回复为空"}<br><br>` +
          (sources && sources.length
            ? `**Sources:**<br>` +
              sources
                .slice(0, 20)
                .map((s, i) => `${i + 1}. ${s.title || s.url}<br>${s.url}`)
                .join("<br>")
            : "");

        const telegraphResult = await this.messageUtils.createTelegraphPage(
          telegraphMarkdown,
          promptInput,
          token,
        );

        const poweredByText = `<br><i>🍀Powered by ${config.currentSearchTag}</i>`;
        const qBlock = config.collapse
          ? `Q:<br><blockquote expandable>${safeQuestion}</blockquote><br>`
          : `Q:<br>${safeQuestion}<br>`;
        const aBlock = config.collapse
          ? `A:<br><blockquote expandable>📰内容较长，Telegraph 观感更好：<br>🔗 <a href="${telegraphResult.url}">点我阅读内容</a></blockquote>${poweredByText}`
          : `A:<br>📰内容较长，Telegraph 观感更好：<br>🔗 <a href="${telegraphResult.url}">点我阅读内容</a>${poweredByText}`;

        await MessageSender.sendNew(
          msg,
          qBlock + aBlock,
          { parseMode: "html", linkPreview: false },
          replyToId,
        );

        const configManager = await this.getConfigManager();
        await configManager.updateConfig((cfg) => {
          cfg.telegraph.list.push(telegraphResult);
          if (cfg.telegraph.list.length > cfg.telegraph.limit)
            cfg.telegraph.list.shift();
        });
      } else {
        await this.messageUtils.sendLongMessage(
          msg,
          formatted,
          replyToId,
          token,
          {
            poweredByTag: config.currentSearchTag,
          },
        );
      }

      await deleteMessageOrGroup(msg);
    } finally {
      this.aiService.releaseToken(token);
    }
  }
}

class ImageFeature extends BaseFeatureHandler {
  readonly name = "图片生成";
  readonly command = "image";
  readonly description = "生成图片";

  private aiService: AIService;
  private messageUtils: MessageUtils;
  private httpClient: HttpClient;

  constructor(
    aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    httpClient: HttpClient,
  ) {
    super(configManagerPromise);
    this.aiService = aiService;
    this.messageUtils = new MessageUtils(configManagerPromise, httpClient);
    this.httpClient = httpClient;
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const prefixes = getPrefixes();
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();
    const replyMsg = await safeGetReplyMessage(msg);
    const replyToId = replyMsg?.id;

    const subCommand = args[1]?.toLowerCase();
    if (subCommand === "preview") {
      const state = args[2]?.toLowerCase();
      if (!state) {
        await this.editMessage(
          msg,
          `🖼️ <b>图片预览状态:</b><br><br>📄 当前状态: ${config.imagePreview ? "开启" : "关闭"}`,
        );
        return;
      }
      requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
      await configManager.updateConfig((cfg) => {
        cfg.imagePreview = state === "on";
      });
      await this.editMessage(
        msg,
        `✅ 图片预览已${state === "on" ? "开启" : "关闭"}`,
      );
      return;
    }

    const promptInput = args.slice(1).join(" ").trim();
    const replyText = getMessageText(replyMsg).trim();
    const replyImageParts = await getMessageImageParts(replyMsg);
    const messageImageParts = await getMessageImageParts(msg);
    const imageParts = [...replyImageParts, ...messageImageParts];

    const hasPrompt = !!promptInput || !!replyText;
    requireUser(hasPrompt, "至少需要一条文字提示");

    if (
      !config.currentImageTag ||
      !config.currentImageModel ||
      !config.configs[config.currentImageTag]
    ) {
      throw new UserError(
        `请先配置 API 并设置模型<br>使用 ${prefixes[0]}ai config add <tag> <url> <key> [type] 和 ${prefixes[0]}ai model image <tag> <model-path>`,
      );
    }

    const token = this.aiService.createAbortToken();
    await sendProcessing(msg, "image");

    try {
      let prompt = "";
      if (promptInput && replyText && replyImageParts.length === 0) {
        prompt = `${replyText}<br><br>${promptInput}`;
      } else if (promptInput && replyImageParts.length > 0) {
        prompt = promptInput;
      } else if (promptInput) {
        prompt = promptInput;
      } else {
        prompt = replyText;
      }

      let images: AIImage[] = [];
      if (imageParts.length > 0) {
        let inputImage = await resolveImagePart(
          imageParts,
          this.httpClient,
          token,
        );
        if (!inputImage?.data) throw new Error("无法解析图片数据");
        if (inputImage.data && inputImage.mimeType !== "image/png") {
          try {
            const pngBuffer = await sharp(inputImage.data).png().toBuffer();
            inputImage = { data: pngBuffer, mimeType: "image/png" };
          } catch (convertError) {
            console.warn(`[ai] Image conversion to PNG failed, using original: ${convertError}`);
          }
        }
        images = await this.aiService.editImage(prompt, inputImage, token);
      } else {
        images = await this.aiService.generateImage(prompt, token);
      }
      if (images.length === 0) throw new Error("AI 回复为空");
      await this.messageUtils.sendImages(msg, images, prompt, replyToId, token);
      await deleteMessageOrGroup(msg);
    } finally {
      this.aiService.releaseToken(token);
    }
  }
}

class VideoFeature extends BaseFeatureHandler {
  readonly name = "视频生成";
  readonly command = "video";
  readonly description = "生成视频";

  private aiService: AIService;
  private messageUtils: MessageUtils;

  constructor(
    aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    httpClient: HttpClient,
  ) {
    super(configManagerPromise);
    this.aiService = aiService;
    this.messageUtils = new MessageUtils(configManagerPromise, httpClient);
  }

  async execute(
    msg: Api.Message,
    args: string[],
    _prefixes: string[],
  ): Promise<void> {
    const prefixes = getPrefixes();
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();
    const replyMsg = await safeGetReplyMessage(msg);
    const replyToId = replyMsg?.id;

    const subCommand = args[1]?.toLowerCase();
    let imageMode: VideoImageMode = "auto";
    let promptStartIndex = 1;
    if (subCommand === "preview") {
      const state = args[2]?.toLowerCase();
      if (!state) {
        await this.editMessage(
          msg,
          `🎬 <b>视频预览状态:</b><br><br>📄 当前状态: ${config.videoPreview ? "开启" : "关闭"}`,
        );
        return;
      }
      requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
      await configManager.updateConfig((cfg) => {
        cfg.videoPreview = state === "on";
      });
      await this.editMessage(
        msg,
        `✅ 视频预览已${state === "on" ? "开启" : "关闭"}`,
      );
      return;
    }
    if (subCommand === "audio") {
      const state = args[2]?.toLowerCase();
      if (!state) {
        await this.editMessage(
          msg,
          `🔊 <b>视频音频状态:</b><br><br>📄 当前状态: ${config.videoAudio ? "开启" : "关闭"}`,
        );
        return;
      }
      requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
      await configManager.updateConfig((cfg) => {
        cfg.videoAudio = state === "on";
      });
      await this.editMessage(
        msg,
        `✅ 视频音频已${state === "on" ? "开启" : "关闭"}`,
      );
      return;
    }
    if (subCommand === "duration") {
      const duration = parseInt(args[2]);
      if (!args[2]) {
        await this.editMessage(
          msg,
          `⏱️ <b>视频时长:</b><br><br>⏰ 当前时长: <code>${config.videoDuration} 秒</code>`,
        );
        return;
      }
      requireUser(
        !isNaN(duration) && duration >= 5 && duration <= 20,
        "时长必须是 5-20 的整数",
      );
      await configManager.updateConfig((cfg) => {
        cfg.videoDuration = duration;
      });
      await this.editMessage(msg, `✅ 视频时长已设置为 ${duration} 秒`);
      return;
    }
    if (subCommand === "first") {
      imageMode = "first";
      promptStartIndex = 2;
    } else if (subCommand === "firstlast") {
      imageMode = "firstlast";
      promptStartIndex = 2;
    }

    const promptInput = args.slice(promptStartIndex).join(" ").trim();
    const replyText = getMessageText(replyMsg).trim();

    const replyImageParts = await getMessageImageParts(replyMsg);
    const messageImageParts = await getMessageImageParts(msg);

    let finalPrompt = "";
    if (promptInput && replyText && replyImageParts.length === 0) {
      finalPrompt = `${replyText}<br><br>${promptInput}`;
    } else if (promptInput && replyImageParts.length > 0) {
      finalPrompt = promptInput;
    } else if (promptInput) {
      finalPrompt = promptInput;
    } else {
      finalPrompt = replyText;
    }

    const allImageParts = [...replyImageParts, ...messageImageParts];
    const hasPrompt = !!finalPrompt.trim();

    requireUser(hasPrompt || allImageParts.length > 0, "至少需要一条提示");

    if (
      !config.currentVideoTag ||
      !config.currentVideoModel ||
      !config.configs[config.currentVideoTag]
    ) {
      throw new UserError(
        `请先配置 API 并设置模型<br>使用 ${prefixes[0]}ai config add <tag> <url> <key> [type] 和 ${prefixes[0]}ai model video <tag> <model-path>`,
      );
    }

    const token = this.aiService.createAbortToken();
    await sendProcessing(msg, "video");

    try {
      let imageParts = allImageParts;

      if (imageMode === "firstlast" && allImageParts.length < 2) {
        if (allImageParts.length === 1) {
          imageMode = "first";
        } else if (hasPrompt) {
          imageMode = "auto";
          imageParts = [];
        }
      }

      if (imageMode === "first" && allImageParts.length < 1) {
        if (hasPrompt) {
          imageMode = "auto";
          imageParts = [];
        }
      }
      if (imageMode === "first") {
        imageParts = allImageParts.slice(0, 1);
      } else if (imageMode === "firstlast") {
        imageParts = allImageParts.slice(0, 2);
      } else if (allImageParts.length > 0) {
        imageMode = "reference";
        imageParts = allImageParts.slice(0, 4);
      }

      const videos = await this.aiService.generateVideo(
        finalPrompt,
        imageParts,
        imageMode,
        token,
      );
      if (videos.length === 0) throw new Error("AI 回复为空");
      await this.messageUtils.sendVideos(
        msg,
        videos,
        finalPrompt,
        replyToId,
        token,
      );
      await deleteMessageOrGroup(msg);
    } finally {
      this.aiService.releaseToken(token);
    }
  }
}

class AIPlugin extends Plugin {
  name = "ai";

  private cleanedUp = false;

  private aiService: AIService;
  private httpClient: HttpClient;
  private featureRegistry: FeatureRegistry;
  private questionFeature: QuestionFeature;
  private configManagerPromise: Promise<ConfigManager>;

  constructor() {
    super();
    this.configManagerPromise = ConfigManager.getInstance();
    this.httpClient = new HttpClient(this.configManagerPromise);
    this.aiService = new AIService(this.configManagerPromise, this.httpClient);
    this.featureRegistry = new FeatureRegistry();
    this.questionFeature = new QuestionFeature(
      this.aiService,
      this.configManagerPromise,
      this.httpClient,
    );
    this.registerFeatures();
  }

  private getMainPrefix(): string {
    const prefixes = getPrefixes();
    return prefixes[0] || "";
  }

  private registerFeatures(): void {
    this.featureRegistry.register(new ConfigFeature(this.configManagerPromise));
    this.featureRegistry.register(new ModelFeature(this.configManagerPromise));
    this.featureRegistry.register(new PromptFeature(this.configManagerPromise));
    this.featureRegistry.register(
      new CollapseFeature(this.configManagerPromise),
    );
    this.featureRegistry.register(
      new TelegraphFeature(this.configManagerPromise),
    );
    this.featureRegistry.register(
      new TimeoutFeature(this.configManagerPromise),
    );
    this.featureRegistry.register(
      new SearchFeature(
        this.aiService,
        this.configManagerPromise,
        this.httpClient,
      ),
    );
    this.featureRegistry.register(
      new ImageFeature(
        this.aiService,
        this.configManagerPromise,
        this.httpClient,
      ),
    );
    this.featureRegistry.register(
      new VideoFeature(
        this.aiService,
        this.configManagerPromise,
        this.httpClient,
      ),
    );
  }

  description = async (): Promise<string> => {
    const mainPrefix = this.getMainPrefix();
    const config = (await this.configManagerPromise).getConfig();

    const baseDescription = `<b>🤖 智能 AI 助手</b>

<b>⚙️ API 配置:</b>
• <code>${mainPrefix}ai config add tag url key [type]</code> - 添加 API 配置
• <code>${mainPrefix}ai config del tag</code> - 删除 API 配置
• <code>${mainPrefix}ai config type tag openai-compatible|openai|gemini|doubao|moonshot|local-cliproxy</code> - 设置 API 类型. 若不设置, 自动按 URL 特征自动识别
• <code>${mainPrefix}ai config stream tag on|off</code> - 设置 API 流式传输
• <code>${mainPrefix}ai config responses tag on|off</code> - 设置 chat/search 的 Responses 模式
• <code>type</code> 可选值: <code>${PROVIDER_TYPE_OPTIONS}</code>

<b>🧠 模型设置:</b>
• <code>${mainPrefix}ai model chat tag model-path</code> - 设置聊天模型
• <code>${mainPrefix}ai model search tag model-path</code> - 设置搜索模型
• <code>${mainPrefix}ai model image tag model-path</code> - 设置图片模型
• <code>${mainPrefix}ai model video tag model-path</code> - 设置视频模型

<b>💬 提问:</b>
• <code>${mainPrefix}ai input</code> - 向 AI 发起提问
• <code>${mainPrefix}ai search input</code> - 联网搜索并回答
• <code>${mainPrefix}ai image prompt</code> - 文生/编辑图片
• <code>${mainPrefix}ai video prompt</code> - 文生/参考图生成视频
• <code>${mainPrefix}ai video first prompt</code> - 首帧生成视频
• <code>${mainPrefix}ai video firstlast prompt</code> - 首尾帧生成视频

<b>✍️ 提示词:</b>
• <code>${mainPrefix}ai prompt set input</code> - 设置提示词
• <code>${mainPrefix}ai prompt del</code> - 删除提示词

<b>🧩 消息设置:</b>
• <code>${mainPrefix}ai image preview on|off</code> - 开/关图片预览
• <code>${mainPrefix}ai video preview on|off</code> - 开/关视频预览
• <code>${mainPrefix}ai video audio on|off</code> - 开/关视频音频
• <code>${mainPrefix}ai collapse on|off</code> - 开/关消息折叠
• <code>${mainPrefix}ai video duration sec</code> - 视频输出时长
• <code>${mainPrefix}ai timeout sec</code> - 设置超时时间

<b>📰 Telegraph:</b>
• <code>${mainPrefix}ai telegraph on</code> - 开启 Telegraph
• <code>${mainPrefix}ai telegraph off</code> - 关闭 Telegraph
• <code>${mainPrefix}ai telegraph limit integer</code> - 设置容量
• <code>${mainPrefix}ai telegraph del number/all</code> - 删除记录

<b>📌 使用说明:</b>
• 不携带参数可进行查询
• 回复消息可进行补充提问
`;
    if (!config.collapse) return baseDescription;
    return `<blockquote expandable>${baseDescription}</blockquote>`;
  };

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    ai: async (msg: Api.Message, trigger?: Api.Message) => {
      try {
        const prefixes = getPrefixes();
        const args = getMessageText(msg).trim().split(/\s+/).slice(1);

        if (args.length === 0) {
          await this.questionFeature.askFromReply(msg, trigger);
          return;
        }

        const sub = args[0].toLowerCase();
        if (sub === "help" || sub === "?") {
          const description = await this.description();
          await MessageSender.sendOrEdit(trigger || msg, description, {
            parseMode: "html",
          });
          return;
        }
        const handler = this.featureRegistry.getHandler(sub);

        if (handler) await handler.execute(msg, args, prefixes);
        else await this.questionFeature.execute(msg, args, prefixes);
      } catch (error: any) {
        await sendErrorMessage(msg, error, trigger);
      }
    },
  };

  async cleanup(): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;

    this.questionFeature.cancelCurrentOperation();
    await this.aiService.destroy();
    this.httpClient.destroy();
    const configManager = await this.configManagerPromise;
    await configManager.destroy();
  }
}

export default new AIPlugin();
