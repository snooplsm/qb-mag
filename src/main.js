function resolveInvoke() {
  if (typeof window.__TAURI__?.core?.invoke === "function") {
    return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
  }
  if (typeof window.__TAURI_INTERNALS__?.invoke === "function") {
    return window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  }
  if (typeof window.__TAURI_INVOKE__ === "function") {
    return window.__TAURI_INVOKE__.bind(window);
  }
  return null;
}

function resolveListen() {
  if (typeof window.__TAURI__?.event?.listen === "function") {
    return window.__TAURI__.event.listen.bind(window.__TAURI__.event);
  }
  return null;
}

const invoke = resolveInvoke();
const listen = resolveListen();

async function tauriInvoke(command, args) {
  if (typeof invoke !== "function") {
    throw new Error("Tauri invoke API unavailable.");
  }
  return invoke(command, args);
}

async function openExternalUrl(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return;
  try {
    const ok = await tauriInvoke("open_external", { url: target });
    if (ok) return;
  } catch {
    // fall through to browser open
  }
  window.open(target, "_blank", "noopener");
}

const els = {
  searchInput: document.getElementById("searchInput"),
  searchSuggest: document.getElementById("searchSuggest"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsClose: document.getElementById("settingsClose"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsBackdrop: document.getElementById("settingsBackdrop"),
  addToggle: document.getElementById("addToggle"),
  sortToggle: document.getElementById("sortToggle"),
  sortMenu: document.getElementById("sortMenu"),
  addLayout: document.getElementById("addLayout"),
  addPanel: document.getElementById("addPanel"),
  addBackdrop: document.getElementById("addBackdrop"),
  addClose: document.getElementById("addClose"),
  openTorrent: document.getElementById("openTorrent"),
  torrentFileInput: document.getElementById("torrentFileInput"),
  tabQueue: document.getElementById("tabQueue"),
  tabHistory: document.getElementById("tabHistory"),
  viewQueue: document.getElementById("viewQueue"),
  viewHistory: document.getElementById("viewHistory"),
  queueCards: document.getElementById("queueCards"),
  refreshHistory: document.getElementById("refreshHistory"),
  clearHistory: document.getElementById("clearHistory"),
  historyBody: document.getElementById("historyBody"),
  send: document.getElementById("send"),
  magnet: document.getElementById("magnet"),
  savePath: document.getElementById("savePath"),
  media: document.getElementById("media"),
  status: document.getElementById("status"),
  host: document.getElementById("host"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  tmdbApiKey: document.getElementById("tmdbApiKey"),
  tmdbAccessToken: document.getElementById("tmdbAccessToken"),
  statNetwork: document.getElementById("statNetwork"),
  statQueue: document.getElementById("statQueue"),
  statStorage: document.getElementById("statStorage"),
  statSpeed: document.getElementById("statSpeed")
};

const SETTINGS_KEY = "qbmagnet_settings_v2";
const UI_KEY = "qbmagnet_ui_v2";
const DEFAULT_HOST = "http://192.168.50.23:8080";
const AUTO_REFRESH_MS = 60_000;
const ACTIVITY_IDLE_MS = 60_000;
const SEARCH_HINTS = ["DOWNLOADING", "DONE"];
const DEFAULT_SORT = "added_desc";
const SEND_LABEL = "SEND";

let queueRaw = [];
let queueEnriched = [];
const mediaCache = new Map();
const tmdbCache = new Map();
const tmdbReasonCache = new Map();
let autoRefreshTimer = null;
let lastRefreshAt = 0;
let lastUserActivityAt = Date.now();
let refreshInFlight = false;
let parseDebounceTimer = null;
let lastPreviewWasReady = false;
let sortCloseTimer = null;
let previewHideTimer = null;
let currentSort = DEFAULT_SORT;
let deepLinkSendTimer = null;
let deepLinkCountdownTimer = null;
let lastDeepLinkAutoKey = "";
let lastDeepLinkAutoAt = 0;

if (/\bMac\b/.test(navigator.platform) || /\bMac OS\b/i.test(navigator.userAgent)) {
  document.body.classList.add("macos");
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesSec) {
  return `${formatBytes(bytesSec)}/s`;
}

function formatHistoryWhen(tsUnix) {
  const now = Date.now();
  const then = Number(tsUnix) * 1000;
  const diffMs = Math.max(0, now - then);
  const mins = Math.floor(diffMs / 60000);

  if (mins <= 99) {
    return `${mins}m ago`;
  }

  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 48) {
    return `${hrs}h${String(remMins).padStart(2, "0")}m ago`;
  }

  const d = new Date(then);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  let hh = d.getHours();
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${min} ${ampm}`;
}

function setStatus(text, isError = false) {
  const raw = String(text || "");
  if (
    isError &&
    /(operation not permitted|local network|network permission|failed to list torrents: error sending request|error sending request for url)/i.test(raw)
  ) {
    els.status.textContent = "Waiting for network permission...";
    els.status.style.color = "#b9d7ff";
    return;
  }
  els.status.textContent = raw;
  els.status.style.color = isError ? "#f87171" : "#b9d7ff";
}

function historyDisplayName(entry) {
  const media = entry.media;
  if (media) return canonicalMediaName(media);
  return compactReleaseTitle(entry.torrent_name || extractDnFromMagnet(entry.magnet_url) || "(unknown)");
}

function shortHash(hash) {
  const h = String(hash || "").trim();
  return h ? h.slice(0, 5) : "";
}

function extractDnFromMagnet(magnetUrl) {
  const raw = String(magnetUrl || "");
  if (!raw.includes("?")) return null;
  const query = raw.slice(raw.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const dn = params.get("dn");
  return dn ? dn.replaceAll("+", " ") : null;
}

function compactReleaseTitle(rawName) {
  const raw = String(rawName || "").trim();
  if (!raw) return "(unknown)";
  const normalized = stripSpamPrefix(
    raw
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replaceAll("+", " ")
    .replace(/\s+/g, " ")
    .trim()
  );
  const yearMatch = normalized.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
  if (yearMatch && yearMatch.index != null) {
    const prefix = normalized.slice(0, yearMatch.index).trim();
    if (prefix) return prefix;
  }
  const seasonMatch = normalized.match(/\bS\d{1,2}E?\d{0,2}\b/i);
  if (seasonMatch && seasonMatch.index != null) {
    const prefix = normalized.slice(0, seasonMatch.index).trim();
    if (prefix) return prefix;
  }
  return normalized;
}

function canonicalMediaName(media) {
  if (!media) return "(unknown)";
  if (media.kind === "show") return cleanShowName(media.name);
  if (media.kind === "movie") return media.title;
  if (media.kind === "book") return media.title;
  if (media.kind === "app") return media.name;
  return "(unknown)";
}

function extractReleaseHints(rawName) {
  const raw = String(rawName || "");
  const norm = raw
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replaceAll("+", " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const quality = norm.match(/\b(\d{3,4}p)\b/i)?.[1] || null;
  const source =
    norm.match(/\b(WEB[-\s]?DL|WEB|BLURAY|DVDRIP|HDTV|REMUX|DSNP)\b/i)?.[1] || null;
  const format =
    norm.match(/\b(x265|h[\s\.]?265|hevc|av1|x264|h[\s\.]?264)\b/i)?.[1] || null;

  const se = norm.match(/\bS(\d{1,2})E(\d{1,2})\b/i);
  const season = se ? Number(se[1]) : null;
  const episode = se ? Number(se[2]) : null;
  const year = norm.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/)?.[1] || null;

  return { quality, source, format, season, episode, year };
}

function inferMediaForLookup(rawName) {
  const hints = extractReleaseHints(rawName);
  const baseTitle = compactReleaseTitle(rawName);

  if (hints.season) {
    return {
      kind: "show",
      name: baseTitle || "Unknown Show",
      season: Number(hints.season),
      episode: hints.episode ? Number(hints.episode) : null,
      quality: hints.quality || null,
      source: hints.source || null,
      format: hints.format || null,
      hdr: false,
      release_group: null,
      proper: false,
      repack: false,
      language: null
    };
  }

  if (hints.year) {
    return {
      kind: "movie",
      title: baseTitle || "Unknown Movie",
      year: Number(hints.year),
      quality: hints.quality || null,
      source: hints.source || null,
      format: hints.format || null,
      hdr: false,
      release_group: null,
      proper: false,
      repack: false,
      language: null
    };
  }

  return null;
}

function normalizeQuality(value) {
  const q = String(value || "").trim().toLowerCase();
  if (!q) return null;
  if (q === "2160p") return "4K";
  return value;
}

function statusFromTorrent(torrent) {
  if (!torrent) return { text: "Removed", cls: "status-removed" };
  const state = String(torrent.state || "").toLowerCase();
  const pct = Math.max(0, Math.min(100, Math.round((torrent.progress || 0) * 100)));
  const speed = formatSpeed(torrent.dlspeed || 0);
  const downloadingStates = [
    "downloading",
    "forceddl",
    "stalleddl",
    "metadl",
    "forcedmeta"
  ];

  if (downloadingStates.some((s) => state.includes(s))) {
    return { text: `${pct}% • ${speed}`, cls: "status-downloading" };
  }
  if (pct >= 100 || state.includes("upload") || state.includes("pausedup")) {
    return { text: "Completed", cls: "status-completed" };
  }
  if (state.includes("error")) {
    return { text: "Error", cls: "status-error" };
  }
  if (state.includes("paused")) {
    return { text: "Paused", cls: "status-paused" };
  }
  return { text: torrent.state || "Unknown", cls: "status-neutral" };
}

function readSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      host: s.host || DEFAULT_HOST,
      username: s.username || "",
      password: s.password || "",
      tmdbApiKey: s.tmdbApiKey || s.tvdbApiKey || "",
      tmdbAccessToken: s.tmdbAccessToken || ""
    };
  } catch {
    return {
      host: DEFAULT_HOST,
      username: "",
      password: "",
      tmdbApiKey: "",
      tmdbAccessToken: ""
    };
  }
}

function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      host: els.host.value.trim(),
      username: els.username.value.trim(),
      password: els.password.value,
      tmdbApiKey: els.tmdbApiKey.value.trim(),
      tmdbAccessToken: els.tmdbAccessToken.value.trim()
    })
  );
}

function readUi() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveUi(ui) {
  localStorage.setItem(UI_KEY, JSON.stringify(ui));
}

function authArgs() {
  return {
    username: els.username.value.trim() || null,
    password: els.password.value || null
  };
}

function tmdbArgs() {
  return {
    tmdbApiKey: els.tmdbApiKey.value.trim(),
    tmdbAccessToken: els.tmdbAccessToken.value.trim() || null
  };
}

function setSettingsOpen(open) {
  els.settingsPanel.classList.toggle("open", open);
  els.settingsBackdrop.classList.toggle("open", open);
  els.settingsToggle.setAttribute("aria-expanded", open ? "true" : "false");
  saveUi({ ...readUi(), settingsOpen: open });
}

function setTab(tab) {
  const isQueue = tab === "queue";
  els.tabQueue.classList.toggle("active", isQueue);
  els.tabHistory.classList.toggle("active", !isQueue);
  els.viewQueue.classList.toggle("active", isQueue);
  els.viewHistory.classList.toggle("active", !isQueue);
  saveUi({ ...readUi(), tab });
}

function setSort(mode) {
  currentSort = mode || DEFAULT_SORT;
  els.sortToggle.setAttribute("title", `Sort: ${currentSort.replaceAll("_", " ")}`);
  for (const btn of els.sortMenu.querySelectorAll(".sort-item")) {
    btn.classList.toggle("active", btn.getAttribute("data-sort") === currentSort);
  }
  saveUi({ ...readUi(), sort: currentSort });
}

function setAddOpen(open) {
  if (!open) {
    clearDeepLinkAutoSend();
  }
  els.addPanel.classList.toggle("hidden", !open);
  els.addBackdrop.classList.toggle("hidden", !open);
  saveUi({ ...readUi(), addOpen: open });
}

function showAddPreviewContainer() {
  if (previewHideTimer) {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = null;
  }
  els.addLayout?.classList.add("has-preview");
  els.media.classList.remove("hidden");
  window.requestAnimationFrame(() => {
    els.media.classList.add("preview-visible");
  });
}

function hideAddPreviewContainer() {
  if (previewHideTimer) {
    window.clearTimeout(previewHideTimer);
    previewHideTimer = null;
  }
  if (els.media.classList.contains("hidden")) {
    els.addLayout?.classList.remove("has-preview");
    return;
  }
  els.media.classList.remove("preview-visible");
  previewHideTimer = window.setTimeout(() => {
    els.media.classList.add("hidden");
    els.addLayout?.classList.remove("has-preview");
    previewHideTimer = null;
  }, 190);
}

function renderMedia(media, tmdb = null) {
  const magnet = els.magnet.value.trim();
  const rawName = extractDnFromMagnet(magnet) || magnet;
  if (!media || !magnet) {
    els.media.classList.add("empty");
    els.media.classList.remove("preview-ready");
    els.media.textContent = "";
    lastPreviewWasReady = false;
    hideAddPreviewContainer();
    return;
  }
  showAddPreviewContainer();
  const previewItem = {
    torrent: {
      name: rawName || canonicalMediaName(media),
      state: "Preview",
      progress: 0,
      dlspeed: 0,
      upspeed: 0,
      completed: 0,
      size: 0,
      save_path: els.savePath.value.trim() || buildPreviewPath(media)
    },
    media,
    tmdb
  };
  const title = queuePrimaryTitle(previewItem);
  const subtitle = mediaSubtitle(media, rawName);
  const episodeTitle = tmdb?.episode_name || "";
  const detail = queueDetailLine(media, rawName);
  const transfer = queueTransferLabel(previewItem.torrent, 0);
  const episodeStill = tmdb?.episode_image_url || "";
  const poster = tmdb?.image_url || episodeStill || "";
  const pageUrl = tmdb?.page_url || "";
  const posterClass = tmdb?.image_url ? "poster" : "poster poster-wide";
  const reason =
    tmdbReasonCache.get(JSON.stringify(media || inferMediaForLookup(rawName) || null)) || "No art";
  els.media.classList.remove("empty");
  els.media.classList.add("preview-ready");
  els.media.innerHTML = `
    <article class="queue-card add-preview-card ${episodeStill ? "queue-card-has-bg" : ""}" ${
      episodeStill ? `style="--episode-bg:url('${esc(episodeStill)}')"` : ""
    }>
      <div class="poster-wrap">
        <div class="poster-frame">
          ${
            poster
              ? `${
                  pageUrl
                    ? `<button class="poster-link-btn" type="button" data-url="${esc(pageUrl)}" title="${esc(pageUrl)}"><img class="${posterClass}" src="${esc(poster)}" alt="Poster URL: ${esc(poster)}" /></button>`
                    : `<img class="${posterClass}" src="${esc(poster)}" alt="Poster URL: ${esc(poster)}" title="${esc(poster)}" />`
                }`
              : `<div class="poster placeholder" title="${esc(reason)}">No art</div>`
          }
        </div>
        <div class="poster-meta">${esc(transfer)}</div>
      </div>
      <div class="queue-main">
        <h3 class="queue-title">${esc(title)}</h3>
        <div class="queue-sub">${esc(episodeTitle ? `${subtitle} • ${episodeTitle}` : subtitle)}</div>
        <p class="queue-overview">${esc(detail)}</p>
        <div class="progress-wrap"><div class="progress-bar" style="width:0%"></div></div>
        <div class="queue-meta">Ready to submit</div>
        <button class="path-chip" type="button" data-path="${esc(previewItem.torrent.save_path)}" title="${esc(previewItem.torrent.save_path)}" aria-label="${esc(previewItem.torrent.save_path)}">${esc(previewItem.torrent.save_path)}</button>
      </div>
    </article>
  `;
  if (!lastPreviewWasReady) {
    const card = els.media.querySelector(".add-preview-card");
    if (card instanceof HTMLElement) {
      card.style.animation = "none";
      void card.offsetHeight;
      card.style.animation = "";
    }
  }
  lastPreviewWasReady = true;
}

async function parseMagnet() {
  const magnet = els.magnet.value.trim();
  if (!magnet) {
    renderMedia(null);
    return null;
  }
  try {
    const media = await tauriInvoke("parse_magnet", { magnetUrl: magnet });
    if (!media) {
      renderMedia(null);
      return null;
    }
    const tmdb = await fetchTmdbCached(media, extractDnFromMagnet(magnet) || magnet);
    renderMedia(media, tmdb);
    return media;
  } catch {
    // Keep add preview quiet while permission/network APIs settle.
    renderMedia(null);
    return null;
  }
}

function buildPreviewPath(media) {
  if (!media) return "/downloads";
  if (media.kind === "show") return `/tv/${media.name}/Season ${media.season}`;
  if (media.kind === "movie") return `/movies/${media.title}${media.year ? ` ${media.year}` : ""}`.trim();
  if (media.kind === "book") return `/books/${media.title}`;
  if (media.kind === "app") return `/apps/${media.name}`;
  return "/downloads";
}

function scheduleAutoParse() {
  if (parseDebounceTimer) {
    window.clearTimeout(parseDebounceTimer);
  }
  parseDebounceTimer = window.setTimeout(() => {
    void parseMagnet();
  }, 280);
}

function applyIncomingMagnet(magnet) {
  const value = String(magnet || "").trim();
  if (!value.startsWith("magnet:")) return;
  console.info("[deep-link] applying magnet", value.slice(0, 96));
  els.magnet.value = value;
  setAddOpen(true);
  scheduleAutoParse();
  scheduleDeepLinkAutoSend(`magnet:${value}`, async () => {
    await sendMagnet();
  });
}

function fileNameFromPath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "torrent file";
  const normalized = raw.replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop();
  return name || "torrent file";
}

async function sendTorrentFilePath(torrentPath) {
  const host = els.host.value.trim();
  const path = String(torrentPath || "").trim();
  const savePathOverride = els.savePath.value.trim();
  if (!host || !path) {
    setStatus("Host and torrent file are required.", true);
    return;
  }
  setAddOpen(true);
  setStatus(`Submitting torrent file: ${fileNameFromPath(path)}...`);
  const result = await tauriInvoke("upload_torrent_file", {
    qbUrl: host,
    torrentPath: path,
    ...authArgs(),
    savePathOverride: savePathOverride || null
  });
  if (result?.success) {
    setStatus(`Submitted: ${result.torrent_name || fileNameFromPath(path)}`);
    await refreshAll({ force: true });
    finalizeAddSuccess();
  } else {
    setStatus("qBittorrent add returned non-200 for torrent file.", true);
  }
}

async function sendTorrentFileBlob(file) {
  const host = els.host.value.trim();
  if (!host || !(file instanceof File)) {
    setStatus("Host and torrent file are required.", true);
    return;
  }
  const lower = String(file.name || "").toLowerCase();
  if (!lower.endsWith(".torrent")) {
    setStatus("Please choose a .torrent file.", true);
    return;
  }

  const savePathOverride = els.savePath.value.trim();
  setAddOpen(true);
  setStatus(`Submitting torrent file: ${file.name}...`);
  const buf = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  const result = await tauriInvoke("upload_torrent_bytes", {
    qbUrl: host,
    fileName: file.name,
    fileBytes: bytes,
    ...authArgs(),
    savePathOverride: savePathOverride || null
  });
  if (result?.success) {
    setStatus(`Submitted: ${result.torrent_name || file.name}`);
    await refreshAll({ force: true });
    finalizeAddSuccess();
  } else {
    setStatus("qBittorrent add returned non-200 for torrent file.", true);
  }
}

function applyIncomingTorrentFile(path) {
  const value = String(path || "").trim();
  if (!value || !/\.torrent$/i.test(value)) return;
  console.info("[deep-link] applying torrent file", value);
  setAddOpen(true);
  scheduleDeepLinkAutoSend(`torrent:${value}`, async () => {
    await sendTorrentFilePath(value);
  });
}

function scheduleDeepLinkAutoSend(key, action) {
  const now = Date.now();
  if (key === lastDeepLinkAutoKey && now - lastDeepLinkAutoAt < 10_000) {
    console.info("[deep-link] skipping duplicate auto-send", key.slice(0, 120));
    return;
  }
  clearDeepLinkAutoSend();
  let remaining = 3;
  setSendButtonLabel(remaining);
  deepLinkCountdownTimer = window.setInterval(() => {
    remaining -= 1;
    if (remaining > 0) {
      setSendButtonLabel(remaining);
    } else if (deepLinkCountdownTimer) {
      window.clearInterval(deepLinkCountdownTimer);
      deepLinkCountdownTimer = null;
    }
  }, 1000);
  deepLinkSendTimer = window.setTimeout(() => {
    deepLinkSendTimer = null;
    if (deepLinkCountdownTimer) {
      window.clearInterval(deepLinkCountdownTimer);
      deepLinkCountdownTimer = null;
    }
    setSendButtonLabel();
    lastDeepLinkAutoKey = key;
    lastDeepLinkAutoAt = Date.now();
    void action().catch((e) => setStatus(String(e), true));
  }, 3_000);
}

function setSendButtonLabel(countdown = null) {
  if (!els.send) return;
  if (typeof countdown === "number" && countdown > 0) {
    els.send.textContent = `${SEND_LABEL} (${countdown})`;
    return;
  }
  els.send.textContent = SEND_LABEL;
}

function clearDeepLinkAutoSend() {
  if (deepLinkSendTimer) {
    window.clearTimeout(deepLinkSendTimer);
    deepLinkSendTimer = null;
  }
  if (deepLinkCountdownTimer) {
    window.clearInterval(deepLinkCountdownTimer);
    deepLinkCountdownTimer = null;
  }
  setSendButtonLabel();
}

function finalizeAddSuccess() {
  els.magnet.value = "";
  els.torrentFileInput.value = "";
  renderMedia(null);
  setAddOpen(false);
}

async function consumePendingMagnet() {
  try {
    const pending = await tauriInvoke("take_initial_magnet");
    if (typeof pending === "string" && pending.startsWith("magnet:")) {
      console.info("[deep-link] consumed pending magnet", pending.slice(0, 96));
      applyIncomingMagnet(pending);
    } else if (pending) {
      console.info("[deep-link] pending value ignored", String(pending).slice(0, 96));
    }
  } catch {
    // ignore
  }
}

async function consumePendingTorrentFile() {
  try {
    const pending = await tauriInvoke("take_initial_torrent_file");
    if (typeof pending === "string" && /\.torrent$/i.test(pending.trim())) {
      console.info("[deep-link] consumed pending torrent file", pending);
      applyIncomingTorrentFile(pending);
    }
  } catch {
    // ignore
  }
}

async function fetchHistory() {
  const rows = await tauriInvoke("get_history");
  let torrentMap = new Map();
  let liveLookupOk = false;
  try {
    const host = els.host.value.trim();
    if (host) {
      const torrents = await tauriInvoke("list_torrents", {
        qbUrl: host,
        ...authArgs()
      });
      torrentMap = new Map(torrents.map((t) => [String(t.hash || "").toLowerCase(), t]));
      liveLookupOk = true;
    }
  } catch (_) {
    // History should still render even if queue status lookup fails.
  }

  els.historyBody.innerHTML = "";
  for (const entry of [...rows].reverse()) {
    const tr = document.createElement("tr");
    const when = formatHistoryWhen(entry.ts_unix);
    const name = historyDisplayName(entry);
    const rawDn = extractDnFromMagnet(entry.magnet_url) || entry.torrent_name || "";
    const hash = (entry.torrent_hash || "").toLowerCase();
    const live = hash ? torrentMap.get(hash) : null;
    let status;
    if (hash && liveLookupOk) {
      status = statusFromTorrent(live);
    } else if (entry.success) {
      status = { text: "Submitted", cls: "status-completed" };
    } else {
      status = { text: "Failed", cls: "status-error" };
    }
    const hashRaw = entry.torrent_hash || "";
    const hashCell = hashRaw
      ? `<button class=\"hash-chip\" type=\"button\" data-hash=\"${esc(hashRaw)}\" title=\"Copy hash\">${esc(shortHash(hashRaw))}</button>`
      : esc(String(entry.id));
    const pathCell = `<button class=\"path-chip\" type=\"button\" data-path=\"${esc(entry.save_path)}\" title=\"${esc(entry.save_path)}\" aria-label=\"${esc(entry.save_path)}\">${esc(entry.save_path)}</button>`;
    const actionCell = `<button class="row-delete" type="button" data-history-id="${entry.id}" title="Delete from history">Delete</button>`;

    tr.innerHTML = `
      <td>${esc(when)}</td>
      <td><span class=\"${status.cls}\">${esc(status.text)}</span></td>
      <td title=\"${esc(rawDn)}\">${esc(name)}</td>
      <td>${hashCell}</td>
      <td>${pathCell}</td>
      <td>${actionCell}</td>
    `;
    els.historyBody.appendChild(tr);
  }
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6">No history yet.</td>';
    els.historyBody.appendChild(tr);
  }
}

