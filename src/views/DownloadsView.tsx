import { AlertCircle, Check, Download, FolderOpen, Loader2, Music2, RotateCcw, X } from "lucide-react";
import { downloadMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { tintHoverHandlers, useUI } from "../stores/ui";
import { cancelDownload, startDownload } from "../lib/downloads";
import { plural } from "../lib/format";
import { Artwork, Btn, EmptyState, IconBtn } from "../components/primitives";
import type { DownloadItem } from "../stores/library";

function StatusCell({ item }: { item: DownloadItem }) {
  if (item.status === "queued") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-dim w-48">
        <span className="w-2 h-2 rounded-full bg-ink-hi/30 shrink-0" />
        Queued
      </div>
    );
  }
  if (item.status === "downloading") {
    const pct = Math.round(item.progress * 100);
    return (
      <div className="flex items-center gap-3 w-48">
        <Loader2 className="w-4 h-4 text-accent animate-spin shrink-0" />
        <div className="flex-1">
          <div className="h-1 rounded-full bg-ink-hi/10 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[11px] text-ink-faint mt-1 tabular-nums">{pct}%</div>
        </div>
      </div>
    );
  }
  if (item.status === "done") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-emerald-400 w-48">
        <span className="p-1 rounded-full bg-emerald-400/10">
          <Check className="w-3.5 h-3.5" />
        </span>
        Downloaded
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[13px] text-red-400 w-48">
      <span className="p-1 rounded-full bg-red-400/10">
        <AlertCircle className="w-3.5 h-3.5" />
      </span>
      Failed
    </div>
  );
}

/** One download row — a drag source like every other list row. */
function DownloadRow({
  item,
  onOpenMenu,
  onRemove,
}: {
  item: DownloadItem;
  onOpenMenu: (x: number, y: number) => void;
  onRemove: (id: string) => void;
}) {
  const drag = useDrag({ track: item.track });
  return (
    <div
      key={item.track.id}
      {...tintHoverHandlers(item.track.thumb)}
      {...drag.props}
      className={`group flex items-center gap-3 h-[58px] px-3 rounded-xl hover:bg-ink-hi/[0.045] ${
        drag.dragging ? "opacity-40" : ""
      }`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(e.clientX, e.clientY);
      }}
    >
      <Artwork src={item.track.thumb} className="w-10 h-10 rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] truncate text-ink">{item.track.title}</div>
        <div className="text-xs truncate text-ink-faint mt-px">{item.track.artist}</div>
      </div>
      <StatusCell item={item} />
      <div className="w-20 shrink-0 flex items-center justify-end gap-0.5">
        {item.status === "failed" && (
          <IconBtn icon={RotateCcw} title="Retry download" onClick={() => void startDownload(item.track)} size="sm" />
        )}
        {(item.status === "downloading" || item.status === "queued") && (
          <IconBtn icon={X} title="Cancel download" danger onClick={() => cancelDownload(item.track.id)} size="sm" />
        )}
        {item.status === "done" && item.path && (
          <IconBtn
            icon={FolderOpen}
            title="Show in folder"
            onClick={() => window.bytune?.revealPath(item.path!)}
            size="sm"
          />
        )}
        {item.status !== "downloading" && item.status !== "queued" && (
          <IconBtn icon={X} title="Remove from list" danger onClick={() => onRemove(item.track.id)} size="sm" />
        )}
      </div>
    </div>
  );
}

export function DownloadsView() {
  const downloads = useLibrary((s) => s.downloads);
  const removeDownload = useLibrary((s) => s.removeDownload);
  const downloadDir = useSettings((s) => s.downloadDir);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);

  const items = Object.values(downloads).sort((a, b) => a.track.title.localeCompare(b.track.title));
  const doneCount = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const activeCount = items.filter((i) => i.status === "downloading" || i.status === "queued").length;

  const openFolder = (): void => {
    const b = window.bytune;
    if (!b) return;
    if (downloadDir) {
      void b.openPath(downloadDir);
    } else {
      void b
        .defaultDownloadDir()
        .then((dir) => b.openPath(dir))
        .catch(() => toast("Couldn't open the downloads folder", "error"));
    }
  };

  return (
    <div className="space-y-7">
      <div className="flex items-end justify-between gap-4 animate-slide-up">
        <div>
          <h1 className="font-display text-[28px] font-bold tracking-tight text-ink-hi">Downloads</h1>
          <p className="text-sm text-ink-dim mt-1 flex items-center gap-2">
            <span>
              {items.length === 0
                ? "Saved music lives on your disk"
                : plural(doneCount, "track", "tracks") + " saved"}
            </span>
            {failedCount > 0 && <span className="text-red-400">· {plural(failedCount, "failure", "failures")}</span>}
            {activeCount > 0 && <span className="text-accent">· {plural(activeCount, "download", "downloads")} in progress</span>}
          </p>
        </div>
        <Btn variant="glass" icon={FolderOpen} onClick={openFolder}>
          Open folder
        </Btn>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Download}
          title="No downloads yet"
          body='Right-click any track and choose "Download", or use the download arrow on a track row. Files are saved to your downloads folder.'
        />
      ) : (
        <div className="space-y-1">
          <div className="flex items-center gap-3 px-3 pb-2 border-b border-ink-hi/[0.055] text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-ghost">
            <div className="w-10 shrink-0" />
            <div className="flex-1 min-w-0">Track</div>
            <div className="w-48 shrink-0">Status</div>
            <div className="w-20 shrink-0" />
          </div>
          {items.map((item) => (
            <DownloadRow
              key={item.track.id}
              item={item}
              onOpenMenu={(x, y) =>
                openContextMenu(x, y, downloadMenuItems(item.track, item.path))
              }
              onRemove={removeDownload}
            />
          ))}
        </div>
      )}
    </div>
  );
}
