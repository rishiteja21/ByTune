/** Player state — pure data; playback side effects live in lib/audio.ts. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
// Coalescing storage: the engine bumps `position` ~4Hz and persist writes on
// every change — raw writes would hit disk/IPC several times a second.
import { coalescedStorage } from "../lib/persist";
import type { Track } from "../types";

export type RepeatMode = "off" | "all" | "one";

interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  /** 0..1 — how much of the current track the audio element has buffered */
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** bumped whenever the engine should hard-seek to `position` */
  seekNonce: number;
  error: string | null;

  current(): Track | null;
  playQueue(tracks: Track[], startIndex?: number): void;
  playTrack(track: Track): void;
  addToQueue(tracks: Track | Track[], playNext?: boolean): void;
  removeAt(i: number): void;
  moveInQueue(from: number, to: number): void;
  clearUpcoming(): void;
  next(manual?: boolean): void;
  prev(): void;
  toggle(): void;
  setPlaying(playing: boolean): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;

  /* internal setters used by the audio engine */
  _setTime(position: number, duration?: number): void;
  _setBuffered(ratio: number): void;
  _setBuffering(buffering: boolean): void;
  _setError(error: string | null): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      index: 0,
      playing: false,
      buffering: false,
      position: 0,
      duration: 0,
      buffered: 0,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: "off",
      seekNonce: 0,
      error: null,

      current() {
        const { queue, index } = get();
        return queue[index] ?? null;
      },

      playQueue(tracks, startIndex = 0) {
        if (!tracks.length) return;
        set({
          queue: tracks,
          index: clamp(startIndex, 0, tracks.length - 1),
          playing: true,
          position: 0,
          error: null,
        });
      },

      playTrack(track) {
        const { queue, index } = get();
        const at = queue.findIndex((t) => t.id === track.id);
        if (at >= 0) {
          set({ index: at, playing: true, position: 0, error: null });
        } else {
          const q = [...queue.slice(0, index + 1), track, ...queue.slice(index + 1)];
          set({ queue: q, index: index + 1, playing: true, position: 0, error: null });
        }
      },

      addToQueue(tracks, playNext = false) {
        const list = Array.isArray(tracks) ? tracks : [tracks];
        if (!list.length) return;
        const { queue, index } = get();
        if (!queue.length) {
          set({ queue: list, index: 0, playing: false, position: 0 });
          return;
        }
        if (playNext) {
          set({ queue: [...queue.slice(0, index + 1), ...list, ...queue.slice(index + 1)] });
        } else {
          set({ queue: [...queue, ...list] });
        }
      },

      removeAt(i) {
        const { queue, index } = get();
        if (i < 0 || i >= queue.length) return;
        const q = queue.filter((_, j) => j !== i);
        let ni = index;
        if (i < index) ni = index - 1;
        else if (i === index) ni = Math.min(index, Math.max(q.length - 1, 0));
        set({ queue: q, index: ni });
      },

      moveInQueue(from, to) {
        const { queue, index } = get();
        if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
        const q = [...queue];
        const [moved] = q.splice(from, 1);
        q.splice(to, 0, moved);
        let ni = index;
        if (from === index) ni = to;
        else if (from > index && to <= index) ni = index + 1;
        else if (from < index && to >= index) ni = index - 1;
        set({ queue: q, index: ni });
      },

      clearUpcoming() {
        const { index } = get();
        set({ queue: get().queue.slice(0, index + 1) });
      },

      next(manual = false) {
        const { queue, index, shuffle, repeat } = get();
        if (!queue.length) {
          set({ playing: false });
          return;
        }
        let ni: number;
        if (shuffle && queue.length > 1) {
          do {
            ni = Math.floor(Math.random() * queue.length);
          } while (ni === index);
        } else {
          ni = index + 1;
          if (ni >= queue.length) {
            if (manual || repeat === "all") {
              ni = 0;
            } else {
              set({ playing: false, position: 0 });
              return;
            }
          }
        }
        set({ index: ni, playing: true, position: 0, error: null });
      },

      prev() {
        if (get().position > 3) {
          set({ position: 0, seekNonce: get().seekNonce + 1 });
          return;
        }
        const { queue, index } = get();
        if (!queue.length) return;
        const ni = index > 0 ? index - 1 : queue.length - 1;
        set({ index: ni, playing: true, position: 0, error: null });
      },

      toggle() {
        // Nothing to play or pause: flipping `playing` against an empty queue
        // left the play button reading "Pause" with no audio behind it.
        if (!get().queue.length) return;
        set({ playing: !get().playing });
      },

      setPlaying(playing) {
        // Mirrors toggle(): a media-key "play" with an empty queue (e.g.
        // after removing every queued track) must not flip the store into a
        // playing state nothing can back.
        if (playing && !get().queue.length) return;
        set({ playing });
      },

      seek(sec) {
        const { duration } = get();
        set({
          position: clamp(sec, 0, duration > 0 ? duration : sec),
          seekNonce: get().seekNonce + 1,
        });
      },

      setVolume(v) {
        set({ volume: clamp(v, 0, 1), muted: false });
      },

      toggleMute() {
        set({ muted: !get().muted });
      },

      toggleShuffle() {
        set({ shuffle: !get().shuffle });
      },

      cycleRepeat() {
        const order: RepeatMode[] = ["off", "all", "one"];
        set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
      },

      _setTime(position, duration) {
        const d = Number.isFinite(duration) && (duration ?? 0) > 0 ? (duration as number) : get().duration;
        set({ position, duration: d });
      },

      _setBuffered(buffered) {
        if (Math.abs(get().buffered - buffered) > 0.005) set({ buffered });
      },

      _setBuffering(buffering) {
        set({ buffering });
      },

      _setError(error) {
        set({ error });
      },
    }),
    {
      name: "player",
      storage: createJSONStorage(() => coalescedStorage),
      partialize: (s) =>
        ({
          queue: s.queue,
          index: s.index,
          position: s.position,
          volume: s.volume,
          muted: s.muted,
          shuffle: s.shuffle,
          repeat: s.repeat,
        }) as unknown as PlayerState,
    }
  )
);
