/** App settings context — theme, language, persistence, and `<html lang>`. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_LANGUAGE,
  getStoredLanguage,
  languageDir,
  storeLanguage,
  translate,
  type Language,
  type TranslateParams,
  type TranslationKey,
} from "./i18n";
import {
  applyTheme,
  getStoredTheme,
  resolveTheme,
  storeTheme,
  systemTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme";

type Translate = (key: TranslationKey, params?: TranslateParams) => string;

type SettingsContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translate;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(getStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));
  const [language, setLanguageState] = useState<Language>(getStoredLanguage);

  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    storeTheme(theme);
  }, [theme]);

  // Other Capptivo webviews (annotation overlay, etc.) pick up theme changes
  // written by the editor — `storage` only fires in *other* documents.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      setTheme(getStoredTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const resolved = systemTheme();
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    storeLanguage(language);
    if (typeof document !== "undefined") {
      document.documentElement.lang = language;
      document.documentElement.dir = languageDir(language);
    }
  }, [language]);

  const setLanguage = useCallback((next: Language) => setLanguageState(next), []);

  const t = useCallback<Translate>((key, params) => translate(language, key, params), [language]);

  const value = useMemo<SettingsContextValue>(
    () => ({ theme, resolvedTheme, setTheme, language, setLanguage, t }),
    [theme, resolvedTheme, language, setLanguage, t],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within a SettingsProvider");
  return ctx;
}

/** Translation helper + current language. */
export function useI18n() {
  const { t, language, setLanguage } = useSettings();
  return { t, language, setLanguage };
}

/** Appearance mode + resolved theme. */
export function useTheme() {
  const { theme, resolvedTheme, setTheme } = useSettings();
  return { theme, resolvedTheme, setTheme };
}
