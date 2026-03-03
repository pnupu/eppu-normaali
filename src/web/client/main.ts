import { POLL_FAST_MS, POLL_SLOW_MS, TOAST_LINES } from './constants';
import {
  copyQueueToPlaylistApi,
  createPlaylistApi,
  createPlaylistFromQueueApi,
  deleteVoiceKeywordApi,
  deletePlaylistApi,
  exchangeDiscordLoginToken,
  fetchAuthProfile,
  fetchPlaybackState,
  fetchPlaylistDetail,
  fetchPlaylists,
  fetchVoiceKeywords,
  importYouTubePlaylistApi,
  initAccessTokenFromUrl,
  initDiscordLoginTokenFromUrl,
  loadWebConfig,
  movePlaylistSongApi,
  playPlaylistApi,
  postApi,
  postVoiceCommand,
  removePlaylistSongApi,
  renamePlaylistApi,
  searchYouTube,
  upsertVoiceKeywordApi,
  addPlaylistSongApi,
} from './api';
import { dom, setLoginHint, setStatus, setVisible } from './dom';
import { appState } from './state';
import { showToast } from './toasts';
import {
  closeSearchModal,
  enableLowPowerModeIfNeeded,
  openSearchModal,
  renderPlaybackState,
  renderPlaylistDetail,
  renderPlaylistList,
  renderQueueSelectionList,
  renderSearchResults,
  renderVoiceKeywordList,
  setPollBadge
} from './ui';
import { GuildPlaybackState, PlaylistDetail, PlaylistSummary } from './types';

const PLAYLIST_LIST_LIMIT = 20;
const PLAYLIST_SONG_LIMIT = 80;
const VOICE_KEYWORD_LIMIT = 30;

let playlistSearchDebounce: number | null = null;
let playlistSongSearchDebounce: number | null = null;
let queueSelectionKeys = new Set<string>();
let pttListening = false;
let pttTranscript = '';
let pttRecognition: BrowserSpeechRecognition | null = null;

type SpeechRecognitionResultListLike = {
  length: number;
  [index: number]: {
    0?: { transcript?: string };
  };
};

interface SpeechRecognitionResultEventLike extends Event {
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error?: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

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
  if (appState.pollTimer) {
    window.clearTimeout(appState.pollTimer);
    appState.pollTimer = null;
  }
  setVisible(dom.mainSection, false);
  setVisible(dom.loginSection, true);
  setLoginHint('Istunto vanheni. Käytä /web-login ja avaa uusi kertakirjautumislinkki.');
  setPollBadge('degraded');
}

function currentGuildState(): GuildPlaybackState | null {
  if (!appState.currentGuild) return null;
  return appState.playbackState[appState.currentGuild] || null;
}

function renderPlaylistPanels(): void {
  renderPlaylistList(appState.playlists, appState.selectedPlaylistId, !!appState.playlistsNextCursor);
  renderPlaylistDetail(appState.selectedPlaylist, !!appState.selectedPlaylist?.songNextCursor);
}

function selectedPlaylistSummary(): PlaylistSummary | null {
  if (!appState.selectedPlaylistId) return null;
  return appState.playlists.find((item) => item.id === appState.selectedPlaylistId) || null;
}

function upsertPlaylistSummary(item: PlaylistSummary): void {
  const index = appState.playlists.findIndex((playlist) => playlist.id === item.id);
  if (index >= 0) {
    appState.playlists[index] = item;
  } else {
    appState.playlists.unshift(item);
  }
}

function removePlaylistSummary(playlistId: string): void {
  appState.playlists = appState.playlists.filter((item) => item.id !== playlistId);
}

