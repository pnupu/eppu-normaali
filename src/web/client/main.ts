import { ApiError, api, initAccessToken, popQueryParam } from './api';
import { POLL_FAST_MS, POLL_SLOW_MS, TOAST_LINES } from './constants';
import { detailHtml, escapeHtml, formatClock, pickListHtml, queueHtml, resultsHtml, shelfHtml, sourceBadge, summarize } from './render';
import { showToast } from './toasts';
import type { GuildPlaybackState, PlaylistDetail, PlaylistSummary, SearchSource, Track } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  loginView: $('loginView'),
  loginHint: $('loginHint'),
  tabs: $('viewTabs'),
  lamp: $('lamp'),
  lampText: $('lampText'),
  jukeboxView: $('jukeboxView'),
  playlistsView: $('playlistsView'),
  nowStrip: $('nowStrip'),
  nowArt: $<HTMLImageElement>('nowArt'),
  nowTitle: $('nowTitle'),
  nowMeta: $('nowMeta'),
  progressFill: $('progressFill'),
  elapsed: $('elapsed'),
  duration: $('duration'),
  pauseBtn: $<HTMLButtonElement>('pauseBtn'),
  skipBtn: $<HTMLButtonElement>('skipBtn'),
  volumeInput: $<HTMLInputElement>('volumeInput'),
  volumeOut: $<HTMLOutputElement>('volumeOut'),
  addForm: $<HTMLFormElement>('addForm'),
  addInput: $<HTMLInputElement>('addInput'),
  addBtn: $<HTMLButtonElement>('addBtn'),
  addStatus: $('addStatus'),
  results: $('results'),
  queueSummary: $('queueSummary'),
  queueList: $('queueList'),
  saveQueueBtn: $<HTMLButtonElement>('saveQueueBtn'),
  newPlaylistBtn: $<HTMLButtonElement>('newPlaylistBtn'),
  importForm: $<HTMLFormElement>('importForm'),
  importInput: $<HTMLInputElement>('importInput'),
  shelfStatus: $('shelfStatus'),
  playlistList: $('playlistList'),
  playlistDetail: $('playlistDetail'),
  nameDialog: $<HTMLDialogElement>('nameDialog'),
  nameDialogTitle: $('nameDialogTitle'),
  nameDialogInput: $<HTMLInputElement>('nameDialogInput'),
  nameDialogConfirm: $<HTMLButtonElement>('nameDialogConfirm'),
  pickDialog: $<HTMLDialogElement>('pickDialog'),
  pickDialogTrack: $('pickDialogTrack'),
  pickDialogList: $('pickDialogList'),
  pickDialogNew: $<HTMLButtonElement>('pickDialogNew'),
};

const state = {
  guildId: null as string | null,
  defaultGuildId: '',
  etag: '',
  playback: null as GuildPlaybackState | null,
  /** Date.now() when playback.positionMs was received; progress is interpolated from there. */
  positionAt: 0,
  pollTimer: 0,
  failedPolls: 0,
  results: [] as Track[],
  pendingKeys: new Set<string>(),
  playlists: [] as PlaylistSummary[],
  playlistsLoaded: false,
  selected: null as PlaylistDetail | null,
  pickTrack: null as Track | null,
  volumeTimer: 0,
  volumeEditingUntil: 0,
};

// ---------- small helpers ----------

