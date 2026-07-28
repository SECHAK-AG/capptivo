/** Tiny typed i18n with English fallback and `{name}` interpolation. */
import { en, type TranslationKey } from "./en";
import { fr } from "./fr";

export type { TranslationKey };

export type Language = "en" | "fr";

export const LANGUAGES: { readonly id: Language; readonly label: string }[] = [
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
];

export const DEFAULT_LANGUAGE: Language = "en";

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, fr };

export type TranslateParams = Record<string, string | number>;

export function translate(lang: Language, key: TranslationKey, params?: TranslateParams): string {
  const dict = DICTIONARIES[lang] ?? DICTIONARIES.en;
  let text = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

const STORAGE_KEY = "capptivo.language";

function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "fr";
}

export function getStoredLanguage(): Language {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLanguage(raw) ? raw : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function storeLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* best-effort */
  }
}
