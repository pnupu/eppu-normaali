(() => {
  // src/web/client/api.ts
  class ApiError extends Error {
    status;
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }
  var accessToken = "";
  function initAccessToken() {
    const fromUrl = popQueryParam("token");
    if (fromUrl)
      window.sessionStorage.setItem("eppu_access_token", fromUrl);
    accessToken = window.sessionStorage.getItem("eppu_access_token") || "";
    return !!accessToken;
  }
  function popQueryParam(key) {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(key);
    if (value !== null) {
      params.delete(key);
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
    return value;
  }
  function headers(extra = {}) {
    return accessToken ? { ...extra, "X-Eppu-Token": accessToken } : extra;
  }
  async function request(path, method = "GET", body) {
    const res = await fetch(path, {
      method,
      headers: headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || data?.error) {
      throw new ApiError(data?.error || `Palvelin vastasi virheellä ${res.status}.`, res.status);
    }
    return data;
  }
  var api = {
    config: () => request("/api/web-config"),
    me: () => request("/api/auth/me"),
    linkLogin: (token) => request("/api/auth/link-login", "POST", { token }),
    async state(etag) {
      const res = await fetch("/api/state", { headers: headers(etag ? { "If-None-Match": etag } : {}) });
      if (res.status === 304)
        return { notModified: true };
      if (!res.ok)
        throw new ApiError(`HTTP ${res.status}`, res.status);
      return { notModified: false, etag: res.headers.get("ETag") || "", state: await res.json() };
    },
    search: (query, source) => request("/api/search", "POST", { query, source, limit: 8 }),
    play: (guildId, payload) => request("/api/play", "POST", { guildId, ...payload }),
    control: (guildId, action) => request(`/api/${action}`, "POST", { guildId }),
    remove: (guildId, index) => request("/api/remove", "POST", { guildId, index }),
    move: (guildId, from, to) => request("/api/move", "POST", { guildId, from, to }),
    volume: (guildId, volume) => request("/api/volume", "POST", { guildId, volume }),
    async playlists() {
      const items = [];
      let cursor = null;
      do {
        const page = await request(`/api/playlists?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return { items };
    },
    async playlist(id) {
      const base = `/api/playlists/${encodeURIComponent(id)}?songLimit=200`;
      const { playlist } = await request(base);
      while (playlist.songNextCursor) {
        const { playlist: page } = await request(`${base}&songCursor=${encodeURIComponent(playlist.songNextCursor)}`);
        playlist.songs.push(...page.songs);
        playlist.songNextCursor = page.songNextCursor;
      }
      return { playlist };
    },
    createPlaylist: (name) => request("/api/playlists", "POST", { name }),
    renamePlaylist: (id, name) => request(`/api/playlists/${encodeURIComponent(id)}`, "PATCH", { name }),
    deletePlaylist: (id) => request(`/api/playlists/${encodeURIComponent(id)}`, "DELETE"),
    importPlaylist: (url) => request("/api/playlists/import", "POST", { url }),
    addToPlaylist: (id, payload) => request(`/api/playlists/${encodeURIComponent(id)}/songs`, "POST", payload),
    removeFromPlaylist: (id, songId) => request(`/api/playlists/${encodeURIComponent(id)}/songs/${encodeURIComponent(songId)}`, "DELETE"),
    moveInPlaylist: (id, fromIndex, toIndex) => request(`/api/playlists/${encodeURIComponent(id)}/songs/move`, "POST", { fromIndex, toIndex }),
    playPlaylist: (id, guildId, shuffle) => request(`/api/playlists/${encodeURIComponent(id)}/play`, "POST", { guildId, shuffle }),
    queueToPlaylist: (guildId, name) => request("/api/playlists/from-queue", "POST", { guildId, name, includeCurrent: true })
  };

  // src/web/client/constants.ts
  var POLL_FAST_MS = 3000;
  var POLL_SLOW_MS = 1e4;
  var TOAST_MS = 4200;
  var TOAST_IMAGES = Object.freeze({
    happy: ["/assets/syrja-happy.jpg", "/assets/syrja-sing.jpg"],
    stern: ["/assets/syrja-normal.jpg", "/assets/syrja-sad.jpg", "/assets/syrja-thinking.avif"],
    neutral: ["/assets/syrja-normal.jpg"]
  });
  var TOAST_LINES = Object.freeze({
    searchError: [
      "Eppu sanoo: tästä hausta ei löytynyt mitään.",
      "Eppu ei vakuuttunut. Kokeile toista hakua.",
      "Eppu tuijotti hakutuloksia, mutta ei saanut mitään."
    ],
    searchSuccess: [
      "Eppu hyväksyy: haku näyttää lupaavalta.",
      "Eppu sanoo, että makusi toimii tänään.",
      "Eppu nyökkää. Hyvä haku."
    ],
    searchEmpty: [
      "Eppu ei löytänyt mitään lisättävää.",
      "Eppu sanoo, että jono kaipaa parempia hakusanoja.",
      "Eppu haluaa tarkemman haun."
    ],
    addSearchError: [
      "Eppu sanoo, että jono hylkäsi kappaleen.",
      "Eppu ei pitänyt tästä lisäysyrityksestä."
    ],
    addSearchOk: [
      "Eppu lisäsi kappaleen varman päälle.",
      "Eppu sanoo: puhdas lisäys, jatka samaan malliin.",
      "Eppu hyväksyy tämän jonopäätöksen."
    ],
    addUrlError: [
      "Eppu sanoo, ettei tämä URL mennyt läpi.",
      "Eppu katsoi linkkiä ja kurtisti kulmiaan."
    ],
    addUrlOk: [
      "Eppu sanoo, että suorat linkit toimivat nyt hyvin.",
      "Eppu tykkää tämän jonon energiasta."
    ],
    pause: [
      "Eppu sanoo: rohkea tauko keskellä fiilistä.",
      "Eppu seuraa tätä dramaattista taukoa."
    ],
    resume: [
      "Eppu sanoo: takaisin asiaan.",
      "Eppu hyväksyy jatkon."
    ],
    skip: [
      "Eppu tiesi ohituksen jo ennen klikkausta.",
      "Eppu sanoo: seuraava biisi, ei armoa."
    ],
    remove: [
      "Eppu sanoo, että yksi kappale poistettiin.",
      "Eppu hyväksyy tämän jonosiivouksen."
    ],
    move: [
      "Eppu sanoo, että jonokoreografia on terävä.",
      "Eppu hyväksyy tämän taktisen siirron."
    ]
  });

  // src/web/client/render.ts
  var SOURCE_LABEL = { youtube: "YouTube", soundcloud: "SoundCloud", spotify: "Spotify" };
  var SOURCE_SHORT = { youtube: "YT", soundcloud: "SC", spotify: "SP" };
  function escapeHtml(value) {
    return (value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }
  function formatClock(seconds) {
    if (!seconds || !Number.isFinite(seconds) || seconds < 0)
      return "";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }
  function summarize(tracks) {
    const count = `${tracks.length} ${tracks.length === 1 ? "kappale" : "kappaletta"}`;
    const seconds = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
    if (!seconds)
      return count;
    const minutes = Math.round(seconds / 60);
    const length = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
    return `${count} · ${length}`;
  }
  function sourceBadge(track) {
    const title = track.source === "spotify" ? "Spotify (soi YouTube-vastineena)" : `Avaa ${SOURCE_LABEL[track.source]}`;
    return `<a class="badge badge-${track.source}" href="${escapeHtml(track.url)}" target="_blank" rel="noreferrer" title="${title}">${SOURCE_SHORT[track.source]}</a>`;
  }
  function stripHtml(track, extraMeta = []) {
    const meta = [sourceBadge(track), ...extraMeta.filter(Boolean).map(escapeHtml)].join('<span aria-hidden="true">·</span>');
    return `<div class="strip"><p class="strip-title">${escapeHtml(track.title)}</p><p class="strip-meta">${meta}</p></div>`;
  }
  function queueHtml(queue) {
    if (!queue.length)
      return '<li class="empty">Jono on tyhjä. Seuraavaksi soi se, minkä lisäät.</li>';
    return queue.map((song, i) => `
    <li class="slot">
      <span class="slot-no">${i + 1}</span>
      ${stripHtml(song, [formatClock(song.duration), song.requestedBy])}
      <div class="slot-actions">
        <button class="icon-btn" type="button" data-action="queue-up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Siirrä ylös: ${escapeHtml(song.title)}">↑</button>
        <button class="icon-btn" type="button" data-action="queue-down" data-index="${i}" ${i === queue.length - 1 ? "disabled" : ""} aria-label="Siirrä alas: ${escapeHtml(song.title)}">↓</button>
        <button class="icon-btn" type="button" data-action="queue-save" data-index="${i}" aria-label="Lisää soittolistaan: ${escapeHtml(song.title)}">+</button>
        <button class="icon-btn btn-danger" type="button" data-action="queue-remove" data-index="${i}" aria-label="Poista jonosta: ${escapeHtml(song.title)}">✕</button>
      </div>
    </li>`).join("");
  }
  function resultsHtml(results, pendingKeys) {
    return results.map((track, i) => {
      const art = track.thumbnail ? `<img class="result-art" src="${escapeHtml(track.thumbnail)}" alt="" loading="lazy" decoding="async">` : '<span class="result-art" aria-hidden="true"></span>';
      const pending = pendingKeys.has(track.key);
      return `
      <li class="result">
        ${art}
        <div class="result-body">
          ${stripHtml(track, [formatClock(track.duration)])}
          <div class="result-actions">
            <button class="btn btn-small btn-amber" type="button" data-action="result-play" data-index="${i}" ${pending ? "disabled" : ""}>${pending ? "Lisätään…" : "Lisää jonoon"}</button>
            <button class="btn btn-small" type="button" data-action="result-save" data-index="${i}">Soittolistaan</button>
          </div>
        </div>
      </li>`;
    }).join("");
  }
  function shelfHtml(playlists, selectedId) {
    if (!playlists.length)
      return '<li class="empty">Ei vielä soittolistoja. Luo uusi tai tuo linkistä.</li>';
    return playlists.map((p) => `
    <li><button class="shelf-item" type="button" data-action="playlist-open" data-id="${escapeHtml(p.id)}" aria-current="${p.id === selectedId}">
      <strong>${escapeHtml(p.name)}</strong><span>${p.songCount} ${p.songCount === 1 ? "kappale" : "kappaletta"}</span>
    </button></li>`).join("");
  }
  function pickListHtml(playlists) {
    if (!playlists.length)
      return '<li class="empty">Ei vielä soittolistoja.</li>';
    return playlists.map((p) => `
    <li><button class="shelf-item" type="button" data-pick="${escapeHtml(p.id)}">
      <strong>${escapeHtml(p.name)}</strong><span>${p.songCount} ${p.songCount === 1 ? "kappale" : "kappaletta"}</span>
    </button></li>`).join("");
  }
  function detailHtml(detail) {
    if (!detail)
      return '<p class="empty">Valitse soittolista tai luo uusi.</p>';
    const songs = detail.songs;
    const rows = songs.length ? songs.map((song, i) => `
      <li class="slot">
        <span class="slot-no">${i + 1}</span>
        ${stripHtml(song, [formatClock(song.duration), song.addedBy])}
        <div class="slot-actions">
          <button class="icon-btn" type="button" data-action="song-queue" data-index="${i}" aria-label="Lisää jonoon: ${escapeHtml(song.title)}">▶</button>
          <button class="icon-btn" type="button" data-action="song-up" data-index="${i}" ${i === 0 ? "disabled" : ""} aria-label="Siirrä ylös: ${escapeHtml(song.title)}">↑</button>
          <button class="icon-btn" type="button" data-action="song-down" data-index="${i}" ${i === songs.length - 1 ? "disabled" : ""} aria-label="Siirrä alas: ${escapeHtml(song.title)}">↓</button>
          <button class="icon-btn btn-danger" type="button" data-action="song-remove" data-index="${i}" aria-label="Poista soittolistalta: ${escapeHtml(song.title)}">✕</button>
        </div>
      </li>`).join("") : '<li class="empty">Soittolista on tyhjä. Lisää kappaleita linkillä tai hakusanalla.</li>';
    return `
    <div class="detail-head">
      <h2>${escapeHtml(detail.name)}</h2>
      <p class="summary">${escapeHtml(summarize(songs))}</p>
      <div class="detail-actions">
        <button class="btn btn-amber" type="button" data-action="playlist-play" ${songs.length ? "" : "disabled"}>Soita</button>
        <button class="btn" type="button" data-action="playlist-shuffle" ${songs.length ? "" : "disabled"}>Soita sekoitettuna</button>
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

  // src/web/client/toasts.ts
  var activeToast = null;
  var activeTimer = 0;
  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }
  function showToast(mood, lines) {
    activeToast?.remove();
    window.clearTimeout(activeTimer);
    const toast = document.createElement("article");
    toast.className = "toast";
    const img = document.createElement("img");
    img.src = randomItem(TOAST_IMAGES[mood] || TOAST_IMAGES.neutral);
    img.alt = "";
    const text = document.createElement("p");
    text.textContent = randomItem(lines);
    toast.append(img, text);
    document.getElementById("toastStack")?.appendChild(toast);
    activeToast = toast;
    activeTimer = window.setTimeout(() => {
      toast.remove();
      if (activeToast === toast)
        activeToast = null;
    }, TOAST_MS);
  }

  // src/web/client/main.ts
  var $ = (id) => document.getElementById(id);
  var el = {
    loginView: $("loginView"),
    loginHint: $("loginHint"),
    tabs: $("viewTabs"),
    lamp: $("lamp"),
    lampText: $("lampText"),
    jukeboxView: $("jukeboxView"),
    playlistsView: $("playlistsView"),
    nowStrip: $("nowStrip"),
    nowArt: $("nowArt"),
    nowTitle: $("nowTitle"),
    nowMeta: $("nowMeta"),
    progressFill: $("progressFill"),
    elapsed: $("elapsed"),
    duration: $("duration"),
    pauseBtn: $("pauseBtn"),
    skipBtn: $("skipBtn"),
    volumeInput: $("volumeInput"),
    volumeOut: $("volumeOut"),
    addForm: $("addForm"),
    addInput: $("addInput"),
    addBtn: $("addBtn"),
    addStatus: $("addStatus"),
    results: $("results"),
    queueSummary: $("queueSummary"),
    queueList: $("queueList"),
    saveQueueBtn: $("saveQueueBtn"),
    newPlaylistBtn: $("newPlaylistBtn"),
    importForm: $("importForm"),
    importInput: $("importInput"),
    shelfStatus: $("shelfStatus"),
    playlistList: $("playlistList"),
    playlistDetail: $("playlistDetail"),
    nameDialog: $("nameDialog"),
    nameDialogTitle: $("nameDialogTitle"),
    nameDialogInput: $("nameDialogInput"),
    nameDialogConfirm: $("nameDialogConfirm"),
    pickDialog: $("pickDialog"),
    pickDialogTrack: $("pickDialogTrack"),
    pickDialogList: $("pickDialogList"),
    pickDialogNew: $("pickDialogNew")
  };
  var state = {
    guildId: null,
    defaultGuildId: "",
    etag: "",
    playback: null,
    positionAt: 0,
    pollTimer: 0,
    failedPolls: 0,
    results: [],
    pendingKeys: new Set,
    playlists: [],
    playlistsLoaded: false,
    selected: null,
    pickTrack: null,
    volumeTimer: 0,
    volumeEditingUntil: 0
  };
  function show(node, visible) {
    node.classList.toggle("hidden", !visible);
  }
  function setStatus(node, text, tone = "info") {
    if (!node)
      return;
    node.textContent = text;
    node.dataset.tone = tone;
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : "Jokin meni pieleen. Yritä uudelleen.";
  }
  function looksLikeLink(value) {
    return /^(https?:\/\/|spotify:)/i.test(value.trim());
  }
  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }
  var running = new Set;
  async function once(key, task) {
    if (running.has(key))
      return;
    running.add(key);
    try {
      await task();
    } finally {
      running.delete(key);
    }
  }
  function askName(title, confirmLabel, initial = "") {
    el.nameDialogTitle.textContent = title;
    el.nameDialogConfirm.textContent = confirmLabel;
    el.nameDialogInput.value = initial;
    el.nameDialog.returnValue = "";
    el.nameDialog.showModal();
    el.nameDialogInput.select();
    return new Promise((resolve) => {
      el.nameDialog.addEventListener("close", () => {
        const name = el.nameDialogInput.value.trim();
        resolve(el.nameDialog.returnValue === "confirm" && name ? name : null);
      }, { once: true });
    });
  }
  function setLamp(kind) {
    const text = { syncing: "Yhdistetään", ready: "Valmis", playing: "Soi", paused: "Tauolla", degraded: "Yhteys pätkii" }[kind];
    el.lamp.dataset.state = kind;
    el.lampText.textContent = text;
  }
  function currentPositionSeconds() {
    const p = state.playback;
    if (!p?.currentSong || p.positionMs === null)
      return 0;
    const drift = p.paused ? 0 : Date.now() - state.positionAt;
    return (p.positionMs + drift) / 1000;
  }
  function renderProgress() {
    const song = state.playback?.currentSong;
    const position = currentPositionSeconds();
    const duration = song?.duration || 0;
    el.elapsed.textContent = song ? formatClock(Math.min(position, duration || position)) || "0:00" : "";
    el.duration.textContent = duration ? formatClock(duration) : "";
    el.progressFill.style.width = duration ? `${Math.min(100, position / duration * 100)}%` : "0%";
  }
  function renderPlayback() {
    const p = state.playback;
    const song = p?.currentSong || null;
    el.nowStrip.classList.toggle("idle", !song);
    if (song) {
      el.nowTitle.textContent = song.title;
      el.nowMeta.innerHTML = [sourceBadge(song), escapeHtml(`Lisäsi ${song.requestedBy}`)].join('<span aria-hidden="true">·</span>');
      if (song.thumbnail)
        el.nowArt.src = song.thumbnail;
      el.nowArt.hidden = !song.thumbnail;
    } else {
      el.nowTitle.textContent = "Mikään ei soi";
      el.nowMeta.textContent = "Lisää kappale alta, niin Eppu aloittaa.";
      el.nowArt.hidden = true;
    }
    el.pauseBtn.disabled = !song;
    el.skipBtn.disabled = !song;
    el.pauseBtn.textContent = p?.paused ? "Jatka" : "Tauko";
    setLamp(song ? p?.paused ? "paused" : "playing" : "ready");
    if (p && Date.now() > state.volumeEditingUntil) {
      el.volumeInput.value = String(p.volume);
      el.volumeOut.textContent = `${p.volume} %`;
    }
    const queue = p?.queue || [];
    el.queueSummary.textContent = queue.length ? summarize(queue) : "";
    el.queueList.innerHTML = queueHtml(queue);
    el.saveQueueBtn.disabled = !song && !queue.length;
    renderProgress();
  }
  function schedulePoll(delay = document.hidden ? POLL_SLOW_MS : POLL_FAST_MS) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = window.setTimeout(() => void poll(), delay);
  }
  async function poll() {
    try {
      const result = await api.state(state.etag);
      state.failedPolls = 0;
      if (result.notModified) {
        const p = state.playback;
        setLamp(p?.currentSong ? p.paused ? "paused" : "playing" : "ready");
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
        showLogin("Istunto vanheni. Kirjoita Discordissa /web-login ja avaa uusi linkki.", true);
        return;
      }
      state.failedPolls += 1;
      if (state.failedPolls >= 2)
        setLamp("degraded");
    }
    schedulePoll();
  }
  function refreshSoon() {
    state.etag = "";
    schedulePoll(150);
  }
  function selectedSearchSource() {
    const checked = document.querySelector('input[name="searchSource"]:checked');
    return checked?.value === "soundcloud" ? "soundcloud" : "youtube";
  }
  function requireGuild(statusNode) {
    if (state.guildId)
      return state.guildId;
    setStatus(statusNode, "Eppu ei löydä Discord-palvelinta. Tarkista botin asetukset.", "error");
    return null;
  }
  function describeEnqueue(added, name, firstTitle, skipped) {
    const skippedNote = skipped ? ` ${plural(skipped, "kappale", "kappaletta")} ei ollut saatavilla.` : "";
    if (name)
      return `Jonoon lisättiin ${plural(added, "kappale", "kappaletta")} listalta ${name}.${skippedNote}`;
    return `Jonoon lisättiin ${firstTitle || "kappale"}.${skippedNote}`;
  }
  async function onAddSubmit(event) {
    event.preventDefault();
    const value = el.addInput.value.trim();
    if (!value)
      return;
    await once("add", async () => {
      el.addBtn.disabled = true;
      try {
        if (looksLikeLink(value)) {
          const guildId = requireGuild(el.addStatus);
          if (!guildId)
            return;
          setStatus(el.addStatus, "Haetaan kappaletta…");
          const res = await api.play(guildId, { input: value });
          setStatus(el.addStatus, describeEnqueue(res.added, res.name, res.firstTitle, res.skipped), "ok");
          showToast("happy", TOAST_LINES.addUrlOk);
          el.addInput.value = "";
          syncAddButton();
          refreshSoon();
          return;
        }
        const source = selectedSearchSource();
        setStatus(el.addStatus, `Haetaan ${source === "soundcloud" ? "SoundCloudista" : "YouTubesta"}…`);
        const { results } = await api.search(value, source);
        state.results = results;
        el.results.innerHTML = resultsHtml(results, state.pendingKeys);
        setStatus(el.addStatus, results.length ? "" : `Haulla "${value}" ei löytynyt mitään.`, results.length ? "info" : "error");
        if (!results.length)
          showToast("stern", TOAST_LINES.searchEmpty);
      } catch (error) {
        setStatus(el.addStatus, errorMessage(error), "error");
        showToast("stern", looksLikeLink(value) ? TOAST_LINES.addUrlError : TOAST_LINES.searchError);
      } finally {
        el.addBtn.disabled = false;
      }
    });
  }
  function syncAddButton() {
    el.addBtn.textContent = looksLikeLink(el.addInput.value) ? "Lisää jonoon" : "Hae";
  }
  async function queueTrack(track, statusNode) {
    const guildId = requireGuild(statusNode);
    if (!guildId)
      return;
    try {
      await api.play(guildId, { track });
      setStatus(statusNode, `Jonoon lisättiin ${track.title}.`, "ok");
      showToast("happy", TOAST_LINES.addSearchOk);
      refreshSoon();
    } catch (error) {
      setStatus(statusNode, errorMessage(error), "error");
      showToast("stern", TOAST_LINES.addSearchError);
    }
  }
  async function onResultsClick(event) {
    const button = event.target.closest("[data-action]");
    const track = button ? state.results[Number(button.dataset.index)] : undefined;
    if (!button || !track)
      return;
    if (button.dataset.action === "result-save") {
      openPickDialog(track);
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
  async function onQueueClick(event) {
    const button = event.target.closest("[data-action]");
    const guildId = state.guildId;
    if (!button || !guildId)
      return;
    const index = Number(button.dataset.index);
    const song = state.playback?.queue[index];
    if (!song)
      return;
    try {
      switch (button.dataset.action) {
        case "queue-up":
          await api.move(guildId, index, index - 1);
          break;
        case "queue-down":
          await api.move(guildId, index, index + 1);
          break;
        case "queue-remove":
          await api.remove(guildId, index);
          showToast("stern", TOAST_LINES.remove);
          break;
        case "queue-save":
          openPickDialog(song);
          return;
      }
      refreshSoon();
    } catch (error) {
      showToast("stern", [errorMessage(error)]);
    }
  }
  async function onControl(action) {
    const guildId = state.guildId;
    if (!guildId)
      return;
    await once(action, async () => {
      try {
        const res = await api.control(guildId, action);
        if (action === "skip")
          showToast("stern", TOAST_LINES.skip);
        else
          showToast(res.paused ? "stern" : "happy", res.paused ? TOAST_LINES.pause : TOAST_LINES.resume);
        refreshSoon();
      } catch (error) {
        showToast("stern", [errorMessage(error)]);
      }
    });
  }
  function onVolumeInput() {
    const volume = Number(el.volumeInput.value);
    el.volumeOut.textContent = `${volume} %`;
    state.volumeEditingUntil = Date.now() + 2000;
    window.clearTimeout(state.volumeTimer);
    state.volumeTimer = window.setTimeout(() => {
      if (state.guildId)
        api.volume(state.guildId, volume).catch(() => setLamp("degraded"));
    }, 120);
  }
  async function onSaveQueue() {
    const guildId = state.guildId;
    if (!guildId)
      return;
    const name = await askName("Tallenna jono soittolistaksi", "Tallenna");
    if (!name)
      return;
    try {
      const res = await api.queueToPlaylist(guildId, name);
      showToast("happy", [`Jono tallennettiin soittolistaksi ${res.playlist.name}.`]);
      state.playlistsLoaded = false;
    } catch (error) {
      showToast("stern", [errorMessage(error)]);
    }
  }
  async function loadPlaylists() {
    try {
      const { items } = await api.playlists();
      state.playlists = items;
      state.playlistsLoaded = true;
      el.playlistList.innerHTML = shelfHtml(items, state.selected?.id ?? null);
    } catch (error) {
      setStatus(el.shelfStatus, errorMessage(error), "error");
    }
  }
  async function openPlaylist(id) {
    try {
      const { playlist } = await api.playlist(id);
      state.selected = playlist;
      el.playlistDetail.innerHTML = detailHtml(playlist);
      el.playlistList.innerHTML = shelfHtml(state.playlists, id);
    } catch (error) {
      setStatus(el.shelfStatus, errorMessage(error), "error");
    }
  }
  async function reloadSelected() {
    if (state.selected)
      await openPlaylist(state.selected.id);
    await loadPlaylists();
  }
  function detailStatus() {
    return el.playlistDetail.querySelector('[data-role="detail-status"]');
  }
  async function onNewPlaylist() {
    const name = await askName("Uusi soittolista", "Luo");
    if (!name)
      return null;
    try {
      const { playlist } = await api.createPlaylist(name);
      await loadPlaylists();
      return playlist;
    } catch (error) {
      setStatus(el.shelfStatus, errorMessage(error), "error");
      showToast("stern", [errorMessage(error)]);
      return null;
    }
  }
  async function onImport(event) {
    event.preventDefault();
    const url = el.importInput.value.trim();
    if (!url)
      return;
    await once("import", async () => {
      setStatus(el.shelfStatus, "Tuodaan… isot listat voivat kestää hetken.");
      try {
        const { playlist, result } = await api.importPlaylist(url);
        const failed = result.failed ? ` ${plural(result.failed, "kappale", "kappaletta")} ei ollut saatavilla.` : "";
        setStatus(el.shelfStatus, `Tuotiin ${plural(result.added, "kappale", "kappaletta")} listaan ${playlist.name}.${failed}`, "ok");
        el.importInput.value = "";
        await loadPlaylists();
        await openPlaylist(playlist.id);
      } catch (error) {
        setStatus(el.shelfStatus, errorMessage(error), "error");
      }
    });
  }
  async function onDetailClick(event) {
    const button = event.target.closest("[data-action]");
    const playlist = state.selected;
    if (!button || !playlist)
      return;
    const index = Number(button.dataset.index);
    const song = playlist.songs[index];
    const status = detailStatus();
    try {
      switch (button.dataset.action) {
        case "playlist-play":
        case "playlist-shuffle": {
          const guildId = requireGuild(status);
          if (!guildId)
            return;
          const shuffle = button.dataset.action === "playlist-shuffle";
          await once("playlist-play", async () => {
            const res = await api.playPlaylist(playlist.id, guildId, shuffle);
            setStatus(status, res.noop ? res.message || "Soittolista on tyhjä." : `Jonoon lisättiin ${plural(res.queued || 0, "kappale", "kappaletta")}.`, "ok");
            showToast("happy", TOAST_LINES.addUrlOk);
            refreshSoon();
          });
          return;
        }
        case "playlist-rename": {
          const name = await askName("Nimeä soittolista uudelleen", "Tallenna", playlist.name);
          if (!name)
            return;
          await api.renamePlaylist(playlist.id, name);
          break;
        }
        case "playlist-delete":
          if (!window.confirm(`Poistetaanko soittolista ${playlist.name}? Tätä ei voi perua.`))
            return;
          await api.deletePlaylist(playlist.id);
          state.selected = null;
          el.playlistDetail.innerHTML = detailHtml(null);
          await loadPlaylists();
          return;
        case "song-queue":
          if (song)
            await queueTrack(song, status);
          return;
        case "song-up":
          await api.moveInPlaylist(playlist.id, index, index - 1);
          break;
        case "song-down":
          await api.moveInPlaylist(playlist.id, index, index + 1);
          break;
        case "song-remove":
          if (song)
            await api.removeFromPlaylist(playlist.id, song.id);
          break;
        default:
          return;
      }
      await reloadSelected();
    } catch (error) {
      setStatus(detailStatus(), errorMessage(error), "error");
    }
  }
  async function onDetailSubmit(event) {
    const form = event.target.closest('[data-form="playlist-add"]');
    if (!form || !state.selected)
      return;
    event.preventDefault();
    const input = form.elements.namedItem("input").value.trim();
    if (!input)
      return;
    const playlistId = state.selected.id;
    await once("playlist-add", async () => {
      setStatus(detailStatus(), "Lisätään…");
      try {
        const { result } = await api.addToPlaylist(playlistId, { input });
        await reloadSelected();
        const dupes = result.skippedDuplicates ? ` Jo listalla: ${result.skippedDuplicates}.` : "";
        setStatus(detailStatus(), `Lisättiin ${plural(result.added, "kappale", "kappaletta")}.${dupes}`, "ok");
      } catch (error) {
        setStatus(detailStatus(), errorMessage(error), "error");
      }
    });
  }
  async function openPickDialog(track) {
    state.pickTrack = track;
    el.pickDialogTrack.textContent = track.title;
    if (!state.playlistsLoaded)
      await loadPlaylists();
    el.pickDialogList.innerHTML = pickListHtml(state.playlists);
    el.pickDialog.showModal();
  }
  async function addPickedTrack(playlist) {
    const track = state.pickTrack;
    if (!track)
      return;
    el.pickDialog.close();
    try {
      const { result } = await api.addToPlaylist(playlist.id, { track });
      showToast("happy", [result.added ? `Lisätty soittolistaan ${playlist.name}.` : `Kappale on jo soittolistalla ${playlist.name}.`]);
      state.playlistsLoaded = false;
      if (state.selected?.id === playlist.id)
        await reloadSelected();
    } catch (error) {
      showToast("stern", [errorMessage(error)]);
    }
  }
  function setView(view) {
    show(el.jukeboxView, view === "jukebox");
    show(el.playlistsView, view === "playlists");
    el.tabs.querySelectorAll("[data-view]").forEach((tab) => {
      tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
    });
    if (view === "playlists" && !state.playlistsLoaded)
      loadPlaylists();
    if (view === "playlists" && !state.selected)
      el.playlistDetail.innerHTML = detailHtml(null);
  }
  function showLogin(message, isError = false) {
    window.clearTimeout(state.pollTimer);
    show(el.loginView, true);
    show(el.jukeboxView, false);
    show(el.playlistsView, false);
    show(el.tabs, false);
    setLamp(isError ? "degraded" : "syncing");
    el.loginHint.textContent = message;
    el.loginHint.dataset.tone = isError ? "error" : "info";
  }
  function showApp() {
    show(el.loginView, false);
    show(el.tabs, true);
    setView("jukebox");
    renderPlayback();
    poll();
  }
  function bindEvents() {
    el.addForm.addEventListener("submit", (e) => void onAddSubmit(e));
    el.addInput.addEventListener("input", syncAddButton);
    el.results.addEventListener("click", (e) => void onResultsClick(e));
    el.queueList.addEventListener("click", (e) => void onQueueClick(e));
    el.pauseBtn.addEventListener("click", () => void onControl("pause"));
    el.skipBtn.addEventListener("click", () => void onControl("skip"));
    el.volumeInput.addEventListener("input", onVolumeInput);
    el.saveQueueBtn.addEventListener("click", () => void onSaveQueue());
    el.tabs.addEventListener("click", (e) => {
      const view = e.target.closest("[data-view]")?.dataset.view;
      if (view === "jukebox" || view === "playlists")
        setView(view);
    });
    el.newPlaylistBtn.addEventListener("click", async () => {
      const created = await onNewPlaylist();
      if (created)
        await openPlaylist(created.id);
    });
    el.importForm.addEventListener("submit", (e) => void onImport(e));
    el.playlistList.addEventListener("click", (e) => {
      const id = e.target.closest('[data-action="playlist-open"]')?.dataset.id;
      if (id)
        openPlaylist(id);
    });
    el.playlistDetail.addEventListener("click", (e) => void onDetailClick(e));
    el.playlistDetail.addEventListener("submit", (e) => void onDetailSubmit(e));
    el.pickDialogList.addEventListener("click", (e) => {
      const id = e.target.closest("[data-pick]")?.dataset.pick;
      const playlist = state.playlists.find((p) => p.id === id);
      if (playlist)
        addPickedTrack(playlist);
    });
    el.pickDialogNew.addEventListener("click", async () => {
      el.pickDialog.close();
      const created = await onNewPlaylist();
      if (created)
        await addPickedTrack(created);
    });
    el.nowArt.addEventListener("error", () => {
      el.nowArt.hidden = true;
    });
    document.addEventListener("visibilitychange", () => schedulePoll(200));
    window.setInterval(() => {
      if (state.playback?.currentSong && !state.playback.paused)
        renderProgress();
    }, 1000);
  }
  async function bootstrap() {
    const hasAccessToken = initAccessToken();
    const loginToken = popQueryParam("login_token");
    bindEvents();
    const config = await api.config().catch(() => ({}));
    state.defaultGuildId = config.defaultGuildId || "";
    if (config.requireAccessToken && !hasAccessToken) {
      showLogin("Pääsytunnus puuttuu. Avaa sivu osoitteella, jossa on ?token=…", true);
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
    } catch {}
    showLogin("Odotetaan kirjautumislinkkiä.");
  }
  bootstrap();
})();