function show(node: HTMLElement, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

function setStatus(node: HTMLElement | null, text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Jokin meni pieleen. Yritä uudelleen.';
}

function looksLikeLink(value: string): boolean {
  return /^(https?:\/\/|spotify:)/i.test(value.trim());
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Guards against double submits: runs `task` only if `key` is not already running. */
const running = new Set<string>();
async function once(key: string, task: () => Promise<void>): Promise<void> {
  if (running.has(key)) return;
  running.add(key);
  try {
    await task();
  } finally {
    running.delete(key);
  }
}

function askName(title: string, confirmLabel: string, initial = ''): Promise<string | null> {
  el.nameDialogTitle.textContent = title;
  el.nameDialogConfirm.textContent = confirmLabel;
  el.nameDialogInput.value = initial;
  el.nameDialog.returnValue = '';
  el.nameDialog.showModal();
  el.nameDialogInput.select();
  return new Promise((resolve) => {
    el.nameDialog.addEventListener('close', () => {
      const name = el.nameDialogInput.value.trim();
      resolve(el.nameDialog.returnValue === 'confirm' && name ? name : null);
    }, { once: true });
  });
}

// ---------- playback state ----------

function setLamp(kind: 'syncing' | 'ready' | 'playing' | 'paused' | 'degraded'): void {
  const text = { syncing: 'Yhdistetään', ready: 'Valmis', playing: 'Soi', paused: 'Tauolla', degraded: 'Yhteys pätkii' }[kind];
  el.lamp.dataset.state = kind;
  el.lampText.textContent = text;
}

function currentPositionSeconds(): number {
  const p = state.playback;
  if (!p?.currentSong || p.positionMs === null) return 0;
  const drift = p.paused ? 0 : Date.now() - state.positionAt;
  return (p.positionMs + drift) / 1000;
}

function renderProgress(): void {
  const song = state.playback?.currentSong;
  const position = currentPositionSeconds();
  const duration = song?.duration || 0;
  el.elapsed.textContent = song ? formatClock(Math.min(position, duration || position)) || '0:00' : '';
  el.duration.textContent = duration ? formatClock(duration) : '';
  el.progressFill.style.width = duration ? `${Math.min(100, (position / duration) * 100)}%` : '0%';
}

function renderPlayback(): void {
  const p = state.playback;
  const song = p?.currentSong || null;
  el.nowStrip.classList.toggle('idle', !song);
  if (song) {
    el.nowTitle.textContent = song.title;
    el.nowMeta.innerHTML = [sourceBadge(song), escapeHtml(`Lisäsi ${song.requestedBy}`)].join('<span aria-hidden="true">·</span>');
    if (song.thumbnail) el.nowArt.src = song.thumbnail;
    el.nowArt.hidden = !song.thumbnail;
  } else {
    el.nowTitle.textContent = 'Mikään ei soi';
    el.nowMeta.textContent = 'Lisää kappale alta, niin Eppu aloittaa.';
    el.nowArt.hidden = true;
  }
  el.pauseBtn.disabled = !song;
  el.skipBtn.disabled = !song;
  el.pauseBtn.textContent = p?.paused ? 'Jatka' : 'Tauko';
  setLamp(song ? (p?.paused ? 'paused' : 'playing') : 'ready');

  if (p && Date.now() > state.volumeEditingUntil) {
    el.volumeInput.value = String(p.volume);
    el.volumeOut.textContent = `${p.volume} %`;
  }

  const queue = p?.queue || [];
  el.queueSummary.textContent = queue.length ? summarize(queue) : '';
  el.queueList.innerHTML = queueHtml(queue);
  el.saveQueueBtn.disabled = !song && !queue.length;
  renderProgress();
}

function schedulePoll(delay = document.hidden ? POLL_SLOW_MS : POLL_FAST_MS): void {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = window.setTimeout(() => void poll(), delay);
}

async function poll(): Promise<void> {
  try {
    const result = await api.state(state.etag);
    state.failedPolls = 0;
    if (result.notModified) {
      const p = state.playback;
      setLamp(p?.currentSong ? (p.paused ? 'paused' : 'playing') : 'ready');
    }
    if (!result.notModified) {
      state.etag = result.etag;
      const guildIds = Object.keys(result.state);
      if (!state.guildId || !guildIds.includes(state.guildId)) {
        state.guildId = guildIds.includes(state.defaultGuildId) ? state.defaultGuildId : guildIds[0] || null;
      }
      state.playback = state.guildId ? result.state[state.guildId] : null;
      state.positionAt = Date.now();
      renderPlayback();
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin('Istunto vanheni. Kirjoita Discordissa /web-login ja avaa uusi linkki.', true);
      return;
    }
    state.failedPolls += 1;
    if (state.failedPolls >= 2) setLamp('degraded');
  }
  schedulePoll();
}

function refreshSoon(): void {
  state.etag = '';
  schedulePoll(150);
}

// ---------- jukebox actions ----------

function selectedSearchSource(): SearchSource {
  const checked = document.querySelector<HTMLInputElement>('input[name="searchSource"]:checked');
  return checked?.value === 'soundcloud' ? 'soundcloud' : 'youtube';
}

function requireGuild(statusNode: HTMLElement | null): string | null {
  if (state.guildId) return state.guildId;
  setStatus(statusNode, 'Eppu ei löydä Discord-palvelinta. Tarkista botin asetukset.', 'error');
  return null;
}

function describeEnqueue(added: number, name: string | null, firstTitle: string | null, skipped: number): string {
  const skippedNote = skipped ? ` ${plural(skipped, 'kappale', 'kappaletta')} ei ollut saatavilla.` : '';
  if (name) return `Jonoon lisättiin ${plural(added, 'kappale', 'kappaletta')} listalta ${name}.${skippedNote}`;
  return `Jonoon lisättiin ${firstTitle || 'kappale'}.${skippedNote}`;
}

async function onAddSubmit(event: Event): Promise<void> {
  event.preventDefault();
  const value = el.addInput.value.trim();
  if (!value) return;
  await once('add', async () => {
    el.addBtn.disabled = true;
    try {
      if (looksLikeLink(value)) {
        const guildId = requireGuild(el.addStatus);
        if (!guildId) return;
        setStatus(el.addStatus, 'Haetaan kappaletta…');
        const res = await api.play(guildId, { input: value });
        setStatus(el.addStatus, describeEnqueue(res.added, res.name, res.firstTitle, res.skipped), 'ok');
        showToast('happy', TOAST_LINES.addUrlOk);
        el.addInput.value = '';
        syncAddButton();
        refreshSoon();
        return;
      }
      const source = selectedSearchSource();
      setStatus(el.addStatus, `Haetaan ${source === 'soundcloud' ? 'SoundCloudista' : 'YouTubesta'}…`);
      const { results } = await api.search(value, source);
      state.results = results;
      el.results.innerHTML = resultsHtml(results, state.pendingKeys);
      setStatus(el.addStatus, results.length ? '' : `Haulla "${value}" ei löytynyt mitään.`, results.length ? 'info' : 'error');
      if (!results.length) showToast('stern', TOAST_LINES.searchEmpty);
    } catch (error) {
      setStatus(el.addStatus, errorMessage(error), 'error');
      showToast('stern', looksLikeLink(value) ? TOAST_LINES.addUrlError : TOAST_LINES.searchError);
    } finally {
      el.addBtn.disabled = false;
    }
  });
}

function syncAddButton(): void {
  el.addBtn.textContent = looksLikeLink(el.addInput.value) ? 'Lisää jonoon' : 'Hae';
}

async function queueTrack(track: Track, statusNode: HTMLElement | null): Promise<void> {
  const guildId = requireGuild(statusNode);
  if (!guildId) return;
  try {
    await api.play(guildId, { track });
    setStatus(statusNode, `Jonoon lisättiin ${track.title}.`, 'ok');
    showToast('happy', TOAST_LINES.addSearchOk);
    refreshSoon();
  } catch (error) {
    setStatus(statusNode, errorMessage(error), 'error');
    showToast('stern', TOAST_LINES.addSearchError);
  }
}

async function onResultsClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  const track = button ? state.results[Number(button.dataset.index)] : undefined;
  if (!button || !track) return;
  if (button.dataset.action === 'result-save') {
    void openPickDialog(track);
    return;
  }
  await once(`result:${track.key}`, async () => {
    state.pendingKeys.add(track.key);
    el.results.innerHTML = resultsHtml(state.results, state.pendingKeys);
    await queueTrack(track, el.addStatus);
    state.pendingKeys.delete(track.key);
    el.results.innerHTML = resultsHtml(state.results, state.pendingKeys);
  });
}

async function onQueueClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  const guildId = state.guildId;
  if (!button || !guildId) return;
  const index = Number(button.dataset.index);
  const song = state.playback?.queue[index];
  if (!song) return;
  try {
    switch (button.dataset.action) {
      case 'queue-up':
        await api.move(guildId, index, index - 1);
        break;
      case 'queue-down':
        await api.move(guildId, index, index + 1);
        break;
      case 'queue-remove':
        await api.remove(guildId, index);
        showToast('stern', TOAST_LINES.remove);
        break;
      case 'queue-save':
        void openPickDialog(song);
        return;
    }
    refreshSoon();
  } catch (error) {
    showToast('stern', [errorMessage(error)]);
  }
}

