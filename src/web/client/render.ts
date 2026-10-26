import type { PlaylistDetail, PlaylistSummary, QueueSong, Track, TrackSource } from './types';

const SOURCE_LABEL: Record<TrackSource, string> = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };
const SOURCE_SHORT: Record<TrackSource, string> = { youtube: 'YT', soundcloud: 'SC', spotify: 'SP' };

export function escapeHtml(value: string | null | undefined): string {
  return (value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function formatClock(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "12 kappaletta · 47 min", counting only songs whose length is known. */
export function summarize(tracks: Track[]): string {
  const count = `${tracks.length} ${tracks.length === 1 ? 'kappale' : 'kappaletta'}`;
  const seconds = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  if (!seconds) return count;
  const minutes = Math.round(seconds / 60);
  const length = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  return `${count} · ${length}`;
}

/** Source badge that links to the original page. Spotify songs play from YouTube, so say so. */
export function sourceBadge(track: Track): string {
  const title = track.source === 'spotify'
    ? 'Spotify (soi YouTube-vastineena)'
    : `Avaa ${SOURCE_LABEL[track.source]}`;
  return `<a class="badge badge-${track.source}" href="${escapeHtml(track.url)}" target="_blank" rel="noreferrer" title="${title}">${SOURCE_SHORT[track.source]}</a>`;
}

function stripHtml(track: Track, extraMeta: string[] = []): string {
  const meta = [sourceBadge(track), ...extraMeta.filter(Boolean).map(escapeHtml)].join('<span aria-hidden="true">·</span>');
  return `<div class="strip"><p class="strip-title">${escapeHtml(track.title)}</p><p class="strip-meta">${meta}</p></div>`;
}

export function queueHtml(queue: QueueSong[]): string {
  if (!queue.length) return '<li class="empty">Jono on tyhjä. Seuraavaksi soi se, minkä lisäät.</li>';
  return queue.map((song, i) => `
    <li class="slot">
      <span class="slot-no">${i + 1}</span>
      ${stripHtml(song, [formatClock(song.duration), song.requestedBy])}
      <div class="slot-actions">
        <button class="icon-btn" type="button" data-action="queue-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Siirrä ylös: ${escapeHtml(song.title)}">↑</button>
        <button class="icon-btn" type="button" data-action="queue-down" data-index="${i}" ${i === queue.length - 1 ? 'disabled' : ''} aria-label="Siirrä alas: ${escapeHtml(song.title)}">↓</button>
        <button class="icon-btn" type="button" data-action="queue-save" data-index="${i}" aria-label="Lisää soittolistaan: ${escapeHtml(song.title)}">+</button>
        <button class="icon-btn btn-danger" type="button" data-action="queue-remove" data-index="${i}" aria-label="Poista jonosta: ${escapeHtml(song.title)}">✕</button>
      </div>
    </li>`).join('');
}

export function resultsHtml(results: Track[], pendingKeys: Set<string>): string {
  return results.map((track, i) => {
    const art = track.thumbnail
      ? `<img class="result-art" src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" decoding="async">`
      : '<span class="result-art" aria-hidden="true"></span>';
    const pending = pendingKeys.has(track.key);
    return `
      <li class="result">
        ${art}
        <div class="result-body">
          ${stripHtml(track, [formatClock(track.duration)])}
          <div class="result-actions">
            <button class="btn btn-small btn-amber" type="button" data-action="result-play" data-index="${i}" ${pending ? 'disabled' : ''}>${pending ? 'Lisätään…' : 'Lisää jonoon'}</button>
            <button class="btn btn-small" type="button" data-action="result-save" data-index="${i}">Soittolistaan</button>
          </div>
        </div>
      </li>`;
  }).join('');
}

export function shelfHtml(playlists: PlaylistSummary[], selectedId: string | null): string {
  if (!playlists.length) return '<li class="empty">Ei vielä soittolistoja. Luo uusi tai tuo linkistä.</li>';
  return playlists.map((p) => `
    <li><button class="shelf-item" type="button" data-action="playlist-open" data-id="${escapeHtml(p.id)}" aria-current="${p.id === selectedId}">
      <strong>${escapeHtml(p.name)}</strong><span>${p.songCount} ${p.songCount === 1 ? 'kappale' : 'kappaletta'}</span>
    </button></li>`).join('');
}

export function pickListHtml(playlists: PlaylistSummary[]): string {
  if (!playlists.length) return '<li class="empty">Ei vielä soittolistoja.</li>';
  return playlists.map((p) => `
    <li><button class="shelf-item" type="button" data-pick="${escapeHtml(p.id)}">
      <strong>${escapeHtml(p.name)}</strong><span>${p.songCount} ${p.songCount === 1 ? 'kappale' : 'kappaletta'}</span>
    </button></li>`).join('');
}

export function detailHtml(detail: PlaylistDetail | null): string {
  if (!detail) return '<p class="empty">Valitse soittolista tai luo uusi.</p>';
  const songs = detail.songs;
  const rows = songs.length
    ? songs.map((song, i) => `
      <li class="slot">
        <span class="slot-no">${i + 1}</span>
        ${stripHtml(song, [formatClock(song.duration), song.addedBy])}
        <div class="slot-actions">
          <button class="icon-btn" type="button" data-action="song-queue" data-index="${i}" aria-label="Lisää jonoon: ${escapeHtml(song.title)}">▶</button>
          <button class="icon-btn" type="button" data-action="song-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Siirrä ylös: ${escapeHtml(song.title)}">↑</button>
          <button class="icon-btn" type="button" data-action="song-down" data-index="${i}" ${i === songs.length - 1 ? 'disabled' : ''} aria-label="Siirrä alas: ${escapeHtml(song.title)}">↓</button>
          <button class="icon-btn btn-danger" type="button" data-action="song-remove" data-index="${i}" aria-label="Poista soittolistalta: ${escapeHtml(song.title)}">✕</button>
        </div>
      </li>`).join('')
    : '<li class="empty">Soittolista on tyhjä. Lisää kappaleita linkillä tai hakusanalla.</li>';
  return `
    <div class="detail-head">
      <h2>${escapeHtml(detail.name)}</h2>
      <p class="summary">${escapeHtml(summarize(songs))}</p>
      <div class="detail-actions">
        <button class="btn btn-amber" type="button" data-action="playlist-play" ${songs.length ? '' : 'disabled'}>Soita</button>
        <button class="btn" type="button" data-action="playlist-shuffle" ${songs.length ? '' : 'disabled'}>Soita sekoitettuna</button>
        <button class="btn btn-small" type="button" data-action="playlist-rename">Nimeä uudelleen</button>
        <button class="btn btn-small btn-danger" type="button" data-action="playlist-delete">Poista soittolista</button>
      </div>
    </div>
    <form class="detail-add" data-form="playlist-add">
      <input class="input" name="input" type="text" autocomplete="off" placeholder="Linkki tai hakusana" aria-label="Lisää soittolistaan linkki tai hakusana">
      <button class="btn" type="submit">Lisää</button>
    </form>
    <p class="status" data-role="detail-status" role="status"></p>
    <ol class="strips">${rows}</ol>`;
}
