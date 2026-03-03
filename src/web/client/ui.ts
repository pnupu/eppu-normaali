import { dom, escapeHtml, setVisible } from './dom';
import { appState } from './state';
import { GuildPlaybackState, PlaybackStateMap, PlaylistDetail, PlaylistSummary, PollBadgeState, VoiceKeyword, WebSearchResult } from './types';

export function enableLowPowerModeIfNeeded(): void {
  const cores = navigator.hardwareConcurrency || 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0;
  if ((cores > 0 && cores <= 4) || (memory > 0 && memory <= 2)) {
    document.documentElement.classList.add('low-power');
  }
}

export function openSearchModal(): void {
  setVisible(dom.searchModal, true);
  document.body.classList.add('modal-open');
  window.setTimeout(() => dom.searchInput.focus(), 50);
}

export function closeSearchModal(): void {
  setVisible(dom.searchModal, false);
  document.body.classList.remove('modal-open');
}

export function setPollBadge(state: PollBadgeState): void {
  dom.pollStatus.classList.remove('pill-ready', 'pill-live', 'pill-degraded');

  switch (state) {
    case 'syncing':
      dom.pollStatus.textContent = 'Synkronoidaan';
      return;
    case 'ready':
      dom.pollStatus.textContent = 'Valmis';
      dom.pollStatus.classList.add('pill-ready');
      return;
    case 'live':
      dom.pollStatus.textContent = 'Toistetaan';
      dom.pollStatus.classList.add('pill-live');
      return;
    case 'degraded':
      dom.pollStatus.textContent = 'Yhteys pätkii';
      dom.pollStatus.classList.add('pill-degraded');
      return;
  }
}

function setPlaybackControlsEnabled(enabled: boolean): void {
  dom.pauseBtn.disabled = !enabled;
  dom.skipBtn.disabled = !enabled;
}

function renderNowPlaying(guildState: GuildPlaybackState | null): void {
  if (!guildState?.currentSong) {
    dom.nowPlayingCard.classList.add('now-idle');
    dom.nowPlayingTitle.textContent = 'Ei toistoa juuri nyt';
    dom.nowPlayingMeta.textContent = 'Avaa YouTube-haku tai liitä URL, niin Eppu aloittaa musiikin.';
    appState.hasActiveSong = false;
    setPlaybackControlsEnabled(false);
    return;
  }

  dom.nowPlayingCard.classList.remove('now-idle');
  dom.nowPlayingTitle.textContent = guildState.currentSong.title;
  dom.nowPlayingMeta.innerHTML = `Lisäsi ${escapeHtml(guildState.currentSong.requestedBy)}${guildState.paused ? ' (tauolla)' : ''}`;
  appState.hasActiveSong = true;
  setPlaybackControlsEnabled(true);
}

function queueItemTemplate(item: GuildPlaybackState['queue'][number], index: number): string {
  return `
    <div class="queue-item" draggable="true" data-index="${index}">
      <span class="drag" title="Vedä järjestyksen vaihtoon">::</span>
      <div class="title-wrap">
        <span class="title">${escapeHtml(item.title)}</span>
        <span class="by">Lisäsi ${escapeHtml(item.requestedBy)}</span>
      </div>
      <button class="remove-btn" type="button" data-remove="${index}" aria-label="Poista ${escapeHtml(item.title)}">Poista</button>
    </div>
  `;
}

function renderQueue(queue: GuildPlaybackState['queue']): void {
  if (!queue.length) {
    dom.queueList.innerHTML = '<p class="empty">Jono odottaa seuraavaa mestariteosta.</p>';
    return;
  }

  dom.queueList.innerHTML = queue.map(queueItemTemplate).join('');
}

