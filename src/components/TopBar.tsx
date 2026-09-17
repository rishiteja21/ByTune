/**
 * Top bar — Spotify's three-cluster layout on a glass strip.
 *
 *  - Left: history chevrons + the brand mark (28dp), like Spotify's logo
 *    beside the back/forward buttons.
 *  - Centre: a centred floating search field, max 560px, on a glass pill.
 *  - Right: notifications, settings, and a round user avatar that opens the
 *    settings dropdown.
 *
 * The bar itself is `chrome-glass` (rgba(0,0,0,0.72) + blur(24) saturate(140%),
 * per index.css) — the same recipe the mobile status bar uses.
 */
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  Copy,
  CornerDownLeft,
  History,
  Home,
  Minus,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { reloadHomeFeed } from "../lib/recs/feed";
import { useSession } from "../lib/session";
import { useUI } from "../stores/ui";
import { usePlayer } from "../stores/player";
import { useRecents } from "../stores/recents";
import type { SearchSuggestion } from "../types";
import brandLogo from "../assets/brand/bytune-logo.svg";
import brandText from "../assets/brand/bytune-Text.svg";

/** Brand mark + wordmark composed inline so the spacing follows the bar height.
    Both SVGs are pure white — they sit directly on the dark `chrome-glass` bar.
    Imported as assets so Vite hashes them and rewrites the URL relative to the
    bundle (base: "./"), which is what makes them resolve under file:// in the
    packaged app — a string like "/brand/x.svg" only works on the dev server. */
function BrandHeader() {
  return (
    <div className="flex items-center gap-2">
      <img
        src={brandLogo}
        alt=""
        aria-hidden
        className="h-7 w-auto block"
      />
      <img
        src={brandText}
        alt="ByTune"
        className="h-5 w-auto block"
      />
    </div>
  );
}

/* Palette for the avatar disc. Every tone is mid-saturation and light enough
   that near-black text stays readable on it. */
const AVATAR_COLORS = [
  "#d97757", "#e0a458", "#d4c95a", "#8fc74f", "#5fc9a2",
  "#59a5d8", "#8f9bf4", "#c58af9", "#e17bb0", "#e06c75",
];

/* Deterministic per-user colour: a simple FNV-1a hash of the username picks
   the palette entry, so an account always gets the same colour across
   launches while different users land on effectively random ones. */
function avatarColor(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ onClick, active }: { onClick: () => void; active?: boolean }) {
  const mode = useSession((s) => s.mode);
  const username = useSession((s) => s.username);
  // Signed-in users show their username's first letter; guest accounts (and
  // sessions that haven't loaded yet) fall back to "G".
  const letter =
    mode === "account" && username?.trim()
      ? username.trim().charAt(0).toUpperCase()
      : "G";
  const color = avatarColor(mode === "account" && username?.trim() ? username.trim().toLowerCase() : "guest");
  return (
    <button
      onClick={onClick}
      title="Settings"
      aria-label="Settings"
      className={`w-11 h-11 rounded-full grid place-items-center transition-colors select-none ${
        active ? "bg-ink-hi/[0.16]" : "bg-ink-hi/[0.10] hover:bg-ink-hi/[0.16]"
      }`}
    >
      <span
        className="grid h-8 w-8 place-items-center rounded-full text-[15px] font-semibold leading-none text-black/85"
        style={{ backgroundColor: color }}
      >
        {letter}
      </span>
    </button>
  );
}

/** Windows caption buttons, drawn by the renderer so they match the theme:
    #242424 hover on min/max, Windows red on close. */
