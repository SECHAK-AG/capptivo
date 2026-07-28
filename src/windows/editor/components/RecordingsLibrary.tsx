/**
 * In-editor recordings grid. Posters are small JPEGs written at record-time
 * (`thumbnail.jpg`); the library never decodes screen.mp4.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commands } from "@/ipc/bindings";
import type { ProjectSummary } from "@/ipc/types";
import { cn } from "@/lib/utils";
import { mediaUrl } from "../store";

function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(d);
}

function displayTitle(p: ProjectSummary): string {
  return p.title?.trim() || "Untitled recording";
}

/** Poster from `thumbnail.jpg` only — backfill once if the file is missing. */
function RecordingThumb({ projectId, thumbnail }: { projectId: string; thumbnail: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<string | null>(thumbnail);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFile(thumbnail);
    setFailed(false);
  }, [projectId, thumbnail]);

  useEffect(() => {
    if (file || failed) return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        void commands
          .ensureThumbnail(projectId)
          .then((name) => {
            if (!cancelled && name) setFile(name);
            else if (!cancelled) setFailed(true);
          })
          .catch(() => {
            if (!cancelled) setFailed(true);
          });
      },
      { rootMargin: "200px" },
    );
    io.observe(host);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [projectId, file, failed]);

  return (
    <div ref={hostRef} className="aspect-video w-full overflow-hidden bg-secondary">
      {file ? (
        <img
          src={mediaUrl(projectId, file)}
          alt=""
          className="h-full w-full object-cover transition-transform duration-500 ease-out will-change-transform group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          loading="lazy"
          decoding="async"
          onError={() => {
            setFile(null);
            setFailed(true);
          }}
        />
      ) : null}
    </div>
  );
}

type RecordingsLibraryProps = {
  currentProjectId: string | null;
  onOpenProject: (id: string) => void;
};

export function RecordingsLibrary({ currentProjectId, onOpenProject }: RecordingsLibraryProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    try {
      const list = await commands.listProjects();
      startTransition(() => {
        setProjects(list);
        setError(null);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load recordings");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (id: string, title: string) => {
    if (!window.confirm(`Delete “${title}”? This cannot be undone.`)) return;
    setBusyId(id);
    try {
      await commands.deleteProject(id);
      startTransition(() => {
        setProjects((prev) => prev.filter((p) => p.id !== id));
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="mx-auto w-full max-w-6xl shrink-0 px-8 pb-2 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Recordings</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your videos stay on this device. Click a recording to open the editor.
        </p>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-8 pb-12 pt-6">
        {error ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {projects.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            No recordings yet. Capture from the menubar tray, then come back here.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const title = displayTitle(p);
              const busy = busyId === p.id;
              const isCurrent = p.id === currentProjectId;
              return (
                <li key={p.id}>
                  <article
                    className={cn(
                      "group cursor-pointer overflow-hidden rounded-xl border border-border bg-card transition-colors",
                      isCurrent && "ring-1 ring-primary/50",
                    )}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onOpenProject(p.id)}
                      className="block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <RecordingThumb projectId={p.id} thumbnail={p.thumbnail} />
                    </button>

                    <div className="flex items-start gap-2 px-3.5 py-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onOpenProject(p.id)}
                        className="min-w-0 flex-1 cursor-pointer text-left outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="block truncate text-sm font-medium text-foreground">
                          {title}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {formatCreatedAt(p.createdAt)}
                        </span>
                      </button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-muted-foreground"
                            disabled={busy}
                            aria-label={`Actions for ${title}`}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => void remove(p.id, title)}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
