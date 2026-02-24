import { POLL_FAST_MS, POLL_SLOW_MS, TOAST_LINES } from './constants';
import {
  apiFetch,
  exchangeDiscordLoginToken,
  fetchAuthProfile,
  fetchPlaybackState,
  initAccessTokenFromUrl,
  initDiscordLoginTokenFromUrl,
  loadWebConfig,
  postApi,
  searchYouTube,
} from './api';
import { dom, setLoginHint, setStatus, setVisible } from './dom';
import { appState } from './state';
import { showToast } from './toasts';
import { closeSearchModal, enableLowPowerModeIfNeeded, openSearchModal, renderPlaybackState, renderSearchResults, setPollBadge } from './ui';

function currentPollInterval(): number {
  return document.hidden ? POLL_SLOW_MS : POLL_FAST_MS;
}

function schedulePoll(delay: number = currentPollInterval()): void {
  if (appState.pollTimer) {
    window.clearTimeout(appState.pollTimer);
  }
  appState.pollTimer = window.setTimeout(() => {
    void fetchState();
  }, delay);
}

function authFailureFallback(): void {
  if (!appState.authRequired) return;
  window.location.reload();
}

async function fetchState(): Promise<void> {
  if (appState.isFetchingState) {
    schedulePoll();
    return;
  }

  appState.isFetchingState = true;
  if (!appState.hasFetchedStateSuccessfully) {
    setPollBadge('syncing');
  }

  try {
    const result = await fetchPlaybackState();

    if (result.kind === 'not-modified') {
      setPollBadge(appState.hasActiveSong ? 'live' : 'ready');
      return;
    }

    if (result.kind === 'unauthorized') {
      authFailureFallback();
      return;
    }

    if (result.kind === 'error') {
      setPollBadge(appState.hasFetchedStateSuccessfully ? 'degraded' : 'ready');
      return;
    }

    appState.hasFetchedStateSuccessfully = true;
    appState.stateEtag = result.etag || '';
    renderPlaybackState(result.state || {});
    setPollBadge(appState.hasActiveSong ? 'live' : 'ready');
  } finally {
    appState.isFetchingState = false;
    schedulePoll();
  }
}

async function fetchMe(): Promise<void> {
  if (!appState.authRequired) {
    dom.userInfo.textContent = 'Paikallinen tila';
    return;
  }

  try {
    const profile = await fetchAuthProfile();
    if (!profile?.email) return;

    dom.userInfo.textContent = `${profile.name || 'Käyttäjä'} (${profile.email})`;
  } catch {
    // Keep UI functional even if profile endpoint fails.
  }
}

function showMain(): void {
  setVisible(dom.loginSection, false);
  setVisible(dom.mainSection, true);
  renderPlaybackState({});
  setPollBadge('ready');
  void fetchMe();
  void fetchState();
}

function requireGuildBeforeQueue(statusEl: HTMLElement): boolean {
  if (appState.currentGuild) return true;
  setStatus(statusEl, 'Palvelinta ei löytynyt. Tarkista botin guild-asetus.', 'error');
  showToast('stern', ['Eppu ei löydä kohdepalvelinta juuri nyt.']);
  return false;
}

async function onSearchSubmit(event: Event): Promise<void> {
  event.preventDefault();
  const query = dom.searchInput.value.trim();
  if (!query) return;

  setStatus(dom.searchStatus, 'Haetaan...');
  const result = await searchYouTube(query);

  if (!result.ok) {
    appState.latestSearchResults = [];
    renderSearchResults([]);
    setStatus(dom.searchStatus, result.error || 'Haku epäonnistui', 'error');
    showToast('stern', TOAST_LINES.searchError);
    return;
  }

  appState.latestSearchResults = result.results || [];
  renderSearchResults(appState.latestSearchResults);
  setStatus(dom.searchStatus, `Löytyi ${appState.latestSearchResults.length} tulosta`, 'ok');

  if (appState.latestSearchResults.length > 0) {
    showToast('happy', TOAST_LINES.searchSuccess);
  } else {
    showToast('stern', TOAST_LINES.searchEmpty);
  }
}

async function onAddSearchResult(index: number): Promise<void> {
  const item = appState.latestSearchResults[index];
  if (!item?.url) return;
  const url = item.url;
  if (appState.pendingSearchAddUrls.has(url)) return;
  if (!requireGuildBeforeQueue(dom.searchStatus)) return;

  appState.pendingSearchAddUrls.add(url);
  renderSearchResults(appState.latestSearchResults);

  try {
    const result = await postApi('play', { url });
    if (result.error) {
      setStatus(dom.searchStatus, result.error, 'error');
      showToast('stern', TOAST_LINES.addSearchError);
      return;
    }

    setStatus(dom.searchStatus, `Lisätty: ${item.title}`, 'ok');
    showToast('happy', TOAST_LINES.addSearchOk);
    closeSearchModal();
    appState.stateEtag = '';
    void fetchState();
  } finally {
    appState.pendingSearchAddUrls.delete(url);
    // Always re-render so "Lisätään..." state cannot get stuck after closing/reopening modal.
    renderSearchResults(appState.latestSearchResults);
  }
}

