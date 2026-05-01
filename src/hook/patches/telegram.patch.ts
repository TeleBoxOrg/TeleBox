import { Api } from "teleproto/tl";
import { sleep } from "teleproto/Helpers";

const { HTMLParser } = require("teleproto/extensions/html");

const ENTITY_SENTINELS = {
  lt: "\uE000",
  gt: "\uE001",
  amp: "\uE002",
  quot: "\uE003",
  apos: "\uE004",
} as const;

function protectHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, ENTITY_SENTINELS.lt)
    .replace(/&gt;/g, ENTITY_SENTINELS.gt)
    .replace(/&quot;/g, ENTITY_SENTINELS.quot)
    .replace(/&#39;/g, ENTITY_SENTINELS.apos)
    .replace(/&amp;/g, ENTITY_SENTINELS.amp);
}

function restoreHtmlEntities(input: string): string {
  return input
    .replace(new RegExp(ENTITY_SENTINELS.lt, "g"), "<")
    .replace(new RegExp(ENTITY_SENTINELS.gt, "g"), ">")
    .replace(new RegExp(ENTITY_SENTINELS.quot, "g"), '"')
    .replace(new RegExp(ENTITY_SENTINELS.apos, "g"), "'")
    .replace(new RegExp(ENTITY_SENTINELS.amp, "g"), "&");
}

const originalHtmlParse = HTMLParser.parse.bind(HTMLParser);

HTMLParser.parse = function patchedHtmlParse(html: string) {
  const [text, entities] = originalHtmlParse(protectHtmlEntities(html));
  return [restoreHtmlEntities(text), entities];
};

Api.Message.prototype.deleteWithDelay = async function (
  delay: number,
  shouldThrowError: boolean
) {
  await sleep(delay);
  try {
    return this.delete();
  } catch (e) {
    console.error(e);
    if (shouldThrowError) {
      throw e;
    }
  }
};

Api.Message.prototype.safeDelete = async function (
  { revoke }: { revoke: boolean } = { revoke: false }
) {
  try {
    return this.delete({ revoke });
  } catch (error) {
    console.log("safeDelete catch error:", error);
  }
};
