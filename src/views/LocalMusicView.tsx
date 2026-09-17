/**
 * Local music — the user's imported folders as independent collections.
 * The list view shows every imported folder (a picked parent appears with
 * its music-bearing subfolders); opening one scopes songs/albums/artists to
 * it. "All songs" keeps the whole index in one list. Scanning lives in the
 * main process; this view renders from the persisted cache and rescans on
 * request. Renames and removals only edit ByTune's metadata/index — the
 * folders and files on disk are never touched.
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  FolderOpen,
  FolderPlus,
  ListMusic,
  Music2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { TrackList } from "../components/TrackList";
import { Artwork, EmptyState, Pills } from "../components/primitives";
import { isUnderPath } from "../../electron/local-paths";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { FolderStatus, LocalFolderEntry, LocalTrack } from "../../electron/local-library";
import type { Track } from "../types";

type Tab = "songs" | "albums" | "artists";
type Sort = "title" | "artist" | "recent";

/** The open collection: the route param is "all" or an imported folder path. */
const ALL = "all";

interface LibState {
  folders: LocalFolderEntry[];
  scannedAt: number;
  tracks: LocalTrack[];
}

function toTrack(t: LocalTrack): Track & { mtime: number } {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    thumb: t.art ?? "",
    // Mark local origin explicitly: the id prefix already routes playback,
    // but dependents (canvas lookup, silence analysis) check this flag.
    localPath: t.path,
    mtime: t.mtime,
  };
}

