/** Shared data types used by both the Electron main process and the renderer. */

export interface Track {
  /** YouTube video id */
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  /** duration in seconds (0 = unknown) */
  duration: number;
  /** best available thumbnail url */
  thumb: string;
  /** catalogue explicit-content flag (YouTube Music) */
  explicit?: boolean;
  /** the artist's own photo, off the artist page (≠ song artwork) */
  artistImage?: string;
  /** set for local-library tracks (local origin flag; playback resolves via the id) */
  localPath?: string;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  year?: string;
  thumb: string;
  /** "Album" / "Single" / "EP", off the release page header. */
  releaseType?: string;
  /** YouTube's editorial blurb — the "About the album" section. */
  description?: string | null;
  /** The release's artist page, when the header linked one. */
  artistId?: string;
}

export interface Artist {
  id: string;
  name: string;
  thumb: string;
  subtitle?: string;
}

export interface PlaylistCard {
  id: string;
  title: string;
  thumb: string;
  count?: number;
  /** "Playlist • YouTube Music • 33 songs" style line, where the shelf carries one. */
  subtitle?: string;
}

export type SearchFilter = "all" | "songs" | "videos" | "albums" | "artists" | "playlists";

export interface SearchResults {
  songs: Track[];
  videos: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: PlaylistCard[];
  /** YouTube's own "Top result" card — the best match for a partial query. */
  top?: TopResult | null;
  /** Other songs by the top result's artist (Spotify's "more by" row). */
  related?: Track[];
}

/* ---------------- Mobile-faithful search ---------------- */

/** What kind of page a non-track search result opens — YouTube's own pageType. */
export type BrowseType = "album" | "artist" | "playlist" | "other";

/** A non-track search row: album, artist, playlist or profile/podcast. */
export interface BrowseItem {
  browseId: string;
  title: string;
  /** YouTube's own line — "Album • Lana Del Rey • 2012", "Artist • 332M monthly audience". */
  subtitle: string;
  thumb: string;
  type: BrowseType;
}

/**
 * One search row, classified exactly as BitChord mobile classifies it: the
 * promoted card ("top"), an ordinary track row, or a browsable page row.
 */
export type SearchRow =
  | { kind: "top"; song: Track }
  | { kind: "track"; song: Track }
  | { kind: "browse"; item: BrowseItem };

/** One page of search rows, plus the token for the next page (null when done). */
export interface SearchPageResult {
  rows: SearchRow[];
  continuation: string | null;
}

/** The kind-aware "Top result" card (YouTube's MusicCardShelf). */
export interface TopResult {
  kind: "track" | "album" | "artist";
  track?: Track;
  album?: Album;
  artist?: Artist;
}

/** A type-ahead search suggestion from YouTube Music. */
export interface SearchSuggestion {
  text: string;
  thumb?: string;
  subtitle?: string;
  /** videoId when the suggestion carries a playable hit. */
  id?: string;
}

export type HomeItemKind = "track" | "album" | "artist" | "playlist";

export interface HomeItem {
  kind: HomeItemKind;
  track?: Track;
  album?: Album;
  artist?: Artist;
  playlist?: PlaylistCard;
}

export interface HomeShelf {
  title: string;
  items: HomeItem[];
}

/** Extended artist page — the BitChord mobile artist screen's data. */
export interface ArtistPageData {
  artist: Artist;
  /** "About the artist" editorial blurb. */
  description?: string | null;
  /** "18.9M subscribers", off the page header. */
  subscriberCount?: string | null;
  /** "332M monthly listeners", off the page header. */
  monthlyListeners?: string | null;
  /** The "Top songs" shelf rows. */
  songs: Track[];
  /** Albums / Singles & EPs / Featured on / Playlists by X / Fans might also like, in YouTube's own order. */
  shelves: HomeShelf[];
}

/** A remote (YouTube) playlist page, as the mobile app's DetailScreen shows it. */
export interface RemotePlaylistPage {
  title: string;
  /** The credit line — "Marie Liesegang, 105 views". */
  credit: string;
  /** "PLAYLIST • 7 TRACKS" style metadata line. */
  meta: string;
  thumb: string;
  tracks: Track[];
}

export interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number;
}

/* ---------------- Lyrics ---------------- */

/** A word (or syllable group) with its own timing — Apple TTML / rich LRC. */
export interface SyncedLyricWord {
  /** seconds into the track */
  start: number;
  end: number;
  text: string;
}

export interface SyncedLyricLine {
  /** seconds into the track */
  time: number;
  text: string;
  /** per-word timings when the provider is word-synced */
  words?: SyncedLyricWord[];
  /** seconds the line stops singing, when known */
  end?: number;
  /** instrumental section marker (nobody sings here) */
  gap?: boolean;
}

export interface LyricsResult {
  /** time-synced lines when available (Spotify-style highlighting) */
  synced: SyncedLyricLine[] | null;
  plain: string | null;
  /** which provider answered */
  source?: string;
  /** true when the synced lines carry per-word timings */
  wordSynced?: boolean;
}
