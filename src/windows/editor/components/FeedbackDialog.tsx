/**
 * Feedback & contact dialog — opened from the editor title bar.
 * Links open in the system browser / mail client via plugin-opener.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { Bug, ExternalLink, Linkedin, Mail } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";

const EMAIL = "idbouid@gmail.com";
const LINKEDIN_URL = "https://www.linkedin.com/in/abdessamad-idboussadel/";
const X_URL = "https://x.com/idboussadel37";
const X_HANDLE = "@idboussadel37";
const ISSUES_URL = "https://github.com/SECHAK-AG/capptivo/issues";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function openExternal(url: string) {
  void openUrl(url).catch(() => undefined);
}

/** Minimal X (Twitter) mark — lucide has no brand glyph for it. */
function XLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={className}
      fill="currentColor"
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

type ContactRowProps = {
  label: string;
  value: string;
  onClick: () => void;
  icon: ReactNode;
};

function ContactRow({ label, value, onClick, icon }: ContactRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
        "hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </span>
        <span className="block truncate text-sm font-medium text-foreground">
          {value}
        </span>
      </span>
      <ExternalLink
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}

export function FeedbackDialog({ open, onOpenChange }: Props) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 border-border bg-card p-5 sm:max-w-sm">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Bug className="size-3.5" aria-hidden />
            </span>
            {t("feedback.title")}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t("feedback.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-2xl border border-border bg-background/60 p-1">
          <ContactRow
            label={t("feedback.email")}
            value={EMAIL}
            icon={<Mail className="size-4" aria-hidden />}
            onClick={() => openExternal(`mailto:${EMAIL}`)}
          />
          <ContactRow
            label={t("feedback.linkedin")}
            value="abdessamad-idboussadel"
            icon={<Linkedin className="size-4" aria-hidden />}
            onClick={() => openExternal(LINKEDIN_URL)}
          />
          <ContactRow
            label={t("feedback.x")}
            value={X_HANDLE}
            icon={<XLogo className="size-3.5" />}
            onClick={() => openExternal(X_URL)}
          />
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-between gap-3 rounded-xl px-3.5"
          onClick={() => openExternal(ISSUES_URL)}
        >
          <span className="flex items-center gap-2.5">
            <Bug className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">{t("feedback.reportIssue")}</span>
          </span>
          <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
        </Button>
      </DialogContent>
    </Dialog>
  );
}
