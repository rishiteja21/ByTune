/**
 * Replay — the listening-statistics experience, fed exclusively by what
 * ByTune actually recorded (electron/stats.ts). No fake numbers: an empty
 * period says so.
 */
import { useEffect, useState } from "react";
import { Clock3, Disc3, Mic2, Music2 } from "lucide-react";
import { Artwork, EmptyState, ErrorState, Pills } from "../components/primitives";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

interface Summary {
  totalMs: number;
  plays: number;
  tracks: { id: string; title: string; artist: string; thumb: string; ms: number; plays: number }[];
  artists: { name: string; ms: number; plays: number }[];
  albums: { name: string; artist?: string; ms: number; plays: number }[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: string;
  months: string[];
}

const PERIODS = [
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
] as const;

function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} hrs`;
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ReplayView() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("month");
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const playQueue = usePlayer((s) => s.playQueue);
  const toast = useUI((s) => s.toast);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.bytune
      ?.statsSummary(period)
      .then((res) => {
        if (!cancelled) setData(res as Summary);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, nonce]);

  if (error) {
    return <ErrorState title="Replay didn't load" body="Give it another try." onRetry={() => setNonce((n) => n + 1)} />;
  }

  const hasData = !!data && data.totalMs > 0;
  const maxDay = Math.max(1, ...(data?.days.map((d) => d.ms) ?? [1]));
  const recentDays = (data?.days ?? []).slice(-28);
  const maxHour = Math.max(1, ...(data?.hours.map((h) => h) ?? [1]));
  const topTracks: Track[] = (data?.tracks ?? []).slice(0, 20).map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    thumb: t.thumb,
    duration: 0,
  }));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-slide-up">
        <div>
          <h1 className="font-display text-[34px] font-bold tracking-[-0.03em] text-ink-hi">Replay</h1>
          <p className="text-[13.5px] text-ink-dim mt-1">Your listening, counted by ByTune — nothing estimated.</p>
        </div>
        <Pills options={PERIODS.map((p) => ({ key: p.key, label: p.label }))} value={period} onChange={(k) => setPeriod(k as typeof period)} />
      </div>

      {loading && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-28 rounded-2xl" />
          ))}
        </div>
      )}

      {!loading && !hasData && (
        <EmptyState
          icon={Clock3}
          title="Nothing here yet"
          body="Play something first — Replay fills in as ByTune counts what you actually listen to."
        />
      )}

      {!loading && hasData && data && (
        <>
          {/* Hero stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Listening time</div>
              <div className="font-display text-[30px] font-bold text-ink-hi mt-2">{fmtHours(data.totalMs)}</div>
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Plays</div>
              <div className="font-display text-[30px] font-bold text-ink-hi mt-2">{data.plays}</div>
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Top artist</div>
              <div className="font-display text-[19px] font-bold text-ink-hi mt-2 truncate">
                {data.artists[0]?.name ?? "—"}
              </div>
              {data.artists[0] && <div className="text-[12.5px] text-ink-dim mt-1">{fmtHours(data.artists[0].ms)}</div>}
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Top song</div>
              <div className="font-display text-[19px] font-bold text-ink-hi mt-2 truncate">
                {data.tracks[0]?.title ?? "—"}
              </div>
              {data.tracks[0] && <div className="text-[12.5px] text-ink-dim mt-1 truncate">{data.tracks[0].artist}</div>}
            </div>
          </div>

          {/* Listening activity */}
          {recentDays.length > 1 && (
            <section>
              <h2 className="section-title text-[21px] mb-4">Listening activity</h2>
              <div className="glass-pill rounded-2xl p-5">
                <div className="flex items-end gap-1.5 h-28">
                  {recentDays.map((d) => (
                    <div
                      key={d.date}
                      title={`${fmtDate(d.date)} — ${fmtHours(d.ms)}`}
                      className="flex-1 rounded-t-md bg-accent/70 hover:bg-accent transition-colors min-h-[3px]"
                      style={{ height: `${Math.max(3, (d.ms / maxDay) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-ink-faint mt-2">
                  <span>{fmtDate(recentDays[0].date)}</span>
                  <span>{fmtDate(recentDays[recentDays.length - 1].date)}</span>
                </div>
              </div>
            </section>
          )}

          {/* Listening clock */}
          <section>
            <h2 className="section-title text-[21px] mb-4">When you listen</h2>
            <div className="glass-pill rounded-2xl p-5">
              <div className="flex items-end gap-1 h-20">
                {data.hours.map((ms, h) => (
                  <div key={h} title={`${h}:00 — ${fmtHours(ms)}`} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t-sm bg-ink-hi/25 hover:bg-ink-hi/50 transition-colors min-h-[2px]"
                      style={{ height: `${Math.max(2, (ms / maxHour) * 72)}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-ink-faint mt-2">
                <span>12am</span>
                <span>6am</span>
                <span>12pm</span>
                <span>6pm</span>
                <span>11pm</span>
              </div>
            </div>
          </section>

          {/* Top tracks + artists */}
          <div className="grid lg:grid-cols-2 gap-8">
            <section>
              <h2 className="section-title text-[21px] mb-4">Top songs</h2>
              <div className="glass-pill rounded-2xl p-2">
                {topTracks.slice(0, 10).map((t, i) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      playQueue(topTracks, i);
                      toast(`Playing ${t.title}`, "info");
                    }}
                    className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-ink-hi/[0.05] transition-colors text-left"
                  >
                    <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                    <Artwork src={t.thumb} className="w-11 h-11 rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-ink-hi truncate">{t.title}</span>
                      <span className="block text-[12.5px] text-ink-dim truncate">{t.artist}</span>
                    </span>
                    <span className="text-[12.5px] text-ink-faint shrink-0">
                      {fmtHours(data.tracks.find((x) => x.id === t.id)?.ms ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h2 className="section-title text-[21px] mb-4">Top artists</h2>
              <div className="glass-pill rounded-2xl p-4 space-y-3">
                {data.artists.slice(0, 10).map((a, i) => (
                  <div key={a.name} className="flex items-center gap-3">
                    <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                    <span className="w-9 h-9 rounded-full bg-ink-hi/[0.07] grid place-items-center shrink-0">
                      {i === 0 ? <Mic2 className="w-4 h-4 text-ink-dim" /> : <Music2 className="w-4 h-4 text-ink-dim" />}
                    </span>
                    <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink-hi truncate">{a.name}</span>
                    <span className="text-[12.5px] text-ink-faint shrink-0">{fmtHours(a.ms)}</span>
                  </div>
                ))}
              </div>
              {data.albums.length > 0 && (
                <>
                  <h2 className="section-title text-[21px] mt-8 mb-4">Top albums</h2>
                  <div className="glass-pill rounded-2xl p-4 space-y-3">
                    {data.albums.slice(0, 5).map((al, i) => (
                      <div key={`${al.name}-${i}`} className="flex items-center gap-3">
                        <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                        <span className="w-9 h-9 rounded-lg bg-ink-hi/[0.07] grid place-items-center shrink-0">
                          <Disc3 className="w-4 h-4 text-ink-dim" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-semibold text-ink-hi truncate">{al.name}</span>
                          <span className="block text-[12.5px] text-ink-dim truncate">{al.artist}</span>
                        </span>
                        <span className="text-[12.5px] text-ink-faint shrink-0">{fmtHours(al.ms)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
