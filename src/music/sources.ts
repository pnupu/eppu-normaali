// src/music/sources.ts
// Turns user input (search text or a YouTube / SoundCloud / Spotify link) into playable tracks.
import { buildYtDlpFlags, formatYtDlpError, runYtDlpJson, runYtDlpJsonWithAutoCookieRefresh } from './ytdlp';

export type TrackSource = 'youtube' | 'soundcloud' | 'spotify';
export type SearchSource = 'youtube' | 'soundcloud';

export interface Track {
  source: TrackSource;
  /** Unique per recording; used for playlist de-duplication. YouTube: bare video id, others prefixed (sc:, sp:). */
  key: string;
  title: string;
  /** Page link users can open. */
  url: string;
  /** Seconds, when known. */
  duration: number | null;
  thumbnail: string | null;
}

export interface ResolvedInput {
  /** Collection name for playlists/albums/sets, null for a single track. */
  name: string | null;
  tracks: Track[];
  /** Entries that exist but cannot be played (private, deleted, DRM). */
  skipped: number;
}

/** Error whose message is safe to show to users (Finnish). */
export class ResolveError extends Error {}

// lean: collections are capped to keep yt-dlp runs on the Pi bounded; raise if people import bigger sets.
const MAX_COLLECTION_TRACKS = 300;
// YouTube Mixes (list=RD...) are generated on the fly and effectively endless.
const MAX_MIX_TRACKS = 50;
const MAX_SOUNDCLOUD_TRACKS = 100;
const HTTP_TIMEOUT_MS = 10_000;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

type InputKind =
  | { kind: 'search'; query: string }
  | { kind: 'youtube'; url: URL }
  | { kind: 'soundcloud'; url: URL }
  | { kind: 'spotify'; type: 'track' | 'album' | 'playlist'; id: string }
  | { kind: 'unsupported' };

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com']);

export function classifyInput(raw: string): InputKind {
  const input = raw.trim();
  const spotifyUri = input.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/);
  if (spotifyUri) return { kind: 'spotify', type: spotifyUri[1] as 'track' | 'album' | 'playlist', id: spotifyUri[2] };
  if (!/^https?:\/\//i.test(input)) return { kind: 'search', query: input };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: 'unsupported' };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (YOUTUBE_HOSTS.has(host)) return { kind: 'youtube', url };
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return { kind: 'soundcloud', url };
  if (host === 'open.spotify.com') {
    const match = url.pathname.match(/\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (match) return { kind: 'spotify', type: match[1] as 'track' | 'album' | 'playlist', id: match[2] };
  }
  return { kind: 'unsupported' };
}

export function extractYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return raw;
  if (!/^https?:\/\//.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    const v = parsed.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    if (parsed.hostname.replace(/^www\./, '') === 'youtu.be') {
      const first = parsed.pathname.split('/').filter(Boolean)[0];
      if (first && /^[a-zA-Z0-9_-]{11}$/.test(first)) return first;
    }
    const pathId = parsed.pathname.match(/\/(?:shorts|embed|live)\/([a-zA-Z0-9_-]{11})/);
    if (pathId?.[1]) return pathId[1];
  } catch {
    return null;
  }
  return null;
}

export function youtubeTrack(videoId: string, title: string, duration: number | null = null): Track {
  return {
    source: 'youtube',
    key: videoId,
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    duration,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
  };
}

/** Arguments that make yt-dlp download the track's audio (the input is appended last). */
export function ytDlpStreamInput(track: Pick<Track, 'source' | 'title' | 'url'>): string[] {
  if (track.source === 'spotify') {
    // Spotify audio is DRM-only; play the best YouTube Music song match instead.
    return ['--playlist-items', '1', `https://music.youtube.com/search?q=${encodeURIComponent(track.title)}#songs`];
  }
  // A browser-supplied SoundCloud "track" can be a set or a short link to one.
  // Never concatenate a collection into one queue item.
  if (track.source === 'soundcloud') return ['--no-playlist', '--playlist-items', '1', track.url];
  return [track.url];
}