async function fetchState(): Promise<void> {
  if (appState.isFetchingState) {
    schedulePoll();
    return;
  }

  let shouldScheduleNextPoll = true;
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
      shouldScheduleNextPoll = false;
      authFailureFallback();
      return;
    }

    if (result.kind === 'error') {
      setPollBadge(appState.hasFetchedStateSuccessfully ? 'degraded' : 'ready');
      return;
    }

    appState.hasFetchedStateSuccessfully = true;
    appState.stateEtag = result.etag || '';
    appState.playbackState = result.state || {};
    renderPlaybackState(appState.playbackState);
    setPollBadge(appState.hasActiveSong ? 'live' : 'ready');
    if (appState.queueSelectModalOpen) {
      renderQueueSelectionModal();
    }
  } finally {
    appState.isFetchingState = false;
    if (shouldScheduleNextPoll) {
      schedulePoll();
    }
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
  renderPlaylistPanels();
  setPollBadge('ready');
  void fetchMe();
  void fetchState();
  void refreshPlaylists(true);
  void refreshVoiceKeywords(true);
}

function requireGuildBeforeQueue(statusEl: HTMLElement): boolean {
  if (appState.currentGuild) return true;
  setStatus(statusEl, 'Palvelinta ei löytynyt. Tarkista botin guild-asetus.', 'error');
  showToast('stern', ['Eppu ei löydä kohdepalvelinta juuri nyt.']);
  return false;
}

function requireSelectedPlaylist(): string | null {
  if (!appState.selectedPlaylistId) {
    setStatus(dom.playlistStatus, 'Valitse ensin soittolista.', 'error');
    return null;
  }
  return appState.selectedPlaylistId;
}

function setPttButtonState(listening: boolean): void {
  dom.pttBtn.classList.toggle('ptt-active', listening);
  dom.pttBtn.textContent = listening ? 'Kuuntelen... päästä irti lopettaaksesi' : 'Pidä pohjassa ja puhu';
}

function voiceRecognitionCtor():
  (new () => BrowserSpeechRecognition)
  | null {
  const maybeWindow = window as unknown as {
    SpeechRecognition?: new () => BrowserSpeechRecognition;
    webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
  };
  return maybeWindow.SpeechRecognition || maybeWindow.webkitSpeechRecognition || null;
}

function buildVoiceRecognition(): BrowserSpeechRecognition | null {
  const Ctor = voiceRecognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = 'fi-FI';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  recognition.onresult = (event: SpeechRecognitionResultEventLike) => {
    const chunks: string[] = [];
    for (let i = 0; i < event.results.length; i += 1) {
      const part = event.results[i]?.[0]?.transcript || '';
      if (part.trim()) chunks.push(part.trim());
    }
    pttTranscript = chunks.join(' ').trim();
    dom.voiceDebugTranscript.textContent = `Viimeisin puhe: ${pttTranscript || '-'}`;
  };
  recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
    if (event.error && event.error !== 'no-speech' && event.error !== 'aborted') {
      setStatus(dom.voiceStatus, `Äänentunnistusvirhe: ${event.error}`, 'error');
    }
  };
  recognition.onend = () => {
    const transcript = pttTranscript.trim();
    pttListening = false;
    setPttButtonState(false);
    pttRecognition = null;
    if (!transcript) {
      setStatus(dom.voiceStatus, 'Puhetta ei tunnistettu.', 'error');
      return;
    }
    void submitVoiceCommand(transcript);
  };
  return recognition;
}

async function submitVoiceCommand(transcript: string): Promise<void> {
  if (!requireGuildBeforeQueue(dom.voiceStatus)) return;
  setStatus(dom.voiceStatus, 'Suoritetaan äänikomentoa...');
  const result = await postVoiceCommand(transcript);
  if (result.error) {
    setStatus(dom.voiceStatus, result.message || result.error, 'error');
    showToast('stern', [result.message || result.error]);
    return;
  }
  setStatus(dom.voiceStatus, result.message || 'Äänikomento suoritettu', 'ok');
  showToast('happy', [result.message || 'Äänikomento valmis']);
  appState.stateEtag = '';
  void fetchState();
}

