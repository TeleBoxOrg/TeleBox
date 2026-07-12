/** Shared HTML escaping utility for Telegram Bot API HTML parse mode. */
export function htmlEscape(text: string | number | unknown): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
  }[m] || m));
}