export async function resolveInput(raw: string): Promise<ResolvedInput> {
  const input = classifyInput(raw);
  switch (input.kind) {
    case 'search': {
      if (!input.query) throw new ResolveError('Kirjoita hakusana tai liitä linkki.');
      const [first] = await searchTracks(input.query, 'youtube', 1);
      if (!first) throw new ResolveError(`Haulla "${input.query}" ei löytynyt mitään.`);
      return { name: null, tracks: [first], skipped: 0 };
    }
    case 'youtube':
      return resolveYouTube(input.url);
    case 'soundcloud':
      return resolveSoundCloud(input.url);
    case 'spotify':
      return resolveSpotify(input.type, input.id);
    default:
      throw new ResolveError('Linkkiä ei tunnistettu. Tuetut: YouTube, SoundCloud ja Spotify.');
  }
}

interface YtDlpEntry {
  id?: string;
  title?: string | null;
  url?: string;
  webpage_url?: string;
  duration?: number | null;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
}

interface YtDlpCollection {
  title?: string;
  entries?: Array<YtDlpEntry | null>;
}

function entryThumbnail(entry: YtDlpEntry): string | null {
  if (entry.thumbnail) return entry.thumbnail;
  const list = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  return list.map((t) => t?.url).filter(Boolean).pop() || null;
}

function roundDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function soundCloudTrack(entry: YtDlpEntry): Track | null {
  if (!entry.id || !entry.title) return null;
  return {
    source: 'soundcloud',
    key: `sc:${entry.id}`,
    title: entry.title,
    url: entry.webpage_url || entry.url || '',
    duration: roundDuration(entry.duration),
    thumbnail: entryThumbnail(entry),
  };
}

function isUnavailableYouTubeEntry(entry: YtDlpEntry): boolean {
  return !entry.title || /^\[(private|deleted|unavailable) video\]$/i.test(entry.title);
}

export async function searchTracks(query: string, source: SearchSource, limit: number): Promise<Track[]> {
  const capped = Math.max(1, Math.min(10, limit));
  const prefix = source === 'soundcloud' ? 'scsearch' : 'ytsearch';
  const payload = await runYtDlpJsonWithAutoCookieRefresh<YtDlpCollection>(
    `${prefix}${capped}:${query.trim()}`,
    buildYtDlpFlags({ dumpSingleJson: true, flatPlaylist: true, simulate: true }),
    `search source=${source}`
  );
  const entries = (payload.entries || []).filter((e): e is YtDlpEntry => !!e);
  if (source === 'soundcloud') {
    return entries.map(soundCloudTrack).filter((t): t is Track => !!t);
  }
  return entries
    .filter((e) => !isUnavailableYouTubeEntry(e))
    .map((e) => {
      const id = extractYouTubeVideoId(e.id || e.url || '');
      return id ? youtubeTrack(id, e.title as string, roundDuration(e.duration)) : null;
    })
    .filter((t): t is Track => !!t);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': BROWSER_UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

async function resolveYouTube(url: URL): Promise<ResolvedInput> {
  const videoId = extractYouTubeVideoId(url.toString());
  const listId = url.searchParams.get('list');
  if (listId) {
    try {
      const listUrl = videoId ? url.toString() : `https://www.youtube.com/playlist?list=${listId}`;
      const payload = await runYtDlpJsonWithAutoCookieRefresh<YtDlpCollection>(
        listUrl,
        buildYtDlpFlags({ dumpSingleJson: true, flatPlaylist: true, simulate: true, yesPlaylist: true, playlistEnd: listId.startsWith('RD') ? MAX_MIX_TRACKS : MAX_COLLECTION_TRACKS }),
        `youtube-list list=${listId}`
      );
      const entries = (payload.entries || []).filter((e): e is YtDlpEntry => !!e);
      const tracks = entries
        .filter((e) => !isUnavailableYouTubeEntry(e))
        .map((e) => {
          const id = extractYouTubeVideoId(e.id || e.url || '');
          return id ? youtubeTrack(id, e.title as string, roundDuration(e.duration)) : null;
        })
        .filter((t): t is Track => !!t);
      if (tracks.length > 0) {
        // Start from the video the link points at, like YouTube does. Mix order changes between requests.
        const start = videoId ? tracks.findIndex((t) => t.key === videoId) : 0;
        let ordered = start > 0 ? tracks.slice(start) : tracks;
        if (start < 0) {
          try {
            ordered = [...(await resolveYouTubeVideo(videoId as string)).tracks, ...tracks];
          } catch (error) {
            if (!(error instanceof ResolveError)) throw error;
            console.warn(`[sources] Linked video ${videoId} is unavailable; keeping playable entries from list ${listId}`);
          }
        }
        return { name: payload.title?.trim() || 'YouTube-soittolista', tracks: ordered, skipped: entries.length - tracks.length };
      }
    } catch (error) {
      if (!videoId) throw error;
      console.warn(`[sources] YouTube list ${listId} failed, falling back to the single video ${videoId}`);
    }
  }
  if (!videoId) throw new ResolveError('YouTube-linkistä ei löytynyt videota tai soittolistaa.');
  return resolveYouTubeVideo(videoId);
}

async function resolveYouTubeVideo(videoId: string): Promise<ResolvedInput> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  // oEmbed is a fast path, but public videos can forbid embedding (401).
  // Let cookie-aware extraction decide availability whenever this path fails.
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (res.ok) {
      const data = await res.json() as { title?: string };
      if (data.title?.trim()) {
        return { name: null, tracks: [youtubeTrack(videoId, data.title.trim())], skipped: 0 };
      }
    }
    console.warn(`[sources] YouTube oEmbed unavailable for ${videoId} (HTTP ${res.status}), trying yt-dlp`);
  } catch {
    console.warn(`[sources] YouTube oEmbed failed for ${videoId}, trying yt-dlp`);
  }
  let info: YtDlpEntry;
  try {
    info = await runYtDlpJsonWithAutoCookieRefresh<YtDlpEntry>(
      url,
      buildYtDlpFlags({ dumpSingleJson: true, simulate: true, noPlaylist: true }),
      `youtube-video id=${videoId}`
    );
  } catch (error) {
    const details = formatYtDlpError(error);
    if (/private video|video unavailable|video (?:has been|was) removed|video has been deleted|this video is not available/i.test(details)) {
      throw new ResolveError('Video on yksityinen, poistettu tai ei muuten saatavilla.');
    }
    throw error;
  }
  if (isUnavailableYouTubeEntry(info)) throw new ResolveError('Video on yksityinen, poistettu tai ei muuten saatavilla.');
  return { name: null, tracks: [youtubeTrack(videoId, info.title as string, roundDuration(info.duration))], skipped: 0 };
}

