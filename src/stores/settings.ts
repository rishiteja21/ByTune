/** User settings (persisted). Dark theme only — no theme switching. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";

export type StreamQuality = "low" | "medium" | "high" | "lossless";
export type DownloadQuality = "standard" | "high" | "lossless";

export const STREAM_QUALITY_LABEL: Record<StreamQuality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  lossless: "Lossless",
};

export const DOWNLOAD_QUALITY_LABEL: Record<DownloadQuality, string> = {
  standard: "Standard",
  high: "High",
  lossless: "Lossless",
};

interface SettingsState {
  /* Downloads */
  downloadDir: string | null;
  downloadQuality: DownloadQuality;
  exportDownloads: boolean;

  /* Playback */
  streamingQuality: StreamQuality;
  crossfadeSeconds: number;
  smartFade: boolean;
  skipSilence: boolean;
  autoplay: boolean;
  /** 0.5..2 — persisted playback speed (pitch-preserving) */
  playbackSpeed: number;
  /** Audio output device (setSinkId). "" follows the system default. */
  audioSinkId: string;

  /* Appearance */
  reduceAnimation: boolean;
  reduceDynamicBlur: boolean;
  liquidGlass: boolean;
  fullBleedArtwork: boolean;
  legacyMeshGradient: boolean;
  animatedCanvas: boolean;
  syncedLyrics: boolean;
  blurUnfocusedLyrics: boolean;

  /* Local music */
  localMusicFolder: string | null;
  filterNonMusicAudio: boolean;

  /* Miscellaneous */
  dontRepeatSuggestions: boolean;
  hideVolumeBar: boolean;

  setDownloadDir(dir: string | null): void;
  setDownloadQuality(q: DownloadQuality): void;
  setExportDownloads(v: boolean): void;
  setStreamingQuality(q: StreamQuality): void;
  setCrossfadeSeconds(v: number): void;
  setSmartFade(v: boolean): void;
  setSkipSilence(v: boolean): void;
  setAutoplay(v: boolean): void;
  setPlaybackSpeed(v: number): void;
  setAudioSinkId(sinkId: string): void;
  setReduceAnimation(v: boolean): void;
  setReduceDynamicBlur(v: boolean): void;
  setLiquidGlass(v: boolean): void;
  setFullBleedArtwork(v: boolean): void;
  setLegacyMeshGradient(v: boolean): void;
  setAnimatedCanvas(v: boolean): void;
  setSyncedLyrics(v: boolean): void;
  setBlurUnfocusedLyrics(v: boolean): void;
  setLocalMusicFolder(v: string | null): void;
  setFilterNonMusicAudio(v: boolean): void;
  setDontRepeatSuggestions(v: boolean): void;
  setHideVolumeBar(v: boolean): void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      downloadDir: null,
      downloadQuality: "lossless",
      exportDownloads: false,

      streamingQuality: "high",
      crossfadeSeconds: 0,
      smartFade: false,
      skipSilence: false,
      autoplay: false,
      playbackSpeed: 1,
      audioSinkId: "",

      reduceAnimation: false,
      reduceDynamicBlur: false,
      liquidGlass: true,
      fullBleedArtwork: false,
      legacyMeshGradient: false,
      animatedCanvas: false,
      syncedLyrics: true,
      blurUnfocusedLyrics: true,

      localMusicFolder: null,
      filterNonMusicAudio: true,

      dontRepeatSuggestions: false,
      hideVolumeBar: false,

      setDownloadDir: (downloadDir) => set({ downloadDir }),
      setDownloadQuality: (downloadQuality) => set({ downloadQuality }),
      setExportDownloads: (exportDownloads) => set({ exportDownloads }),
      setStreamingQuality: (streamingQuality) => set({ streamingQuality }),
      setCrossfadeSeconds: (crossfadeSeconds) => set({ crossfadeSeconds }),
      setSmartFade: (smartFade) => set({ smartFade }),
      setSkipSilence: (skipSilence) => set({ skipSilence }),
      setAutoplay: (autoplay) => set({ autoplay }),
      setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed: Math.min(2, Math.max(0.5, playbackSpeed)) }),
      setAudioSinkId: (audioSinkId) => set({ audioSinkId }),
      setReduceAnimation: (reduceAnimation) => set({ reduceAnimation }),
      setReduceDynamicBlur: (reduceDynamicBlur) => set({ reduceDynamicBlur }),
      setLiquidGlass: (liquidGlass) => set({ liquidGlass }),
      setFullBleedArtwork: (fullBleedArtwork) => set({ fullBleedArtwork }),
      setLegacyMeshGradient: (legacyMeshGradient) => set({ legacyMeshGradient }),
      setAnimatedCanvas: (animatedCanvas) => set({ animatedCanvas }),
      setSyncedLyrics: (syncedLyrics) => set({ syncedLyrics }),
      setBlurUnfocusedLyrics: (blurUnfocusedLyrics) => set({ blurUnfocusedLyrics }),
      setLocalMusicFolder: (localMusicFolder) => set({ localMusicFolder }),
      setFilterNonMusicAudio: (filterNonMusicAudio) => set({ filterNonMusicAudio }),
      setDontRepeatSuggestions: (dontRepeatSuggestions) => set({ dontRepeatSuggestions }),
      setHideVolumeBar: (hideVolumeBar) => set({ hideVolumeBar }),
    }),
    {
      name: "settings",
      storage: createJSONStorage(() => storage),
    }
  )
);