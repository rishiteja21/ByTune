/** Library state: liked tracks, playlists, history and download registry. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { coalescedStorage } from "../lib/persist";
import { recordDeletionChanges } from "../lib/deletion-sync";
import type { DeletionChange, DeletionSync } from "../lib/deletion-sync";
import type { Track } from "../types";

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
  /** pinned playlists sort first */
  pinned?: boolean;
  /** library folder this playlist lives in, when filed */
  folderId?: string;
  /** set when the playlist was imported from an artist drop — clicking it
      opens the artist page and the artist's photo stands in as cover */
  artistId?: string;
  artistThumb?: string;
}

/** An artist the user dropped into their library — a follow, not a playlist. */
export interface FollowedArtist {
  id: string;
  name: string;
  thumb?: string;
  followedAt: number;
}

/** A user-created library folder that groups playlists. */
export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: number;
}

export type DownloadStatus = "queued" | "downloading" | "done" | "failed";

export interface DownloadItem {
  track: Track;
  path: string | null;
  status: DownloadStatus;
  /** 0..1, only meaningful while downloading */
  progress: number;
  downloaded: number;
  total: number;
}

/** Pinnable library shortcuts — Liked Songs, Downloads, Local Music. */
export type PinnedSingleKey = "liked" | "downloads" | "local";

interface LibraryState {
  liked: Track[];
  playlists: Playlist[];
  folders: LibraryFolder[];
  /** artists the user dropped into their library */
  followedArtists: FollowedArtist[];
  history: Track[];
  downloads: Record<string, DownloadItem>;
  /** pin state for the Liked / Downloads / Local shortcut rows — all pinned by default */
  pinnedSingles: Record<PinnedSingleKey, boolean>;
  /** deletion/version metadata replicated with the library (see deletion-sync.ts) */
  deletionSync?: DeletionSync;

  isLiked(id: string): boolean;
  toggleLike(track: Track): void;
  togglePinSingle(key: PinnedSingleKey): void;
  createPlaylist(name: string): Playlist;
  renamePlaylist(id: string, name: string): void;
  togglePinPlaylist(id: string): void;
  deletePlaylist(id: string): void;
  addToPlaylist(playlistId: string, track: Track): boolean;
  removeFromPlaylist(playlistId: string, trackId: string): void;
  getPlaylist(id: string): Playlist | null;
  createFolder(name: string): LibraryFolder;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
  setPlaylistFolder(playlistId: string, folderId: string | null): void;
  pushHistory(track: Track): void;
  clearHistory(): void;
  followArtist(artist: { id: string; name: string; thumb?: string }): boolean;
  unfollowArtist(id: string): void;
  setDownload(id: string, item: DownloadItem): void;
  patchDownload(id: string, patch: Partial<DownloadItem>): void;
  removeDownload(id: string): void;
}