const SOUNDCLOUD_COLLECTION_SEGMENTS = new Set(['sets', 'tracks', 'likes', 'reposts', 'albums', 'popular-tracks', 'toptracks']);

async function resolveSoundCloud(url: URL): Promise<ResolvedInput> {
  const segments = url.pathname.split('/').filter(Boolean);
  // Short links (on.soundcloud.com) and secret links (/user/track/s-xxxx) go through yt-dlp below.
  const isSingleTrack = url.hostname !== 'on.soundcloud.com'
    && segments.length === 2
    && !SOUNDCLOUD_COLLECTION_SEGMENTS.has(segments[1]);

  if (isSingleTrack) {
    const res = await fetchWithTimeout(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url.toString())}`);
    if (res.status === 403 || res.status === 404) throw new ResolveError('SoundCloud-kappaletta ei löytynyt tai se on yksityinen.');
    if (!res.ok) throw new Error(`SoundCloud oEmbed failed: HTTP ${res.status}`);
    const data = await res.json() as { title?: string; html?: string; thumbnail_url?: string };
    const id = (data.html || '').match(/api\.soundcloud\.com(?:%2F|\/)tracks(?:%2F|\/)(\d+)/i)?.[1];
    return {
      name: null,
      tracks: [{
        source: 'soundcloud',
        key: id ? `sc:${id}` : `sc:${segments.join('/')}`,
        title: data.title?.trim() || segments[1],
        url: `https://soundcloud.com/${segments.join('/')}`,
        duration: null,
        thumbnail: data.thumbnail_url || null,
      }],
      skipped: 0,
    };
  }

  // Flat SoundCloud listings have no titles, so resolve entries fully. DRM-protected tracks come back as null.
  // lean: ~0.3 s per entry on a laptop, so collections are capped at 100; batch via SoundCloud's API if that hurts.
  const payload = await runYtDlpJson<YtDlpCollection | null>(
    ['--dump-single-json', '--ignore-errors', '--playlist-end', String(MAX_SOUNDCLOUD_TRACKS), url.toString()],
    `soundcloud url=${url}`,
    { allowPartial: true }
  ).catch(() => null);
  if (!payload) throw new ResolveError('SoundCloud ei anna ladata tätä linkkiä. Se voi olla yksityinen tai alueella estetty.');
  // A short or secret link that points at one track comes back as a bare track object.
  const isCollection = Array.isArray(payload.entries);
  const entries = isCollection ? payload.entries as Array<YtDlpEntry | null> : [payload as YtDlpEntry];
  const tracks = entries.map((e) => (e ? soundCloudTrack(e) : null)).filter((t): t is Track => !!t);
  if (tracks.length === 0) {
    throw new ResolveError(
      entries.length > 0
        ? 'SoundCloud-kappaleet ovat DRM-suojattuja, eikä niitä voi soittaa.'
        : 'SoundCloud-linkistä ei löytynyt kappaleita.'
    );
  }
  return { name: isCollection ? payload.title?.trim() || 'SoundCloud' : null, tracks, skipped: entries.length - tracks.length };
}

