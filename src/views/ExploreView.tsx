import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useUI } from "../stores/ui";
import { requireBridge } from "../lib/bridge";
import { FALLBACK_MOODS, type MoodEntry } from "../../electron/moods";

/**
 * Explore — the provider's own per-market "Moods & genres" catalog, rendered
 * as duotone tiles using the accent colors YouTube assigns each mood. The
 * list follows the device market (the session's `gl`), so every country gets
 * its own suggestions; when the provider is unreachable the view falls back
 * to a neutral global set. Tapping a tile runs it as a search, exactly like
 * the old hardcoded chips — the difference is the DATA now comes from YouTube
 * for the user's market, never from a hardcoded list.
 */

const MOODS_TTL_MS = 24 * 3_600_000;
let moodCache: { moods: MoodEntry[]; at: number } | null = null;

async function loadMoods(): Promise<MoodEntry[]> {
  if (moodCache && Date.now() - moodCache.at < MOODS_TTL_MS) return moodCache.moods;
  try {
    const moods = (await requireBridge().getMoods()) as MoodEntry[];
    const usable = moods.filter((m) => m.browseId.includes("moods_and_genres_category"));
    if (usable.length >= 6) {
      moodCache = { moods: usable, at: Date.now() };
      return usable;
    }
  } catch {
    /* offline / no bridge — neutral global fallback below */
  }
  return moodCache?.moods ?? FALLBACK_MOODS;
}

/** Darken a #RRGGBB color for the gradient's second stop. */
function shade(hex: string, factor: number): string {
  const n = hex.replace("#", "");
  const rgb = n.length === 6 ? [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) : [58, 12, 163];
  const dark = rgb.map((c) => Math.max(0, Math.round(c * factor)));
  return `#${dark.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function MoodTile({ mood }: { mood: MoodEntry }) {
  const setQuery = useUI((s) => s.setSearchQuery);
  const navigate = useUI((s) => s.navigate);
  const from = mood.color ?? "#3A0CA3";
  const to = shade(from, 0.5);

  return (
    <button
      onClick={() => {
        setQuery(mood.title);
        navigate({ name: "search" });
      }}
      className="group relative aspect-[16/10] rounded-xl overflow-hidden text-left transition-transform duration-200 hover:scale-[1.02]"
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {/* provider accent sheen — a lighter wash toward the top edge */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-25 group-hover:opacity-40 transition-opacity"
        style={{ background: `linear-gradient(180deg, ${from}, transparent 65%)` }}
      />
      <span className="absolute left-4 top-4 right-6 font-display text-[18px] font-extrabold tracking-[-0.02em] text-white leading-tight drop-shadow">
        {mood.title}
      </span>
    </button>
  );
}

export function ExploreView() {
  const [moods, setMoods] = useState<MoodEntry[]>(moodCache?.moods ?? FALLBACK_MOODS);

  useEffect(() => {
    if (moodCache && Date.now() - moodCache.at < MOODS_TTL_MS) return;
    let alive = true;
    void loadMoods().then((m) => {
      if (alive) setMoods(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="pt-2">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi pb-5 flex items-center gap-3">
        <Sparkles className="w-7 h-7 text-ink-hi/80" />
        Explore
      </h1>

      <h2 className="section-title text-[21px] mb-4">Moods &amp; genres</h2>
      <p className="text-[13px] text-ink-dim -mt-3 mb-4">
        Picked for your region by YouTube Music
      </p>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
        {moods.map((m) => (
          <MoodTile key={`${m.title}-${m.params ?? ""}`} mood={m} />
        ))}
      </div>
    </div>
  );
}