function startPttCapture(): void {
  if (pttListening) return;
  if (!requireGuildBeforeQueue(dom.voiceStatus)) return;
  pttTranscript = '';
  dom.voiceDebugTranscript.textContent = 'Viimeisin puhe: ...';
  const recognition = buildVoiceRecognition();
  if (!recognition) {
    setStatus(dom.voiceStatus, 'Selain ei tue äänentunnistusta tässä näkymässä.', 'error');
    return;
  }
  pttRecognition = recognition;
  try {
    pttListening = true;
    setPttButtonState(true);
    recognition.start();
  } catch {
    pttListening = false;
    setPttButtonState(false);
    pttRecognition = null;
    setStatus(dom.voiceStatus, 'Äänentunnistus ei käynnistynyt.', 'error');
  }
}

function stopPttCapture(): void {
  if (!pttListening || !pttRecognition) return;
  try {
    pttRecognition.stop();
  } catch {
    pttListening = false;
    setPttButtonState(false);
    pttRecognition = null;
  }
}

async function refreshVoiceKeywords(reset: boolean): Promise<void> {
  if (appState.voiceKeywordsBusy) return;
  appState.voiceKeywordsBusy = true;
  try {
    const cursor = reset ? null : appState.voiceKeywordsNextCursor;
    if (!reset && !cursor) return;
    const result = await fetchVoiceKeywords('', cursor, VOICE_KEYWORD_LIMIT);
    if (result.error) {
      setStatus(dom.voiceKeywordStatus, result.error, 'error');
      return;
    }

    const items = Array.isArray(result.items) ? result.items : [];
    if (reset) {
      appState.voiceKeywords = items;
    } else {
      const merged = [...appState.voiceKeywords];
      for (const item of items) {
        const index = merged.findIndex((row) => row.phrase === item.phrase);
        if (index >= 0) merged[index] = item;
        else merged.push(item);
      }
      appState.voiceKeywords = merged;
    }
    appState.voiceKeywordsNextCursor = result.nextCursor || null;
    renderVoiceKeywordList(appState.voiceKeywords, !!appState.voiceKeywordsNextCursor);
  } finally {
    appState.voiceKeywordsBusy = false;
  }
}

async function onSaveVoiceKeyword(event: Event): Promise<void> {
  event.preventDefault();
  const phrase = dom.voiceKeywordPhraseInput.value.trim();
  const url = dom.voiceKeywordUrlInput.value.trim();
  if (!phrase) {
    setStatus(dom.voiceKeywordStatus, 'Anna avainsana.', 'error');
    return;
  }
  if (!url) {
    setStatus(dom.voiceKeywordStatus, 'Anna YouTube-linkki.', 'error');
    return;
  }
  const result = await upsertVoiceKeywordApi(phrase, url);
  if (result.error) {
    setStatus(dom.voiceKeywordStatus, result.error, 'error');
    return;
  }
  dom.voiceKeywordPhraseInput.value = '';
  dom.voiceKeywordUrlInput.value = '';
  setStatus(dom.voiceKeywordStatus, 'Avainsana tallennettu.', 'ok');
  showToast('happy', ['Eppu oppi uuden avainsanan.']);
  await refreshVoiceKeywords(true);
}

function fillVoiceKeywordForEdit(phrase: string): void {
  const keyword = appState.voiceKeywords.find((item) => item.phrase === phrase);
  if (!keyword) return;
  dom.voiceKeywordPhraseInput.value = keyword.phrase;
  dom.voiceKeywordUrlInput.value = keyword.url;
  dom.voiceKeywordPhraseInput.focus();
}

async function onDeleteVoiceKeyword(phrase: string): Promise<void> {
  const result = await deleteVoiceKeywordApi(phrase);
  if (result.error) {
    setStatus(dom.voiceKeywordStatus, result.error, 'error');
    return;
  }
  appState.voiceKeywords = appState.voiceKeywords.filter((item) => item.phrase !== phrase);
  renderVoiceKeywordList(appState.voiceKeywords, !!appState.voiceKeywordsNextCursor);
  setStatus(dom.voiceKeywordStatus, 'Avainsana poistettu.', 'ok');
  showToast('stern', ['Eppu unohti avainsanan.']);
  if (appState.voiceKeywords.length === 0) {
    await refreshVoiceKeywords(true);
  }
}