async function onControl(action: 'pause' | 'skip'): Promise<void> {
  const guildId = state.guildId;
  if (!guildId) return;
  await once(action, async () => {
    try {
      const res = await api.control(guildId, action);
      if (action === 'skip') showToast('stern', TOAST_LINES.skip);
      else showToast(res.paused ? 'stern' : 'happy', res.paused ? TOAST_LINES.pause : TOAST_LINES.resume);
      refreshSoon();
    } catch (error) {
      showToast('stern', [errorMessage(error)]);
    }
  });
}

function onVolumeInput(): void {
  const volume = Number(el.volumeInput.value);
  el.volumeOut.textContent = `${volume} %`;
  // Keep polls from snapping the slider back while the request is in flight.
  state.volumeEditingUntil = Date.now() + 2000;
  window.clearTimeout(state.volumeTimer);
  state.volumeTimer = window.setTimeout(() => {
    if (state.guildId) void api.volume(state.guildId, volume).catch(() => setLamp('degraded'));
  }, 120);
}

async function onSaveQueue(): Promise<void> {
  const guildId = state.guildId;
  if (!guildId) return;
  const name = await askName('Tallenna jono soittolistaksi', 'Tallenna');
  if (!name) return;
  try {
    const res = await api.queueToPlaylist(guildId, name);
    showToast('happy', [`Jono tallennettiin soittolistaksi ${res.playlist.name}.`]);
    state.playlistsLoaded = false;
  } catch (error) {
    showToast('stern', [errorMessage(error)]);
  }
}

