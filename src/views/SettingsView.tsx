import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  AppWindow,
  BarChart3,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  Download,
  Droplets,
  FileDown,
  FileUp,
  FolderOpen,
  Gauge,
  HardDrive,
  Image,
  Infinity as InfinityIcon,
  Languages,
  ListMusic,
  Maximize2,
  Music4,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  User,
  UserRound,
  VolumeX,
  Wifi,
} from "lucide-react";
import {
  DOWNLOAD_QUALITY_LABEL,
  STREAM_QUALITY_LABEL,
  useSettings,
  type DownloadQuality,
  type StreamQuality,
} from "../stores/settings";
import { useSession } from "../lib/session";
import { setOnboardingIntent } from "../lib/onboardingIntent";
import { GuestDeleteModal } from "../components/AccountModals";
import { useUI } from "../stores/ui";

/* ============================================================ settings chrome
   Settings are inset cards of rows: an uppercase group header, a
   rounded card, glyph + title + optional subtitle on the left, a value/switch
   or chevron on the right, and hairline dividers inset to the text column. */

const GROUP_INSET = "px-0"; // page padding comes from the view container
const ROW_INSET = "px-4";
const TEXT_INSET = "pl-[52px]"; // icon (22) + gap (14) + row inset (16)

function SettingsGroup({
  header,
  footer,
  children,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <section className="animate-slide-up">
      {header && (
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim px-5 pt-7 pb-2">
          {header}
        </h2>
      )}
      {!header && <div className="pt-7" />}
      <div className={`mx-4 rounded-[14px] bg-panel overflow-hidden ${GROUP_INSET}`}>{children}</div>
      {footer && <p className="text-[12.5px] text-ink-dim px-5 pt-2 leading-relaxed">{footer}</p>}
    </section>
  );
}

function Divider() {
  return <div className={`h-px bg-ink-hi/[0.08] ${TEXT_INSET}`} />;
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={`relative shrink-0 w-[42px] h-[26px] rounded-full transition-colors duration-200 disabled:opacity-40 ${
        checked ? "bg-primary" : "bg-ink-hi/[0.16]"
      }`}
    >
      <span
        className={`absolute top-[3px] w-[20px] h-[20px] rounded-full transition-all duration-200 ${
          checked ? "left-[19px] bg-on-primary" : "left-[3px] bg-white"
        }`}
      />
    </button>
  );
}

function Chevron() {
  return <ChevronRight className="w-5 h-5 text-ink-dim/70 shrink-0" />;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-ink-hi/90 rounded-[5px] bg-ink-hi/[0.16] px-1.5 py-0.5">
      {children}
    </span>
  );
}