async function parseReleaseNameCached(name) {
  if (mediaCache.has(name)) return mediaCache.get(name);
  const media = await tauriInvoke("parse_release_name", { name });
  mediaCache.set(name, media);
  return media;
}

async function fetchTmdbCached(media, rawName = "") {
  const lookupMedia = media || inferMediaForLookup(rawName);
  const key = JSON.stringify(lookupMedia || null);
  if (tmdbCache.has(key)) return tmdbCache.get(key);
  const { tmdbApiKey, tmdbAccessToken } = tmdbArgs();
  if (!(lookupMedia?.kind === "show" || lookupMedia?.kind === "movie")) {
    tmdbCache.set(key, null);
    tmdbReasonCache.set(key, "No art: parser could not infer show/movie from release name.");
    return null;
  }
  const queryForHint =
    lookupMedia.kind === "show" ? canonicalMediaName(lookupMedia) : lookupMedia.title;
  const typeForHint = lookupMedia.kind === "show" ? "tv" : "movie";
  try {
    const meta = await tauriInvoke("fetch_tmdb_metadata", {
      media: lookupMedia,
      tmdbApiKey,
      tmdbAccessToken
    });
    tmdbCache.set(key, meta || null);
    if (meta?.image_url) {
      tmdbReasonCache.set(key, `Poster URL: ${meta.image_url}`);
    } else {
      tmdbReasonCache.set(
        key,
        `No art from TMDb. Lookup used /search/${typeForHint}?query=${queryForHint}`
      );
    }
    return meta || null;
  } catch (err) {
    tmdbCache.set(key, null);
    tmdbReasonCache.set(
      key,
      `TMDb error. Lookup used /search/${typeForHint}?query=${queryForHint} (settings or env) | ${String(err)}`
    );
    return null;
  }
}