interface SpotifyArtist { name?: string }
interface SpotifyEmbedTrack {
  uri?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
}
interface SpotifyEmbedEntity {
  type?: string;
  id?: string;
  name?: string;
  title?: string;
  artists?: SpotifyArtist[];
  duration?: number;
  trackList?: SpotifyEmbedTrack[];
  coverArt?: { sources?: Array<{ url?: string; width?: number }> };
  visualIdentity?: { image?: Array<{ url?: string; maxWidth?: number }> };
}

function spotifyTrack(id: string, title: string, artists: string, durationMs: number | undefined, thumbnail: string | null): Track {
  return {
    source: 'spotify',
    key: `sp:${id}`,
    title: artists ? `${artists} - ${title}` : title,
    url: `https://open.spotify.com/track/${id}`,
    duration: durationMs ? Math.round(durationMs / 1000) : null,
    thumbnail,
  };
}

function spotifyCover(entity: SpotifyEmbedEntity): string | null {
  const images = entity.visualIdentity?.image || entity.coverArt?.sources || [];
  const sorted = [...images].filter((i) => i?.url).sort((a: any, b: any) => (a.maxWidth ?? a.width ?? 0) - (b.maxWidth ?? b.width ?? 0));
  // Smallest image that is still at least 300px wide, else the largest.
  return (sorted.find((i: any) => (i.maxWidth ?? i.width ?? 0) >= 300) || sorted[sorted.length - 1])?.url || null;
}

// lean: Spotify's public embed page lists at most 100 tracks and needs no API keys. The official Web API no longer
// returns items of playlists the app owner doesn't own (Feb 2026 dev-mode change), so it would not help either.
async function resolveSpotify(type: 'track' | 'album' | 'playlist', id: string): Promise<ResolvedInput> {
  const res = await fetchWithTimeout(`https://open.spotify.com/embed/${type}/${id}`);
  if (res.status === 404) throw new ResolveError('Spotify-linkkiä ei löytynyt. Onko soittolista julkinen?');
  if (!res.ok) throw new Error(`Spotify embed failed: HTTP ${res.status}`);
  const html = await res.text();
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  const entity = json
    ? (JSON.parse(json)?.props?.pageProps?.state?.data?.entity as SpotifyEmbedEntity | undefined)
    : undefined;
  if (!entity) throw new Error('Spotify embed page had no track data');

  // Album tracks share the album art; playlist items would wrongly show the playlist cover.
  const cover = type === 'playlist' ? null : spotifyCover(entity);
  if (type === 'track') {
    const artists = (entity.artists || []).map((a) => a.name).filter(Boolean).join(', ');
    return { name: null, tracks: [spotifyTrack(id, entity.name || entity.title || 'Spotify', artists, entity.duration, cover)], skipped: 0 };
  }
  const tracks = (entity.trackList || [])
    .map((item) => {
      const trackId = item.uri?.match(/^spotify:track:([A-Za-z0-9]+)$/)?.[1];
      return trackId && item.title ? spotifyTrack(trackId, item.title, item.subtitle || '', item.duration, cover) : null;
    })
    .filter((t): t is Track => !!t);
  if (tracks.length === 0) throw new ResolveError('Spotify-listalta ei löytynyt kappaleita.');
  return { name: entity.name || entity.title || 'Spotify', tracks, skipped: (entity.trackList?.length || 0) - tracks.length };
}
