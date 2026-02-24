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
    hasActiveSong: false
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
    userInfo: byId("userInfo"),
    toastStack: byId("toastStack"),
    urlInput: byId("urlInput")
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

  // src/web/client/main.ts
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
      renderPlaybackState(result.state || {});
      setPollBadge(appState.hasActiveSong ? "live" : "ready");
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
    setPollBadge("ready");
    fetchMe();
    fetchState();
  }
  function requireGuildBeforeQueue(statusEl) {
    if (appState.currentGuild)
      return true;
    setStatus(statusEl, "Palvelinta ei löytynyt. Tarkista botin guild-asetus.", "error");
    showToast("stern", ["Eppu ei löydä kohdepalvelinta juuri nyt."]);
    return false;
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
      if (event.key === "Escape" && !dom.searchModal.classList.contains("hidden")) {
        closeSearchModal();
      }
    });
    document.addEventListener("visibilitychange", () => {
      schedulePoll(200);
    });
    attachQueueEvents();
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