async function onAddUrlSubmit(event: Event): Promise<void> {
  event.preventDefault();
  const url = dom.urlInput.value.trim();
  if (!url) return;
  if (!requireGuildBeforeQueue(dom.addStatus)) return;

  setStatus(dom.addStatus, 'Lisätään...');
  const result = await postApi('play', { url });

  if (result.error) {
    setStatus(dom.addStatus, result.error, 'error');
    showToast('stern', TOAST_LINES.addUrlError);
    return;
  }

  dom.urlInput.value = '';
  setStatus(dom.addStatus, 'Lisätty jonoon', 'ok');
  showToast('happy', TOAST_LINES.addUrlOk);
  appState.stateEtag = '';
  void fetchState();
}

async function onTogglePause(): Promise<void> {
  if (!appState.currentGuild) return;
  const result = await postApi('pause', {});
  showToast(result.paused ? 'stern' : 'happy', result.paused ? TOAST_LINES.pause : TOAST_LINES.resume);
  appState.stateEtag = '';
  void fetchState();
}

async function onSkip(): Promise<void> {
  if (!appState.currentGuild) return;
  await postApi('skip', {});
  showToast('stern', TOAST_LINES.skip);
  appState.stateEtag = '';
  void fetchState();
}

async function onRemoveQueueItem(index: number): Promise<void> {
  if (!appState.currentGuild) return;
  await postApi('remove', { index });
  showToast('stern', TOAST_LINES.remove);
  appState.stateEtag = '';
  void fetchState();
}

async function onMoveQueueItem(from: number, to: number): Promise<void> {
  if (!appState.currentGuild || from === to) return;
  await postApi('move', { from, to });
  showToast('happy', TOAST_LINES.move);
  appState.stateEtag = '';
  void fetchState();
}

function attachQueueEvents(): void {
  dom.queueList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-remove]');
    if (!button) return;

    const idx = Number.parseInt(button.getAttribute('data-remove') || '', 10);
    if (!Number.isNaN(idx)) {
      void onRemoveQueueItem(idx);
    }
  });

  dom.queueList.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest('.queue-item') as HTMLElement | null;
    if (!item) return;

    appState.dragFromIndex = Number.parseInt(item.getAttribute('data-index') || '', 10);
    item.classList.add('dragging');
  });

  dom.queueList.addEventListener('dragend', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest('.queue-item') as HTMLElement | null;
    if (item) item.classList.remove('dragging');
    appState.dragFromIndex = null;
  });

  dom.queueList.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  dom.queueList.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const item = target.closest('.queue-item') as HTMLElement | null;
    if (!item || appState.dragFromIndex === null) return;

    const to = Number.parseInt(item.getAttribute('data-index') || '', 10);
    if (!Number.isNaN(to)) {
      void onMoveQueueItem(appState.dragFromIndex, to);
    }
    appState.dragFromIndex = null;
  });
}

function bindEvents(): void {
  dom.searchForm.addEventListener('submit', (event) => {
    void onSearchSubmit(event);
  });
  dom.addForm.addEventListener('submit', (event) => {
    void onAddUrlSubmit(event);
  });
  dom.pauseBtn.addEventListener('click', () => {
    void onTogglePause();
  });
  dom.skipBtn.addEventListener('click', () => {
    void onSkip();
  });

  dom.searchResults.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-search-add]');
    if (!button) return;

    const index = Number.parseInt(button.getAttribute('data-search-add') || '', 10);
    if (!Number.isNaN(index)) {
      void onAddSearchResult(index);
    }
  });

  dom.openSearchBtn.addEventListener('click', openSearchModal);
  dom.closeSearchBtn.addEventListener('click', closeSearchModal);

  dom.searchModal.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-modal-close]')) {
      closeSearchModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.searchModal.classList.contains('hidden')) {
      closeSearchModal();
    }
  });

  document.addEventListener('visibilitychange', () => {
    schedulePoll(200);
  });

  attachQueueEvents();
}

async function bootstrap(): Promise<void> {
  enableLowPowerModeIfNeeded();
  initAccessTokenFromUrl();
  const discordLoginToken = initDiscordLoginTokenFromUrl();
  bindEvents();

  await loadWebConfig();

  if (appState.requireAccessToken && !appState.accessToken) {
    setLoginHint('Pääsytunnus puuttuu. Avaa osoitteella ?token=OMA_TUNNUS', true);
    return;
  }

  if (discordLoginToken) {
    try {
      const result = await exchangeDiscordLoginToken(discordLoginToken);
      if (!result.error) {
        showMain();
        return;
      }
      setLoginHint(result.error || 'Linkkikirjautuminen epäonnistui', true);
      return;
    } catch {
      setLoginHint('Linkkikirjautuminen epäonnistui', true);
      return;
    }
  }

  if (!appState.authRequired) {
    setLoginHint(appState.localMode ? 'Paikallinen tila käytössä.' : 'Todennus on poistettu käytöstä.');
    showMain();
    return;
  }

  if (appState.exposureMode === 'tunnel') {
    setLoginHint('Tunnelitila käytössä. Avaa Discordin kertakirjautumislinkki.');
  }

  try {
    const profile = await fetchAuthProfile();
    if (profile?.email) {
      showMain();
      return;
    }
  } catch {
    // User is not signed in yet.
  }

  setVisible(dom.loginSection, true);
  setVisible(dom.mainSection, false);
  setLoginHint('Käytä Discordissa /web-login ja avaa yksityisviestillä tullut linkki täällä.');
}

void bootstrap();