function mediaSubtitle(media, rawName = "") {
  const hints = extractReleaseHints(rawName);
  if (!media) {
    if (hints.season && hints.episode) {
      return `S${String(hints.season).padStart(2, "0")}E${String(hints.episode).padStart(2, "0")}`;
    }
    if (hints.season) return `Season ${hints.season}`;
    if (hints.year) return String(hints.year);
    return "Unknown";
  }
  if (media.kind === "show") {
    if (media.episode) {
      const episodeText = `E${String(media.episode).padStart(2, "0")}`;
      return `S${String(media.season).padStart(2, "0")}${episodeText}`;
    }
    return `Season ${media.season}`;
  }
  if (media.kind === "movie") {
    return `${media.year || hints.year || "Unknown Year"}`;
  }
  return media.kind;
}

function cleanShowName(name) {
  const n = stripSpamPrefix(String(name || "").trim());
  return n.replace(/\b(19|20|21)\d{2}\b$/g, "").trim();
}

function stripSpamPrefix(name) {
  let n = String(name || "").trim();
  if (!n) return n;

  // Handle scene-index style separators with large whitespace gaps.
  // e.g. "www.UIndex.org    -    ONE PIECE 2023 S02E03 ..."
  const wideSep = n.match(/\s{2,}[-|:]\s{2,}/);
  if (wideSep) {
    const parts = n.split(/\s{2,}[-|:]\s{2,}/).filter(Boolean);
    if (parts.length > 1) n = parts[parts.length - 1].trim();
  }

  // Strip leading domain label + separator.
  // e.g. "www.UIndex.org - ...", "UIndex.org: ..."
  n = n.replace(
    /^\s*(?:https?:\/\/)?(?:www[.\s]+)?[a-z0-9][a-z0-9-]*(?:[.\s]+[a-z0-9-]+)*[.\s]+(?:org|com|net|info|io|co|me|tv)\s*[-|:]\s*/i,
    ""
  );

  return n.trim();
}