// ---------- playlists ----------

async function loadPlaylists(): Promise<void> {
  try {
    const { items } = await api.playlists();
    state.playlists = items;
    state.playlistsLoaded = true;
    el.playlistList.innerHTML = shelfHtml(items, state.selected?.id ?? null);
  } catch (error) {
    setStatus(el.shelfStatus, errorMessage(error), 'error');
  }
}

async function openPlaylist(id: string): Promise<void> {
  try {
    const { playlist } = await api.playlist(id);
    state.selected = playlist;
    el.playlistDetail.innerHTML = detailHtml(playlist);
    el.playlistList.innerHTML = shelfHtml(state.playlists, id);
  } catch (error) {
    setStatus(el.shelfStatus, errorMessage(error), 'error');
  }
}

async function reloadSelected(): Promise<void> {
  if (state.selected) await openPlaylist(state.selected.id);
  await loadPlaylists();
}

function detailStatus(): HTMLElement | null {
  return el.playlistDetail.querySelector<HTMLElement>('[data-role="detail-status"]');
}

async function onNewPlaylist(): Promise<PlaylistSummary | null> {
  const name = await askName('Uusi soittolista', 'Luo');
  if (!name) return null;
  try {
    const { playlist } = await api.createPlaylist(name);
    await loadPlaylists();
    return playlist;
  } catch (error) {
    setStatus(el.shelfStatus, errorMessage(error), 'error');
    showToast('stern', [errorMessage(error)]);
    return null;
  }
}

async function onImport(event: Event): Promise<void> {
  event.preventDefault();
  const url = el.importInput.value.trim();
  if (!url) return;
  await once('import', async () => {
    setStatus(el.shelfStatus, 'Tuodaan… isot listat voivat kestää hetken.');
    try {
      const { playlist, result } = await api.importPlaylist(url);
      const failed = result.failed ? ` ${plural(result.failed, 'kappale', 'kappaletta')} ei ollut saatavilla.` : '';
      setStatus(el.shelfStatus, `Tuotiin ${plural(result.added, 'kappale', 'kappaletta')} listaan ${playlist.name}.${failed}`, 'ok');
      el.importInput.value = '';
      await loadPlaylists();
      await openPlaylist(playlist.id);
    } catch (error) {
      setStatus(el.shelfStatus, errorMessage(error), 'error');
    }
  });
}

