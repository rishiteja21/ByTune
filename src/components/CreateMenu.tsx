/**
 * CreateMenu — the library "+" trigger and its Spotify-style dropdown:
 * Playlist and Folder (deliberately no Blend). The menu is portal'd to
 * <body> because the library pill clips absolutely-positioned children,
 * and outside-mousedown closes it while honouring both the trigger ref
 * and the portal'd menu ref.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, ListPlus, Plus } from "lucide-react";
import { useLibrary, type LibraryFolder } from "../stores/library";
import { useUI } from "../stores/ui";

export function CreateMenu({ onFolderCreated }: { onFolderCreated?: (folder: LibraryFolder) => void }) {
  const playlistCount = useLibrary((s) => s.playlists.length);
  const folderCount = useLibrary((s) => s.folders.length);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const createFolder = useLibrary((s) => s.createFolder);
  const navigate = useUI((s) => s.navigate);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** viewport position of the portal'd menu (hosts clip) */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Capture phase: the popup is the topmost layer, but App's bubble-level
      // shortcut handler is registered first and would close whatever panel
      // sits underneath (queue, lyrics) in the same keystroke.
      e.stopPropagation();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  /** Drop below the + and run rightward over the main pane, the way Spotify's
      create menu hangs off the sidebar; clamped so it never leaves the
      viewport. */
  const toggle = (): void => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const MENU_W = 264;
      const EDGE = 12;
      const HANG = 72; // menu starts this far left of the + and extends right
      const left = Math.min(Math.max(r.left - HANG, EDGE), window.innerWidth - MENU_W - EDGE);
      setPos({ top: r.bottom + 8, left: Math.max(left, EDGE) });
    }
    setOpen((v) => !v);
  };

  const newPlaylist = (): void => {
    const p = createPlaylist(`My Playlist #${playlistCount + 1}`);
    setOpen(false);
    navigate({ name: "playlist", param: p.id });
  };

  const newFolder = (): void => {
    const f = createFolder(`New Folder ${folderCount + 1}`);
    setOpen(false);
    onFolderCreated?.(f);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        title="Create playlist or folder"
        aria-label="Create playlist or folder"
        aria-expanded={open}
        className={`p-1.5 rounded-full transition-colors ${
          open ? "text-ink-hi bg-ink-hi/[0.10]" : "text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06]"
        }`}
      >
        <Plus className="w-4 h-4" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[130] w-[264px] glass-strong rounded-2xl p-1.5 shadow-float origin-top-left animate-menu-in"
            style={{ top: pos.top, left: pos.left }}
          >
            <button
              onClick={newPlaylist}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-ink-hi/[0.08] grid place-items-center shrink-0">
                <ListPlus className="w-5 h-5 text-ink-hi" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink-hi">Playlist</span>
                <span className="block text-[12px] text-ink-hi/55 truncate">Create a playlist with songs</span>
              </span>
            </button>
            <button
              onClick={newFolder}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-ink-hi/[0.08] grid place-items-center shrink-0">
                <Folder className="w-5 h-5 text-ink-hi" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink-hi">Folder</span>
                <span className="block text-[12px] text-ink-hi/55 truncate">Organize your playlists</span>
              </span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