function queuePrimaryTitle(item) {
  const { media, torrent, tmdb } = item;
  if (!media) return compactReleaseTitle(torrent.name);
  if (media.kind === "show") {
    return tmdb?.title || canonicalMediaName(media);
  }
  if (media.kind === "movie") {
    return tmdb?.title || canonicalMediaName(media);
  }
  return canonicalMediaName(media);
}

function queueOriginalName(item) {
  // For queue items from qBittorrent, torrent.name is the closest equivalent to original dn.
  return String(item?.torrent?.name || "").trim();
}

function queueDetailLine(media, rawName = "") {
  const hints = extractReleaseHints(rawName);
  const fields = [
    normalizeQuality(media?.quality || hints.quality),
    media?.source || hints.source,
    media?.format || hints.format
  ].filter(Boolean);
  return fields.length ? fields.join(" • ") : "N/A";
}

function queueTransferLabel(torrent, pct) {
  const state = String(torrent?.state || "").toLowerCase();
  const down = Number(torrent?.dlspeed || 0);
  const up = Number(torrent?.upspeed || 0);
  const uploading = up > 0 || state.includes("upload") || state.includes("pausedup");

  if (pct >= 100 && !uploading) return "";
  if (uploading && up > 0) return `↑ ${formatSpeed(up)}`;
  if (down > 0) return formatSpeed(down);
  return "";
}