function SettingsRow({
  icon: Icon,
  title,
  subtitle,
  value,
  badge,
  disabled,
  onClick,
  trailing,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  disabled?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}) {
  const interactive = onClick && !disabled;
  return (
    <div
      onClick={interactive ? onClick : undefined}
      className={`flex items-center min-h-[52px] py-3 ${ROW_INSET} ${
        interactive ? "cursor-pointer hover:bg-ink-hi/[0.04] active:bg-ink-hi/[0.07] transition-colors" : ""
      } ${disabled ? "opacity-45" : ""}`}
    >
      <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
      <div className="flex-1 min-w-0 ml-[14px]">
        <div className="flex items-center">
          <span className="text-[14px] text-ink-hi truncate">{title}</span>
          {badge && <Badge>{badge}</Badge>}
        </div>
        {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5 leading-snug">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-3">
        {trailing ?? (
          <>
            {value && <span className="text-[14px] text-ink-dim">{value}</span>}
            {onClick && <Chevron />}
          </>
        )}
      </div>
    </div>
  );
}

/** A toggle that reads as part of the option above it — no glyph, no divider. */
function SettingsSubRow({
  title,
  checked,
  onChange,
  badge,
}: {
  title: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  badge?: string;
}) {
  return (
    <div
      onClick={() => onChange(!checked)}
      className={`flex items-center ${ROW_INSET} pb-2.5 -mt-1 cursor-pointer`}
    >
      <div className="flex-1 flex items-center min-w-0">
        <span className="text-[14px] text-ink-hi truncate">{title}</span>
        {badge && <Badge>{badge}</Badge>}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

function SliderRow({
  icon: Icon,
  title,
  subtitle,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className={`${ROW_INSET} py-3`}>
      <div className="flex items-center">
        <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
        <div className="flex-1 min-w-0 ml-[14px]">
          <div className="text-[14px] text-ink-hi">{title}</div>
          {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5">{subtitle}</div>}
        </div>
        <span className="text-[14px] text-ink-dim ml-3 shrink-0">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider w-full mt-3 ml-[36px]"
        style={{ width: "calc(100% - 36px)" }}
      />
    </div>
  );
}

/* ============================================================ view */

/**
 * ByTune account — the cloud layer above the YouTube cookie. Guests keep
 * everything local; signed-in users get automatic cloud backup of library,
 * playlists, history and settings. Backups always run on top of the local
 * copy: restoring never deletes anything without writing a local backup
 * first (userData/data/backups).
 */
function CloudAccountGroup() {
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const session = useSession();
  const [status, setStatus] = useState<{
    lastSyncAt: number | null;
    state: "idle" | "syncing" | "pending" | "error";
    lastError: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the sync-status line honest: poll while mounted (cheap local IPC),
  // plus refresh after every mode change.
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void window.bytune
        ?.syncStatus()
        .then((st) => {
          if (!cancelled) {
            const s = st as { lastSyncAt: number | null; state?: string; lastError?: string | null } | undefined;
            setStatus({
              lastSyncAt: s?.lastSyncAt ?? null,
              state: (s?.state as "idle" | "syncing" | "pending" | "error") ?? "idle",
              lastError: s?.lastError ?? null,
            });
          }
        })
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [session.mode]);

  const run = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      toast(done, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Sync failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const signOutWithConfirm = (): void => {
    openDialog({
      title: "Sign out of ByTune?",
      body: "Your account data is safely backed up to the cloud. You can sign in again any time to restore it.",
      confirmLabel: "Sign out",
      cancelLabel: "Cancel",
      onConfirm: () => void run(async () => { await window.bytune?.authSignOut(); }, "Signed out"),
    });
  };

  const changeUsername = (): void => {
    openDialog({
      title: "Change username",
      body: "Letters and numbers only. The new name must not already be taken.",
      initialValue: session.username ?? "",
      confirmLabel: "Rename",
      onConfirm: (value) => {
        const next = value.trim();
        if (!next || next === session.username) return;
        void run(async () => {
          await window.bytune?.authSetUsername(next);
          await useSession.getState().refresh();
        }, `Username changed to ${next}`);
      },
    });
  };

  const signedIn = session.mode === "account";
  const subtitle = !session.loaded
    ? "…"
    : signedIn
      ? status?.state === "syncing"
        ? "Syncing…"
        : status?.state === "error"
          ? `Sync error, will retry${status.lastError ? "" : ""}`
          : status?.state === "pending"
            ? "Pending changes"
            : status?.lastSyncAt
              ? `Synced ${new Date(status.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Signed in, backing up automatically"
      : session.mode === "guest"
        ? "Your data is stored only on this device"
        : "Not signed in";

  return (
    <SettingsGroup
      header="ByTune account"
      footer={
        signedIn
          ? "Backup runs automatically. Changes upload within seconds. Restore replaces this device's copy with the cloud version (a local backup is kept first)."
          : "Create an account to keep your library safe even if this PC's app data is wiped."
      }
    >
      <SettingsRow
        icon={signedIn ? UserRound : User}
        title={signedIn ? (session.username ?? "Account") : session.mode === "guest" ? "Guest" : "No account"}
        subtitle={subtitle}
        badge={session.mode === "guest" ? "Guest" : undefined}
        trailing={
          signedIn ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                changeUsername();
              }}
              className="h-7 px-2.5 rounded-md bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[12px] font-semibold text-ink-hi transition-colors"
            >
              Change
            </button>
          ) : undefined
        }
      />
      <div className="px-4 pb-3 flex flex-wrap gap-2">
        {signedIn ? (
          <>
            <button
              onClick={() => void run(async () => { await window.bytune?.syncBackupNow(); }, "Backup complete")}
              disabled={busy}
              className="h-9 px-3.5 rounded-lg bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[13px] font-semibold text-ink-hi transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <CloudUpload className="w-4 h-4" /> Back up now
            </button>
            <button
              onClick={() => void run(async () => { await window.bytune?.syncRestoreNow(); }, "Restored from cloud")}
              disabled={busy}
              className="h-9 px-3.5 rounded-lg bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[13px] font-semibold text-ink-hi transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <CloudDownload className="w-4 h-4" /> Restore from cloud
            </button>
            <button
              onClick={signOutWithConfirm}
              disabled={busy}
              className="h-9 px-3.5 rounded-lg bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[13px] font-semibold text-ink-hi transition-colors disabled:opacity-40"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={async () => {
              // Guests upgrade by re-running onboarding; their local data
              // stays and merges into the account on the first sync.
              if (session.mode === "guest") {
                try {
                  await window.bytune?.authClearGuestProfile();
                } catch {
                  useUI.getState().toast("Couldn't open onboarding — try again", "error");
                  return;
                }
              }
              void useSession.getState().refresh();
            }}
            className="h-9 px-3.5 rounded-lg bg-accent text-[13px] font-semibold text-on-primary hover:brightness-110"
          >
            {session.mode === "guest" ? "Create account / sign in" : "Sign in or create account"}
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}

export function SettingsView() {
  const s = useSettings();
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const versions = window.bytune?.versions;
  const session = useSession();
  const [guestDeleteOpen, setGuestDeleteOpen] = useState(false);
  const [folderSummary, setFolderSummary] = useState<string | null>(null);

  const refreshFolderSummary = async (): Promise<void> => {
    const lib = await window.bytune?.localLibrary();
    const n = lib?.folders?.length ?? 0;
    setFolderSummary(n === 0 ? "No folders imported yet" : `${n} folder${n === 1 ? "" : "s"} imported`);
  };

  useEffect(() => {
    void refreshFolderSummary();
  }, []);

  const browse = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (dir) {
        s.setDownloadDir(dir);
        toast("Download folder updated", "success");
      }
    } catch {
      toast("Couldn't open the folder picker", "error");
    }
  };

  const chooseMusicFolder = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (!dir) return;
      toast("Importing folder…", "info");
      const res = await window.bytune.addLibraryFolders([dir]);
      if (res.added.length === 0) {
        setFolderSummary(`${res.lib.folders.length} folders imported`);
        toast("That folder is already in your library", "info");
        return;
      }
      s.setLocalMusicFolder(dir);
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      setFolderSummary(`${res.lib.folders.length} folder${res.lib.folders.length === 1 ? "" : "s"} imported`);
      toast("Local library scanned", "success");
    } catch {
      toast("Couldn't import that folder", "error");
    }
  };

  const rescanMusic = async (): Promise<void> => {
    if (!window.bytune) return;
    const lib = await window.bytune.localLibrary();
    if (!lib?.folders?.length) {
      toast("Import a local folder first", "info");
      return;
    }
    toast("Rescanning local library…", "info");
    try {
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      toast("Local library updated", "success");
    } catch {
      toast("Rescan failed", "error");
    }
  };

  const exportData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupExport();
      if (res?.path) toast("Backup saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed", "error");
    }
  };

  const importData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupImport();
      if (res?.restored) {
        toast(
          `Backup restored${typeof res.months === "number" && res.months > 0 ? ` (${res.months} months of history)` : ""}. Reloading…`,
          "success"
        );
        window.setTimeout(() => window.location.reload(), 900);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Import failed", "error");
    }
  };

  const resetAppData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      // Main-process wipe: every store, history buckets and derived caches.
      // Downloaded audio files are the user's files and stay on disk.
      await window.bytune.resetData();
      window.location.reload();
    } catch {
      toast("Couldn't reset app data", "error");
    }
  };

  return (
    <div className="max-w-2xl pb-14">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi px-5 pt-2 pb-3.5">
        Settings
      </h1>

      <CloudAccountGroup />

      <SettingsGroup header="Audio quality">
        <SettingsRow
          icon={Wifi}
          title="Streaming quality"
          subtitle="Ceiling for streamed audio"
          value={STREAM_QUALITY_LABEL[s.streamingQuality]}
          onClick={() => {
            const order: StreamQuality[] = ["low", "medium", "high", "lossless"];
            const next = order[(order.indexOf(s.streamingQuality) + 1) % order.length];
            s.setStreamingQuality(next);
          }}
        />
      </SettingsGroup>

      <SettingsGroup
        header="Downloads"
        footer="Export compatible saves into your Music library (Music/ByTune) so other players can use the files; otherwise downloads stay in the folder above."
      >
        <SettingsRow
          icon={FolderOpen}
          title="Download folder"
          subtitle={s.downloadDir ?? "Default: your system Downloads folder / ByTune"}
          onClick={() => void browse()}
        />
        <Divider />
        <SettingsRow
          icon={Download}
          title="Download quality"
          subtitle="What a saved track costs on disk"
          value={DOWNLOAD_QUALITY_LABEL[s.downloadQuality]}
          onClick={() => {
            const order: DownloadQuality[] = ["standard", "high", "lossless"];
            const next = order[(order.indexOf(s.downloadQuality) + 1) % order.length];
            s.setDownloadQuality(next);
          }}
        />
        <SettingsSubRow
          title="Export compatible downloads"
          checked={s.exportDownloads}
          onChange={s.setExportDownloads}
          badge={s.exportDownloads ? "Music/ByTune" : undefined}
        />
      </SettingsGroup>

      <SettingsGroup header="Playback">
        {!s.smartFade && (
          <>
            <SliderRow
              icon={Activity}
              title="Crossfade"
              subtitle="Blend the end of one track into the next"
              value={s.crossfadeSeconds === 0 ? "Off" : `${s.crossfadeSeconds}s`}
              min={0}
              max={12}
              step={1}
              current={s.crossfadeSeconds}
              onChange={s.setCrossfadeSeconds}
            />
            <Divider />
          </>
        )}
        <SettingsRow
          icon={Sparkles}
          title="Automix"
          subtitle={s.smartFade ? "Enabled: transitions decided per track pair" : "Disabled: uses the crossfade above"}
          trailing={<Switch checked={s.smartFade} onChange={s.setSmartFade} />}
          onClick={() => s.setSmartFade(!s.smartFade)}
        />
        <Divider />
        <SettingsRow
          icon={VolumeX}
          title="Skip silence"
          subtitle="Jump over silent intros and gaps"
          trailing={<Switch checked={s.skipSilence} onChange={s.setSkipSilence} />}
          onClick={() => s.setSkipSilence(!s.skipSilence)}
        />
        <Divider />
        <SettingsRow
          icon={InfinityIcon}
          title="Autoplay"
          subtitle="Keep the music going when the queue ends"
          trailing={<Switch checked={s.autoplay} onChange={s.setAutoplay} />}
          onClick={() => s.setAutoplay(!s.autoplay)}
        />
        <Divider />
        <SliderRow
          icon={Gauge}
          title="Playback speed"
          subtitle="Pitch-preserving tempo for everything you play"
          value={`${s.playbackSpeed.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}x`}
          min={0.5}
          max={2}
          step={0.05}
          current={s.playbackSpeed}
          onChange={s.setPlaybackSpeed}
        />
      </SettingsGroup>

      <SettingsGroup header="Appearance">
        <SettingsRow
          icon={AppWindow}
          title="Reduce animation"
          subtitle="Cut crossfades and motion through the app"
          trailing={<Switch checked={s.reduceAnimation} onChange={s.setReduceAnimation} />}
          onClick={() => s.setReduceAnimation(!s.reduceAnimation)}
        />
        <Divider />
        <SettingsRow
          icon={Droplets}
          title="Reduce dynamic blur"
          subtitle="Fill glass surfaces solid instead of blurring"
          trailing={<Switch checked={s.reduceDynamicBlur} onChange={s.setReduceDynamicBlur} />}
          onClick={() => s.setReduceDynamicBlur(!s.reduceDynamicBlur)}
        />
        <Divider />
        <SettingsRow
          icon={Sparkles}
          title="Liquid glass"
          subtitle="Refractive glass on the floating chrome"
          trailing={<Switch checked={s.liquidGlass} onChange={s.setLiquidGlass} disabled={s.reduceDynamicBlur} />}
          onClick={() => s.setLiquidGlass(!s.liquidGlass)}
        />
        <Divider />
        <SettingsRow
          icon={Maximize2}
          title="Full-screen cover art"
          subtitle="Let the artwork bleed behind the status area"
          trailing={<Switch checked={s.fullBleedArtwork} onChange={s.setFullBleedArtwork} />}
          onClick={() => s.setFullBleedArtwork(!s.fullBleedArtwork)}
        />
        <Divider />
        <SettingsRow
          icon={Image}
          title="Legacy mesh gradient"
          subtitle="Use the older drifting-blob player backdrop"
          trailing={<Switch checked={s.legacyMeshGradient} onChange={s.setLegacyMeshGradient} />}
          onClick={() => s.setLegacyMeshGradient(!s.legacyMeshGradient)}
        />
        <Divider />
        <SettingsRow
          icon={Music4}
          title="Animated cover art"
          subtitle="Play canvas clips in place of the still cover"
          trailing={<Switch checked={s.animatedCanvas} onChange={s.setAnimatedCanvas} />}
          onClick={() => s.setAnimatedCanvas(!s.animatedCanvas)}
        />
        <Divider />
        <SettingsRow
          icon={ListMusic}
          title="Synced lyrics"
          subtitle="Highlight the current line and auto-scroll"
          trailing={<Switch checked={s.syncedLyrics} onChange={s.setSyncedLyrics} />}
          onClick={() => s.setSyncedLyrics(!s.syncedLyrics)}
        />
        {s.syncedLyrics && (
          <>
            <Divider />
            <SettingsRow
              icon={Droplets}
              title="Blur unfocused lyrics"
              subtitle="Keep the spotlight on the current line"
              trailing={<Switch checked={s.blurUnfocusedLyrics} onChange={s.setBlurUnfocusedLyrics} />}
              onClick={() => s.setBlurUnfocusedLyrics(!s.blurUnfocusedLyrics)}
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup header="Local music">
        <SettingsRow
          icon={FolderOpen}
          title="Local music folders"
          subtitle={folderSummary ?? "Your imported collections"}
          onClick={() => useUI.getState().navigate({ name: "local" })}
        />
        <Divider />
        <SettingsRow
          icon={ListMusic}
          title="Add a folder"
          subtitle="Import music folders — a parent folder brings its music subfolders along"
          onClick={() => void chooseMusicFolder()}
        />
        <Divider />
        <SettingsRow
          icon={RefreshCw}
          title="Rescan library"
          subtitle="Re-read tags and artwork from every imported folder"
          onClick={() => void rescanMusic()}
        />
        <Divider />
        <SettingsRow
          icon={Music4}
          title="Filter non-music audio"
          subtitle="Hide clips, recordings and voice notes (applies on rescan)"
          trailing={<Switch checked={s.filterNonMusicAudio} onChange={(v) => { s.setFilterNonMusicAudio(v); void rescanMusic(); }} />}
          onClick={() => { s.setFilterNonMusicAudio(!s.filterNonMusicAudio); void rescanMusic(); }}
        />
      </SettingsGroup>



      <SettingsGroup header="Your data">
        <SettingsRow
          icon={BarChart3}
          title="Replay"
          subtitle="Your listening wrapped over time"
          onClick={() => useUI.getState().navigate({ name: "replay" })}
        />
        <Divider />
        <SettingsRow
          icon={FileUp}
          title="Export data"
          subtitle="Write a backup of your library and history"
          onClick={() => void exportData()}
        />
        <Divider />
        <SettingsRow
          icon={FileDown}
          title="Import data"
          subtitle="Restore a backup, replacing what's here"
          onClick={() =>
            openDialog({
              title: "Import a backup?",
              body: "Your current library, playlists and history will be replaced by the backup's.",
              confirmLabel: "Choose file",
              danger: true,
              onConfirm: () => void importData(),
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup
        header="Miscellaneous"
        footer="These apply to this desktop client and are stored locally."
      >
        <SettingsRow
          icon={ListMusic}
          title="Don't repeat suggestions"
          subtitle="Keep recently played tracks out of the home feed"
          trailing={<Switch checked={s.dontRepeatSuggestions} onChange={s.setDontRepeatSuggestions} />}
          onClick={() => s.setDontRepeatSuggestions(!s.dontRepeatSuggestions)}
        />
        <Divider />
        <SettingsRow
          icon={VolumeX}
          title="Hide volume bar"
          subtitle="Keep the player bar free of the volume slider"
          trailing={<Switch checked={s.hideVolumeBar} onChange={s.setHideVolumeBar} />}
          onClick={() => s.setHideVolumeBar(!s.hideVolumeBar)}
        />
      </SettingsGroup>



      <SettingsGroup header="Danger zone">
        <SettingsRow
          icon={Trash2}
          title="Reset app data"
          subtitle="Erase library, playlists, history and settings on this device"
          onClick={() => {
            // Guests have no cloud backup — deletion is unrecoverable, so
            // route through the dedicated protection modal instead.
            if (session.mode === "guest") {
              setGuestDeleteOpen(true);
              return;
            }
            openDialog({
              title: "Reset local data?",
              body: "Your local ByTune data will be removed from this device. Your account and cloud backup won't be deleted. Sign in again and everything restores. Downloaded audio files are not touched.",
              confirmLabel: "Reset local data",
              danger: true,
              onConfirm: () => void resetAppData(),
            });
          }}
        />
      </SettingsGroup>

      {guestDeleteOpen && (
        <GuestDeleteModal
          onClose={() => setGuestDeleteOpen(false)}
          onSignIn={async () => {
            setGuestDeleteOpen(false);
            try {
              await window.bytune?.authClearGuestProfile();
            } catch {
              useUI.getState().toast("Couldn't open onboarding — try again", "error");
              return;
            }
            setOnboardingIntent("signin");
            void useSession.getState().refresh();
          }}
          onCreateAccount={async () => {
            setGuestDeleteOpen(false);
            try {
              await window.bytune?.authClearGuestProfile();
            } catch {
              useUI.getState().toast("Couldn't open onboarding — try again", "error");
              return;
            }
            setOnboardingIntent("signup");
            void useSession.getState().refresh();
          }}
          onDeleteAnyway={() => {
            setGuestDeleteOpen(false);
            void resetAppData();
          }}
        />
      )}


      <div className="text-center text-[11px] text-ink-dim/80 pt-6 px-5 leading-relaxed">
        ByTune {versions?.app ?? "1.0.0"} · GPL-3.0
      </div>
    </div>
  );
}