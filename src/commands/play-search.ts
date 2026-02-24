import youtubeDl, { Flags } from 'youtube-dl-exec';
import { SearchPayload, WebSearchResult } from './play-types';

function formatYtDlpError(error: unknown): string {
  const err = error as { message?: string; stderr?: string; stdout?: string; exitCode?: number } | null;
  if (!err) return 'unknown error';
  const parts: string[] = [];
  if (typeof err.exitCode === 'number') parts.push(`exitCode=${err.exitCode}`);
  if (err.message) parts.push(`message=${err.message}`);
  if (err.stderr) parts.push(`stderr=${String(err.stderr).trim()}`);
  if (err.stdout) parts.push(`stdout=${String(err.stdout).trim()}`);
  return parts.join(' | ') || 'unknown error';
}

export async function searchYouTubeFromWeb(
  query: string,
  limit: number = 6
): Promise<{ success: boolean; results?: WebSearchResult[]; error?: string }> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { success: false, error: 'Search query is empty' };
  }

  const cappedLimit = Math.max(1, Math.min(10, limit));
  const startedAt = Date.now();
  console.log(`[yt-search] begin query="${trimmedQuery}" limit=${cappedLimit}`);

  try {
    const flags: Flags = {
      dumpSingleJson: true,
      flatPlaylist: true,
      simulate: true,
    };

    const payload = await youtubeDl(`ytsearch${cappedLimit}:${trimmedQuery}`, flags) as unknown as SearchPayload;
    const entries = Array.isArray(payload.entries) ? payload.entries : [];

    const extractVideoId = (entryId: string, entryUrl?: string): string | null => {
      const rawCandidates = [entryId, entryUrl].filter((value): value is string => !!value);
      for (const raw of rawCandidates) {
        if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
          return raw;
        }
        if (!/^https?:\/\//.test(raw)) {
          continue;
        }

        try {
          const parsed = new URL(raw);
          const v = parsed.searchParams.get('v');
          if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
            return v;
          }

          if (parsed.hostname.includes('youtu.be')) {
            const shortId = parsed.pathname.split('/').filter(Boolean)[0];
            if (shortId && /^[a-zA-Z0-9_-]{11}$/.test(shortId)) {
              return shortId;
            }
          }

          const shortsMatch = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
          if (shortsMatch?.[1]) {
            return shortsMatch[1];
          }
        } catch {
          // Ignore invalid URL parse and continue.
        }
      }
      return null;
    };

    const results = entries
      .map((entry): WebSearchResult | null => {
        const id = (typeof entry.id === 'string' && entry.id) || (typeof entry.url === 'string' ? entry.url : '');
        if (!id || !entry.title) return null;
        const url = /^https?:\/\//.test(id) ? id : `https://www.youtube.com/watch?v=${id}`;
        const thumbFromArray = Array.isArray(entry.thumbnails)
          ? entry.thumbnails.find((t) => typeof t?.url === 'string')?.url || null
          : null;
        const videoId = extractVideoId(id, typeof entry.url === 'string' ? entry.url : undefined);
        const thumbnail = (typeof entry.thumbnail === 'string' && entry.thumbnail)
          || thumbFromArray
          || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);
        return {
          id,
          title: entry.title,
          url,
          duration: typeof entry.duration === 'number' ? entry.duration : null,
          channel: typeof entry.uploader === 'string' ? entry.uploader : null,
          thumbnail,
        };
      })
      .filter((item): item is WebSearchResult => item !== null);

    console.log(`[yt-search] success query="${trimmedQuery}" results=${results.length} in ${Date.now() - startedAt}ms`);
    return { success: true, results };
  } catch (error) {
    console.error(`[yt-search] failed query="${trimmedQuery}" error=${formatYtDlpError(error)}`);
    return { success: false, error: 'YouTube search failed' };
  }
}
