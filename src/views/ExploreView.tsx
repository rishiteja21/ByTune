import { Sparkles } from "lucide-react";
import { useUI } from "../stores/ui";

/**
 * Explore: "moods & moments" tiles at desktop scale. Each tile is a
 * diagonal duotone gradient with a bold white title, and a rotated cover
 * thumbnail overlapping the right edge (cropped by the tile) — the mobile
 * Explore layout, widened into a responsive grid.
 */
interface Mood {
  title: string;
  /** [from, to] gradient stops. */
  colors: [string, string];
  thumb: string;
}

const MOODS: Mood[] = [
  {
    title: "Today's hits",
    colors: ["#E13300", "#FF7A45"],
    thumb: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800&q=80",
  },
  {
    title: "Lo-fi beats",
    colors: ["#4B2AAD", "#8B5CF6"],
    thumb: "https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=800&q=80",
  },
  {
    title: "Punjabi hits",
    colors: ["#B5179E", "#F72585"],
    thumb: "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80",
  },
  {
    title: "Bollywood 2000s",
    colors: ["#7B2CBF", "#C77DFF"],
    thumb: "https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=800&q=80",
  },
  {
    title: "Workout energy",
    colors: ["#D00000", "#FFBA08"],
    thumb: "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=800&q=80",
  },
  {
    title: "Focus flow",
    colors: ["#023E8A", "#48CAE4"],
    thumb: "https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=800&q=80",
  },
  {
    title: "Rock classics",
    colors: ["#370617", "#DC2F02"],
    thumb: "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=800&q=80",
  },
  {
    title: "Jazz evenings",
    colors: ["#2B2D42", "#8D99AE"],
    thumb: "https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=800&q=80",
  },
];

const GENRES: Mood[] = [
  {
    title: "Pop",
    colors: ["#C9184A", "#FF4D6D"],
    thumb: "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800&q=80",
  },
  {
    title: "Hip-hop",
    colors: ["#3A0CA3", "#7209B7"],
    thumb: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&q=80",
  },
  {
    title: "Electronic",
    colors: ["#0077B6", "#00B4D8"],
    thumb: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=800&q=80",
  },
  {
    title: "Indie",
    colors: ["#2D6A4F", "#52B788"],
    thumb: "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=800&q=80",
  },
  {
    title: "R&B",
    colors: ["#9D4EDD", "#C77DFF"],
    thumb: "https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=800&q=80",
  },
  {
    title: "Classical",
    colors: ["#4A4E69", "#9A8C98"],
    thumb: "https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=800&q=80",
  },
];

function MoodTile({ mood }: { mood: Mood }) {
  const setQuery = useUI((s) => s.setSearchQuery);
  const navigate = useUI((s) => s.navigate);
  const [from, to] = mood.colors;

  return (
    <button
      onClick={() => {
        setQuery(mood.title);
        navigate({ name: "search" });
      }}
      className="group relative aspect-[16/10] rounded-xl overflow-hidden text-left"
      style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {/* rotated cover, cropped by the tile */}
      <img
        src={mood.thumb}
        alt=""
        className="absolute -right-4 top-1/2 w-[46%] aspect-square object-cover rounded-md shadow-art rotate-[12deg] -translate-y-1/2 transition-transform duration-200 group-hover:rotate-[8deg] art-hairline"
      />
      <div className="absolute inset-0 bg-black/10 group-hover:bg-black/0 transition-colors" />
      <div className="absolute left-4 top-4 right-[48%]">
        <span className="font-display text-[18px] font-extrabold tracking-[-0.02em] text-white leading-tight drop-shadow">
          {mood.title}
        </span>
      </div>
    </button>
  );
}

export function ExploreView() {
  return (
    <div className="pt-2">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi pb-5 flex items-center gap-3">
        <Sparkles className="w-7 h-7 text-ink-hi/80" />
        Explore
      </h1>

      <h2 className="section-title text-[21px] mb-4">Moods &amp; moments</h2>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
        {MOODS.map((m) => (
          <MoodTile key={m.title} mood={m} />
        ))}
      </div>

      <h2 className="section-title text-[21px] mt-9 mb-4">Genres</h2>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
        {GENRES.map((g) => (
          <MoodTile key={g.title} mood={g} />
        ))}
      </div>
    </div>
  );
}