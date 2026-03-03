(() => {
  // src/web/client/constants.ts
  var POLL_FAST_MS = 3000;
  var POLL_SLOW_MS = 1e4;
  var SEARCH_RESULT_LIMIT = 6;
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
      "Eppu tuijotti YouTubea, mutta ei saanut mitään."
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

  // src/web/client/state.ts
  var appState = {
    currentGuild: null,
    authRequired: true,
    localMode: false,
    exposureMode: "local",
    requireAccessToken: false,
    defaultGuildId: "",
    accessToken: "",
    stateEtag: "",
    latestSearchResults: [],
    pendingSearchAddUrls: new Set,
    pollTimer: null,
    isFetchingState: false,
    dragFromIndex: null,
    hasFetchedStateSuccessfully: false,
    hasActiveSong: false,
    playlistSongDragFromIndex: null,
    playbackState: {},
    playlists: [],
    playlistsNextCursor: null,
    selectedPlaylistId: null,
    selectedPlaylist: null,
    playlistSearchQuery: "",
    playlistSongSearchQuery: "",
    playlistListBusy: false,
    playlistDetailBusy: false,
    playlistLoadMoreBusy: false,
    playlistSongsLoadMoreBusy: false,
    queueSelectModalOpen: false,
    voiceKeywords: [],
    voiceKeywordsNextCursor: null,
    voiceKeywordsBusy: false
  };

  // src/web/client/api.ts
  function authHeaders(base = {}) {
    if (!appState.accessToken)
      return base;
    return { ...base, "X-Eppu-Token": appState.accessToken };
  }
  async function apiFetch(url, options = {}) {
    const headers = authHeaders(options.headers || {});
    return fetch(url, { ...options, headers });
  }
  function popQueryParam(key) {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(key);
    if (value !== null) {
      params.delete(key);
      const query = params.toString();
      const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", nextUrl);
    }
    return value;
  }
  function initAccessTokenFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get("token");
    if (tokenFromUrl) {
      window.sessionStorage.setItem("eppu_access_token", tokenFromUrl);
      params.delete("token");
      const query = params.toString();
      const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", nextUrl);
    }
    appState.accessToken = window.sessionStorage.getItem("eppu_access_token") || "";
  }
  function initDiscordLoginTokenFromUrl() {
    return popQueryParam("login_token");
  }
  async function loadWebConfig() {
    try {
      const res = await apiFetch("/api/web-config");
      if (!res.ok)
        return;
      const config = await res.json();
      appState.authRequired = config.authRequired !== false;
      appState.localMode = !!config.localMode;
      appState.exposureMode = config.exposureMode || "local";
      appState.requireAccessToken = !!config.requireAccessToken;
      appState.defaultGuildId = typeof config.defaultGuildId === "string" ? config.defaultGuildId : "";
    } catch {}
  }
  async function exchangeDiscordLoginToken(loginToken) {
    const res = await apiFetch("/api/auth/link-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: loginToken })
    });
    return res.json();
  }
  async function fetchAuthProfile() {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok)
      return null;
    return res.json();
  }
  async function fetchPlaybackState() {
    try {
      const headers = {};
      if (appState.stateEtag) {
        headers["If-None-Match"] = appState.stateEtag;
      }
      const res = await apiFetch("/api/state", { headers });
      if (res.status === 304) {
        return { kind: "not-modified" };
      }
      if (res.status === 401) {
        return { kind: "unauthorized" };
      }
      if (!res.ok) {
        return { kind: "error" };
      }
      return {
        kind: "ok",
        etag: res.headers.get("ETag") || "",
        state: await res.json()
      };
    } catch {
      return { kind: "error" };
    }
  }
  async function postApi(path, payload) {
    const res = await apiFetch(`/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: appState.currentGuild, ...payload })
    });
    return res.json();
  }
  async function postVoiceCommand(transcript) {
    const res = await apiFetch("/api/voice-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: appState.currentGuild, transcript })
    });
    return res.json();
  }
  async function fetchVoiceKeywords(query, cursor, limit) {
    const params = new URLSearchParams;
    if (query.trim())
      params.set("query", query.trim());
    if (cursor)
      params.set("cursor", cursor);
    params.set("limit", String(limit));
    const res = await apiFetch(`/api/voice-keywords?${params.toString()}`);
    return res.json();
  }
  async function upsertVoiceKeywordApi(phrase, url) {
    const res = await apiFetch("/api/voice-keywords", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase, url })
    });
    return res.json();
  }
  async function deleteVoiceKeywordApi(phrase) {
    const res = await apiFetch(`/api/voice-keywords/${encodeURIComponent(phrase)}`, {
      method: "DELETE"
    });
    return res.json();
  }
  async function searchYouTube(query) {
    const res = await apiFetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: SEARCH_RESULT_LIMIT })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      return { ok: false, error: data.error || "Haku epäonnistui" };
    }
    return {
      ok: true,
      results: Array.isArray(data.results) ? data.results : []
    };
  }
  async function parseApiJson(res) {
    return res.json();
  }
  async function fetchPlaylists(query, cursor, limit) {
    const params = new URLSearchParams;
    if (query.trim())
      params.set("query", query.trim());
    if (cursor)
      params.set("cursor", cursor);
    params.set("limit", String(limit));
    const res = await apiFetch(`/api/playlists?${params.toString()}`);
    return parseApiJson(res);
  }
  async function createPlaylistApi(name) {
    const res = await apiFetch("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    return parseApiJson(res);
  }
  async function renamePlaylistApi(playlistId, name) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    return parseApiJson(res);
  }
  async function deletePlaylistApi(playlistId) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
      method: "DELETE"
    });
    return parseApiJson(res);
  }
  async function fetchPlaylistDetail(playlistId, songQuery, songCursor, songLimit) {
    const params = new URLSearchParams;
    if (songQuery.trim())
      params.set("songQuery", songQuery.trim());
    if (songCursor)
      params.set("songCursor", songCursor);
    params.set("songLimit", String(songLimit));
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}?${params.toString()}`);
    return parseApiJson(res);
  }
  async function addPlaylistSongApi(playlistId, url) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    return parseApiJson(res);
  }
  async function removePlaylistSongApi(playlistId, songId) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs/${encodeURIComponent(songId)}`, {
      method: "DELETE"
    });
    return parseApiJson(res);
  }
  async function movePlaylistSongApi(playlistId, fromIndex, toIndex) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromIndex, toIndex })
    });
    return parseApiJson(res);
  }
  async function playPlaylistApi(playlistId, guildId, shuffle) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, shuffle })
    });
    return parseApiJson(res);
  }
  async function createPlaylistFromQueueApi(guildId, name, includeCurrent, selectedIndices) {
    const res = await apiFetch("/api/playlists/from-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, name, includeCurrent, selectedIndices })
    });
    return parseApiJson(res);
  }
  async function copyQueueToPlaylistApi(playlistId, guildId, includeCurrent, selectedIndices) {
    const res = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/from-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId, includeCurrent, selectedIndices })
    });
    return parseApiJson(res);
  }
  async function importYouTubePlaylistApi(name, url) {
    const res = await apiFetch("/api/playlists/import-youtube", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url })
    });
    return parseApiJson(res);
  }

  // src/web/client/dom.ts
  function byId(id) {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`Missing required element #${id}`);
    }
    return el;
  }
  var dom = {
    mainSection: byId("mainSection"),
    loginSection: byId("loginSection"),
    loginHint: byId("loginHint"),
    addForm: byId("addForm"),
    searchForm: byId("searchForm"),
    searchModal: byId("searchModal"),
    openSearchBtn: byId("openSearchBtn"),
    closeSearchBtn: byId("closeSearchBtn"),
    pauseBtn: byId("pauseBtn"),
    skipBtn: byId("skipBtn"),
    queueList: byId("queueList"),
    addStatus: byId("addStatus"),
    searchStatus: byId("searchStatus"),
    pollStatus: byId("pollStatus"),
    nowPlayingCard: byId("nowPlayingCard"),
    nowPlayingTitle: byId("nowPlayingTitle"),
    nowPlayingMeta: byId("nowPlayingMeta"),
    searchInput: byId("searchInput"),
    searchResults: byId("searchResults"),
    pttBtn: byId("pttBtn"),
    voiceDebugTranscript: byId("voiceDebugTranscript"),
    voiceStatus: byId("voiceStatus"),
    voiceKeywordForm: byId("voiceKeywordForm"),
    voiceKeywordPhraseInput: byId("voiceKeywordPhraseInput"),
    voiceKeywordUrlInput: byId("voiceKeywordUrlInput"),
    voiceKeywordList: byId("voiceKeywordList"),
    voiceKeywordLoadMoreBtn: byId("voiceKeywordLoadMoreBtn"),
    voiceKeywordStatus: byId("voiceKeywordStatus"),
    userInfo: byId("userInfo"),
    toastStack: byId("toastStack"),
    urlInput: byId("urlInput"),
    playlistList: byId("playlistList"),
    playlistLoadMoreBtn: byId("playlistLoadMoreBtn"),
    playlistSearchInput: byId("playlistSearchInput"),
    createPlaylistBtn: byId("createPlaylistBtn"),
    playlistTitle: byId("playlistTitle"),
    renamePlaylistBtn: byId("renamePlaylistBtn"),
    deletePlaylistBtn: byId("deletePlaylistBtn"),
    playPlaylistBtn: byId("playPlaylistBtn"),
    playPlaylistShuffleBtn: byId("playPlaylistShuffleBtn"),
    playlistSongForm: byId("playlistSongForm"),
    playlistSongUrlInput: byId("playlistSongUrlInput"),
    playlistSongList: byId("playlistSongList"),
    playlistSongSearchInput: byId("playlistSongSearchInput"),
    playlistSongsLoadMoreBtn: byId("playlistSongsLoadMoreBtn"),
    playlistStatus: byId("playlistStatus"),
    saveQueueToPlaylistBtn: byId("saveQueueToPlaylistBtn"),
    saveSelectedQueueBtn: byId("saveSelectedQueueBtn"),
    createPlaylistFromQueueBtn: byId("createPlaylistFromQueueBtn"),
    playlistImportForm: byId("playlistImportForm"),
    playlistImportNameInput: byId("playlistImportNameInput"),
    playlistImportUrlInput: byId("playlistImportUrlInput"),
    queueSelectModal: byId("queueSelectModal"),
    closeQueueSelectBtn: byId("closeQueueSelectBtn"),
    queueSelectList: byId("queueSelectList"),
    queueSelectStatus: byId("queueSelectStatus"),
    queueSelectConfirmBtn: byId("queueSelectConfirmBtn")
  };
  function setVisible(el, visible) {
    el.classList.toggle("hidden", !visible);
  }
  function escapeHtml(value) {
    const tmp = document.createElement("div");
    tmp.textContent = value || "";
    return tmp.innerHTML;
  }
  function setStatus(el, text, tone = "info") {
    const color = tone === "error" ? "#ff7a9b" : tone === "ok" ? "#83f8b8" : "#45d0ff";
    el.textContent = text;
    el.style.color = color;
    setVisible(el, true);
    window.setTimeout(() => setVisible(el, false), 2200);
  }
  function setLoginHint(text, isError = false) {
    dom.loginHint.textContent = text;
    dom.loginHint.style.color = isError ? "#ff7a9b" : "";
  }

  // src/web/client/toasts.ts
  var activeToast = null;
  var activeToastTimer = null;
  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }
  function showToast(mood, lines) {
    if (activeToast) {
      activeToast.remove();
      activeToast = null;
    }
    if (activeToastTimer) {
      window.clearTimeout(activeToastTimer);
      activeToastTimer = null;
    }
    const toast = document.createElement("article");
    const imagePool = TOAST_IMAGES[mood] || TOAST_IMAGES.neutral;
    const image = randomItem(imagePool);
    const text = randomItem(lines);
    toast.className = "toast";
    toast.innerHTML = `
    <img src="${image}" alt="Epun reaktio">
    <p>${escapeHtml(text)}</p>
  `;
    activeToast = toast;
    dom.toastStack.appendChild(toast);
    activeToastTimer = window.setTimeout(() => {
      toast.remove();
      if (activeToast === toast) {
        activeToast = null;
      }
      activeToastTimer = null;
    }, TOAST_MS);
  }

  // src/web/client/ui.ts
  function enableLowPowerModeIfNeeded() {
    const cores = navigator.hardwareConcurrency || 0;
    const memory = navigator.deviceMemory || 0;
    if (cores > 0 && cores <= 4 || memory > 0 && memory <= 2) {
      document.documentElement.classList.add("low-power");
    }
  }
  function openSearchModal() {
    setVisible(dom.searchModal, true);
    document.body.classList.add("modal-open");
    window.setTimeout(() => dom.searchInput.focus(), 50);
  }
  function closeSearchModal() {
    setVisible(dom.searchModal, false);
    document.body.classList.remove("modal-open");
  }
  function setPollBadge(state) {
    dom.pollStatus.classList.remove("pill-ready", "pill-live", "pill-degraded");
    switch (state) {
      case "syncing":
        dom.pollStatus.textContent = "Synkronoidaan";
        return;
      case "ready":
        dom.pollStatus.textContent = "Valmis";
        dom.pollStatus.classList.add("pill-ready");
        return;
      case "live":
        dom.pollStatus.textContent = "Toistetaan";
        dom.pollStatus.classList.add("pill-live");
        return;
      case "degraded":
        dom.pollStatus.textContent = "Yhteys pätkii";
        dom.pollStatus.classList.add("pill-degraded");
        return;
    }
  }
  function setPlaybackControlsEnabled(enabled) {
    dom.pauseBtn.disabled = !enabled;
    dom.skipBtn.disabled = !enabled;
  }
  function renderNowPlaying(guildState) {
    if (!guildState?.currentSong) {
      dom.nowPlayingCard.classList.add("now-idle");
      dom.nowPlayingTitle.textContent = "Ei toistoa juuri nyt";
      dom.nowPlayingMeta.textContent = "Avaa YouTube-haku tai liitä URL, niin Eppu aloittaa musiikin.";
      appState.hasActiveSong = false;
      setPlaybackControlsEnabled(false);
      return;
    }
    dom.nowPlayingCard.classList.remove("now-idle");
    dom.nowPlayingTitle.textContent = guildState.currentSong.title;
    dom.nowPlayingMeta.innerHTML = `Lisäsi ${escapeHtml(guildState.currentSong.requestedBy)}${guildState.paused ? " (tauolla)" : ""}`;
    appState.hasActiveSong = true;
    setPlaybackControlsEnabled(true);
  }
  function queueItemTemplate(item, index) {
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
  function renderQueue(queue) {
    if (!queue.length) {
      dom.queueList.innerHTML = '<p class="empty">Jono odottaa seuraavaa mestariteosta.</p>';
      return;
    }
    dom.queueList.innerHTML = queue.map(queueItemTemplate).join("");
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || (seconds || 0) <= 0)
      return null;
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }
  function searchItemTemplate(item, index) {
    const duration = formatDuration(item.duration);
    const meta = [item.channel, duration].filter(Boolean).join(" • ");
    const isPending = !!item.url && appState.pendingSearchAddUrls.has(item.url);
    const buttonLabel = isPending ? "Lisätään..." : "Lisää";
    const thumbnail = item.thumbnail ? `<img class="search-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" decoding="async">` : '<div class="search-thumb search-thumb-fallback" aria-hidden="true">▶</div>';
    return `
    <div class="search-item">
      <div class="search-thumb-wrap">
        ${thumbnail}
      </div>
      <div class="search-main">
        <div class="search-top">
          <div>
            <div class="search-title">${escapeHtml(item.title)}</div>
            ${meta ? `<div class="search-meta">${escapeHtml(meta)}</div>` : ""}
          </div>
          <button class="btn btn-secondary" type="button" data-search-add="${index}" ${isPending ? "disabled" : ""}>${buttonLabel}</button>
        </div>
      </div>
    </div>
  `;
  }
  function renderSearchResults(results) {
    if (!results.length) {
      dom.searchResults.innerHTML = '<div class="search-empty">Ei hakutuloksia.</div>';
      return;
    }
    dom.searchResults.innerHTML = results.map(searchItemTemplate).join("");
  }
  function pickActiveGuild(state) {
    const guildIds = Object.keys(state);
    if (!guildIds.length) {
      appState.currentGuild = null;
      renderNowPlaying(null);
      renderQueue([]);
      return null;
    }
    if (!appState.currentGuild || !guildIds.includes(appState.currentGuild)) {
      appState.currentGuild = appState.defaultGuildId && guildIds.includes(appState.defaultGuildId) ? appState.defaultGuildId : guildIds[0];
    }
    return state[appState.currentGuild] || null;
  }
  function renderPlaybackState(state) {
    const guildState = pickActiveGuild(state);
    renderNowPlaying(guildState);
    renderQueue(guildState?.queue || []);
  }
  function playlistItemTemplate(item, active) {
    return `
    <button class="playlist-item ${active ? "active" : ""}" type="button" data-playlist-id="${escapeHtml(item.id)}">
      <div class="playlist-item-title">${escapeHtml(item.name)}</div>
      <div class="playlist-item-meta">${item.songCount} kappaletta</div>
    </button>
  `;
  }
  function renderPlaylistList(playlists, selectedId, showLoadMore) {
    if (!playlists.length) {
      dom.playlistList.innerHTML = '<p class="playlist-empty">Ei soittolistoja vielä.</p>';
    } else {
      dom.playlistList.innerHTML = playlists.map((item) => playlistItemTemplate(item, selectedId === item.id)).join("");
    }
    setVisible(dom.playlistLoadMoreBtn, showLoadMore);
  }
  function playlistSongTemplate(song) {
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
  function renderPlaylistDetail(detail, showSongsLoadMore) {
    if (!detail) {
      dom.playlistTitle.textContent = "Valitse soittolista";
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
      dom.playlistSongList.innerHTML = detail.songs.map((song) => playlistSongTemplate(song)).join("");
    }
    setVisible(dom.playlistSongsLoadMoreBtn, showSongsLoadMore);
  }
  function renderQueueSelectionList(items) {
    if (!items.length) {
      dom.queueSelectList.innerHTML = '<p class="playlist-empty">Jonossa ei ole valittavia kappaleita.</p>';
      return;
    }
    dom.queueSelectList.innerHTML = items.map((item) => `
      <div class="queue-select-item">
        <label>
          <input type="checkbox" data-queue-select="${escapeHtml(item.key)}" ${item.checked ? "checked" : ""}>
          <span>
            <strong>${escapeHtml(item.title)}</strong>
            <span class="meta">${escapeHtml(item.meta)}</span>
          </span>
        </label>
      </div>
    `).join("");
  }
  function voiceKeywordItemTemplate(item) {
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
  function renderVoiceKeywordList(items, showLoadMore) {
    if (!items.length) {
      dom.voiceKeywordList.innerHTML = '<p class="playlist-empty">Ei avainsanoja vielä.</p>';
    } else {
      dom.voiceKeywordList.innerHTML = items.map((item) => voiceKeywordItemTemplate(item)).join("");
    }
    setVisible(dom.voiceKeywordLoadMoreBtn, showLoadMore);
  }

  // src/web/client/main.ts
  var PLAYLIST_LIST_LIMIT = 20;
  var PLAYLIST_SONG_LIMIT = 80;
  var VOICE_KEYWORD_LIMIT = 30;
  var playlistSearchDebounce = null;
  var playlistSongSearchDebounce = null;
  var queueSelectionKeys = new Set;
  var pttListening = false;
  var pttTranscript = "";
  var pttRecognition = null;
  function currentPollInterval() {
    return document.hidden ? POLL_SLOW_MS : POLL_FAST_MS;
  }
  function schedulePoll(delay = currentPollInterval()) {
    if (appState.pollTimer) {
      window.clearTimeout(appState.pollTimer);
    }
    appState.pollTimer = window.setTimeout(() => {
      fetchState();
    }, delay);
  }
  function authFailureFallback() {
    if (!appState.authRequired)
      return;
    window.location.reload();
  }
  function currentGuildState() {
    if (!appState.currentGuild)
      return null;
    return appState.playbackState[appState.currentGuild] || null;
  }
  function renderPlaylistPanels() {
    renderPlaylistList(appState.playlists, appState.selectedPlaylistId, !!appState.playlistsNextCursor);
    renderPlaylistDetail(appState.selectedPlaylist, !!appState.selectedPlaylist?.songNextCursor);
  }
  function selectedPlaylistSummary() {
    if (!appState.selectedPlaylistId)
      return null;
    return appState.playlists.find((item) => item.id === appState.selectedPlaylistId) || null;
  }
  function upsertPlaylistSummary(item) {
    const index = appState.playlists.findIndex((playlist) => playlist.id === item.id);
    if (index >= 0) {
      appState.playlists[index] = item;
    } else {
      appState.playlists.unshift(item);
    }
  }
  function removePlaylistSummary(playlistId) {
    appState.playlists = appState.playlists.filter((item) => item.id !== playlistId);
  }
  async function fetchState() {
    if (appState.isFetchingState) {
      schedulePoll();
      return;
    }
    appState.isFetchingState = true;
    if (!appState.hasFetchedStateSuccessfully) {
      setPollBadge("syncing");
    }
    try {
      const result = await fetchPlaybackState();
      if (result.kind === "not-modified") {
        setPollBadge(appState.hasActiveSong ? "live" : "ready");
        return;
      }
      if (result.kind === "unauthorized") {
        authFailureFallback();
        return;
      }
      if (result.kind === "error") {
        setPollBadge(appState.hasFetchedStateSuccessfully ? "degraded" : "ready");
        return;
      }
      appState.hasFetchedStateSuccessfully = true;
      appState.stateEtag = result.etag || "";
      appState.playbackState = result.state || {};
      renderPlaybackState(appState.playbackState);
      setPollBadge(appState.hasActiveSong ? "live" : "ready");
      if (appState.queueSelectModalOpen) {
        renderQueueSelectionModal();
      }
    } finally {
      appState.isFetchingState = false;
      schedulePoll();
    }
  }
  async function fetchMe() {
    if (!appState.authRequired) {
      dom.userInfo.textContent = "Paikallinen tila";
      return;
    }
    try {
      const profile = await fetchAuthProfile();
      if (!profile?.email)
        return;
      dom.userInfo.textContent = `${profile.name || "Käyttäjä"} (${profile.email})`;
    } catch {}
  }
  function showMain() {
    setVisible(dom.loginSection, false);
    setVisible(dom.mainSection, true);
    renderPlaybackState({});
    renderPlaylistPanels();
    setPollBadge("ready");
    fetchMe();
    fetchState();
    refreshPlaylists(true);
    refreshVoiceKeywords(true);
  }
  function requireGuildBeforeQueue(statusEl) {
    if (appState.currentGuild)
      return true;
    setStatus(statusEl, "Palvelinta ei löytynyt. Tarkista botin guild-asetus.", "error");
    showToast("stern", ["Eppu ei löydä kohdepalvelinta juuri nyt."]);
    return false;
  }
  function requireSelectedPlaylist() {
    if (!appState.selectedPlaylistId) {
      setStatus(dom.playlistStatus, "Valitse ensin soittolista.", "error");
      return null;
    }
    return appState.selectedPlaylistId;
  }
  function setPttButtonState(listening) {
    dom.pttBtn.classList.toggle("ptt-active", listening);
    dom.pttBtn.textContent = listening ? "Kuuntelen... päästä irti lopettaaksesi" : "Pidä pohjassa ja puhu";
  }
  function voiceRecognitionCtor() {
    const maybeWindow = window;
    return maybeWindow.SpeechRecognition || maybeWindow.webkitSpeechRecognition || null;
  }
  function buildVoiceRecognition() {
    const Ctor = voiceRecognitionCtor();
    if (!Ctor)
      return null;
    const recognition = new Ctor;
    recognition.lang = "fi-FI";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const chunks = [];
      for (let i = 0;i < event.results.length; i += 1) {
        const part = event.results[i]?.[0]?.transcript || "";
        if (part.trim())
          chunks.push(part.trim());
      }
      pttTranscript = chunks.join(" ").trim();
      dom.voiceDebugTranscript.textContent = `Viimeisin puhe: ${pttTranscript || "-"}`;
    };
    recognition.onerror = (event) => {
      if (event.error && event.error !== "no-speech" && event.error !== "aborted") {
        setStatus(dom.voiceStatus, `Äänentunnistusvirhe: ${event.error}`, "error");
      }
    };
    recognition.onend = () => {
      const transcript = pttTranscript.trim();
      pttListening = false;
      setPttButtonState(false);
      pttRecognition = null;
      if (!transcript) {
        setStatus(dom.voiceStatus, "Puhetta ei tunnistettu.", "error");
        return;
      }
      submitVoiceCommand(transcript);
    };
    return recognition;
  }
  async function submitVoiceCommand(transcript) {
    if (!requireGuildBeforeQueue(dom.voiceStatus))
      return;
    setStatus(dom.voiceStatus, "Suoritetaan äänikomentoa...");
    const result = await postVoiceCommand(transcript);
    if (result.error) {
      setStatus(dom.voiceStatus, result.message || result.error, "error");
      showToast("stern", [result.message || result.error]);
      return;
    }
    setStatus(dom.voiceStatus, result.message || "Äänikomento suoritettu", "ok");
    showToast("happy", [result.message || "Äänikomento valmis"]);
    appState.stateEtag = "";
    fetchState();
  }
  function startPttCapture() {
    if (pttListening)
      return;
    if (!requireGuildBeforeQueue(dom.voiceStatus))
      return;
    pttTranscript = "";
    dom.voiceDebugTranscript.textContent = "Viimeisin puhe: ...";
    const recognition = buildVoiceRecognition();
    if (!recognition) {
      setStatus(dom.voiceStatus, "Selain ei tue äänentunnistusta tässä näkymässä.", "error");
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
      setStatus(dom.voiceStatus, "Äänentunnistus ei käynnistynyt.", "error");
    }
  }
  function stopPttCapture() {
    if (!pttListening || !pttRecognition)
      return;
    try {
      pttRecognition.stop();
    } catch {
      pttListening = false;
      setPttButtonState(false);
      pttRecognition = null;
    }
  }
  async function refreshVoiceKeywords(reset) {
    if (appState.voiceKeywordsBusy)
      return;
    appState.voiceKeywordsBusy = true;
    try {
      const cursor = reset ? null : appState.voiceKeywordsNextCursor;
      if (!reset && !cursor)
        return;
      const result = await fetchVoiceKeywords("", cursor, VOICE_KEYWORD_LIMIT);
      if (result.error) {
        setStatus(dom.voiceKeywordStatus, result.error, "error");
        return;
      }
      const items = Array.isArray(result.items) ? result.items : [];
      if (reset) {
        appState.voiceKeywords = items;
      } else {
        const merged = [...appState.voiceKeywords];
        for (const item of items) {
          const index = merged.findIndex((row) => row.phrase === item.phrase);
          if (index >= 0)
            merged[index] = item;
          else
            merged.push(item);
        }
        appState.voiceKeywords = merged;
      }
      appState.voiceKeywordsNextCursor = result.nextCursor || null;
      renderVoiceKeywordList(appState.voiceKeywords, !!appState.voiceKeywordsNextCursor);
    } finally {
      appState.voiceKeywordsBusy = false;
    }
  }
  async function onSaveVoiceKeyword(event) {
    event.preventDefault();
    const phrase = dom.voiceKeywordPhraseInput.value.trim();
    const url = dom.voiceKeywordUrlInput.value.trim();
    if (!phrase) {
      setStatus(dom.voiceKeywordStatus, "Anna avainsana.", "error");
      return;
    }
    if (!url) {
      setStatus(dom.voiceKeywordStatus, "Anna YouTube-linkki.", "error");
      return;
    }
    const result = await upsertVoiceKeywordApi(phrase, url);
    if (result.error) {
      setStatus(dom.voiceKeywordStatus, result.error, "error");
      return;
    }
    dom.voiceKeywordPhraseInput.value = "";
    dom.voiceKeywordUrlInput.value = "";
    setStatus(dom.voiceKeywordStatus, "Avainsana tallennettu.", "ok");
    showToast("happy", ["Eppu oppi uuden avainsanan."]);
    await refreshVoiceKeywords(true);
  }
  function fillVoiceKeywordForEdit(phrase) {
    const keyword = appState.voiceKeywords.find((item) => item.phrase === phrase);
    if (!keyword)
      return;
    dom.voiceKeywordPhraseInput.value = keyword.phrase;
    dom.voiceKeywordUrlInput.value = keyword.url;
    dom.voiceKeywordPhraseInput.focus();
  }
  async function onDeleteVoiceKeyword(phrase) {
    const result = await deleteVoiceKeywordApi(phrase);
    if (result.error) {
      setStatus(dom.voiceKeywordStatus, result.error, "error");
      return;
    }
    appState.voiceKeywords = appState.voiceKeywords.filter((item) => item.phrase !== phrase);
    renderVoiceKeywordList(appState.voiceKeywords, !!appState.voiceKeywordsNextCursor);
    setStatus(dom.voiceKeywordStatus, "Avainsana poistettu.", "ok");
    showToast("stern", ["Eppu unohti avainsanan."]);
    if (appState.voiceKeywords.length === 0) {
      await refreshVoiceKeywords(true);
    }
  }
  async function refreshPlaylists(reset) {
    if (appState.playlistListBusy)
      return;
    appState.playlistListBusy = true;
    try {
      const cursor = reset ? null : appState.playlistsNextCursor;
      if (!reset && !cursor)
        return;
      const result = await fetchPlaylists(appState.playlistSearchQuery, cursor, PLAYLIST_LIST_LIMIT);
      if (result.error) {
        setStatus(dom.playlistStatus, result.error, "error");
        return;
      }
      const received = Array.isArray(result.items) ? result.items : [];
      if (reset) {
        appState.playlists = received;
      } else {
        const next = [...appState.playlists];
        for (const item of received) {
          const idx = next.findIndex((row) => row.id === item.id);
          if (idx >= 0)
            next[idx] = item;
          else
            next.push(item);
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
  async function refreshSelectedPlaylist(append = false) {
    const playlistId = appState.selectedPlaylistId;
    if (!playlistId) {
      appState.selectedPlaylist = null;
      renderPlaylistPanels();
      return;
    }
    if (appState.playlistDetailBusy)
      return;
    appState.playlistDetailBusy = true;
    try {
      const cursor = append ? appState.selectedPlaylist?.songNextCursor || null : null;
      if (append && !cursor)
        return;
      const response = await fetchPlaylistDetail(playlistId, appState.playlistSongSearchQuery, cursor, PLAYLIST_SONG_LIMIT);
      if (response.error || !response.playlist) {
        setStatus(dom.playlistStatus, response.error || "Soittolistan lataus epäonnistui", "error");
        return;
      }
      const playlist = response.playlist;
      if (append && appState.selectedPlaylist && appState.selectedPlaylist.id === playlist.id) {
        const merged = {
          ...playlist,
          songs: [...appState.selectedPlaylist.songs, ...playlist.songs]
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
        songCount: playlist.songCount
      });
      renderPlaylistPanels();
    } finally {
      appState.playlistDetailBusy = false;
    }
  }
  async function selectPlaylist(playlistId) {
    if (appState.selectedPlaylistId === playlistId && appState.selectedPlaylist)
      return;
    appState.selectedPlaylistId = playlistId;
    appState.selectedPlaylist = null;
    appState.playlistSongSearchQuery = "";
    dom.playlistSongSearchInput.value = "";
    renderPlaylistPanels();
    await refreshSelectedPlaylist(false);
  }
  async function onSearchSubmit(event) {
    event.preventDefault();
    const query = dom.searchInput.value.trim();
    if (!query)
      return;
    setStatus(dom.searchStatus, "Haetaan...");
    const result = await searchYouTube(query);
    if (!result.ok) {
      appState.latestSearchResults = [];
      renderSearchResults([]);
      setStatus(dom.searchStatus, result.error || "Haku epäonnistui", "error");
      showToast("stern", TOAST_LINES.searchError);
      return;
    }
    appState.latestSearchResults = result.results || [];
    renderSearchResults(appState.latestSearchResults);
    setStatus(dom.searchStatus, `Löytyi ${appState.latestSearchResults.length} tulosta`, "ok");
    if (appState.latestSearchResults.length > 0) {
      showToast("happy", TOAST_LINES.searchSuccess);
    } else {
      showToast("stern", TOAST_LINES.searchEmpty);
    }
  }
  async function onAddSearchResult(index) {
    const item = appState.latestSearchResults[index];
    if (!item?.url)
      return;
    const url = item.url;
    if (appState.pendingSearchAddUrls.has(url))
      return;
    if (!requireGuildBeforeQueue(dom.searchStatus))
      return;
    appState.pendingSearchAddUrls.add(url);
    renderSearchResults(appState.latestSearchResults);
    try {
      const result = await postApi("play", { url });
      if (result.error) {
        setStatus(dom.searchStatus, result.error, "error");
        showToast("stern", TOAST_LINES.addSearchError);
        return;
      }
      setStatus(dom.searchStatus, `Lisätty: ${item.title}`, "ok");
      showToast("happy", TOAST_LINES.addSearchOk);
      closeSearchModal();
      appState.stateEtag = "";
      fetchState();
    } finally {
      appState.pendingSearchAddUrls.delete(url);
      renderSearchResults(appState.latestSearchResults);
    }
  }
  async function onAddUrlSubmit(event) {
    event.preventDefault();
    const url = dom.urlInput.value.trim();
    if (!url)
      return;
    if (!requireGuildBeforeQueue(dom.addStatus))
      return;
    setStatus(dom.addStatus, "Lisätään...");
    const result = await postApi("play", { url });
    if (result.error) {
      setStatus(dom.addStatus, result.error, "error");
      showToast("stern", TOAST_LINES.addUrlError);
      return;
    }
    dom.urlInput.value = "";
    setStatus(dom.addStatus, "Lisätty jonoon", "ok");
    showToast("happy", TOAST_LINES.addUrlOk);
    appState.stateEtag = "";
    fetchState();
  }
  async function onTogglePause() {
    if (!appState.currentGuild)
      return;
    const result = await postApi("pause", {});
    showToast(result.paused ? "stern" : "happy", result.paused ? TOAST_LINES.pause : TOAST_LINES.resume);
    appState.stateEtag = "";
    fetchState();
  }
  async function onSkip() {
    if (!appState.currentGuild)
      return;
    await postApi("skip", {});
    showToast("stern", TOAST_LINES.skip);
    appState.stateEtag = "";
    fetchState();
  }
  async function onRemoveQueueItem(index) {
    if (!appState.currentGuild)
      return;
    await postApi("remove", { index });
    showToast("stern", TOAST_LINES.remove);
    appState.stateEtag = "";
    fetchState();
  }
  async function onMoveQueueItem(from, to) {
    if (!appState.currentGuild || from === to)
      return;
    await postApi("move", { from, to });
    showToast("happy", TOAST_LINES.move);
    appState.stateEtag = "";
    fetchState();
  }
  async function onCreatePlaylist() {
    const name = window.prompt("Anna uuden soittolistan nimi:")?.trim();
    if (!name)
      return;
    const result = await createPlaylistApi(name);
    if (result.error || !result.playlist) {
      setStatus(dom.playlistStatus, result.error || "Soittolistan luonti epäonnistui", "error");
      return;
    }
    setStatus(dom.playlistStatus, `Luotu: ${result.playlist.name}`, "ok");
    await refreshPlaylists(true);
    if (result.playlist?.id) {
      await selectPlaylist(result.playlist.id);
    }
  }
  async function onRenamePlaylist() {
    const playlist = selectedPlaylistSummary();
    if (!playlist) {
      setStatus(dom.playlistStatus, "Valitse ensin soittolista.", "error");
      return;
    }
    const name = window.prompt("Uusi nimi soittolistalle:", playlist.name)?.trim();
    if (!name)
      return;
    const result = await renamePlaylistApi(playlist.id, name);
    if (result.error || !result.playlist) {
      setStatus(dom.playlistStatus, result.error || "Nimen vaihto epäonnistui", "error");
      return;
    }
    setStatus(dom.playlistStatus, "Soittolista nimettiin uudelleen", "ok");
    await refreshPlaylists(true);
    await selectPlaylist(playlist.id);
  }
  async function onDeletePlaylist() {
    const playlist = selectedPlaylistSummary();
    if (!playlist) {
      setStatus(dom.playlistStatus, "Valitse ensin soittolista.", "error");
      return;
    }
    const confirmed = window.confirm(`Poistetaanko soittolista "${playlist.name}"?`);
    if (!confirmed)
      return;
    const result = await deletePlaylistApi(playlist.id);
    if (result.error) {
      setStatus(dom.playlistStatus, result.error, "error");
      return;
    }
    setStatus(dom.playlistStatus, "Soittolista poistettu", "ok");
    if (appState.selectedPlaylistId === playlist.id) {
      appState.selectedPlaylistId = null;
      appState.selectedPlaylist = null;
    }
    removePlaylistSummary(playlist.id);
    renderPlaylistPanels();
    await refreshPlaylists(true);
  }
  async function onAddSongToPlaylist(event) {
    event.preventDefault();
    const playlistId = requireSelectedPlaylist();
    if (!playlistId)
      return;
    const url = dom.playlistSongUrlInput.value.trim();
    if (!url)
      return;
    const result = await addPlaylistSongApi(playlistId, url);
    if (result.error) {
      setStatus(dom.playlistStatus, result.error, "error");
      return;
    }
    dom.playlistSongUrlInput.value = "";
    setStatus(dom.playlistStatus, "Kappale lisätty soittolistaan", "ok");
    await refreshSelectedPlaylist(false);
  }
  async function onImportYouTubePlaylist(event) {
    event.preventDefault();
    const url = dom.playlistImportUrlInput.value.trim();
    if (!url) {
      setStatus(dom.playlistStatus, "YouTube-soittolistan URL puuttuu", "error");
      return;
    }
    const name = dom.playlistImportNameInput.value.trim();
    setStatus(dom.playlistStatus, "Tuodaan YouTube-soittolistaa...");
    const result = await importYouTubePlaylistApi(name, url);
    if (result.error || !result.playlist) {
      setStatus(dom.playlistStatus, result.error || "Tuonti epäonnistui", "error");
      return;
    }
    dom.playlistImportUrlInput.value = "";
    dom.playlistImportNameInput.value = "";
    setStatus(dom.playlistStatus, `Tuotu: ${result.playlist.name}`, "ok");
    await refreshPlaylists(true);
    await selectPlaylist(result.playlist.id);
  }
  async function onPlayPlaylist(shuffle) {
    const playlistId = requireSelectedPlaylist();
    if (!playlistId)
      return;
    if (!appState.currentGuild) {
      setStatus(dom.playlistStatus, "Valitse palvelin ennen jonotusta.", "error");
      return;
    }
    const result = await playPlaylistApi(playlistId, appState.currentGuild, shuffle);
    if (result.error) {
      setStatus(dom.playlistStatus, result.error, "error");
      return;
    }
    if (result.noop) {
      setStatus(dom.playlistStatus, result.message || "Soittolista oli tyhjä", "info");
      return;
    }
    setStatus(dom.playlistStatus, `Jonoon lisätty ${result.queued || 0} kappaletta`, "ok");
    appState.stateEtag = "";
    fetchState();
  }
  async function onSaveWholeQueueToPlaylist() {
    const playlistId = requireSelectedPlaylist();
    if (!playlistId)
      return;
    if (!appState.currentGuild) {
      setStatus(dom.playlistStatus, "Valitse palvelin ennen tallennusta.", "error");
      return;
    }
    const result = await copyQueueToPlaylistApi(playlistId, appState.currentGuild, true);
    if (result.error || !result.result) {
      setStatus(dom.playlistStatus, result.error || "Jonon tallennus epäonnistui", "error");
      return;
    }
    setStatus(dom.playlistStatus, `Tallennettu: +${result.result.added}, duplikaatit ${result.result.skippedDuplicates}, virheet ${result.result.failed}`, "ok");
    await refreshSelectedPlaylist(false);
    await refreshPlaylists(true);
  }
  async function onCreatePlaylistFromQueue() {
    if (!appState.currentGuild) {
      setStatus(dom.playlistStatus, "Valitse palvelin ennen tallennusta.", "error");
      return;
    }
    const name = window.prompt("Anna nimi uudelle soittolistalle (jonosta):")?.trim();
    if (!name)
      return;
    const result = await createPlaylistFromQueueApi(appState.currentGuild, name, true);
    if (result.error || !result.playlist) {
      setStatus(dom.playlistStatus, result.error || "Soittolistan luonti jonosta epäonnistui", "error");
      return;
    }
    setStatus(dom.playlistStatus, `Soittolista luotu jonosta: +${result.result?.added || 0}`, "ok");
    await refreshPlaylists(true);
    if (result.playlist?.id) {
      await selectPlaylist(result.playlist.id);
    }
  }
  function queueSelectionItems() {
    const guildState = currentGuildState();
    const items = [];
    if (!guildState)
      return items;
    if (guildState.currentSong) {
      const key = "current";
      items.push({
        key,
        title: guildState.currentSong.title,
        meta: "Nyt soi",
        checked: queueSelectionKeys.has(key)
      });
    }
    guildState.queue.forEach((song, index) => {
      const key = `queue:${index}`;
      items.push({
        key,
        title: song.title,
        meta: `Jonossa #${index + 1}`,
        checked: queueSelectionKeys.has(key)
      });
    });
    return items;
  }
  function renderQueueSelectionModal() {
    const items = queueSelectionItems();
    if (queueSelectionKeys.size === 0) {
      items.forEach((item) => queueSelectionKeys.add(item.key));
    }
    const rendered = items.map((item) => ({ ...item, checked: queueSelectionKeys.has(item.key) }));
    renderQueueSelectionList(rendered);
  }
  function openQueueSelectionModal() {
    appState.queueSelectModalOpen = true;
    queueSelectionKeys = new Set;
    renderQueueSelectionModal();
    setVisible(dom.queueSelectModal, true);
    document.body.classList.add("modal-open");
  }
  function closeQueueSelectionModal() {
    appState.queueSelectModalOpen = false;
    setVisible(dom.queueSelectModal, false);
    setVisible(dom.queueSelectStatus, false);
    dom.queueSelectStatus.textContent = "";
    document.body.classList.remove("modal-open");
  }
  async function onSaveSelectedQueueToPlaylist() {
    const playlistId = requireSelectedPlaylist();
    if (!playlistId)
      return;
    if (!appState.currentGuild) {
      setStatus(dom.playlistStatus, "Valitse palvelin ennen tallennusta.", "error");
      return;
    }
    openQueueSelectionModal();
  }
  async function onConfirmQueueSelectionSave() {
    const playlistId = requireSelectedPlaylist();
    if (!playlistId || !appState.currentGuild)
      return;
    const includeCurrent = queueSelectionKeys.has("current");
    const selectedIndices = [...queueSelectionKeys].filter((key) => key.startsWith("queue:")).map((key) => Number.parseInt(key.split(":")[1], 10)).filter((value) => !Number.isNaN(value)).sort((a, b) => a - b);
    if (!includeCurrent && selectedIndices.length === 0) {
      setStatus(dom.queueSelectStatus, "Valitse vähintään yksi kappale.", "error");
      return;
    }
    const result = await copyQueueToPlaylistApi(playlistId, appState.currentGuild, includeCurrent, selectedIndices);
    if (result.error || !result.result) {
      setStatus(dom.queueSelectStatus, result.error || "Valinnan tallennus epäonnistui", "error");
      return;
    }
    closeQueueSelectionModal();
    setStatus(dom.playlistStatus, `Tallennettu valinta: +${result.result.added}, duplikaatit ${result.result.skippedDuplicates}, virheet ${result.result.failed}`, "ok");
    await refreshSelectedPlaylist(false);
    await refreshPlaylists(true);
  }
  async function onRemovePlaylistSong(songId) {
    const playlistId = requireSelectedPlaylist();
    if (!playlistId)
      return;
    const result = await removePlaylistSongApi(playlistId, songId);
    if (result.error) {
      setStatus(dom.playlistStatus, result.error, "error");
      return;
    }
    setStatus(dom.playlistStatus, "Kappale poistettu soittolistasta", "ok");
    await refreshSelectedPlaylist(false);
    await refreshPlaylists(true);
  }
  async function onMovePlaylistSong(fromIndex, toIndex) {
    const playlistId = requireSelectedPlaylist();
    if (!playlistId || fromIndex === toIndex)
      return;
    const result = await movePlaylistSongApi(playlistId, fromIndex, toIndex);
    if (result.error) {
      setStatus(dom.playlistStatus, result.error, "error");
      return;
    }
    await refreshSelectedPlaylist(false);
  }
  function attachQueueEvents() {
    dom.queueList.addEventListener("click", (event) => {
      const target = event.target;
      const button = target.closest("[data-remove]");
      if (!button)
        return;
      const idx = Number.parseInt(button.getAttribute("data-remove") || "", 10);
      if (!Number.isNaN(idx)) {
        onRemoveQueueItem(idx);
      }
    });
    dom.queueList.addEventListener("dragstart", (event) => {
      const target = event.target;
      const item = target.closest(".queue-item");
      if (!item)
        return;
      appState.dragFromIndex = Number.parseInt(item.getAttribute("data-index") || "", 10);
      item.classList.add("dragging");
    });
    dom.queueList.addEventListener("dragend", (event) => {
      const target = event.target;
      const item = target.closest(".queue-item");
      if (item)
        item.classList.remove("dragging");
      appState.dragFromIndex = null;
    });
    dom.queueList.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    dom.queueList.addEventListener("drop", (event) => {
      event.preventDefault();
      const target = event.target;
      const item = target.closest(".queue-item");
      if (!item || appState.dragFromIndex === null)
        return;
      const to = Number.parseInt(item.getAttribute("data-index") || "", 10);
      if (!Number.isNaN(to)) {
        onMoveQueueItem(appState.dragFromIndex, to);
      }
      appState.dragFromIndex = null;
    });
  }
  function attachPlaylistEvents() {
    dom.createPlaylistBtn.addEventListener("click", () => {
      onCreatePlaylist();
    });
    dom.renamePlaylistBtn.addEventListener("click", () => {
      onRenamePlaylist();
    });
    dom.deletePlaylistBtn.addEventListener("click", () => {
      onDeletePlaylist();
    });
    dom.playPlaylistBtn.addEventListener("click", () => {
      onPlayPlaylist(false);
    });
    dom.playPlaylistShuffleBtn.addEventListener("click", () => {
      onPlayPlaylist(true);
    });
    dom.saveQueueToPlaylistBtn.addEventListener("click", () => {
      onSaveWholeQueueToPlaylist();
    });
    dom.saveSelectedQueueBtn.addEventListener("click", () => {
      onSaveSelectedQueueToPlaylist();
    });
    dom.createPlaylistFromQueueBtn.addEventListener("click", () => {
      onCreatePlaylistFromQueue();
    });
    dom.playlistSongForm.addEventListener("submit", (event) => {
      onAddSongToPlaylist(event);
    });
    dom.playlistImportForm.addEventListener("submit", (event) => {
      onImportYouTubePlaylist(event);
    });
    dom.playlistLoadMoreBtn.addEventListener("click", () => {
      refreshPlaylists(false);
    });
    dom.playlistSongsLoadMoreBtn.addEventListener("click", () => {
      refreshSelectedPlaylist(true);
    });
    dom.playlistSearchInput.addEventListener("input", () => {
      appState.playlistSearchQuery = dom.playlistSearchInput.value.trim();
      if (playlistSearchDebounce)
        window.clearTimeout(playlistSearchDebounce);
      playlistSearchDebounce = window.setTimeout(() => {
        refreshPlaylists(true);
      }, 250);
    });
    dom.playlistSongSearchInput.addEventListener("input", () => {
      appState.playlistSongSearchQuery = dom.playlistSongSearchInput.value.trim();
      if (playlistSongSearchDebounce)
        window.clearTimeout(playlistSongSearchDebounce);
      playlistSongSearchDebounce = window.setTimeout(() => {
        refreshSelectedPlaylist(false);
      }, 250);
    });
    dom.playlistList.addEventListener("click", (event) => {
      const target = event.target;
      const button = target.closest("[data-playlist-id]");
      if (!button)
        return;
      const playlistId = button.getAttribute("data-playlist-id");
      if (!playlistId)
        return;
      selectPlaylist(playlistId);
    });
    dom.playlistSongList.addEventListener("click", (event) => {
      const target = event.target;
      const button = target.closest("[data-playlist-remove-song]");
      if (!button)
        return;
      const songId = button.getAttribute("data-playlist-remove-song");
      if (!songId)
        return;
      onRemovePlaylistSong(songId);
    });
    dom.playlistSongList.addEventListener("dragstart", (event) => {
      const target = event.target;
      const item = target.closest(".playlist-song-item");
      if (!item)
        return;
      appState.playlistSongDragFromIndex = Number.parseInt(item.getAttribute("data-playlist-song-index") || "", 10);
      item.classList.add("dragging");
    });
    dom.playlistSongList.addEventListener("dragend", (event) => {
      const target = event.target;
      const item = target.closest(".playlist-song-item");
      if (item)
        item.classList.remove("dragging");
      appState.playlistSongDragFromIndex = null;
    });
    dom.playlistSongList.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    dom.playlistSongList.addEventListener("drop", (event) => {
      event.preventDefault();
      const target = event.target;
      const item = target.closest(".playlist-song-item");
      if (!item || appState.playlistSongDragFromIndex === null)
        return;
      const to = Number.parseInt(item.getAttribute("data-playlist-song-index") || "", 10);
      if (!Number.isNaN(to)) {
        onMovePlaylistSong(appState.playlistSongDragFromIndex, to);
      }
      appState.playlistSongDragFromIndex = null;
    });
    dom.queueSelectList.addEventListener("change", (event) => {
      const target = event.target;
      const key = target.getAttribute("data-queue-select");
      if (!key)
        return;
      if (target.checked)
        queueSelectionKeys.add(key);
      else
        queueSelectionKeys.delete(key);
    });
    dom.queueSelectConfirmBtn.addEventListener("click", () => {
      onConfirmQueueSelectionSave();
    });
    dom.closeQueueSelectBtn.addEventListener("click", closeQueueSelectionModal);
    dom.queueSelectModal.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest('[data-modal-close="queue-select"]')) {
        closeQueueSelectionModal();
      }
    });
  }
  function bindEvents() {
    dom.searchForm.addEventListener("submit", (event) => {
      onSearchSubmit(event);
    });
    dom.addForm.addEventListener("submit", (event) => {
      onAddUrlSubmit(event);
    });
    dom.pauseBtn.addEventListener("click", () => {
      onTogglePause();
    });
    dom.skipBtn.addEventListener("click", () => {
      onSkip();
    });
    setPttButtonState(false);
    dom.pttBtn.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      startPttCapture();
    });
    dom.pttBtn.addEventListener("pointerup", (event) => {
      event.preventDefault();
      stopPttCapture();
    });
    dom.pttBtn.addEventListener("pointerleave", () => {
      stopPttCapture();
    });
    dom.pttBtn.addEventListener("pointercancel", () => {
      stopPttCapture();
    });
    dom.voiceKeywordForm.addEventListener("submit", (event) => {
      onSaveVoiceKeyword(event);
    });
    dom.voiceKeywordLoadMoreBtn.addEventListener("click", () => {
      refreshVoiceKeywords(false);
    });
    dom.voiceKeywordList.addEventListener("click", (event) => {
      const target = event.target;
      const editButton = target.closest("[data-voice-keyword-use]");
      if (editButton) {
        const phrase = editButton.getAttribute("data-voice-keyword-use");
        if (phrase)
          fillVoiceKeywordForEdit(phrase);
        return;
      }
      const deleteButton = target.closest("[data-voice-keyword-delete]");
      if (deleteButton) {
        const phrase = deleteButton.getAttribute("data-voice-keyword-delete");
        if (phrase) {
          onDeleteVoiceKeyword(phrase);
        }
      }
    });
    dom.searchResults.addEventListener("click", (event) => {
      const target = event.target;
      const button = target.closest("[data-search-add]");
      if (!button)
        return;
      const index = Number.parseInt(button.getAttribute("data-search-add") || "", 10);
      if (!Number.isNaN(index)) {
        onAddSearchResult(index);
      }
    });
    dom.openSearchBtn.addEventListener("click", openSearchModal);
    dom.closeSearchBtn.addEventListener("click", closeSearchModal);
    dom.searchModal.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest("[data-modal-close]")) {
        closeSearchModal();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!dom.searchModal.classList.contains("hidden")) {
          closeSearchModal();
        }
        if (!dom.queueSelectModal.classList.contains("hidden")) {
          closeQueueSelectionModal();
        }
      }
    });
    document.addEventListener("visibilitychange", () => {
      schedulePoll(200);
    });
    attachQueueEvents();
    attachPlaylistEvents();
  }
  async function bootstrap() {
    enableLowPowerModeIfNeeded();
    initAccessTokenFromUrl();
    const discordLoginToken = initDiscordLoginTokenFromUrl();
    bindEvents();
    await loadWebConfig();
    if (appState.requireAccessToken && !appState.accessToken) {
      setLoginHint("Pääsytunnus puuttuu. Avaa osoitteella ?token=OMA_TUNNUS", true);
      return;
    }
    if (discordLoginToken) {
      try {
        const result = await exchangeDiscordLoginToken(discordLoginToken);
        if (!result.error) {
          showMain();
          return;
        }
        setLoginHint(result.error || "Linkkikirjautuminen epäonnistui", true);
        return;
      } catch {
        setLoginHint("Linkkikirjautuminen epäonnistui", true);
        return;
      }
    }
    if (!appState.authRequired) {
      setLoginHint(appState.localMode ? "Paikallinen tila käytössä." : "Todennus on poistettu käytöstä.");
      showMain();
      return;
    }
    if (appState.exposureMode === "tunnel") {
      setLoginHint("Tunnelitila käytössä. Avaa Discordin kertakirjautumislinkki.");
    }
    try {
      const profile = await fetchAuthProfile();
      if (profile?.email) {
        showMain();
        return;
      }
    } catch {}
    setVisible(dom.loginSection, true);
    setVisible(dom.mainSection, false);
    setLoginHint("Käytä Discordissa /web-login ja avaa yksityisviestillä tullut linkki täällä.");
  }
  bootstrap();
})();
