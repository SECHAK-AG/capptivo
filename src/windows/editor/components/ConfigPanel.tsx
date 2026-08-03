/**
 * Config inspector panel — appearance (light / dark / system), language, and
 * installed app version. Preferences are persisted and applied app-wide by the
 * settings provider.
 */

import { getVersion } from "@tauri-apps/api/app";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { LANGUAGES, type Language, type TranslationKey } from "@/lib/i18n";
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
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getVersion().then((next) => {
      if (!cancelled) setVersion(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <Select
          value={language}
          onValueChange={(v) => setLanguage(v as Language)}
        >
          <SelectTrigger
            className="h-9 w-full"
            aria-label={t("config.language.title")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map(({ id, label }) => (
              <SelectItem key={id} value={id}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section className="space-y-2">
        <SectionLabel>{t("config.about.title")}</SectionLabel>
        {version ? (
          <p className="text-sm tabular-nums text-foreground">
            {t("config.about.version", { version })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