function uid(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let hydrationLikes: Map<string, { track: Track; liked: boolean }> | null = null;
let hydrationHistory: Array<Track | null> | null = null;

/** Membership and its version must persist atomically in the same write. */
function withChanges(
  set: (partial: Partial<LibraryState>) => void,
  get: () => LibraryState,
  next: Partial<LibraryState>,
  changes: DeletionChange[]
): void {
  set({ ...next, deletionSync: recordDeletionChanges(get(), next, changes) });
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      liked: [],
      playlists: [],
      folders: [],
      followedArtists: [],
      history: [],
      downloads: {},
      pinnedSingles: { liked: true, downloads: true, local: true },

      togglePinSingle(key) {
        const current = get().pinnedSingles ?? { liked: true, downloads: true, local: true };
        set({ pinnedSingles: { ...current, [key]: !current[key] } });
      },

      isLiked(id) {
        return get().liked.some((t) => t.id === id);
      },

      toggleLike(track) {
        const { liked } = get();
        const wasLiked = liked.some((t) => t.id === track.id);
        // Replay the desired value, not a toggle against the restored value.
        hydrationLikes?.set(track.id, { track, liked: !wasLiked });
        if (wasLiked) {
          withChanges(set, get, { liked: liked.filter((t) => t.id !== track.id) },
            [{ kind: "delete", group: "liked", id: track.id }]);
        } else {
          withChanges(set, get, { liked: [track, ...liked] },
            [{ kind: "add", group: "liked", id: track.id }]);
        }
      },

      createPlaylist(name) {
        const playlist: Playlist = { id: uid(), name: name.trim() || "New Playlist", tracks: [], createdAt: Date.now() };
        withChanges(set, get, { playlists: [playlist, ...get().playlists] },
          [{ kind: "add", group: "playlists", id: playlist.id }]);
        return playlist;
      },

      renamePlaylist(id, name) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      togglePinPlaylist(id) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      deletePlaylist(id) {
        const deleted = get().playlists.find((p) => p.id === id);
        const changes: DeletionChange[] = [{ kind: "delete", group: "playlists", id }];
        // Keep explicit child deletions too, in case this id is later recreated.
        for (const track of deleted?.tracks ?? []) changes.push({ kind: "delete", group: "tracks", id: track.id, parent: id });
        withChanges(set, get, { playlists: get().playlists.filter((p) => p.id !== id) }, changes);
      },

      addToPlaylist(playlistId, track) {
        const playlists = get().playlists.map((p) => {
          if (p.id !== playlistId) return p;
          if (p.tracks.some((t) => t.id === track.id)) return p;
          return { ...p, tracks: [...p.tracks, track] };
        });
        const target = get().playlists.find((p) => p.id === playlistId);
        const dup = target?.tracks.some((t) => t.id === track.id) ?? false;
        if (!target || dup) return false;
        withChanges(set, get, { playlists },
          [{ kind: "add", group: "tracks", id: track.id, parent: playlistId }]);
        return true;
      },

      removeFromPlaylist(playlistId, trackId) {
        const target = get().playlists.find((p) => p.id === playlistId);
        if (!target || !target.tracks.some((t) => t.id === trackId)) return;
        withChanges(set, get, {
          playlists: get().playlists.map((p) =>
            p.id === playlistId ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p
          ),
        }, [{ kind: "delete", group: "tracks", id: trackId, parent: playlistId }]);
      },

      getPlaylist(id) {
        return get().playlists.find((p) => p.id === id) ?? null;
      },

      createFolder(name) {
        const folder: LibraryFolder = { id: uid(), name: name.trim() || "New Folder", createdAt: Date.now() };
        withChanges(set, get, { folders: [...get().folders, folder] },
          [{ kind: "add", group: "folders", id: folder.id }]);
        return folder;
      },

      renameFolder(id, name) {
        withChanges(set, get, {
          folders: get().folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)),
        }, [{ kind: "edit", group: "folders", id }]);
      },

      deleteFolder(id) {
        if (!get().folders.some((f) => f.id === id)) return;
        // The folder goes; its playlists come back to the top level.
        withChanges(set, get, {
          folders: get().folders.filter((f) => f.id !== id),
          playlists: get().playlists.map((p) => (p.folderId === id ? { ...p, folderId: undefined } : p)),
        }, [{ kind: "delete", group: "folders", id }]);
      },

      setPlaylistFolder(playlistId: string, folderId: string | null) {
        const target = get().playlists.find((p) => p.id === playlistId);
        const nextFolderId = folderId ?? undefined;
        if (target?.folderId === nextFolderId) return;
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === playlistId ? { ...p, folderId: nextFolderId } : p)),
        }, [{ kind: "edit", group: "playlists", id: playlistId }]);
      },

      pushHistory(track) {
        hydrationHistory?.push(track);
        const rest = get().history.filter((t) => t.id !== track.id);
        withChanges(set, get, { history: [track, ...rest].slice(0, 200) },
          [{ kind: "add", group: "history", id: track.id }]);
      },

      clearHistory() {
        hydrationHistory?.push(null);
        withChanges(set, get, { history: [] }, [{ kind: "clear", group: "history" }]);
      },

      followArtist(artist) {
    if (!artist.id) return false;
    if (get().followedArtists.some((a) => a.id === artist.id)) return false;
    withChanges(set, get, {
      followedArtists: [
        { id: artist.id, name: artist.name, thumb: artist.thumb, followedAt: Date.now() },
        ...get().followedArtists,
      ],
    }, [{ kind: "add", group: "followedArtists", id: artist.id }]);
    return true;
  },

  unfollowArtist(id) {
    withChanges(set, get, { followedArtists: get().followedArtists.filter((a) => a.id !== id) },
      [{ kind: "delete", group: "followedArtists", id }]);
  },

  setDownload(id, item) {
        set({ downloads: { ...get().downloads, [id]: item } });
      },

      patchDownload(id, patch) {
        const existing = get().downloads[id];
        if (!existing) return;
        set({ downloads: { ...get().downloads, [id]: { ...existing, ...patch } } });
      },

      removeDownload(id) {
        const next = { ...get().downloads };
        delete next[id];
        set({ downloads: next });
      },
    }),
    {
      name: "library",
      // Coalesced like the player store: download progress patches the
      // downloads registry several times a second, and an uncoalesced persist
      // would serialize the whole library (liked + playlists + history + the
      // full Track objects) to disk at that rate. Pending writes still flush
      // on pagehide/beforeunload, so close-time durability is unchanged.
      storage: createJSONStorage(() => coalescedStorage),
      version: 1,
      onRehydrateStorage: () => {
        const likes = hydrationLikes ?? new Map<string, { track: Track; liked: boolean }>();
        const history = hydrationHistory ?? [];
        hydrationLikes = likes;
        hydrationHistory = history;
        return (state) => {
          if (hydrationLikes !== likes) return;
          hydrationLikes = null;
          hydrationHistory = null;
          if (!state || (likes.size === 0 && history.length === 0)) return;
          // Hydration replaced the intermediate metadata too. Replay explicit
          // user intents against the restored clock, preserving their order.
          // These are real buffered actions, not newly inferred additions.
          let replay = state;
          for (const action of likes.values()) {
            const rest = replay.liked.filter((track) => track.id !== action.track.id);
            const next = { liked: action.liked ? [action.track, ...rest] : rest };
            replay = { ...replay, ...next, deletionSync: recordDeletionChanges(replay, next,
              [{ kind: action.liked ? "add" : "delete", group: "liked", id: action.track.id }]) };
          }
          for (const track of history) {
            const next = { history: track === null ? [] : [track, ...replay.history.filter((item) => item.id !== track.id)].slice(0, 200) };
            replay = { ...replay, ...next, deletionSync: recordDeletionChanges(replay, next,
              [track === null ? { kind: "clear", group: "history" } : { kind: "add", group: "history", id: track.id }]) };
          }
          useLibrary.setState({ liked: replay.liked, history: replay.history, deletionSync: replay.deletionSync });
        };
      },
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 1 || state.pinnedSingles == null) {
          return {
            ...state,
            pinnedSingles: { liked: true, downloads: true, local: true },
          };
        }
        return state;
      },
    }
  )
);
