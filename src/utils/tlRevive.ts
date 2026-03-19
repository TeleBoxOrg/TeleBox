// 1. Telegram 的 fileReference 可能过期, 所以不存文件只存数据不靠谱. 媒体序列化和还原先放着
// 2. 只有 bot 才能 replyMarkup

import { Api } from "teleproto";

type JsonLike = any;

function isBufferLike(v: any): v is { type: "Buffer"; data: number[] } {
  return (
    v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)
  );
}

function resolveCtor(className: string): any | undefined {
  // Supports names like "MessageEntityBold" or namespaced "messages.SendMessage"
  const parts = className.split(".");
  let cur: any = Api as any;
  for (const p of parts) {
    cur = cur?.[p];
    if (!cur) return undefined;
  }
  return cur;
}

export function reviveTl<T = any>(input: JsonLike): T {
  // Arrays
  if (Array.isArray(input)) {
    // @ts-ignore
    return input.map((i) => reviveTl(i));
  }
  // Buffers serialized by JSON
  if (isBufferLike(input)) {
    // @ts-ignore
    return Buffer.from(input.data);
  }
  // Primitive
  if (!input || typeof input !== "object") {
    // @ts-ignore
    return input;
  }

  // If it looks like a TL JSON object with className/_ markers
  const className: string | undefined =
    (input as any).className || (input as any)._;

  // Recurse into properties first to revive nested children
  const revivedArgs: Record<string, any> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "className" || k === "_") continue;
    revivedArgs[k] = reviveTl(v);
  }

  if (className) {
    const Ctor = resolveCtor(className);
    if (typeof Ctor === "function") {
      // @ts-ignore
      return new Ctor(revivedArgs);
    }
    // If we cannot resolve, fall through and return plain object
  }

  // @ts-ignore
  return revivedArgs as T;
}

export function reviveEntities(
  jsonEntities: JsonLike
): Api.TypeMessageEntity[] | undefined {
  if (!jsonEntities) return undefined;
  const entities = reviveTl<Api.TypeMessageEntity[]>(jsonEntities);
  return entities;
}

export function reviveMedia(
  jsonMedia: JsonLike
): Api.TypeMessageMedia | undefined {
  if (!jsonMedia) return undefined;
  const media = reviveTl<Api.TypeMessageMedia>(jsonMedia);
  // Filter out media types that cannot be resent via sendFile
  if (
    media instanceof Api.MessageMediaWebPage ||
    media instanceof Api.MessageMediaEmpty ||
    media instanceof Api.MessageMediaUnsupported
  ) {
    return undefined;
  }
  return media;
}