export function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    window.bytune?.isMaximized().then(setMaximized).catch(() => undefined);
    const off = window.bytune?.onMaximizeChange(setMaximized);
    return () => off?.();
  }, []);

  const base =
    "app-no-drag w-[46px] h-full grid place-items-center text-ink-hi/85 transition-colors";
  return (
    <div className="app-no-drag h-full flex items-stretch">
      <button
        onClick={() => window.bytune?.windowMinimize()}
        title="Minimize"
        aria-label="Minimize"
        className={`${base} hover:bg-ink-hi/[0.08]`}
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        onClick={() => window.bytune?.windowMaximizeToggle()}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        className={`${base} hover:bg-ink-hi/[0.08]`}
      >
        {maximized ? <Copy className="w-[13px] h-[13px]" /> : <Square className="w-[13px] h-[13px]" />}
      </button>
      <button
        onClick={() => window.bytune?.windowClose()}
        title="Close"
        aria-label="Close"
        className={`${base} hover:bg-[#c42b1c] hover:text-white`}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function TopBar() {
  const query = useUI((s) => s.searchQuery);
  const setQuery = useUI((s) => s.setSearchQuery);
  const view = useUI((s) => s.view);
  const navigate = useUI((s) => s.navigate);
  const goBack = useUI((s) => s.goBack);
  const goForward = useUI((s) => s.goForward);
  const canBack = useUI((s) => s.navPast.length > 0);
  const canForward = useUI((s) => s.navFuture.length > 0);
  const recents = useRecents((s) => s.searches);
  const removeSearch = useRecents((s) => s.removeSearch);
  const clearSearches = useRecents((s) => s.clearSearches);
  const track = usePlayer((s) => s.queue[s.index] ?? null);

  // Typing only feeds the dropdown — the page behind it stays put. The
  // results page is where songs get chosen; navigation happens on Enter or
  // a completion click, and the dropdown closes either way.

  // Type-ahead dropdown — BitChord mobile's model: plain text completions
  // only, no artwork rows while typing. Row 0 offers the typed query itself.
  const [suggests, setSuggests] = useState<SearchSuggestion[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [fieldFocused, setFieldFocused] = useState(false);
  /** keyboard highlight: 0 = the typed-query row, 1..n = completions, -1 = none */
  const [activeIdx, setActiveIdx] = useState(-1);
  const suggestSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** the field + both dropdowns — blur is ignored while focus stays inside */
  const searchClusterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!fieldFocused || q.length < 2) {
      setSuggests([]);
      setSuggestOpen(false);
      setActiveIdx(-1);
      return;
    }
    const seq = ++suggestSeq.current;
    const timer = window.setTimeout(() => {
      window.bytune
        ?.suggestions(q)
        .then((res) => {
          if (suggestSeq.current !== seq) return; // a newer keystroke won
          // Row 0 already offers the typed query — don't echo it back.
          const items = ((res?.items ?? []) as SearchSuggestion[]).filter(
            (s) => s.text.trim().toLowerCase() !== q.toLowerCase()
          );
          setSuggests(items.slice(0, 8));
          setSuggestOpen(items.length > 0);
          setActiveIdx(-1);
        })
        .catch(() => undefined);
    }, 160);
    return () => window.clearTimeout(timer);
  }, [query, fieldFocused]);

  const closeDropdown = (): void => {
    setSuggestOpen(false);
    setActiveIdx(-1);
  };

  /** Going home always lands clean — a stale query left in the field would
      read as "a search is still active" while the feed shows behind it. */
  const goHome = (): void => {
    setQuery("");
    closeDropdown();
    setSuggests([]);
    setFieldFocused(false);
    inputRef.current?.blur();
    navigate({ name: "home" });
  };

  /** Mobile model: an empty focused field drops the recent-searches panel. */
  const historyOpen = fieldFocused && suggestOpen === false && recents.length > 0 && query.trim().length === 0;

  /** Run a search: commit the text, close the dropdown, blur the field. */
  const submitSearch = (text: string): void => {
    const t = text.trim();
    if (!t) return;
    setQuery(t);
    closeDropdown();
    setFieldFocused(false);
    inputRef.current?.blur();
    navigate({ name: "search" });
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
      setFieldFocused(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown" && suggestOpen && suggests.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggests.length));
    } else if (e.key === "ArrowUp" && suggestOpen) {
      e.preventDefault();
      setActiveIdx((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Keyboard-highlighted completion runs itself; anything else runs the
      // typed query. Either way the dropdown goes away.
      const pick = suggestOpen && activeIdx >= 1 ? suggests[activeIdx - 1]?.text : query;
      submitSearch(pick);
    }
  };

  // Feed refresh — drops the feed's caches and re-orchestrates Home from the
  // latest listening stats. The icon spins while the rebuild settles, and the
  // click hops to Home so the refreshed recommendations are actually on screen.
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const refreshFeed = (): void => {
    if (feedRefreshing) return;
    setFeedRefreshing(true);
    reloadHomeFeed();
    goHome();
    window.setTimeout(() => setFeedRefreshing(false), 800);
  };

  return (
    /* The renderer draws its own caption buttons (CaptionButtons below), so
       the bar runs to the window edge. The bar owns the 12px breathing strip
       under it (App's shell no longer adds one), so its content centres in
       the full 68px — equal space above and below. */
    <div className="app-drag relative h-[68px] shrink-0 flex items-center gap-3 pl-3 chrome-glass z-20">
      {/* Left cluster — brand flush to the edge, then a hairline divider so the
          logo reads as separate from the history + refresh controls (Spotify's
          top-bar model: 32px circular buttons, 16px glyphs). */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={goHome}
          className="app-no-drag flex items-center gap-2 pl-1 pr-2 h-10 rounded-full hover:bg-ink-hi/[0.06] transition-colors"
          title="ByTune"
        >
          <BrandHeader />
        </button>
        <div className="mx-1.5 h-6 w-px bg-ink-hi/15" />
        <button
          onClick={() => goBack()}
          title="Go back"
          aria-label="Go back"
          disabled={!canBack}
          className={`app-no-drag w-9 h-9 grid place-items-center rounded-full transition-colors ${
            canBack
              ? "text-ink-hi/90 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              : "text-ink-hi/30 pointer-events-none"
          }`}
        >
          <ChevronLeft className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={() => goForward()}
          title="Go forward"
          aria-label="Go forward"
          disabled={!canForward}
          className={`app-no-drag w-9 h-9 grid place-items-center rounded-full transition-colors ${
            canForward
              ? "text-ink-hi/90 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              : "text-ink-hi/30 pointer-events-none"
          }`}
        >
          <ChevronRight className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={refreshFeed}
          title="Refresh recommendations"
          aria-label="Refresh recommendations"
          className="app-no-drag w-9 h-9 grid place-items-center rounded-full text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${feedRefreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Centre cluster — home button beside the search field, Spotify-style:
          pinned to the true window centre (not balanced between the side
          clusters), centred on the bar's vertical midline. */}
      <div className="absolute left-1/2 top-0 h-full -translate-x-1/2 flex items-center gap-3">
        <button
          onClick={goHome}
          title="Home"
          aria-label="Home"
          aria-current={view.name === "home" ? "page" : undefined}
          className={`app-no-drag w-12 h-12 shrink-0 grid place-items-center rounded-full transition-colors ${
            view.name === "home"
              ? "bg-elevated text-ink-hi"
              : "bg-panel text-ink-hi/75 hover:text-ink-hi hover:bg-ink-hi/[0.06]"
          }`}
        >
          <Home className="w-5 h-5" />
        </button>
        <div ref={searchClusterRef} className="app-no-drag relative w-[min(474px,36vw)]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-6 h-6 text-ink-hi/55 pointer-events-none" />
          <input
            id="global-search"
            ref={inputRef}
            type="text"
            value={query}
            maxLength={200}
            placeholder="What do you want to play?"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => {
              setFieldFocused(true);
              if (suggests.length > 0) setSuggestOpen(true);
            }}
            onBlur={(e) => {
              // Close the moment focus genuinely leaves the cluster — no
              // timer. Dropdown rows keep focus on the field with
              // onMouseDown preventDefault, so a click on a row never blurs
              // here; and if focus moves INTO the dropdown (keyboard Tab),
              // the popover stays open for it. A pending blur timeout used
              // to fire after a quick re-focus and hide the popover while
              // the field was focused again.
              const next = e.relatedTarget as Node | null;
              if (next && searchClusterRef.current?.contains(next)) return;
              setFieldFocused(false);
              setSuggestOpen(false);
              setActiveIdx(-1);
            }}
            onKeyDown={onSearchKeyDown}
            className={`w-full h-12 pl-12 rounded-full bg-panel border border-transparent text-[16px] text-ink-hi placeholder:text-ink-hi/45 outline-none hover:bg-ink-hi/[0.06] focus:border-ink-hi/25 focus:bg-ink-hi/[0.06] transition-all duration-150 ${
              query.trim() !== "" ? "pr-[104px]" : "pr-[72px]"
            }`}
          />
          {/* Type-ahead dropdown — BitChord mobile's model: the typed query
              plus plain text completions, no artwork rows while typing. */}
          {suggestOpen && suggests.length > 0 && (
            <div
              className="absolute left-0 right-0 top-full mt-2 z-50 glass-strong-solid rounded-2xl p-1.5 shadow-float max-h-[420px] overflow-y-auto animate-pop-in"
              role="listbox"
              aria-label="Search suggestions"
            >
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submitSearch(query)}
                className={`w-full flex items-center gap-3 px-2.5 h-11 rounded-lg text-left transition-colors ${
                  activeIdx === 0 ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.06]"
                }`}
              >
                <Search className="w-4 h-4 text-ink-hi/55 shrink-0" />
                <span className="text-[14px] font-medium text-ink-hi truncate">
                  Search “{query.trim()}”
                </span>
              </button>
              {suggests.map((s, i) => (
                <button
                  key={`${s.text}-${i}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submitSearch(s.text)}
                  className={`w-full flex items-center gap-3 px-2.5 h-11 rounded-lg text-left transition-colors ${
                    activeIdx === i + 1 ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.06]"
                  }`}
                >
                  <Search className="w-4 h-4 text-ink-hi/55 shrink-0" />
                  <span className="min-w-0 flex-1 text-[14px] text-ink-hi truncate">{s.text}</span>
                  <CornerDownLeft className="w-4 h-4 text-ink-hi/35 shrink-0" />
                </button>
              ))}
            </div>
          )}
          {/* Recent searches — BitChord mobile's model: an empty focused field
              drops the history list, with a clear-all in the header and a
              per-row ✕. Choosing a row runs that search. */}
          {historyOpen && (
            <div
              className="absolute left-0 right-0 top-full mt-2 z-50 glass-strong-solid rounded-2xl p-1.5 shadow-float max-h-[420px] overflow-y-auto animate-pop-in"
              role="listbox"
              aria-label="Recent searches"
            >
              <div className="flex items-center justify-between pl-3 pr-1.5 h-9">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-hi/45">
                  Recent searches
                </span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clearSearches}
                  className="px-2 h-6 rounded-full text-[11.5px] text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
                >
                  Clear all
                </button>
              </div>
              {recents.map((q) => (
                <div
                  key={q}
                  /* Whole row is the click target: the inner button only spans
                     its content height, so the rest of the highlighted row
                     showed the arrow cursor and ate clicks. */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => submitSearch(q)}
                  className="group w-full flex cursor-pointer items-center gap-3 pl-2.5 pr-1.5 h-11 rounded-lg hover:bg-ink-hi/[0.06] transition-colors"
                >
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      submitSearch(q);
                    }}
                    className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer"
                  >
                    <History className="w-4 h-4 text-ink-hi/55 shrink-0" />
                    <span className="text-[14px] text-ink-hi truncate">{q}</span>
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSearch(q);
                    }}
                    title="Remove"
                    aria-label={`Remove "${q}" from recent searches`}
                    className="p-1.5 rounded-full text-ink-hi/35 hover:text-ink-hi hover:bg-ink-hi/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Spotify's right side of the field: clear (once there's text), a
              hairline divider, and the Explore (browse) button. Clearing
              from the results view would leave the empty search shell
              behind, so it hops home instead; from any other view it just
              wipes the field and stays put. */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2.5">
            {query.trim() !== "" && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  closeDropdown();
                  setSuggests([]);
                  setFieldFocused(false);
                  inputRef.current?.blur();
                  if (view.name === "search") navigate({ name: "home" });
                }}
                title="Clear search"
                aria-label="Clear search"
                className="p-1.5 rounded-full text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
              >
                <X className="w-[18px] h-[18px]" />
              </button>
            )}
            <div className="h-6 w-px bg-ink-hi/20" />
            <button
              onClick={() => navigate({ name: "explore" })}
              title="Explore"
              aria-label="Explore"
              className={`p-1.5 rounded-full transition-colors ${
                view.name === "explore"
                  ? "text-ink-hi bg-ink-hi/[0.10]"
                  : "text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.08]"
              }`}
            >
              <Compass className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* Right cluster — user badge, then the renderer-drawn caption
          buttons flush to the window edge. */}
      <div className="ml-auto h-full flex items-center gap-1 shrink-0">
        <div className="app-no-drag ml-1 mr-2 flex items-center">
          <Avatar onClick={() => navigate({ name: "settings" })} active={view.name === "settings"} />
        </div>
        <CaptionButtons />
      </div>
    </div>
  );
}
