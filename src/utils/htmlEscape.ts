/**
 * Shared HTML escaping utility for Telegram Bot API HTML parse mode.
 *
 * Prefer this over a local `htmlEscape` in every plugin:
 *   import { htmlEscape } from "@utils/htmlEscape";
 *
 * Escapes: & < > " '
 */
export function htmlEscape(text: string | number | unknown): string {
  if (text === null || text === undefined) return "";
  return String(text).replace(/[&<>"']/g, (m) =>
    (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#x27;",
      } as Record<string, string>
    )[m] || m
  );
}
