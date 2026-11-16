/** This computer's panel-width preferences, kept separately from synced account settings. */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { coalescedStorage } from "../lib/persist";
import { DEFAULT_PANEL_WIDTHS, readPanelWidths, type PanelWidths } from "../lib/panelLayout";

interface PanelLayoutState {
  widths: PanelWidths;
  setWidths(widths: PanelWidths): void;
  resetWidths(): void;
}

export const usePanelLayout = create<PanelLayoutState>()(
  persist(
    (set, get) => ({
      widths: { ...DEFAULT_PANEL_WIDTHS },
      setWidths(widths) {
        const next = readPanelWidths(widths);
        const previous = get().widths;
        if (next.library === previous.library && next.nowPlaying === previous.nowPlaying) return;
        set({ widths: next });
      },
      resetWidths: () => get().setWidths(DEFAULT_PANEL_WIDTHS),
    }),
    {
      name: "panel-layout",
      // Pointer moves stay responsive without writing to disk on every frame.
      storage: coalescedStorage,
      partialize: ({ widths }) => ({ widths }),
      merge: (saved, current) => ({
        ...current,
        widths: readPanelWidths((saved as { widths?: unknown } | null)?.widths),
      }),
    }
  )
);