function isDoneLikeTorrent(torrent) {
  const state = String(torrent?.state || "").toLowerCase();
  const pct = Math.max(0, Math.min(100, Math.round((torrent?.progress || 0) * 100)));
  if (pct >= 100) return true;
  return (
    state.includes("stopped") ||
    state.includes("upload") ||
    state.includes("pausedup") ||
    state.includes("stalledup") ||
    state.includes("queuedup") ||
    state.includes("checkingup") ||
    state.includes("forcedup")
  );
}

function isDownloadingLikeTorrent(torrent) {
  const state = String(torrent?.state || "").toLowerCase();
  const pct = Math.max(0, Math.min(100, Math.round((torrent?.progress || 0) * 100)));
  if (pct >= 100) return false;
  return (
    state.includes("downloading") ||
    state.includes("forceddl") ||
    state.includes("stalleddl") ||
    state.includes("metadl") ||
    state.includes("forcedmeta") ||
    state.includes("queueddl") ||
    state.includes("checkingdl")
  );
}

function isStoppedLikeTorrent(torrent) {
  const state = String(torrent?.state || "").toLowerCase();
  return state.includes("stopped") || state.includes("paused");
}

function isActiveLikeTorrent(torrent) {
  const state = String(torrent?.state || "").toLowerCase();
  return (
    state.includes("downloading") ||
    state.includes("forceddl") ||
    state.includes("stalleddl") ||
    state.includes("metadl") ||
    state.includes("forcedmeta") ||
    state.includes("upload") ||
    state.includes("stalledup") ||
    state.includes("queuedup") ||
    state.includes("forcedup")
  );
}

function queueActionsForTorrent(torrent) {
  const stopped = isStoppedLikeTorrent(torrent);
  const active = isActiveLikeTorrent(torrent);
  if (isDoneLikeTorrent(torrent)) {
    const actions = [
      { action: "delete_with_files", label: "Delete", tone: "danger" },
      { action: "remove_keep_files", label: "Remove", tone: "default" }
    ];
    if (stopped) actions.unshift({ action: "resume", label: "Resume", tone: "ok" });
    else if (active) actions.unshift({ action: "pause", label: "Pause", tone: "default" });
    return actions;
  }
  const actions = [
    { action: "force_start", label: "Force", tone: "ok" },
    { action: "delete_with_files", label: "Delete", tone: "danger" },
    { action: "reannounce", label: "Reannounce", tone: "default" }
  ];
  if (stopped) actions.unshift({ action: "resume", label: "Resume", tone: "ok" });
  else if (active) actions.unshift({ action: "pause", label: "Pause", tone: "default" });
  return actions;
}

function sortQueueItems(items) {
  const arr = [...items];
  const [key, dir] = currentSort.split("_");
  const mul = dir === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    if (key === "size") {
      return (Number(a.torrent.size || 0) - Number(b.torrent.size || 0)) * mul;
    }
    if (key === "added") {
      return (Number(a.torrent.added_on || 0) - Number(b.torrent.added_on || 0)) * mul;
    }
    if (key === "status") {
      const sa = statusFromTorrent(a.torrent).text.toLowerCase();
      const sb = statusFromTorrent(b.torrent).text.toLowerCase();
      return sa.localeCompare(sb) * mul;
    }
    const ta = queuePrimaryTitle(a).toLowerCase();
    const tb = queuePrimaryTitle(b).toLowerCase();
    return ta.localeCompare(tb) * mul;
  });
  return arr;
}

function renderSearchSuggestions() {
  const query = els.searchInput.value.trim().toUpperCase();
  if (!query) {
    els.searchSuggest.classList.remove("open");
    els.searchSuggest.innerHTML = "";
    return;
  }
  const options = SEARCH_HINTS.filter((opt) => opt.startsWith(query) && opt !== query);
  if (!options.length) {
    els.searchSuggest.classList.remove("open");
    els.searchSuggest.innerHTML = "";
    return;
  }
  els.searchSuggest.innerHTML = options
    .map(
      (opt) =>
        `<button type="button" class="search-suggest-item" data-value="${esc(opt)}">${esc(opt)}</button>`
    )
    .join("");
  els.searchSuggest.classList.add("open");
}

