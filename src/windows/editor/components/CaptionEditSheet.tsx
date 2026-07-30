/**
 * "Edit text" opens a right sheet with every caption cue.
 * Drafts stay local until Submit — one store write / persist.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { CaptionCue } from "@/captions/types";
import { cn } from "../lib/cn";

function formatCueClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function draftsFromCaptions(captions: CaptionCue[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const c of captions) next[c.id] = c.text;
  return next;
}

type Props = {
  captions: CaptionCue[];
  onSubmit: (updates: { id: string; text: string }[]) => void;
  onSeek: (timeSec: number) => void;
};

export function CaptionEditSheet({ captions, onSubmit, onSeek }: Props) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) setDrafts(draftsFromCaptions(captions));
  }, [open, captions]);

  if (captions.length === 0) return null;

  const submit = () => {
    const updates: { id: string; text: string }[] = [];
    for (const cue of captions) {
      const text = drafts[cue.id];
      if (text === undefined) continue;
      updates.push({ id: cue.id, text });
    }
    onSubmit(updates);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={() => setOpen(true)}
      >
        Edit text
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="gap-0 p-0 sm:max-w-md">
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border p-5">
              <SheetTitle className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
                Edit captions
              </SheetTitle>
              <SheetDescription className="text-[11px] leading-snug">
                Fix Whisper typos. Timings stay; word highlight is kept when the
                word count still matches.
              </SheetDescription>
            </SheetHeader>

            <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
              {captions.map((cue) => (
                <li key={cue.id} className="space-y-1.5">
                  <button
                    type="button"
                    className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => onSeek(cue.startMs / 1000)}
                  >
                    {formatCueClock(cue.startMs)}–{formatCueClock(cue.endMs)}
                  </button>
                  <textarea
                    value={drafts[cue.id] ?? cue.text}
                    rows={3}
                    spellCheck
                    aria-label={`Caption from ${formatCueClock(cue.startMs)}`}
                    className={cn(
                      "w-full resize-y rounded-md border border-border bg-background px-3 py-2",
                      "text-sm leading-snug text-foreground outline-none",
                      "focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                    onFocus={() => onSeek(cue.startMs / 1000)}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [cue.id]: e.target.value }))
                    }
                  />
                </li>
              ))}
            </ul>

            <SheetFooter className="p-5">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={submit}>
                Submit
              </Button>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