async function onDetailClick(event: Event): Promise<void> {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  const playlist = state.selected;
  if (!button || !playlist) return;
  const index = Number(button.dataset.index);
  const song = playlist.songs[index];
  const status = detailStatus();
  try {
    switch (button.dataset.action) {
      case 'playlist-play':
      case 'playlist-shuffle': {
        const guildId = requireGuild(status);
        if (!guildId) return;
        const shuffle = button.dataset.action === 'playlist-shuffle';
        await once('playlist-play', async () => {
          const res = await api.playPlaylist(playlist.id, guildId, shuffle);
          setStatus(status, res.noop ? (res.message || 'Soittolista on tyhjä.') : `Jonoon lisättiin ${plural(res.queued || 0, 'kappale', 'kappaletta')}.`, 'ok');
          showToast('happy', TOAST_LINES.addUrlOk);
          refreshSoon();
        });
        return;
      }
      case 'playlist-rename': {
        const name = await askName('Nimeä soittolista uudelleen', 'Tallenna', playlist.name);
        if (!name) return;
        await api.renamePlaylist(playlist.id, name);
        break;
      }
      case 'playlist-delete':
        if (!window.confirm(`Poistetaanko soittolista ${playlist.name}? Tätä ei voi perua.`)) return;
        await api.deletePlaylist(playlist.id);
        state.selected = null;
        el.playlistDetail.innerHTML = detailHtml(null);
        await loadPlaylists();
        return;
      case 'song-queue':
        if (song) await queueTrack(song, status);
        return;
      case 'song-up':
        await api.moveInPlaylist(playlist.id, index, index - 1);
        break;
      case 'song-down':
        await api.moveInPlaylist(playlist.id, index, index + 1);
        break;
      case 'song-remove':
        if (song) await api.removeFromPlaylist(playlist.id, song.id);
        break;
      default:
        return;
    }
    await reloadSelected();
  } catch (error) {
    setStatus(detailStatus(), errorMessage(error), 'error');
  }
}

async function onDetailSubmit(event: Event): Promise<void> {
  const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-form="playlist-add"]');
  if (!form || !state.selected) return;
  event.preventDefault();
  const input = (form.elements.namedItem('input') as HTMLInputElement).value.trim();
  if (!input) return;
  const playlistId = state.selected.id;
  await once('playlist-add', async () => {
    setStatus(detailStatus(), 'Lisätään…');
    try {
      const { result } = await api.addToPlaylist(playlistId, { input });
      await reloadSelected();
      const dupes = result.skippedDuplicates ? ` Jo listalla: ${result.skippedDuplicates}.` : '';
      setStatus(detailStatus(), `Lisättiin ${plural(result.added, 'kappale', 'kappaletta')}.${dupes}`, 'ok');
    } catch (error) {
      setStatus(detailStatus(), errorMessage(error), 'error');
    }
  });
}

async function openPickDialog(track: Track): Promise<void> {
  state.pickTrack = track;
  el.pickDialogTrack.textContent = track.title;
  if (!state.playlistsLoaded) await loadPlaylists();
  el.pickDialogList.innerHTML = pickListHtml(state.playlists);
  el.pickDialog.showModal();
}

async function addPickedTrack(playlist: PlaylistSummary): Promise<void> {
  const track = state.pickTrack;
  if (!track) return;
  el.pickDialog.close();
  try {
    const { result } = await api.addToPlaylist(playlist.id, { track });
    showToast('happy', [result.added ? `Lisätty soittolistaan ${playlist.name}.` : `Kappale on jo soittolistalla ${playlist.name}.`]);
    state.playlistsLoaded = false;
    if (state.selected?.id === playlist.id) await reloadSelected();
  } catch (error) {
    showToast('stern', [errorMessage(error)]);
  }
}

// ---------- views & boot ----------