function renderQueueCards(items) {
  const query = els.searchInput.value.trim().toLowerCase();
  const isDownloadingQuery =
    query === "downloading" || ("downloading".startsWith(query) && query.length >= 2);
  const isDoneQuery =
    query === "done" ||
    query === "completed" ||
    ("done".startsWith(query) && query.length >= 2) ||
    ("completed".startsWith(query) && query.length >= 2);
  let filtered = items;
  if (isDownloadingQuery) {
    filtered = items.filter((x) => isDownloadingLikeTorrent(x.torrent));
  } else if (isDoneQuery) {
    filtered = items.filter((x) => isDoneLikeTorrent(x.torrent));
  } else if (query) {
    filtered = items.filter((x) => {
      const name = String(x.torrent.name || "").toLowerCase();
      const state = String(x.torrent.state || "").toLowerCase();
      const detail = queueDetailLine(x.media, x.torrent.name).toLowerCase();
      return name.includes(query) || state.includes(query) || detail.includes(query);
    });
  }
  filtered = sortQueueItems(filtered);

  els.queueCards.innerHTML = "";
  for (const item of filtered) {
    const t = item.torrent;
    const pct = Math.max(0, Math.min(100, Math.round((t.progress || 0) * 100)));
    const episodeStill = item.tmdb?.episode_image_url || "";
    const poster = item.tmdb?.image_url || episodeStill || "";
    const pageUrl = item.tmdb?.page_url || "";
    const posterClass = item.tmdb?.image_url ? "poster" : "poster poster-wide";
    const title = queuePrimaryTitle(item);
    const originalName = queueOriginalName(item);
    const subtitle = mediaSubtitle(item.media, t.name);
    const detail = queueDetailLine(item.media, t.name);
    const reason =
      tmdbReasonCache.get(JSON.stringify(item.media || inferMediaForLookup(t.name) || null)) ||
      "No art";
    const transfer = queueTransferLabel(t, pct);
    const menuItems = queueActionsForTorrent(t)
      .map(
        (a) => `
          <button
            class="card-menu-item ${a.tone === "danger" ? "danger" : a.tone === "ok" ? "ok" : ""}"
            type="button"
            data-action="${a.action}"
            data-hash="${esc(t.hash)}"
          >${a.label}</button>
        `
      )
      .join("");

    const card = document.createElement("article");
    card.className = "queue-card";
    if (episodeStill) {
      card.classList.add("queue-card-has-bg");
      card.style.setProperty("--episode-bg", `url("${episodeStill}")`);
    } else {
      card.style.removeProperty("--episode-bg");
    }
    card.innerHTML = `
      ${
        poster
          ? `
            <div class="poster-wrap">
              <div class="poster-frame">
                ${
                  pageUrl
                    ? `<button class="poster-link-btn" type="button" data-url="${esc(pageUrl)}" title="${esc(pageUrl)}"><img class="${posterClass}" src="${esc(poster)}" alt="Poster URL: ${esc(poster)}" /></button>`
                    : `<img class="${posterClass}" src="${esc(poster)}" alt="Poster URL: ${esc(poster)}" title="${esc(poster)}" />`
                }
                <div class="poster-pct">${pct}%</div>
              </div>
              <div class="poster-meta">${esc(transfer)}</div>
            </div>
          `
          : `
            <div class="poster-wrap">
              <div class="poster-frame">
                <div class="poster placeholder" title="${esc(reason)}">No art</div>
                <div class="poster-pct">${pct}%</div>
              </div>
              <div class="poster-meta">${esc(transfer)}</div>
            </div>
          `
      }
      <div class="queue-main">
        <div class="card-menu-wrap">
          <button class="card-menu-btn" type="button" aria-label="Torrent actions" title="Actions" data-menu-toggle="${esc(t.hash)}">⋯</button>
          <div class="card-menu" data-menu="${esc(t.hash)}">
            ${menuItems}
          </div>
        </div>
        <h3 class="queue-title">
          <button
            class="name-chip"
            type="button"
            data-raw-name="${esc(originalName)}"
            title="${esc(originalName || "No original name available")}"
          >${esc(title)}</button>
        </h3>
        <div class="queue-sub">${esc(subtitle)}</div>
        <p class="queue-overview">${esc(detail)}</p>
        <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
        <div class="queue-meta">${esc(formatBytes(t.completed))} of ${esc(formatBytes(t.size))} • ${esc(t.state)}</div>
        <button class="path-chip" type="button" data-path="${esc(t.save_path)}" title="${esc(t.save_path)}" aria-label="${esc(t.save_path)}">${esc(t.save_path)}</button>
      </div>
    `;
    els.queueCards.appendChild(card);
  }

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "panel";
    empty.textContent = "No queue items match current filter.";
    els.queueCards.appendChild(empty);
  }
}

async function runTorrentAction(hash, action) {
  const host = els.host.value.trim();
  if (!host) {
    setStatus("Host is required in settings.", true);
    return;
  }
  if (!hash) {
    setStatus("Missing torrent hash.", true);
    return;
  }
  const labels = {
    delete_with_files: "Deleting torrent + files...",
    remove_keep_files: "Removing torrent (keeping files)...",
    force_start: "Force-starting torrent...",
    reannounce: "Reannouncing torrent...",
    pause: "Pausing torrent...",
    resume: "Resuming torrent..."
  };
  setStatus(labels[action] || "Applying torrent action...");
  const ok = await tauriInvoke("torrent_action", {
    qbUrl: host,
    hashes: [hash],
    action,
    ...authArgs()
  });
  if (!ok) {
    setStatus("qBittorrent action failed.", true);
    return;
  }
  setStatus("Action applied.");
  await refreshAll({ force: true });
}

function updateFooterStats(items, freeSpaceBytes = null) {
  const active = items.filter((i) => (i.torrent.progress || 0) < 1).length;
  const speed = items.reduce((sum, i) => sum + (Number(i.torrent.dlspeed) || 0), 0);
  els.statNetwork.textContent = "Network: Stable";
  els.statQueue.textContent = `Queue: ${active} active`;
  if (typeof freeSpaceBytes === "number" && Number.isFinite(freeSpaceBytes)) {
    els.statStorage.textContent = `Storage: ${formatBytes(freeSpaceBytes)} free`;
  } else {
    els.statStorage.textContent = "Storage: --";
  }
  els.statSpeed.textContent = `Total Throughput: ${formatSpeed(speed)}`;
}

async function refreshQueue({ silent = false } = {}) {
  const host = els.host.value.trim();
  if (!host) {
    setStatus("Host is required in settings.", true);
    return;
  }

  const torrents = await tauriInvoke("list_torrents", {
    qbUrl: host,
    ...authArgs()
  });
  let freeSpace = null;
  try {
    freeSpace = await tauriInvoke("get_free_space", {
      qbUrl: host,
      ...authArgs()
    });
  } catch {
    // Keep queue rendering even if transfer info endpoint fails.
  }

  queueRaw = torrents;
  const limited = torrents.slice(0, 30);
  const enriched = await Promise.all(
    limited.map(async (torrent) => {
      const media = await parseReleaseNameCached(torrent.name);
      const tmdb = await fetchTmdbCached(media, torrent.name);
      return { torrent, media, tmdb };
    })
  );
  queueEnriched = enriched;

  renderQueueCards(enriched);
  updateFooterStats(enriched, freeSpace);
  if (!silent) {
    setStatus(`Loaded ${torrents.length} queue item(s).`);
  }
}