function formatDuration(seconds: number | null): string | null {
  if (!Number.isFinite(seconds) || (seconds || 0) <= 0) return null;
  const total = Math.floor(seconds as number);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function searchItemTemplate(item: WebSearchResult, index: number): string {
  const duration = formatDuration(item.duration);
  const meta = [item.channel, duration].filter(Boolean).join(' • ');
  const isPending = !!item.url && appState.pendingSearchAddUrls.has(item.url);
  const buttonLabel = isPending ? 'Lisätään...' : 'Lisää';
  const thumbnail = item.thumbnail
    ? `<img class="search-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" decoding="async">`
    : '<div class="search-thumb search-thumb-fallback" aria-hidden="true">▶</div>';

  return `
    <div class="search-item">
      <div class="search-thumb-wrap">
        ${thumbnail}
      </div>
      <div class="search-main">
        <div class="search-top">
          <div>
            <div class="search-title">${escapeHtml(item.title)}</div>
            ${meta ? `<div class="search-meta">${escapeHtml(meta)}</div>` : ''}
          </div>
          <button class="btn btn-secondary" type="button" data-search-add="${index}" ${isPending ? 'disabled' : ''}>${buttonLabel}</button>
        </div>
      </div>
    </div>
  `;
}

export function renderSearchResults(results: WebSearchResult[]): void {
  if (!results.length) {
    dom.searchResults.innerHTML = '<div class="search-empty">Ei hakutuloksia.</div>';
    return;
  }

  dom.searchResults.innerHTML = results.map(searchItemTemplate).join('');
}

export function pickActiveGuild(state: PlaybackStateMap): GuildPlaybackState | null {
  const guildIds = Object.keys(state);
  if (!guildIds.length) {
    appState.currentGuild = null;
    renderNowPlaying(null);
    renderQueue([]);
    return null;
  }

  if (!appState.currentGuild || !guildIds.includes(appState.currentGuild)) {
    appState.currentGuild = appState.defaultGuildId && guildIds.includes(appState.defaultGuildId)
      ? appState.defaultGuildId
      : guildIds[0];
  }

  return state[appState.currentGuild] || null;
}

export function renderPlaybackState(state: PlaybackStateMap): void {
  const guildState = pickActiveGuild(state);
  renderNowPlaying(guildState);
  renderQueue(guildState?.queue || []);
}

function playlistItemTemplate(item: PlaylistSummary, active: boolean): string {
  return `
    <button class="playlist-item ${active ? 'active' : ''}" type="button" data-playlist-id="${escapeHtml(item.id)}">
      <div class="playlist-item-title">${escapeHtml(item.name)}</div>
      <div class="playlist-item-meta">${item.songCount} kappaletta</div>
    </button>
  `;
}

export function renderPlaylistList(playlists: PlaylistSummary[], selectedId: string | null, showLoadMore: boolean): void {
  if (!playlists.length) {
    dom.playlistList.innerHTML = '<p class="playlist-empty">Ei soittolistoja vielä.</p>';
  } else {
    dom.playlistList.innerHTML = playlists
      .map((item) => playlistItemTemplate(item, selectedId === item.id))
      .join('');
  }
  setVisible(dom.playlistLoadMoreBtn, showLoadMore);
}

function playlistSongTemplate(song: PlaylistDetail['songs'][number]): string {
  return `
    <div class="playlist-song-item" draggable="true" data-playlist-song-index="${song.position}">
      <span class="drag" title="Vedä järjestyksen vaihtoon">::</span>
      <div class="title-wrap">
        <span class="title">${escapeHtml(song.title)}</span>
        <span class="by">Lisäsi ${escapeHtml(song.addedBy)}</span>
      </div>
      <button class="remove-btn" type="button" data-playlist-remove-song="${escapeHtml(song.id)}">Poista</button>
    </div>
  `;
}

export function renderPlaylistDetail(detail: PlaylistDetail | null, showSongsLoadMore: boolean): void {
  if (!detail) {
    dom.playlistTitle.textContent = 'Valitse soittolista';
    dom.playlistSongList.innerHTML = '<p class="playlist-empty">Valitse vasemmalta soittolista hallintaan.</p>';
    dom.renamePlaylistBtn.disabled = true;
    dom.deletePlaylistBtn.disabled = true;
    dom.playPlaylistBtn.disabled = true;
    dom.playPlaylistShuffleBtn.disabled = true;
    dom.saveQueueToPlaylistBtn.disabled = true;
    dom.saveSelectedQueueBtn.disabled = true;
    dom.playlistSongUrlInput.disabled = true;
    dom.playlistSongSearchInput.disabled = true;
    setVisible(dom.playlistSongsLoadMoreBtn, false);
    return;
  }

  dom.playlistTitle.textContent = detail.name;
  dom.renamePlaylistBtn.disabled = false;
  dom.deletePlaylistBtn.disabled = false;
  dom.playPlaylistBtn.disabled = false;
  dom.playPlaylistShuffleBtn.disabled = false;
  dom.saveQueueToPlaylistBtn.disabled = false;
  dom.saveSelectedQueueBtn.disabled = false;
  dom.playlistSongUrlInput.disabled = false;
  dom.playlistSongSearchInput.disabled = false;
  if (!detail.songs.length) {
    dom.playlistSongList.innerHTML = '<p class="playlist-empty">Soittolistassa ei ole kappaleita.</p>';
  } else {
    dom.playlistSongList.innerHTML = detail.songs
      .map((song) => playlistSongTemplate(song))
      .join('');
  }
  setVisible(dom.playlistSongsLoadMoreBtn, showSongsLoadMore);
}

interface QueueSelectionItem {
  key: string;
  title: string;
  meta: string;
  checked: boolean;
}

export function renderQueueSelectionList(items: QueueSelectionItem[]): void {
  if (!items.length) {
    dom.queueSelectList.innerHTML = '<p class="playlist-empty">Jonossa ei ole valittavia kappaleita.</p>';
    return;
  }
  dom.queueSelectList.innerHTML = items
    .map((item) => `
      <div class="queue-select-item">
        <label>
          <input type="checkbox" data-queue-select="${escapeHtml(item.key)}" ${item.checked ? 'checked' : ''}>
          <span>
            <strong>${escapeHtml(item.title)}</strong>
            <span class="meta">${escapeHtml(item.meta)}</span>
          </span>
        </label>
      </div>
    `)
    .join('');
}

function voiceKeywordItemTemplate(item: VoiceKeyword): string {
  return `
    <div class="voice-keyword-item">
      <div>
        <div class="voice-keyword-title">${escapeHtml(item.phrase)}</div>
        <a class="voice-keyword-url" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a>
      </div>
      <div class="voice-keyword-actions">
        <button class="btn btn-ghost tiny" type="button" data-voice-keyword-use="${escapeHtml(item.phrase)}">Muokkaa</button>
        <button class="btn btn-ghost tiny" type="button" data-voice-keyword-delete="${escapeHtml(item.phrase)}">Poista</button>
      </div>
    </div>
  `;
}

export function renderVoiceKeywordList(items: VoiceKeyword[], showLoadMore: boolean): void {
  if (!items.length) {
    dom.voiceKeywordList.innerHTML = '<p class="playlist-empty">Ei avainsanoja vielä.</p>';
  } else {
    dom.voiceKeywordList.innerHTML = items.map((item) => voiceKeywordItemTemplate(item)).join('');
  }
  setVisible(dom.voiceKeywordLoadMoreBtn, showLoadMore);
}
