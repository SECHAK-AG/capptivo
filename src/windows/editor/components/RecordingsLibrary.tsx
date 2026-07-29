/**
 * In-editor recordings grid. Posters are small JPEGs written at record-time
 * (`thumbnail.jpg`); the library never decodes screen.mp4.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { MoreHorizontal, Search, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commands } from "@/ipc/bindings";
import type { ProjectSummary } from "@/ipc/types";
import { useI18n } from "@/lib/settings";
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

function matchesNameFilter(project: ProjectSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return displayTitle(project).toLowerCase().includes(needle);
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
  const { t } = useI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [, startTransition] = useTransition();
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredProjects = useMemo(
    () => projects.filter((p) => matchesNameFilter(p, nameFilter)),
    [projects, nameFilter],
  );

  const applyNameFilter = useCallback(() => {
    setNameFilter(searchDraft.trim());
  }, [searchDraft]);

  const clearNameFilter = useCallback(() => {
    setSearchDraft("");
    setNameFilter("");
    searchRef.current?.focus();
  }, []);

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
        {projects.length > 0 ? (
          <form
            className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(e) => {
              e.preventDefault();
              applyNameFilter();
            }}
          >
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                ref={searchRef}
                type="search"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder={t("library.search.placeholder")}
                aria-label={t("library.search.placeholder")}
                className={cn(
                  "h-10 w-full rounded-lg border border-border bg-card py-2 pr-9 pl-9 text-sm text-foreground",
                  "placeholder:text-muted-foreground outline-none transition-colors",
                  "focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30",
                )}
              />
              {nameFilter ? (
                <button
                  type="button"
                  onClick={clearNameFilter}
                  className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t("library.search.clear")}
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
            <Button type="submit" variant="secondary" className="shrink-0 sm:w-auto">
              {t("library.search.filter")}
            </Button>
          </form>
        ) : null}

        {error ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {projects.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            No recordings yet. Capture from the menubar tray, then come back here.
          </p>
        ) : filteredProjects.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            {t("library.search.noMatch")}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((p) => {
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