function markUserActivity() {
  lastUserActivityAt = Date.now();
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

async function refreshAll({ force = false, silent = false } = {}) {
  if (refreshInFlight) return;
  const now = Date.now();
  const focused = document.hasFocus() && !document.hidden;
  const idleEnough = now - lastUserActivityAt >= ACTIVITY_IDLE_MS;
  const due = now - lastRefreshAt >= AUTO_REFRESH_MS;
  if (!force && (!focused || !idleEnough || !due)) return;

  refreshInFlight = true;
  try {
    await Promise.all([refreshQueue({ silent }), fetchHistory()]);
    lastRefreshAt = Date.now();
  } finally {
    refreshInFlight = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!document.hasFocus() || document.hidden) return;
  autoRefreshTimer = window.setInterval(() => {
    void refreshAll({ force: false, silent: true }).catch((e) => setStatus(String(e), true));
  }, 5_000);
}

async function sendMagnet() {
  const host = els.host.value.trim();
  const magnet = els.magnet.value.trim();
  const savePathOverride = els.savePath.value.trim();

  if (!host || !magnet) {
    setStatus("Host and magnet URL are required.", true);
    return;
  }

  setStatus("Submitting magnet to qBittorrent...");
  const result = await tauriInvoke("upload_magnet", {
    qbUrl: host,
    magnetUrl: magnet,
    ...authArgs(),
    savePathOverride: savePathOverride || null
  });

  renderMedia(result.media ?? null);
  if (result.success) {
    const fallbackDn = extractDnFromMagnet(magnet) || "";
    const displayName = result.media
      ? canonicalMediaName(result.media)
      : compactReleaseTitle(result.torrent_name || fallbackDn || "");
    setStatus(
      `Submitted${displayName ? `: ${displayName}` : ""} (${result.torrent_hash || "n/a"})`
    );
    await refreshAll({ force: true });
    finalizeAddSuccess();
  } else {
    setStatus("qBittorrent add returned non-200.", true);
  }
}

function hydrateFromStorage() {
  const settings = readSettings();
  els.host.value = settings.host;
  els.username.value = settings.username;
  els.password.value = settings.password;
  els.tmdbApiKey.value = settings.tmdbApiKey;
  els.tmdbAccessToken.value = settings.tmdbAccessToken;

  const ui = readUi();
  setSettingsOpen(Boolean(ui.settingsOpen));
  setAddOpen(Boolean(ui.addOpen));
  setSort(typeof ui.sort === "string" ? ui.sort : DEFAULT_SORT);
  setTab(ui.tab === "history" ? "history" : "queue");
}

for (const el of [els.host, els.username, els.password, els.tmdbApiKey, els.tmdbAccessToken]) {
  el.addEventListener("input", saveSettings);
}

els.settingsToggle.addEventListener("click", () => {
  const isOpen = els.settingsPanel.classList.contains("open");
  setSettingsOpen(!isOpen);
});
els.settingsClose.addEventListener("click", () => setSettingsOpen(false));
els.settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));
const sortWrap = els.sortToggle.closest(".sort-wrap");
function setSortMenuOpen(open) {
  if (open) {
    adjustSortMenuPlacement();
  }
  els.sortMenu.classList.toggle("open", open);
  els.sortToggle.setAttribute("aria-expanded", open ? "true" : "false");
}
function adjustSortMenuPlacement() {
  els.sortMenu.style.left = "0";
  els.sortMenu.style.right = "auto";
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const rect = els.sortMenu.getBoundingClientRect();
  if (rect.right > vw - 10) {
    els.sortMenu.style.left = "auto";
    els.sortMenu.style.right = "0";
  }
  const after = els.sortMenu.getBoundingClientRect();
  if (after.left < 10) {
    els.sortMenu.style.left = "10px";
    els.sortMenu.style.right = "auto";
  }
}
function clearSortCloseTimer() {
  if (sortCloseTimer) {
    window.clearTimeout(sortCloseTimer);
    sortCloseTimer = null;
  }
}
function pointInTriangle(p, a, b, c) {
  const area = (p1, p2, p3) =>
    (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y)) / 2;
  const a1 = Math.abs(area(p, a, b));
  const a2 = Math.abs(area(p, b, c));
  const a3 = Math.abs(area(p, c, a));
  const at = Math.abs(area(a, b, c));
  return Math.abs(a1 + a2 + a3 - at) < 0.8;
}
function isPointerInSortCone(clientX, clientY) {
  const toggleRect = els.sortToggle.getBoundingClientRect();
  const menuRect = els.sortMenu.getBoundingClientRect();
  const pad = Math.max(10, Math.min(28, Math.round((window.innerWidth || 1000) * 0.018)));

  // Primary safe zone (expanded box around toggle + menu).
  const minX = Math.min(toggleRect.left, menuRect.left) - pad;
  const maxX = Math.max(toggleRect.right, menuRect.right) + pad;
  const minY = toggleRect.top - Math.max(8, Math.round(pad * 0.5));
  const maxY = menuRect.bottom + Math.max(8, Math.round(pad * 0.5));
  if (clientX >= minX && clientX <= maxX && clientY >= minY && clientY <= maxY) {
    return true;
  }

  // Directional cone from toggle bottom-center toward menu top corners.
  const apex = { x: toggleRect.left + toggleRect.width / 2, y: toggleRect.bottom + 1 };
  const left = { x: menuRect.left - Math.max(10, Math.round(pad * 0.8)), y: menuRect.top + 2 };
  const right = { x: menuRect.right + Math.max(10, Math.round(pad * 0.8)), y: menuRect.top + 2 };
  return pointInTriangle({ x: clientX, y: clientY }, apex, left, right);
}
function beginSortCloseGrace() {
  clearSortCloseTimer();
  const onMove = (event) => {
    if (isPointerInSortCone(event.clientX, event.clientY)) {
      clearSortCloseTimer();
      document.removeEventListener("mousemove", onMove, true);
      return;
    }
  };
  document.addEventListener("mousemove", onMove, true);
  sortCloseTimer = window.setTimeout(() => {
    setSortMenuOpen(false);
    document.removeEventListener("mousemove", onMove, true);
    sortCloseTimer = null;
  }, 180);
}
if (sortWrap) {
  sortWrap.addEventListener("mouseenter", () => {
    clearSortCloseTimer();
    setSortMenuOpen(true);
  });
  sortWrap.addEventListener("mouseleave", () => {
    beginSortCloseGrace();
  });
  sortWrap.addEventListener("focusin", () => setSortMenuOpen(true));
  sortWrap.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !sortWrap.contains(next)) {
      setSortMenuOpen(false);
    }
  });
}
window.addEventListener("resize", () => {
  if (els.sortMenu.classList.contains("open")) {
    adjustSortMenuPlacement();
  }
});
els.sortToggle.addEventListener("click", () => {
  // Keep click for touch/keyboard usage.
  setSortMenuOpen(!els.sortMenu.classList.contains("open"));
});
els.sortMenu.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest(".sort-item");
  if (!(btn instanceof HTMLButtonElement)) return;
  const sort = btn.getAttribute("data-sort");
  if (!sort) return;
  setSort(sort);
  setSortMenuOpen(false);
  renderQueueCards(queueEnriched);
});
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".sort-wrap")) return;
  clearSortCloseTimer();
  setSortMenuOpen(false);
});
els.settingsPanel.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest(".reveal-btn");
  if (!(btn instanceof HTMLButtonElement)) return;
  const targetId = btn.getAttribute("data-target");
  if (!targetId) return;
  const input = document.getElementById(targetId);
  if (!(input instanceof HTMLInputElement)) return;
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  btn.textContent = reveal ? "Hide" : "Show";
  const label = btn.getAttribute("aria-label") || "secret";
  btn.setAttribute("aria-label", label.replace(reveal ? "Show" : "Hide", reveal ? "Hide" : "Show"));
});
els.addToggle.addEventListener("click", () => setAddOpen(true));
els.openTorrent.addEventListener("click", () => {
  els.torrentFileInput.value = "";
  els.torrentFileInput.click();
});
els.torrentFileInput.addEventListener("change", () => {
  const file = els.torrentFileInput.files?.[0];
  if (!file) return;
  void sendTorrentFileBlob(file).catch((e) => setStatus(String(e), true));
});
els.addClose.addEventListener("click", () => setAddOpen(false));
els.addBackdrop.addEventListener("click", () => setAddOpen(false));

