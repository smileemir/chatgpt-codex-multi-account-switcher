export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "codex.themeMode";
const MODES = new Set<ThemeMode>(["system", "light", "dark"]);

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && MODES.has(value as ThemeMode);
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? systemTheme() : mode;
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolvedTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
}

export async function getThemeMode(): Promise<ThemeMode> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return isThemeMode(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : "system";
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  if (!isThemeMode(mode)) throw new Error("Invalid theme mode");
  await chrome.storage.local.set({ [STORAGE_KEY]: mode });
  applyTheme(mode);
}

export async function initializeTheme(): Promise<() => void> {
  const mode = await getThemeMode();
  applyTheme(mode);
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (document.documentElement.dataset.themeMode === "system") applyTheme("system");
  };
  media?.addEventListener?.("change", onSystemChange);
  return () => media?.removeEventListener?.("change", onSystemChange);
}
