/** Builds right-click / "more" menu items for tracks and playlists. */
import {
  Disc3,
  Download,
  FolderOpen,
  Heart,
  Link2,
  ListMusic,
  ListPlus,
  ListStart,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { startDownload } from "./downloads";
import { useLibrary, type Playlist } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI, type MenuItem } from "../stores/ui";
import type { Track } from "../types";

export function trackMenuItems(track: Track): MenuItem[] {
  const lib = useLibrary.getState();
  const ui = useUI.getState();
  const liked = lib.isLiked(track.id);
  const dl = lib.downloads[track.id];
  const done = dl?.status === "done";

  const items: MenuItem[] = [
    {
      label: "Play now",
      icon: Play,
      action: () => usePlayer.getState().playTrack(track),
    },
    {
      label: "Play next",
      icon: ListStart,
      action: () => {
        usePlayer.getState().addToQueue(track, true);
        useUI.getState().toast("Playing next");
      },
    },
    {
      label: "Add to queue",
      icon: ListPlus,
      action: () => {
        usePlayer.getState().addToQueue(track);
        useUI.getState().toast("Added to queue");
      },
    },
    {
      separatorBefore: true,
      label: liked ? "Remove from Liked" : "Add to Liked",
      icon: Heart,
      action: () => useLibrary.getState().toggleLike(track),
    },
  ];

  const playlists = lib.playlists.slice(0, 6);
  for (const p of playlists) {
    items.push({
      label: `Add to "${p.name}"`,
      action: () => {
        const added = useLibrary.getState().addToPlaylist(p.id, track);
        useUI.getState().toast(added ? `Added to "${p.name}"` : "Already in this playlist");
      },
    });
  }
  items.push({
    label: "New playlist…",
    icon: ListMusic,
    action: () => {
      const count = useLibrary.getState().playlists.length;
      const playlist = useLibrary.getState().createPlaylist(`Playlist ${count + 1}`);
      useLibrary.getState().addToPlaylist(playlist.id, track);
      useUI.getState().navigate({ name: "playlist", param: playlist.id });
    },
  });

  items.push({
    separatorBefore: true,
    label: done ? "Show in folder" : "Download",
    icon: done ? FolderOpen : Download,
    action: () => {
      if (done && dl?.path) {
        requireReveal(dl.path);
      } else {
        void startDownload(track);
      }
    },
  });

  if (track.albumId) {
    items.push({
      separatorBefore: true,
      label: "Go to album",
      icon: Disc3,
      action: () => useUI.getState().navigate({ name: "album", param: track.albumId }),
    });
  }

  items.push({
    label: "Copy link",
    icon: Link2,
    action: () => {
      void navigator.clipboard
        .writeText(`https://music.youtube.com/watch?v=${track.id}`)
        .then(() => useUI.getState().toast("Link copied"))
        .catch(() => useUI.getState().toast("Couldn't copy link", "error"));
    },
  });

  return items;
}

function requireReveal(path: string): void {
  if (window.bytune) window.bytune.revealPath(path);
}

export function playlistMenuItems(playlist: Playlist, track: Track): MenuItem[] {
  return [
    {
      label: "Remove from this playlist",
      icon: Trash2,
      danger: true,
      action: () => {
        useLibrary.getState().removeFromPlaylist(playlist.id, track.id);
        useUI.getState().toast("Removed from playlist");
      },
    },
    ...trackMenuItems(track),
  ];
}

export function playlistHeaderItems(playlist: Playlist): MenuItem[] {
  return [
    {
      label: "Rename",
      icon: Pencil,
      action: () => {
        useUI.getState().openDialog({
          title: "Rename playlist",
          initialValue: playlist.name,
          placeholder: "Playlist name",
          confirmLabel: "Rename",
          onConfirm: (value) => {
            if (value.trim()) useLibrary.getState().renamePlaylist(playlist.id, value);
          },
        });
      },
    },
    {
      label: "Delete playlist",
      icon: Trash2,
      danger: true,
      action: () => {
        useUI.getState().openDialog({
          title: `Delete "${playlist.name}"?`,
          body: "This can't be undone. The tracks themselves aren't affected.",
          confirmLabel: "Delete",
          danger: true,
          onConfirm: () => {
            useLibrary.getState().deletePlaylist(playlist.id);
            useUI.getState().navigate({ name: "playlists" });
            useUI.getState().toast("Playlist deleted", "info");
          },
        });
      },
    },
  ];
}

/** File a playlist into a library folder (or back out to the top level). */
export function playlistFolderItems(playlist: Playlist): MenuItem[] {
  const folders = useLibrary.getState().folders;
  const items: MenuItem[] = folders.map((f, i) => ({
    label: f.id === playlist.folderId ? `✓ ${f.name}` : `Move to “${f.name}”`,
    icon: FolderOpen,
    separatorBefore: i === 0,
    action: () => useLibrary.getState().setPlaylistFolder(playlist.id, f.id),
  }));
  if (playlist.folderId) {
    items.push({
      label: "Remove from folder",
      icon: FolderOpen,
      separatorBefore: true,
      action: () => useLibrary.getState().setPlaylistFolder(playlist.id, null),
    });
  }
  return items;
}

export function historyMenuItems(track: Track): MenuItem[] {
  return [
    {
      label: "Remove from history",
      icon: Trash2,
      danger: true,
      action: () => {
        const lib = useLibrary.getState();
        lib.clearHistory();
        // Re-add everything except this track.
        lib.history
          .filter((t) => t.id !== track.id)
          .slice()
          .reverse()
          .forEach((t) => lib.pushHistory(t));
      },
    },
    ...trackMenuItems(track),
  ];
}

export function downloadMenuItems(track: Track, path: string | null): MenuItem[] {
  return [
    {
      label: "Show in folder",
      icon: FolderOpen,
      action: () => {
        if (path) requireReveal(path);
      },
    },
    {
      label: "Retry download",
      icon: RotateCcw,
      action: () => void startDownload(track),
    },
  ];
}