async function refreshPlaylists(reset: boolean): Promise<void> {
  if (appState.playlistListBusy) return;
  appState.playlistListBusy = true;
  try {
    const cursor = reset ? null : appState.playlistsNextCursor;
    if (!reset && !cursor) return;

    const result = await fetchPlaylists(appState.playlistSearchQuery, cursor, PLAYLIST_LIST_LIMIT);
    if (result.error) {
      setStatus(dom.playlistStatus, result.error, 'error');
      return;
    }

    const received = Array.isArray(result.items) ? result.items : [];
    if (reset) {
      appState.playlists = received;
    } else {
      const next = [...appState.playlists];
      for (const item of received) {
        const idx = next.findIndex((row) => row.id === item.id);
        if (idx >= 0) next[idx] = item;
        else next.push(item);
      }
      appState.playlists = next;
    }
    appState.playlistsNextCursor = result.nextCursor || null;

    if (appState.selectedPlaylistId && !appState.playlists.some((item) => item.id === appState.selectedPlaylistId)) {
      appState.selectedPlaylistId = null;
      appState.selectedPlaylist = null;
    }
    if (!appState.selectedPlaylistId && appState.playlists.length > 0) {
      await selectPlaylist(appState.playlists[0].id);
      return;
    }
    renderPlaylistPanels();
  } finally {
    appState.playlistListBusy = false;
  }
}

async function refreshSelectedPlaylist(append = false): Promise<void> {
  const playlistId = appState.selectedPlaylistId;
  if (!playlistId) {
    appState.selectedPlaylist = null;
    renderPlaylistPanels();
    return;
  }

  if (appState.playlistDetailBusy) return;
  appState.playlistDetailBusy = true;
  try {
    const cursor = append ? (appState.selectedPlaylist?.songNextCursor || null) : null;
    if (append && !cursor) return;

    const response = await fetchPlaylistDetail(
      playlistId,
      appState.playlistSongSearchQuery,
      cursor,
      PLAYLIST_SONG_LIMIT
    );
    if (response.error || !response.playlist) {
      setStatus(dom.playlistStatus, response.error || 'Soittolistan lataus epäonnistui', 'error');
      return;
    }

    const playlist = response.playlist;
    if (append && appState.selectedPlaylist && appState.selectedPlaylist.id === playlist.id) {
      const merged: PlaylistDetail = {
        ...playlist,
        songs: [...appState.selectedPlaylist.songs, ...playlist.songs],
      };
      appState.selectedPlaylist = merged;
    } else {
      appState.selectedPlaylist = playlist;
    }

    upsertPlaylistSummary({
      id: playlist.id,
      name: playlist.name,
      createdBy: playlist.createdBy,
      updatedBy: playlist.updatedBy,
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
      songCount: playlist.songCount,
    });
    renderPlaylistPanels();
  } finally {
    appState.playlistDetailBusy = false;
  }
}

