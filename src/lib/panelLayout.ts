/** Width rules for the three-pane shell. All sizes are CSS pixels. */
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 480;
export const CONTENT_MIN_WIDTH = 480;
export const PANEL_DIVIDER_WIDTH = 8;

export interface PanelWidths {
  library: number;
  nowPlaying: number;
}

export type SidePanel = keyof PanelWidths;

export const DEFAULT_PANEL_WIDTHS: Readonly<PanelWidths> = { library: 328, nowPlaying: 328 };

const readWidth = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(value)))
    : fallback;

/** Old installs, partial saves and damaged values all get usable widths. */
export function readPanelWidths(raw: unknown): PanelWidths {
  const value = raw && typeof raw === "object" ? raw as Partial<PanelWidths> : {};
  return {
    library: readWidth(value.library, DEFAULT_PANEL_WIDTHS.library),
    nowPlaying: readWidth(value.nowPlaying, DEFAULT_PANEL_WIDTHS.nowPlaying),
  };
}

/** containerWidth excludes the shell's outer margins, but includes both dividers. */
function panelBudget(containerWidth: number): number {
  const width = Number.isFinite(containerWidth) ? Math.floor(containerWidth) : 0;
  // At the native window's 1000px minimum, all three minimums fit. A hidden or
  // unusually small browser preview still keeps the side panels at their minimums.
  return Math.max(2 * PANEL_MIN_WIDTH, width - 2 * PANEL_DIVIDER_WIDTH - CONTENT_MIN_WIDTH);
}

/** Fit saved preferences to this window without modifying the saved values. */
export function fitPanelWidths(preferred: PanelWidths, containerWidth: number): PanelWidths {
  const widths = readPanelWidths(preferred);
  const budget = panelBudget(containerWidth);
  const total = widths.library + widths.nowPlaying;
  if (total <= budget) return widths;

  // Share the reduction according to each panel's room above its minimum.
  // Neither side is sacrificed first when the window gets smaller.
  const fraction = (budget - 2 * PANEL_MIN_WIDTH) / (total - 2 * PANEL_MIN_WIDTH);
  const library = PANEL_MIN_WIDTH + Math.floor((widths.library - PANEL_MIN_WIDTH) * fraction);
  return { library, nowPlaying: budget - library };
}

/** A divider stops before it squeezes either the opposite panel or the content. */
export function panelMaxWidth(panel: SidePanel, widths: PanelWidths, containerWidth: number): number {
  const fitted = fitPanelWidths(widths, containerWidth);
  const other = panel === "library" ? fitted.nowPlaying : fitted.library;
  return Math.min(PANEL_MAX_WIDTH, panelBudget(containerWidth) - other);
}

export function resizePanel(widths: PanelWidths, panel: SidePanel, requested: number, containerWidth: number): PanelWidths {
  const fitted = fitPanelWidths(widths, containerWidth);
  return {
    ...fitted,
    [panel]: Math.min(readWidth(requested, fitted[panel]), panelMaxWidth(panel, fitted, containerWidth)),
  };
}
