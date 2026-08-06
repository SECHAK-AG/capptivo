/**
 * Custom in-window title bar. macOS keeps the native overlay traffic lights;
 * Windows/Linux run fully undecorated (see `editor_window_builder`), so this
 * bar also renders minimize/maximize/close controls there.
 * Interactive controls sit above the drag layer so clicks reach buttons.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, Bug, Minus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { isMacOS as isMacOs } from "@/lib/platform";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";

import { EditorPresetsControl } from "./EditorPresetsControl";
import { ExportVideoButton } from "./ExportVideoButton";
import { FeedbackDialog } from "./FeedbackDialog";

/** Must stay in sync with `EDITOR_TITLE_BAR_HEIGHT` in `src-tauri/src/windows.rs` (44px). */
const EDITOR_TITLE_BAR_HEIGHT_CLASS = "h-11";

/** Room for native traffic lights when `TitleBarStyle::Overlay` is enabled. */
const MACOS_CHROME_INSET_PX = 76;

/** Minimize / maximize / close for undecorated windows (Windows + Linux). */
function WindowControls() {
  const win = getCurrentWindow();
  const buttonClass =
    "pointer-events-auto flex h-8 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
  return (
    <div className="ml-2 flex items-center">
      <button
        type="button"
        aria-label="Minimize"
        className={buttonClass}
        onClick={() => void win.minimize().catch(() => undefined)}
      >
        <Minus className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        className={buttonClass}
        onClick={() => void win.toggleMaximize().catch(() => undefined)}
      >
        <Square className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Close"
        className={cn(
          buttonClass,
          "hover:bg-red-500/90 hover:text-white dark:hover:bg-red-600/90",
        )}
        onClick={() => void win.close().catch(() => undefined)}
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

type Props = {
  title: string;
  /** When set, a back button leads the bar (library shell with a project open). */
  onBack?: () => void;
  /** When set, title is click-to-edit. Empty string clears the saved title. */
  onRename?: (next: string) => void;
  /** Value seeded into the input (use "" for untitled so the field starts empty). */
  renameSeed?: string;
  exportError?: string | null;
  exporting?: boolean;
  exportDisabled?: boolean;
  onExport?: () => void;
  showExport?: boolean;
  /** Named look presets (editor shell only). */
  showPresets?: boolean;
};

function TitleDisplay({ title }: { title: string }) {
  const dot = title.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < title.length - 1;

  if (!hasExtension) {
    return (
      <span className="min-w-0 truncate text-sm font-medium leading-8 text-foreground">
        {title}
      </span>
    );
  }

  return (
    <span className="min-w-0 truncate text-sm font-medium leading-8 text-foreground">
      <span>{title.slice(0, dot)}</span>
      <span className="text-muted-foreground">{title.slice(dot)}</span>
    </span>
  );
}

function EditableTitle({
  title,
  renameSeed,
  onRename,
}: {
  title: string;
  renameSeed: string;
  onRename: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(renameSeed);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurCommit = useRef(false);

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const startEditing = () => {
    setDraft(renameSeed);
    skipBlurCommit.current = false;
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    const prev = renameSeed.trim();
    if (next === prev) return;
    onRename(next);
  };

  const cancel = () => {
    skipBlurCommit.current = true;
    setEditing(false);
    setDraft(renameSeed);
  };

  if (editing) {
    return (
      <div className="flex min-w-0 max-w-[min(100%,28rem)] items-center gap-2">
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          aria-hidden
        />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (skipBlurCommit.current) {
              skipBlurCommit.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              skipBlurCommit.current = true;
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          aria-label="Rename recording"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-0.5 text-center text-sm font-medium text-foreground outline-none ring-1 ring-primary/40"
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      className="flex min-w-0 max-w-[min(100%,28rem)] items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-muted/50"
      title="Rename"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
      <TitleDisplay title={title} />
    </button>
  );
}

export function EditorTitleBar({
  title,
  onBack,
  onRename,
  renameSeed,
  exportError = null,
  exporting = false,
  exportDisabled = false,
  onExport,
  showExport = false,
  showPresets = false,
}: Props) {
  const { t } = useI18n();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => undefined);
  }, [title]);

  return (
    <header
      className={cn(
        "relative flex shrink-0 items-center justify-end border-b border-border box-border py-px pr-3",
        EDITOR_TITLE_BAR_HEIGHT_CLASS,
        isMacOs ? "pl-3" : "pl-4",
      )}
      style={isMacOs ? { paddingLeft: MACOS_CHROME_INSET_PX } : undefined}
    >
      {/* Drag region must not cover macOS traffic lights — overlay chrome sits
          in the left inset and a full-bleed drag layer steals their clicks. */}
      <div
        className="absolute inset-y-0 right-0"
        style={{ left: isMacOs ? MACOS_CHROME_INSET_PX : 0 }}
        data-tauri-drag-region
        aria-hidden
      />

      {onBack ? (
        <div className="relative z-10 mr-auto flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t("library.back")}
          </Button>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-px bottom-px flex items-center justify-center px-24">
        <div className="pointer-events-auto">
          {onRename ? (
            <EditableTitle
              title={title}
              renameSeed={renameSeed ?? title}
              onRename={onRename}
            />
          ) : (
            <div className="flex min-w-0 max-w-[min(100%,28rem)] items-center gap-2">
              <span
                className="size-1.5 shrink-0 rounded-full bg-primary"
                aria-hidden
              />
              <TitleDisplay title={title} />
            </div>
          )}
        </div>
      </div>

      <div className="relative z-10 flex shrink-0 items-center gap-2">
        {exportError ? (
          <p
            className="pointer-events-auto max-w-[14rem] truncate text-xs text-amber-600 dark:text-amber-400"
            title={exportError}
          >
            {exportError}
          </p>
        ) : null}
        {showPresets ? <EditorPresetsControl /> : null}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          aria-label={t("feedback.open")}
          title={t("feedback.open")}
          onClick={() => setFeedbackOpen(true)}
        >
          <Bug className="size-4" aria-hidden />
        </Button>
        {showExport && onExport ? (
          <ExportVideoButton
            exporting={exporting}
            disabled={exportDisabled}
            onExport={onExport}
          />
        ) : null}
        {!isMacOs ? <WindowControls /> : null}
      </div>

      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
}
