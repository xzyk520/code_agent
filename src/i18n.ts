export type Locale = "zh" | "en";

export const LANGUAGE_SETTING = "beeCode.ui.language";

export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : "zh";
}

/** Pick the localized string for user-visible output. Model-facing prompts are English-only. */
export function tr(locale: Locale, zh: string, en: string): string {
  return locale === "en" ? en : zh;
}
