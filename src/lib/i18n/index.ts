/** Tiny typed i18n with English fallback and `{name}` interpolation. */
import { ar } from "./ar";
import { en, type TranslationKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { zh } from "./zh";

export type { TranslationKey };

export type Language = "en" | "fr" | "es" | "ar" | "zh";

/** Native labels — shown in the picker so users can find their language. */
export const LANGUAGES: { readonly id: Language; readonly label: string }[] = [
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
  { id: "ar", label: "العربية" },
  { id: "zh", label: "中文" },
];

export const DEFAULT_LANGUAGE: Language = "en";

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = {
  en,
  fr,
  es,
  ar,
  zh,
};

const LANGUAGE_IDS = new Set<string>(LANGUAGES.map((l) => l.id));

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

/** Document text direction for the active UI language. */
export function languageDir(lang: Language): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

const STORAGE_KEY = "capptivo.language";

function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && LANGUAGE_IDS.has(value);
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
