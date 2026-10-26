import { expect, test } from 'bun:test';
import { api } from './api';

// Cross page boundaries so the last playlist/song cannot disappear from the UI.
test('loads every playlist and song page using the server cursors', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/playlists') {
      return Response.json(url.searchParams.get('cursor') === 'page/2'
        ? { items: [{ id: 'playlist-101' }], nextCursor: null }
        : { items: Array.from({ length: 100 }, (_, index) => ({ id: `playlist-${index + 1}` })), nextCursor: 'page/2' });
    }
    const nextPage = url.searchParams.get('songCursor') === 'songs/2';
    return Response.json({ playlist: {
      id: 'playlist-101', name: 'Full list', songCount: 201,
      songs: nextPage ? [{ id: 'song-201' }] : Array.from({ length: 200 }, (_, index) => ({ id: `song-${index + 1}` })),
      songNextCursor: nextPage ? null : 'songs/2',
    } });
  }) as typeof fetch;
  try {
    const { items } = await api.playlists();
    expect(items).toHaveLength(101);
    expect(items[100].id).toBe('playlist-101');
    const { playlist } = await api.playlist(items[100].id);
    expect(playlist.songs).toHaveLength(201);
    expect(playlist.songs[200].id).toBe('song-201');
    expect(playlist.songNextCursor).toBeNull();
    expect(calls).toContain('/api/playlists?limit=100&cursor=page%2F2');
    expect(calls).toContain('/api/playlists/playlist-101?songLimit=200&songCursor=songs%2F2');
  } finally {
    globalThis.fetch = original;
  }
});
