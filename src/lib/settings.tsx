/**
 * App settings (appearance + language) exposed through one context. The provider
 * keeps the resolved theme in sync with the OS when the mode is `system`, persists
 * both preferences, and reflects the language on <html lang>.
 */
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

  // Apply + persist theme whenever the mode changes.
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    storeTheme(theme);
  }, [theme]);

  // Track OS appearance while following the system.
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

  // Persist + reflect the language on <html lang> (covers the initial value too).
  useEffect(() => {
    storeLanguage(language);
    if (typeof document !== "undefined") document.documentElement.lang = language;
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