els.tabQueue.addEventListener("click", () => setTab("queue"));
els.tabHistory.addEventListener("click", () => setTab("history"));
els.refreshHistory.addEventListener("click", () => void fetchHistory());
els.clearHistory.addEventListener("click", async () => {
  await tauriInvoke("clear_history");
  await fetchHistory();
});
els.historyBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const del = target.closest(".row-delete");
  if (del) {
    const idRaw = del.getAttribute("data-history-id");
    const id = Number(idRaw);
    if (!Number.isFinite(id)) return;
    const ok = await tauriInvoke("delete_history_entry", { id });
    if (ok) {
      setStatus("History entry deleted.");
      await fetchHistory();
    }
    return;
  }
  const chip = target.closest(".hash-chip");
  if (!chip) return;
  const hash = chip.getAttribute("data-hash");
  if (!hash) return;
  try {
    await navigator.clipboard.writeText(hash);
    setStatus(`Copied hash: ${hash.slice(0, 5)}…`);
  } catch {
    setStatus("Failed to copy hash.", true);
  }
});
els.historyBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const chip = target.closest(".path-chip");
  if (!chip) return;
  const path = chip.getAttribute("data-path");
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    setStatus("Copied path.");
  } catch {
    setStatus("Failed to copy path.", true);
  }
});
els.media.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest(".poster-link-btn");
  if (!btn) return;
  const url = btn.getAttribute("data-url");
  if (!url) return;
  void openExternalUrl(url);
});
els.queueCards.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const posterLink = target.closest(".poster-link-btn");
  if (posterLink) {
    const url = posterLink.getAttribute("data-url");
    if (url) void openExternalUrl(url);
    return;
  }
  const actionBtn = target.closest(".card-menu-item");
  if (actionBtn) {
    const hash = actionBtn.getAttribute("data-hash");
    const action = actionBtn.getAttribute("data-action");
    if (!hash || !action) return;
    await runTorrentAction(hash, action).catch((e) => setStatus(String(e), true));
    return;
  }
  const chip = target.closest(".path-chip");
  if (!chip) return;
  const path = chip.getAttribute("data-path");
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    setStatus("Copied path.");
  } catch {
    setStatus("Failed to copy path.", true);
  }
});
els.queueCards.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const chip = target.closest(".name-chip");
  if (!chip) return;
  const raw = chip.getAttribute("data-raw-name");
  if (!raw) return;
  try {
    await navigator.clipboard.writeText(raw);
    setStatus("Copied original name.");
  } catch {
    setStatus("Failed to copy original name.", true);
  }
});
els.send.addEventListener("click", () => void sendMagnet().catch((e) => setStatus(String(e), true)));
els.magnet.addEventListener("input", () => {
  scheduleAutoParse();
});
els.savePath.addEventListener("input", () => {
  // Keep preview path in sync without re-parsing server side.
  void parseMagnet();
});
els.searchInput.addEventListener("input", () => {
  renderQueueCards(queueEnriched);
  renderSearchSuggestions();
});
els.searchInput.addEventListener("focus", () => {
  renderSearchSuggestions();
});
els.searchInput.addEventListener("blur", () => {
  window.setTimeout(() => {
    els.searchSuggest.classList.remove("open");
  }, 120);
});
els.searchSuggest.addEventListener("mousedown", (event) => {
  event.preventDefault();
});
els.searchSuggest.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest(".search-suggest-item");
  if (!btn) return;
  const value = btn.getAttribute("data-value");
  if (!value) return;
  els.searchInput.value = value;
  els.searchSuggest.classList.remove("open");
  renderQueueCards(queueEnriched);
});

window.addEventListener("keydown", (e) => {
  markUserActivity();
  const isRefreshCombo =
    (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "r";
  if (isRefreshCombo) {
    e.preventDefault();
    void refreshAll({ force: true }).catch((err) => setStatus(String(err), true));
    return;
  }
  if (e.key === "Escape") {
    setSettingsOpen(false);
    setAddOpen(false);
  }
});
for (const ev of ["pointerdown", "mousemove", "scroll", "touchstart", "input"]) {
  window.addEventListener(
    ev,
    () => {
      markUserActivity();
    },
    { passive: true }
  );
}
window.addEventListener("blur", () => {
  stopAutoRefresh();
});
window.addEventListener("focus", () => {
  void refreshAll({ force: true, silent: true }).catch((e) => setStatus(String(e), true));
  void consumePendingMagnet();
  void consumePendingTorrentFile();
  startAutoRefresh();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAutoRefresh();
    return;
  }
  void refreshAll({ force: true, silent: true }).catch((e) => setStatus(String(e), true));
  void consumePendingMagnet();
  void consumePendingTorrentFile();
  startAutoRefresh();
});

if (listen) {
  console.info("[deep-link] magnet-link listener registered");
  await listen("magnet-link", (event) => {
    const payload = event.payload;
    if (typeof payload === "string" && payload.startsWith("magnet:")) {
      console.info("[deep-link] live magnet-link event", payload.slice(0, 96));
      applyIncomingMagnet(payload);
    }
  });
  await listen("torrent-file-link", (event) => {
    const payload = event.payload;
    if (typeof payload === "string" && /\.torrent$/i.test(payload.trim())) {
      console.info("[deep-link] live torrent-file-link event", payload);
      applyIncomingTorrentFile(payload);
    }
  });
} else {
  console.info("[deep-link] listen API unavailable");
}

hydrateFromStorage();
setSendButtonLabel();
await consumePendingMagnet();
await consumePendingTorrentFile();
if (!els.magnet.value.trim()) {
  renderMedia(null);
}

await refreshAll({ force: true }).catch((e) => setStatus(String(e), true));
startAutoRefresh();
