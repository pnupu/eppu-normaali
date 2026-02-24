import { dom, escapeHtml, setVisible } from './dom';
import { appState } from './state';
import { GuildPlaybackState, PlaybackStateMap, PollBadgeState, WebSearchResult } from './types';

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
