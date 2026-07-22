/**
 * TeleBox Panel public barrel.
 * Plugins can: import { registerPanelSettings } from "@utils/panel";
 */

export type {
  PanelAdmin,
  PanelConfig,
  PanelFieldType,
  PanelSettingField,
  PanelSettingsProvider,
  PanelSession,
  PanelStatusSnapshot,
  TpmRemotePlugin,
  TpmInstalledPlugin,
  HelpCommandInfo,
  LoadedPluginInfo,
} from "./types";

export {
  registerPanelSettings,
  unregisterPanelSettings,
  listPanelSettingsProviders,
  getPanelSettingsProvider,
  getProviderSnapshot,
  applyProviderValues,
} from "./settingsRegistry";

export {
  readPanelConfig,
  updatePanelConfig,
  setPanelEnabled,
  setPanelBotToken,
  listPanelAdmins,
  addPanelAdmin,
  removePanelAdmin,
  maskToken,
} from "./configStore";

export {
  applyPanelRuntimeFromConfig,
  shutdownPanelRuntime,
  ensurePanelProviders,
} from "./controller";
