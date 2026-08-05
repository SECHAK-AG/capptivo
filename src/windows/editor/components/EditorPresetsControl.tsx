/**
 * Title-bar presets menu — Capptivo recorder-bar chrome (not a floating form card).
 */

import { Bookmark, Check, ChevronDown, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
  loadEditorPresets,
  newPresetId,
  saveEditorPresets,
  serializeEditorPresetLook,
  type EditorPreset,
} from "../lib/editorPresets";
import { useEditorStore } from "../store";

const MENU =
  "rounded-xl border-border/80 bg-popover p-1.5 shadow-lg ring-1 ring-border/40";

export function EditorPresetsControl() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<EditorPreset[]>(() => loadEditorPresets());
  const [nameDraft, setNameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Source of truth for which row is checked — never re-pick by signature. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Look signature right after apply/save; drift from this clears the check. */
  const selectionBaseline = useRef<string | null>(null);

  const look = useEditorStore((s) => s.look);
  const faceCam = useEditorStore((s) => s.faceCam);
  const cursorSettings = useEditorStore((s) => s.cursorSettings);
  const captionSettings = useEditorStore((s) => s.captionSettings);
  const screenContentCrop = useEditorStore((s) => s.screenContentCrop);
  const aspectRatioPresetId = useEditorStore((s) => s.aspectRatioPresetId);
  const selectedBackground = useEditorStore((s) => s.selectedBackground);
  const backgroundType = useEditorStore((s) => s.backgroundType);
  const customBackgroundColor = useEditorStore((s) => s.customBackgroundColor);
  const customGradientStart = useEditorStore((s) => s.customGradientStart);
  const customGradientEnd = useEditorStore((s) => s.customGradientEnd);
  const customGradientAngle = useEditorStore((s) => s.customGradientAngle);

  const currentSignature = useMemo(() => {
    return serializeEditorPresetLook(
      useEditorStore.getState().captureEditorPresetSnapshot(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listed deps form the look signature
  }, [
    look,
    faceCam,
    cursorSettings,
    captionSettings,
    screenContentCrop,
    aspectRatioPresetId,
    selectedBackground,
    backgroundType,
    customBackgroundColor,
    customGradientStart,
    customGradientEnd,
    customGradientAngle,
  ]);

  const activePreset = useMemo(
    () => (activeId ? (presets.find((p) => p.id === activeId) ?? null) : null),
    [activeId, presets],
  );

  // Clear the check only when the canvas look drifts from what we applied/saved.
  useEffect(() => {
    if (!activeId || selectionBaseline.current == null) return;
    if (currentSignature !== selectionBaseline.current) {
      selectionBaseline.current = null;
      setActiveId(null);
    }
  }, [activeId, currentSignature]);

  const pinSelection = useCallback((id: string) => {
    setActiveId(id);
    selectionBaseline.current = serializeEditorPresetLook(
      useEditorStore.getState().captureEditorPresetSnapshot(),
    );
  }, []);

  const handleSave = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const name = nameDraft.trim();
      if (!name) {
        setError(t("presets.nameRequired"));
        return;
      }
      if (presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        setError(t("presets.duplicateName"));
        return;
      }
      const now = new Date().toISOString();
      const next: EditorPreset = {
        id: newPresetId(),
        name,
        createdAt: now,
        updatedAt: now,
        snapshot: useEditorStore.getState().captureEditorPresetSnapshot(),
      };
      const nextPresets = [next, ...presets];
      if (!saveEditorPresets(nextPresets)) {
        setError(t("presets.saveFailed"));
        return;
      }
      setPresets(nextPresets);
      pinSelection(next.id);
      setNameDraft("");
      setError(null);
    },
    [nameDraft, pinSelection, presets, t],
  );

  const handleApply = useCallback(
    (id: string) => {
      const preset = presets.find((p) => p.id === id);
      if (!preset) return;
      useEditorStore.getState().applyEditorPresetSnapshot(preset.snapshot);
      pinSelection(preset.id);
    },
    [pinSelection, presets],
  );

  const handleDelete = useCallback(
    (id: string) => {
      const nextPresets = presets.filter((p) => p.id !== id);
      if (!saveEditorPresets(nextPresets)) {
        setError(t("presets.saveFailed"));
        return;
      }
      setPresets(nextPresets);
      if (activeId === id) {
        selectionBaseline.current = null;
        setActiveId(null);
      }
      setError(null);
    },
    [activeId, presets, t],
  );

  const triggerLabel = activePreset?.name ?? t("presets.label");

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t("presets.open")}
          aria-label={t("presets.open")}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium transition-colors",
            "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
            "data-[state=open]:bg-muted data-[state=open]:text-foreground",
            activePreset && "text-foreground",
          )}
        >
          <Bookmark className="size-3.5 shrink-0 fill-current" aria-hidden />
          <span className="max-w-28 truncate">{triggerLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className={cn(MENU, "w-72")}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <form
          onSubmit={handleSave}
          className="space-y-1.5 px-1 pb-1.5 pt-0.5"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <p className="px-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            {t("presets.saveCurrentAs")}
          </p>
          <div className="flex items-center gap-1.5">
            <input
              value={nameDraft}
              onChange={(e) => {
                setNameDraft(e.target.value);
                if (error) setError(null);
              }}
              className={cn(
                "h-8 min-w-0 flex-1 rounded-lg bg-muted/60 px-2.5 text-xs text-foreground",
                "placeholder:text-muted-foreground/70",
                "outline-none ring-1 ring-border/60 focus:ring-ring/60",
              )}
              placeholder={t("presets.namePlaceholder")}
              aria-label={t("presets.namePlaceholder")}
            />
            <Button
              type="submit"
              size="sm"
              className="h-8 shrink-0 rounded-lg px-3 text-xs font-semibold"
            >
              {t("presets.save")}
            </Button>
          </div>
          {error ? (
            <p className="px-1 text-[11px] text-destructive">{error}</p>
          ) : null}
        </form>

        <DropdownMenuSeparator className="my-1.5 bg-border/80" />

        <div className="px-1 pb-0.5">
          <p className="mb-1 px-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            {t("presets.savedList")}
          </p>
          <div className="max-h-52 space-y-0.5 overflow-y-auto">
            {presets.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t("presets.empty")}
              </p>
            ) : (
              presets.map((preset) => {
                const isActive = preset.id === activePreset?.id;
                return (
                  <div
                    key={preset.id}
                    className={cn(
                      "group flex items-center gap-0.5 rounded-md transition-colors",
                      isActive
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleApply(preset.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                      {isActive ? (
                        <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(preset.id)}
                      className={cn(
                        "mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                        "text-muted-foreground opacity-0 transition-opacity",
                        "hover:bg-muted hover:text-foreground",
                        "group-hover:opacity-100 focus-visible:opacity-100",
                      )}
                      aria-label={t("presets.delete", { name: preset.name })}
                      title={t("presets.delete", { name: preset.name })}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