export function LocalMusicView() {
  const [lib, setLib] = useState<LibState | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState<Tab>("songs");
  const [sort, setSort] = useState<Sort>("title");
  const [q, setQ] = useState("");
  const [albumFilter, setAlbumFilter] = useState<string | null>(null);
  const [artistFilter, setArtistFilter] = useState<string | null>(null);
  const settings = useSettings();
  const toast = useUI((s) => s.toast);
  const openDialog = useUI((s) => s.openDialog);
  const navigate = useUI((s) => s.navigate);
  const routeParam = useUI((s) => (s.view.name === "local" ? s.view.param ?? null : null));

  const openFolder = useMemo(
    () => (routeParam && routeParam !== ALL ? lib?.folders.find((f) => f.path === routeParam) ?? null : null),
    [routeParam, lib]
  );
  // A param pointing at a folder that is no longer imported reads as the list.
  const openPath = routeParam === ALL || openFolder ? routeParam : null;

  const refresh = async (): Promise<void> => {
    const [l, statuses] = await Promise.all([
      window.bytune?.localLibrary(),
      window.bytune?.libraryFolderStatuses?.(),
    ]);
    if (l) setLib(l as LibState);
    if (statuses) {
      setMissing(new Set((statuses as FolderStatus[]).filter((st) => !st.exists).map((st) => st.path)));
    }
  };

  useEffect(() => {
    void refresh();
    // A song downloaded into the folder (panel drop or Downloads view) lands
    // on disk in the main process — this event carries the fresh scan.
    const onChanged = (e: Event): void => {
      const detail = (e as CustomEvent).detail as LibState | undefined;
      if (detail) setLib(detail);
      else void refresh();
    };
    window.addEventListener("bytune:local-library-updated", onChanged);
    return () => window.removeEventListener("bytune:local-library-updated", onChanged);
  }, []);

  // Filters are per-collection — a new collection starts clean.
  useEffect(() => {
    setTab("songs");
    setQ("");
    setAlbumFilter(null);
    setArtistFilter(null);
  }, [openPath]);

  const rescan = async (): Promise<void> => {
    if (!window.bytune) return;
    setScanning(true);
    try {
      const res = await window.bytune.scanLibrary(settings.filterNonMusicAudio);
      setLib(res as LibState);
      void refresh();
      toast("Local library scanned", "success");
    } catch {
      toast("Scan failed", "error");
    } finally {
      setScanning(false);
    }
  };

  const addFolders = async (): Promise<void> => {
    if (!window.bytune) return;
    const dir = await window.bytune.pickFolder();
    if (!dir) return;
    setScanning(true);
    try {
      const res = await window.bytune.addLibraryFolders([dir]);
      const n = res.added.length;
      if (n === 0) {
        setLib(res.lib as LibState);
        toast("That folder is already in your library", "info");
        return;
      }
      settings.setLocalMusicFolder(dir);
      const scanned = await window.bytune.scanLibrary(settings.filterNonMusicAudio);
      setLib(scanned as LibState);
      void refresh();
      toast(n === 1 ? `Imported "${res.added[0].name}"` : `Imported ${n} folders`, "success");
    } catch {
      toast("Couldn't import that folder", "error");
    } finally {
      setScanning(false);
    }
  };

  const renameFolder = (entry: LocalFolderEntry): void => {
    openDialog({
      title: `Rename "${entry.displayName ?? entry.name}"`,
      body: "This name is only used inside ByTune — the folder on disk keeps its own name.",
      initialValue: entry.displayName ?? entry.name,
      confirmLabel: "Rename",
      onConfirm: (value) => {
        void (async () => {
          try {
            const res = await window.bytune?.renameLibraryFolder(entry.path, value);
            if (res) setLib(res as LibState);
            toast("Renamed", "success");
          } catch {
            toast("Couldn't rename", "error");
          }
        })();
      },
    });
  };

  const removeFolder = (entry: LocalFolderEntry): void => {
    openDialog({
      title: `Remove "${entry.displayName ?? entry.name}"?`,
      body: "Removes the folder from ByTune only — your files stay exactly where they are on disk.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () => {
        void (async () => {
          try {
            const res = await window.bytune?.removeLibraryFolder(entry.path);
            if (res) setLib(res as LibState);
            if (routeParam === entry.path) navigate({ name: "local" });
            toast("Removed from ByTune — files untouched", "success");
          } catch {
            toast("Couldn't remove the folder", "error");
          }
        })();
      },
    });
  };

  // The collection's slice of the index: everything, or the tracks physically
  // under the open folder (a shared parent/child file shows in both collections).
  const scoped: LocalTrack[] = useMemo(() => {
    const all = lib?.tracks ?? [];
    if (!openPath) return [];
    if (openPath === ALL) return all;
    return all.filter((t) => isUnderPath(t.path, openPath));
  }, [lib, openPath]);

  const tracks: (Track & { mtime: number })[] = useMemo(() => {
    let out = scoped.map(toTrack);
    const needle = q.trim().toLowerCase();
    if (needle) {
      out = out.filter(
        (t) =>
          t.title.toLowerCase().includes(needle) ||
          t.artist.toLowerCase().includes(needle) ||
          (t.album ?? "").toLowerCase().includes(needle)
      );
    }
    if (albumFilter) out = out.filter((t) => t.album === albumFilter);
    if (artistFilter) out = out.filter((t) => t.artist === artistFilter);
    const sorted = [...out];
    if (sort === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "artist") sorted.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    if (sort === "recent") sorted.sort((a, b) => b.mtime - a.mtime);
    return sorted;
  }, [scoped, q, sort, albumFilter, artistFilter]);

  const albums = useMemo(() => {
    const map = new Map<string, { name: string; artist: string; count: number; art?: string }>();
    for (const t of scoped) {
      const key = `${t.album}|${t.artist}`;
      const cur = map.get(key) ?? { name: t.album, artist: t.artist, count: 0, art: t.art };
      cur.count += 1;
      if (!cur.art && t.art) cur.art = t.art;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [scoped]);

  const artists = useMemo(() => {
    const map = new Map<string, { name: string; count: number; art?: string }>();
    for (const t of scoped) {
      const cur = map.get(t.artist) ?? { name: t.artist, count: 0, art: t.art };
      cur.count += 1;
      if (!cur.art && t.art) cur.art = t.art;
      map.set(t.artist, cur);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [scoped]);

  const scannedLabel =
    lib?.scannedAt && lib.scannedAt > 0
      ? `Scanned ${new Date(lib.scannedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : null;

  const folderTitle = (f: LocalFolderEntry): string => f.displayName ?? f.name;

  /* ---------------- Empty: nothing imported yet ---------------- */
  if (!lib || lib.folders.length === 0) {
    return (
      <div className="pt-6">
        <EmptyState
          icon={FolderOpen}
          title="Play your own files"
          body="Import one folder or a whole organised parent — ByTune keeps each folder as its own collection, with tags and cover art, on your machine only."
          action={
            <button
              onClick={() => void addFolders()}
              disabled={scanning}
              className="mt-4 inline-flex items-center gap-2 h-10 px-5 rounded-full bg-accent text-[14px] font-semibold text-on-primary hover:brightness-110 transition-all disabled:opacity-50"
            >
              <FolderOpen className="w-4 h-4" />
              {scanning ? "Scanning…" : "Choose a folder"}
            </button>
          }
        />
      </div>
    );
  }

  /* ---------------- List: the imported collections ---------------- */
  if (!openPath) {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4 flex-wrap animate-slide-up">
          <div className="min-w-0">
            <h1 className="font-display text-[34px] font-bold tracking-[-0.03em] text-ink-hi">Local Music</h1>
            <p className="text-[13px] text-ink-faint mt-1">
              {lib.folders.length} folder{lib.folders.length === 1 ? "" : "s"} on this device
              {scannedLabel ? ` — ${scannedLabel}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void rescan()}
              disabled={scanning}
              title="Rescan every folder"
              className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-ink-hi/[0.12] text-ink-dim hover:text-ink-hi transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => void addFolders()}
              disabled={scanning}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-accent text-[13px] font-semibold text-on-primary hover:brightness-110 transition-all disabled:opacity-50"
            >
              <FolderPlus className="w-4 h-4" />
              Add folders
            </button>
          </div>
        </div>

        {scanning && (
          <div className="flex items-center gap-3 text-[13px] text-ink-dim">
            <span className="w-4 h-4 rounded-full border-2 border-ink-hi/15 border-t-accent animate-spin" />
            Reading tags and artwork…
          </div>
        )}

        <div className="space-y-1.5">
          <button
            onClick={() => navigate({ name: "local", param: ALL })}
            className="w-full flex items-center gap-3.5 p-3 rounded-xl hover:bg-ink-hi/[0.05] transition-colors text-left group"
          >
            <span className="w-11 h-11 rounded-md bg-accent/15 grid place-items-center shrink-0">
              <ListMusic className="w-5 h-5 text-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14.5px] font-semibold text-ink-hi truncate">All songs</span>
              <span className="block text-[12.5px] text-ink-dim truncate">
                Everything imported · {lib.tracks.length} song{lib.tracks.length === 1 ? "" : "s"}
              </span>
            </span>
          </button>

          {lib.folders.map((f) => {
            const count = lib.tracks.filter((t) => isUnderPath(t.path, f.path)).length;
            const gone = missing.has(f.path);
            return (
              <div
                key={f.path}
                className="w-full flex items-center gap-3.5 p-3 rounded-xl hover:bg-ink-hi/[0.05] transition-colors text-left group cursor-pointer"
                onClick={() => navigate({ name: "local", param: f.path })}
              >
                <span
                  className={`w-11 h-11 rounded-md grid place-items-center shrink-0 ${
                    gone ? "bg-amber-500/15" : "bg-ink-hi/[0.06]"
                  }`}
                >
                  {gone ? (
                    <AlertTriangle className="w-5 h-5 text-amber-400" />
                  ) : (
                    <FolderOpen className="w-5 h-5 text-ink-hi/55" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-semibold text-ink-hi truncate">{folderTitle(f)}</span>
                  <span
                    className={`block text-[12.5px] truncate mt-0.5 ${gone ? "text-amber-400/90" : "text-ink-dim"}`}
                    title={f.path}
                  >
                    {gone
                      ? "Folder missing — check the drive, or remove it from ByTune"
                      : `${count} song${count === 1 ? "" : "s"} · ${f.path}`}
                  </span>
                </span>
                <span className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      renameFolder(f);
                    }}
                    title="Rename in ByTune"
                    className="w-8 h-8 grid place-items-center rounded-lg text-ink-dim hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFolder(f);
                    }}
                    title="Remove from ByTune (files stay on disk)"
                    className="w-8 h-8 grid place-items-center rounded-lg text-ink-dim hover:text-red-400 hover:bg-red-400/10 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </span>
              </div>
            );
          })}

          <button
            onClick={() => void addFolders()}
            disabled={scanning}
            className="w-full flex items-center justify-center gap-2 p-3 rounded-xl border border-dashed border-ink-hi/15 text-[13.5px] text-ink-dim hover:text-ink-hi hover:border-ink-hi/30 transition-colors disabled:opacity-50"
          >
            <FolderPlus className="w-4 h-4" />
            Import another folder
          </button>
        </div>
      </div>
    );
  }

  /* ---------------- Inside a collection ---------------- */
  const collectionTitle = openPath === ALL ? "All songs" : folderTitle(openFolder as LocalFolderEntry);
  const collectionPath = openPath === ALL ? null : (openFolder as LocalFolderEntry).path;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-slide-up">
        <div className="min-w-0 flex items-center gap-3">
          <button
            onClick={() => navigate({ name: "local" })}
            title="Back to folders"
            className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-ink-hi/[0.12] text-ink-dim hover:text-ink-hi transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <h1 className="font-display text-[30px] font-bold tracking-[-0.03em] text-ink-hi truncate">
              {collectionTitle}
            </h1>
            {collectionPath && (
              <p className="text-[13px] text-ink-faint mt-0.5 truncate" title={collectionPath}>
                {collectionPath}
                {scannedLabel ? ` — ${scannedLabel}` : ""}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint pointer-events-none" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search your files"
              className="w-52 h-9 pl-8 pr-3 rounded-lg bg-ink-hi/[0.05] border border-ink-hi/10 text-[13px] text-ink-hi placeholder:text-ink-faint outline-none focus:border-ink-hi/25"
            />
          </div>
          {openFolder && (
            <>
              <button
                onClick={() => renameFolder(openFolder)}
                title="Rename in ByTune"
                className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-ink-hi/[0.12] text-ink-dim hover:text-ink-hi transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => removeFolder(openFolder)}
                title="Remove from ByTune (files stay on disk)"
                className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-red-400/10 hover:text-red-400 text-ink-dim transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
          <button
            onClick={() => void rescan()}
            disabled={scanning}
            title="Rescan"
            className="w-9 h-9 grid place-items-center rounded-lg bg-ink-hi/[0.06] hover:bg-ink-hi/[0.12] text-ink-dim hover:text-ink-hi transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${scanning ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {missing.has(collectionPath ?? "") && (
        <div className="flex items-center gap-2.5 p-3 rounded-xl bg-amber-500/10 text-[13px] text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          This folder can't be reached right now. The list below is ByTune's last scan — rescan after reconnecting the
          drive, or remove the folder from ByTune.
        </div>
      )}

      {(albumFilter || artistFilter) && (
        <button
          onClick={() => {
            setAlbumFilter(null);
            setArtistFilter(null);
          }}
          className="text-[13px] text-ink-dim hover:text-ink-hi transition-colors"
        >
          ← Clear filter: {albumFilter ?? artistFilter}
        </button>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Pills
          options={[
            { key: "songs", label: `Songs${scoped.length ? ` · ${scoped.length}` : ""}` },
            { key: "albums", label: `Albums · ${albums.length}` },
            { key: "artists", label: `Artists · ${artists.length}` },
          ]}
          value={tab}
          onChange={(k) => setTab(k as Tab)}
        />
        {tab === "songs" && (
          <Pills
            options={[
              { key: "title", label: "Title" },
              { key: "artist", label: "Artist" },
            ]}
            value={sort === "recent" ? "title" : sort}
            onChange={(k) => setSort(k as Sort)}
          />
        )}
      </div>

      {scanning && (
        <div className="flex items-center gap-3 text-[13px] text-ink-dim">
          <span className="w-4 h-4 rounded-full border-2 border-ink-hi/15 border-t-accent animate-spin" />
          Reading tags and artwork…
        </div>
      )}

      {!scanning && tab === "songs" && (scoped.length === 0 || tracks.length === 0) && (
        <EmptyState
          icon={Music2}
          title={scoped.length === 0 ? "No music found in this folder" : "Nothing matches that search"}
          body={scoped.length === 0 ? "Drop some audio files in and rescan." : undefined}
        />
      )}

      {tab === "songs" && tracks.length > 0 && <TrackList tracks={tracks} showAlbum emptyLabel="No songs." />}

      {tab === "albums" && (
        <div className="flex flex-wrap gap-5">
          {albums.map((a) => (
            <button
              key={`${a.name}|${a.artist}`}
              onClick={() => {
                setAlbumFilter(a.name);
                setTab("songs");
              }}
              className="group w-[168px] text-left cursor-pointer"
            >
              <Artwork src={a.art ?? ""} className="w-full aspect-square rounded-xl" iconClassName="w-7 h-7" alt="" />
              <div className="mt-2.5">
                <div className="text-[15px] font-semibold text-ink-hi truncate leading-snug">{a.name}</div>
                <div className="text-[13px] text-ink-dim truncate mt-0.5">
                  {a.artist} · {a.count} song{a.count === 1 ? "" : "s"}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {tab === "artists" && (
        <div className="grid sm:grid-cols-2 gap-2">
          {artists.map((a) => (
            <button
              key={a.name}
              onClick={() => {
                setArtistFilter(a.name);
                setTab("songs");
              }}
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-ink-hi/[0.05] transition-colors text-left"
            >
              {a.art ? (
                <Artwork src={a.art} className="w-11 h-11 rounded-full shrink-0" iconClassName="w-4 h-4" alt="" />
              ) : (
                <span className="w-11 h-11 rounded-full bg-ink-hi/[0.07] grid place-items-center shrink-0">
                  <User className="w-4 h-4 text-ink-dim" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold text-ink-hi truncate">{a.name}</span>
                <span className="block text-[12.5px] text-ink-dim">
                  {a.count} song{a.count === 1 ? "" : "s"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