async function selectPlaylist(playlistId: string): Promise<void> {
  if (appState.selectedPlaylistId === playlistId && appState.selectedPlaylist) return;
  appState.selectedPlaylistId = playlistId;
  appState.selectedPlaylist = null;
  appState.playlistSongSearchQuery = '';
  dom.playlistSongSearchInput.value = '';
  renderPlaylistPanels();
  await refreshSelectedPlaylist(false);
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

async function onCreatePlaylist(): Promise<void> {
  const name = window.prompt('Anna uuden soittolistan nimi:')?.trim();
  if (!name) return;
  const result = await createPlaylistApi(name);
  if (result.error || !result.playlist) {
    setStatus(dom.playlistStatus, result.error || 'Soittolistan luonti epäonnistui', 'error');
    return;
  }
  setStatus(dom.playlistStatus, `Luotu: ${result.playlist.name}`, 'ok');
  await refreshPlaylists(true);
  if (result.playlist?.id) {
    await selectPlaylist(result.playlist.id);
  }
}

async function onRenamePlaylist(): Promise<void> {
  const playlist = selectedPlaylistSummary();
  if (!playlist) {
    setStatus(dom.playlistStatus, 'Valitse ensin soittolista.', 'error');
    return;
  }
  const name = window.prompt('Uusi nimi soittolistalle:', playlist.name)?.trim();
  if (!name) return;
  const result = await renamePlaylistApi(playlist.id, name);
  if (result.error || !result.playlist) {
    setStatus(dom.playlistStatus, result.error || 'Nimen vaihto epäonnistui', 'error');
    return;
  }
  setStatus(dom.playlistStatus, 'Soittolista nimettiin uudelleen', 'ok');
  await refreshPlaylists(true);
  await selectPlaylist(playlist.id);
}

async function onDeletePlaylist(): Promise<void> {
  const playlist = selectedPlaylistSummary();
  if (!playlist) {
    setStatus(dom.playlistStatus, 'Valitse ensin soittolista.', 'error');
    return;
  }
  const confirmed = window.confirm(`Poistetaanko soittolista "${playlist.name}"?`);
  if (!confirmed) return;
  const result = await deletePlaylistApi(playlist.id);
  if (result.error) {
    setStatus(dom.playlistStatus, result.error, 'error');
    return;
  }
  setStatus(dom.playlistStatus, 'Soittolista poistettu', 'ok');
  if (appState.selectedPlaylistId === playlist.id) {
    appState.selectedPlaylistId = null;
    appState.selectedPlaylist = null;
  }
  removePlaylistSummary(playlist.id);
  renderPlaylistPanels();
  await refreshPlaylists(true);
}

async function onAddSongToPlaylist(event: Event): Promise<void> {
  event.preventDefault();
  const playlistId = requireSelectedPlaylist();
  if (!playlistId) return;
  const url = dom.playlistSongUrlInput.value.trim();
  if (!url) return;
  const result = await addPlaylistSongApi(playlistId, url);
  if (result.error) {
    setStatus(dom.playlistStatus, result.error, 'error');
    return;
  }
  dom.playlistSongUrlInput.value = '';
  setStatus(dom.playlistStatus, 'Kappale lisätty soittolistaan', 'ok');
  await refreshSelectedPlaylist(false);
}

async function onImportYouTubePlaylist(event: Event): Promise<void> {
  event.preventDefault();
  const url = dom.playlistImportUrlInput.value.trim();
  if (!url) {
    setStatus(dom.playlistStatus, 'YouTube-soittolistan URL puuttuu', 'error');
    return;
  }
  const name = dom.playlistImportNameInput.value.trim();
  setStatus(dom.playlistStatus, 'Tuodaan YouTube-soittolistaa...');
  const result = await importYouTubePlaylistApi(name, url);
  if (result.error || !result.playlist) {
    setStatus(dom.playlistStatus, result.error || 'Tuonti epäonnistui', 'error');
    return;
  }
  dom.playlistImportUrlInput.value = '';
  dom.playlistImportNameInput.value = '';
  setStatus(dom.playlistStatus, `Tuotu: ${result.playlist.name}`, 'ok');
  await refreshPlaylists(true);
  await selectPlaylist(result.playlist.id);
}

async function onPlayPlaylist(shuffle: boolean): Promise<void> {
  const playlistId = requireSelectedPlaylist();
  if (!playlistId) return;
  if (!appState.currentGuild) {
    setStatus(dom.playlistStatus, 'Valitse palvelin ennen jonotusta.', 'error');
    return;
  }
  const result = await playPlaylistApi(playlistId, appState.currentGuild, shuffle);
  if (result.error) {
    setStatus(dom.playlistStatus, result.error, 'error');
    return;
  }
  if (result.noop) {
    setStatus(dom.playlistStatus, result.message || 'Soittolista oli tyhjä', 'info');
    return;
  }
  setStatus(dom.playlistStatus, `Jonoon lisätty ${result.queued || 0} kappaletta`, 'ok');
  appState.stateEtag = '';
  void fetchState();
}

async function onSaveWholeQueueToPlaylist(): Promise<void> {
  const playlistId = requireSelectedPlaylist();
  if (!playlistId) return;
  if (!appState.currentGuild) {
    setStatus(dom.playlistStatus, 'Valitse palvelin ennen tallennusta.', 'error');
    return;
  }
  const result = await copyQueueToPlaylistApi(playlistId, appState.currentGuild, true);
  if (result.error || !result.result) {
    setStatus(dom.playlistStatus, result.error || 'Jonon tallennus epäonnistui', 'error');
    return;
  }
  setStatus(
    dom.playlistStatus,
    `Tallennettu: +${result.result.added}, duplikaatit ${result.result.skippedDuplicates}, virheet ${result.result.failed}`,
    'ok'
  );
  await refreshSelectedPlaylist(false);
  await refreshPlaylists(true);
}

async function onCreatePlaylistFromQueue(): Promise<void> {
  if (!appState.currentGuild) {
    setStatus(dom.playlistStatus, 'Valitse palvelin ennen tallennusta.', 'error');
    return;
  }
  const name = window.prompt('Anna nimi uudelle soittolistalle (jonosta):')?.trim();
  if (!name) return;
  const result = await createPlaylistFromQueueApi(appState.currentGuild, name, true);
  if (result.error || !result.playlist) {
    setStatus(dom.playlistStatus, result.error || 'Soittolistan luonti jonosta epäonnistui', 'error');
    return;
  }
  setStatus(
    dom.playlistStatus,
    `Soittolista luotu jonosta: +${result.result?.added || 0}`,
    'ok'
  );
  await refreshPlaylists(true);
  if (result.playlist?.id) {
    await selectPlaylist(result.playlist.id);
  }
}

function queueSelectionItems(): Array<{ key: string; title: string; meta: string; checked: boolean }> {
  const guildState = currentGuildState();
  const items: Array<{ key: string; title: string; meta: string; checked: boolean }> = [];
  if (!guildState) return items;

  if (guildState.currentSong) {
    const key = 'current';
    items.push({
      key,
      title: guildState.currentSong.title,
      meta: 'Nyt soi',
      checked: queueSelectionKeys.has(key),
    });
  }

  guildState.queue.forEach((song, index) => {
    const key = `queue:${index}`;
    items.push({
      key,
      title: song.title,
      meta: `Jonossa #${index + 1}`,
      checked: queueSelectionKeys.has(key),
    });
  });
  return items;
}

function renderQueueSelectionModal(): void {
  const items = queueSelectionItems();
  if (queueSelectionKeys.size === 0) {
    items.forEach((item) => queueSelectionKeys.add(item.key));
  }
  const rendered = items.map((item) => ({ ...item, checked: queueSelectionKeys.has(item.key) }));
  renderQueueSelectionList(rendered);
}

function openQueueSelectionModal(): void {
  appState.queueSelectModalOpen = true;
  queueSelectionKeys = new Set<string>();
  renderQueueSelectionModal();
  setVisible(dom.queueSelectModal, true);
  document.body.classList.add('modal-open');
}

function closeQueueSelectionModal(): void {
  appState.queueSelectModalOpen = false;
  setVisible(dom.queueSelectModal, false);
  setVisible(dom.queueSelectStatus, false);
  dom.queueSelectStatus.textContent = '';
  document.body.classList.remove('modal-open');
}

async function onSaveSelectedQueueToPlaylist(): Promise<void> {
  const playlistId = requireSelectedPlaylist();
  if (!playlistId) return;
  if (!appState.currentGuild) {
    setStatus(dom.playlistStatus, 'Valitse palvelin ennen tallennusta.', 'error');
    return;
  }
  openQueueSelectionModal();
}

async function onConfirmQueueSelectionSave(): Promise<void> {
  const playlistId = requireSelectedPlaylist();
  if (!playlistId || !appState.currentGuild) return;

  const includeCurrent = queueSelectionKeys.has('current');
  const selectedIndices = [...queueSelectionKeys]
    .filter((key) => key.startsWith('queue:'))
    .map((key) => Number.parseInt(key.split(':')[1], 10))
    .filter((value) => !Number.isNaN(value))
    .sort((a, b) => a - b);

  if (!includeCurrent && selectedIndices.length === 0) {
    setStatus(dom.queueSelectStatus, 'Valitse vähintään yksi kappale.', 'error');
    return;
  }

  const result = await copyQueueToPlaylistApi(playlistId, appState.currentGuild, includeCurrent, selectedIndices);
  if (result.error || !result.result) {
    setStatus(dom.queueSelectStatus, result.error || 'Valinnan tallennus epäonnistui', 'error');
    return;
  }

  closeQueueSelectionModal();
  setStatus(
    dom.playlistStatus,
    `Tallennettu valinta: +${result.result.added}, duplikaatit ${result.result.skippedDuplicates}, virheet ${result.result.failed}`,
    'ok'
  );
  await refreshSelectedPlaylist(false);
  await refreshPlaylists(true);
}

async function onRemovePlaylistSong(songId: string): Promise<void> {
  const playlistId = requireSelectedPlaylist();
  if (!playlistId) return;
  const result = await removePlaylistSongApi(playlistId, songId);
  if (result.error) {
    setStatus(dom.playlistStatus, result.error, 'error');
    return;
  }
  setStatus(dom.playlistStatus, 'Kappale poistettu soittolistasta', 'ok');
  await refreshSelectedPlaylist(false);
  await refreshPlaylists(true);
}

async function onMovePlaylistSong(fromIndex: number, toIndex: number): Promise<void> {
  const playlistId = requireSelectedPlaylist();
  if (!playlistId || fromIndex === toIndex) return;
  const result = await movePlaylistSongApi(playlistId, fromIndex, toIndex);
  if (result.error) {
    setStatus(dom.playlistStatus, result.error, 'error');
    return;
  }
  await refreshSelectedPlaylist(false);
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

function attachPlaylistEvents(): void {
  dom.createPlaylistBtn.addEventListener('click', () => {
    void onCreatePlaylist();
  });
  dom.renamePlaylistBtn.addEventListener('click', () => {
    void onRenamePlaylist();
  });
  dom.deletePlaylistBtn.addEventListener('click', () => {
    void onDeletePlaylist();
  });
  dom.playPlaylistBtn.addEventListener('click', () => {
    void onPlayPlaylist(false);
  });
  dom.playPlaylistShuffleBtn.addEventListener('click', () => {
    void onPlayPlaylist(true);
  });
  dom.saveQueueToPlaylistBtn.addEventListener('click', () => {
    void onSaveWholeQueueToPlaylist();
  });
  dom.saveSelectedQueueBtn.addEventListener('click', () => {
    void onSaveSelectedQueueToPlaylist();
  });
  dom.createPlaylistFromQueueBtn.addEventListener('click', () => {
    void onCreatePlaylistFromQueue();
  });
  dom.playlistSongForm.addEventListener('submit', (event) => {
    void onAddSongToPlaylist(event);
  });
  dom.playlistImportForm.addEventListener('submit', (event) => {
    void onImportYouTubePlaylist(event);
  });
  dom.playlistLoadMoreBtn.addEventListener('click', () => {
    void refreshPlaylists(false);
  });
  dom.playlistSongsLoadMoreBtn.addEventListener('click', () => {
    void refreshSelectedPlaylist(true);
  });

  dom.playlistSearchInput.addEventListener('input', () => {
    appState.playlistSearchQuery = dom.playlistSearchInput.value.trim();
    if (playlistSearchDebounce) window.clearTimeout(playlistSearchDebounce);
    playlistSearchDebounce = window.setTimeout(() => {
      void refreshPlaylists(true);
    }, 250);
  });

  dom.playlistSongSearchInput.addEventListener('input', () => {
    appState.playlistSongSearchQuery = dom.playlistSongSearchInput.value.trim();
    if (playlistSongSearchDebounce) window.clearTimeout(playlistSongSearchDebounce);
    playlistSongSearchDebounce = window.setTimeout(() => {
      void refreshSelectedPlaylist(false);
    }, 250);
  });

  dom.playlistList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-playlist-id]') as HTMLElement | null;
    if (!button) return;
    const playlistId = button.getAttribute('data-playlist-id');
    if (!playlistId) return;
    void selectPlaylist(playlistId);
  });

  dom.playlistSongList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-playlist-remove-song]') as HTMLElement | null;
    if (!button) return;
    const songId = button.getAttribute('data-playlist-remove-song');
    if (!songId) return;
    void onRemovePlaylistSong(songId);
  });

  dom.playlistSongList.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest('.playlist-song-item') as HTMLElement | null;
    if (!item) return;
    appState.playlistSongDragFromIndex = Number.parseInt(item.getAttribute('data-playlist-song-index') || '', 10);
    item.classList.add('dragging');
  });

  dom.playlistSongList.addEventListener('dragend', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest('.playlist-song-item') as HTMLElement | null;
    if (item) item.classList.remove('dragging');
    appState.playlistSongDragFromIndex = null;
  });

  dom.playlistSongList.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  dom.playlistSongList.addEventListener('drop', (event) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    const item = target.closest('.playlist-song-item') as HTMLElement | null;
    if (!item || appState.playlistSongDragFromIndex === null) return;
    const to = Number.parseInt(item.getAttribute('data-playlist-song-index') || '', 10);
    if (!Number.isNaN(to)) {
      void onMovePlaylistSong(appState.playlistSongDragFromIndex, to);
    }
    appState.playlistSongDragFromIndex = null;
  });

  dom.queueSelectList.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    const key = target.getAttribute('data-queue-select');
    if (!key) return;
    if (target.checked) queueSelectionKeys.add(key);
    else queueSelectionKeys.delete(key);
  });
  dom.queueSelectConfirmBtn.addEventListener('click', () => {
    void onConfirmQueueSelectionSave();
  });
  dom.closeQueueSelectBtn.addEventListener('click', closeQueueSelectionModal);
  dom.queueSelectModal.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-modal-close="queue-select"]')) {
      closeQueueSelectionModal();
    }
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
  setPttButtonState(false);
  dom.pttBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startPttCapture();
  });
  dom.pttBtn.addEventListener('pointerup', (event) => {
    event.preventDefault();
    stopPttCapture();
  });
  dom.pttBtn.addEventListener('pointerleave', () => {
    stopPttCapture();
  });
  dom.pttBtn.addEventListener('pointercancel', () => {
    stopPttCapture();
  });
  dom.voiceKeywordForm.addEventListener('submit', (event) => {
    void onSaveVoiceKeyword(event);
  });
  dom.voiceKeywordLoadMoreBtn.addEventListener('click', () => {
    void refreshVoiceKeywords(false);
  });
  dom.voiceKeywordList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const editButton = target.closest('[data-voice-keyword-use]') as HTMLElement | null;
    if (editButton) {
      const phrase = editButton.getAttribute('data-voice-keyword-use');
      if (phrase) fillVoiceKeywordForEdit(phrase);
      return;
    }
    const deleteButton = target.closest('[data-voice-keyword-delete]') as HTMLElement | null;
    if (deleteButton) {
      const phrase = deleteButton.getAttribute('data-voice-keyword-delete');
      if (phrase) {
        void onDeleteVoiceKeyword(phrase);
      }
    }
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
    if (event.key === 'Escape') {
      if (!dom.searchModal.classList.contains('hidden')) {
        closeSearchModal();
      }
      if (!dom.queueSelectModal.classList.contains('hidden')) {
        closeQueueSelectionModal();
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    schedulePoll(200);
  });

  attachQueueEvents();
  attachPlaylistEvents();
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
