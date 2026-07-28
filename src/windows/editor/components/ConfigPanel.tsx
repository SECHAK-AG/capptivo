/**
 * Config inspector panel — appearance (light / dark / system) and language.
 * Preferences are persisted and applied app-wide by the settings provider.
 */

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { LANGUAGES, type TranslationKey } from "@/lib/i18n";
import { useI18n, useTheme } from "@/lib/settings";
import type { ThemeMode } from "@/lib/theme";

import { SectionLabel } from "./ui";

const THEME_OPTIONS: { mode: ThemeMode; icon: LucideIcon; labelKey: TranslationKey }[] = [
  { mode: "light", icon: Sun, labelKey: "config.theme.light" },
  { mode: "dark", icon: Moon, labelKey: "config.theme.dark" },
  { mode: "system", icon: Monitor, labelKey: "config.theme.system" },
];

export function ConfigPanel({ visible = true }: { visible?: boolean }) {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div className={cn("flex flex-col gap-7", !visible && "hidden")}>
      <section className="space-y-2">
        <SectionLabel>{t("config.appearance.title")}</SectionLabel>
        <p className="text-xs text-muted-foreground">{t("config.appearance.desc")}</p>
        <div role="radiogroup" aria-label={t("config.appearance.title")} className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ mode, icon: Icon, labelKey }) => {
            const selected = theme === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(mode)}
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-lg border bg-muted/40 px-3 py-4 text-sm font-medium transition-colors",
                  selected
                    ? "border-primary text-foreground ring-2 ring-primary/40"
                    : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                <Icon className="size-5" strokeWidth={1.75} />
                {t(labelKey)}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel>{t("config.language.title")}</SectionLabel>
        <p className="text-xs text-muted-foreground">{t("config.language.desc")}</p>
        <div
          role="radiogroup"
          aria-label={t("config.language.title")}
          className="inline-flex w-full items-center rounded-xl bg-muted p-1"
        >
          {LANGUAGES.map(({ id, label }) => (
            <LanguagePill
              key={id}
              label={label}
              selected={language === id}
              onSelect={() => setLanguage(id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function LanguagePill({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "min-w-0 flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
        selected
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}