function setView(view: 'jukebox' | 'playlists'): void {
  show(el.jukeboxView, view === 'jukebox');
  show(el.playlistsView, view === 'playlists');
  el.tabs.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((tab) => {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
  });
  if (view === 'playlists' && !state.playlistsLoaded) void loadPlaylists();
  if (view === 'playlists' && !state.selected) el.playlistDetail.innerHTML = detailHtml(null);
}

function showLogin(message: string, isError = false): void {
  window.clearTimeout(state.pollTimer);
  show(el.loginView, true);
  show(el.jukeboxView, false);
  show(el.playlistsView, false);
  show(el.tabs, false);
  setLamp(isError ? 'degraded' : 'syncing');
  el.loginHint.textContent = message;
  el.loginHint.dataset.tone = isError ? 'error' : 'info';
}

function showApp(): void {
  show(el.loginView, false);
  show(el.tabs, true);
  setView('jukebox');
  renderPlayback();
  void poll();
}

function bindEvents(): void {
  el.addForm.addEventListener('submit', (e) => void onAddSubmit(e));
  el.addInput.addEventListener('input', syncAddButton);
  el.results.addEventListener('click', (e) => void onResultsClick(e));
  el.queueList.addEventListener('click', (e) => void onQueueClick(e));
  el.pauseBtn.addEventListener('click', () => void onControl('pause'));
  el.skipBtn.addEventListener('click', () => void onControl('skip'));
  el.volumeInput.addEventListener('input', onVolumeInput);
  el.saveQueueBtn.addEventListener('click', () => void onSaveQueue());
  el.tabs.addEventListener('click', (e) => {
    const view = (e.target as HTMLElement).closest<HTMLElement>('[data-view]')?.dataset.view;
    if (view === 'jukebox' || view === 'playlists') setView(view);
  });
  el.newPlaylistBtn.addEventListener('click', async () => {
    const created = await onNewPlaylist();
    if (created) await openPlaylist(created.id);
  });
  el.importForm.addEventListener('submit', (e) => void onImport(e));
  el.playlistList.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-action="playlist-open"]')?.dataset.id;
    if (id) void openPlaylist(id);
  });
  el.playlistDetail.addEventListener('click', (e) => void onDetailClick(e));
  el.playlistDetail.addEventListener('submit', (e) => void onDetailSubmit(e));
  el.pickDialogList.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]')?.dataset.pick;
    const playlist = state.playlists.find((p) => p.id === id);
    if (playlist) void addPickedTrack(playlist);
  });
  el.pickDialogNew.addEventListener('click', async () => {
    el.pickDialog.close();
    const created = await onNewPlaylist();
    if (created) await addPickedTrack(created);
  });
  // A thumbnail that fails to load would leave an empty frame; hide it instead.
  el.nowArt.addEventListener('error', () => { el.nowArt.hidden = true; });
  document.addEventListener('visibilitychange', () => schedulePoll(200));
  window.setInterval(() => {
    if (state.playback?.currentSong && !state.playback.paused) renderProgress();
  }, 1000);
}

async function bootstrap(): Promise<void> {
  const hasAccessToken = initAccessToken();
  const loginToken = popQueryParam('login_token');
  bindEvents();

  const config = await api.config().catch(() => ({} as Awaited<ReturnType<typeof api.config>>));
  state.defaultGuildId = config.defaultGuildId || '';
  if (config.requireAccessToken && !hasAccessToken) {
    showLogin('Pääsytunnus puuttuu. Avaa sivu osoitteella, jossa on ?token=…', true);
    return;
  }
  if (loginToken) {
    try {
      await api.linkLogin(loginToken);
      showApp();
    } catch (error) {
      showLogin(`${errorMessage(error)} Pyydä uusi linkki komennolla /web-login.`, true);
    }
    return;
  }
  if (config.authRequired === false) {
    showApp();
    return;
  }
  try {
    const me = await api.me();
    if (me.email) {
      showApp();
      return;
    }
  } catch {
    // Not signed in yet.
  }
  showLogin('Odotetaan kirjautumislinkkiä.');
}

void bootstrap();
