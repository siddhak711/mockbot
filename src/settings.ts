export const SETTINGS_SECTIONS = [
  { id: "agents", label: "Agents" },
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "workspace", label: "Model & workspace" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}
