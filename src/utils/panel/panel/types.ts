/**
 * TeleBox Panel — shared types (local-only module).
 */

export interface PanelAdmin {
  userId: number;
  note?: string;
  addedAt: number;
}

export interface PanelConfig {
  /** Master switch. When false the bot + HTTP server stay down. */
  enabled: boolean;
  /** Bot API token for the companion management bot. */
  botToken: string;
  /** Public HTTPS base URL that Telegram WebApp can open (e.g. https://panel.example.com). */
  publicBaseUrl: string;
  /** Local HTTP bind host. */
  bindHost: string;
  /** Local HTTP bind port. */
  bindPort: number;
  /** HMAC secret for panel session tokens (auto-generated). */
  sessionSecret: string;
  /** Extra admins who may open the WebApp (owner is always allowed). */
  admins: PanelAdmin[];
  /** Optional display name override shown in the WebApp header. */
  displayName: string;
  updatedAt: number;
  /** Tunnel mode: "manual" | "cloudflare" | "off" */
  tunnelMode: "manual" | "cloudflare" | "off";
  /** Last known cloudflare tunnel URL (read-only). */
  tunnelUrl: string;
}

export type PanelFieldType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "textarea"
  | "json"
  | "password"
  | "provider-list"
  | "prompt-map"
  | "tag-list";

export interface PanelSettingField {
  key: string;
  label: string;
  type: PanelFieldType;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  /** Hide value in UI responses (still writable). */
  secret?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  /** For provider-list: pipe-separated columns to show */
  providerColumns?: string;
  /** For provider-list: label for add button */
  providerAddLabel?: string;
  /** For prompt-map: placeholder for key/short name */
  promptKeyPlaceholder?: string;
  /** For prompt-map: placeholder for value/prompt */
  promptValuePlaceholder?: string;
  /** For tag-list: placeholder */
  tagPlaceholder?: string;
  /** For tag-list: whether tags can be duplicated */
  tagAllowDuplicates?: boolean;
}

export interface PanelSettingsProvider {
  /** Stable unique id, e.g. "prefix" / "status" / "acn". */
  id: string;
  title: string;
  description?: string;
  /** Grouping label in the settings list. */
  category?: string;
  /** Optional icon emoji for UI. */
  icon?: string;
  getSchema: () => PanelSettingField[] | Promise<PanelSettingField[]>;
  getValues: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  setValues: (
    patch: Record<string, unknown>,
  ) => void | Promise<void>;
}

export interface PanelSession {
  userId: number;
  username?: string;
  firstName?: string;
  exp: number;
}

export interface PanelStatusSnapshot {
  enabled: boolean;
  botConfigured: boolean;
  botRunning: boolean;
  httpRunning: boolean;
  publicBaseUrl: string;
  bind: string;
  adminCount: number;
  ownerId: number | null;
  version: string;
  pluginCount: number;
  commandCount: number;
}

export interface TpmRemotePlugin {
  name: string;
  url: string;
  desc: string;
  status: "installed" | "local" | "remote";
  source?: "official" | "custom";
}

export interface TpmInstalledPlugin {
  name: string;
  url?: string;
  desc?: string;
  updatedAt?: number;
  hasFile: boolean;
  fileSize?: number;
}

export interface HelpCommandInfo {
  command: string;
  aliases: string[];
  description: string;
  handlers: string[];
  hasCron: boolean;
  pluginName?: string;
  isSystem: boolean;
}

export interface LoadedPluginInfo {
  name: string;
  commands: string[];
  description: string;
  isSystem: boolean;
  hasSettings: boolean;
  hasCron: boolean;
}
