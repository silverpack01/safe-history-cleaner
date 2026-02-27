"use strict";

const REMOTE_KEYWORD_URL  = "https://raw.githubusercontent.com/StevenBlack/hosts/refs/heads/master/hosts";
const ADULT_HIT_THRESHOLD = 2;

const ADULT_WORD_WEIGHTS = {
  "hentai": 3, "hanime": 3, "rule34": 3, "xxx": 3, "x-rated": 3,
  "nsfw": 3, "lewd": 3, "ecchi": 3, "fetish": 3, "pornography": 3,
  "porn": 3, "xvideos": 3, "xnxx": 3, "xhamster": 3, "pornhub": 3,
  "nude": 3, "naked": 3, "18+": 2, "adult": 2, "uncensored": 2,
  "explicit": 2, "sexual": 2, "sensual": 2, "sexy": 1, "provocative": 1,
  "mature": 1, "pleasure": 1, "fantasy": 1, "erotic": 1,
};

const WHITELIST = new Set([
  "wikipedia.org", "stackoverflow.com", "github.com", "youtube.com",
  "reddit.com", "amazon.com", "hotstar.com", "girlscouts.org",
]);

const SEARCH_ENGINES = new Set([
  "google.com", "google.co.uk", "google.com.pk", "google.ca",
  "google.com.au", "bing.com", "duckduckgo.com", "search.yahoo.com",
]);

// ─── Bloom Filter ────────────────────────────────────────────────────────────

class BloomFilter {
  constructor(size = 2 ** 20, hashCount = 4) {
    this.size      = size;
    this.hashCount = hashCount;
    this.bits      = new Uint8Array(Math.ceil(size / 8));
  }

  // FNV-1a variant - fast aur low collision
  _hash(str, seed) {
    let h = 2166136261 ^ seed;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % this.size;
  }

  _bit(pos, set = false) {
    const idx  = pos >> 3;
    const mask = 1 << (pos & 7);
    if (set) this.bits[idx] |= mask;
    return !!(this.bits[idx] & mask);
  }

  add(str) {
    for (let i = 0; i < this.hashCount; i++)
      this._bit(this._hash(str, i * 1000003), true);
  }

  has(str) {
    for (let i = 0; i < this.hashCount; i++)
      if (!this._bit(this._hash(str, i * 1000003))) return false;
    return true;
  }

  // Serialize/deserialize for storage
  toArray()         { return Array.from(this.bits); }
  static from(arr)  {
    const bf = new BloomFilter();
    bf.bits  = new Uint8Array(arr);
    return bf;
  }
}


let domainFilter    = new BloomFilter();
let domainBaseNames = new Set(); // scoreText mein use hota hai
let isInitialized   = false;

// ─── Startup Queue ────────────────────────────────────────────────────────────

const startupQueue = [];

function enqueueOrProcess(url, title = "") {
  if (!isInitialized) {
    startupQueue.push({ url, title });
  } else {
    checkAndDelete(url, title);
  }
}

function flushQueue() {
  while (startupQueue.length > 0) {
    const { url, title } = startupQueue.shift();
    checkAndDelete(url, title);
  }
}

// ─── Keyword Loading ──────────────────────────────────────────────────────────

async function loadKeywords() {
  const newFilter    = new BloomFilter();
  const newBaseNames = new Set();

  function addDomain(domain) {
    if (!domain || !domain.includes(".")) return;
    const d    = domain.toLowerCase().trim();
    const base = d.split(".")[0];
    newFilter.add(d);
    if (base.length >= 4) newBaseNames.add(base);
  }

  // Local blocked.json
  try {
    const res  = await fetch(browser.runtime.getURL("blocked.json"));
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.keywords || []);
    list.forEach(addDomain);
  } catch (e) {
    console.warn("[SHC] blocked.json load failed:", e.message);
  }

  // Remote hosts file
  try {
    const res = await fetch(REMOTE_KEYWORD_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const line of (await res.text()).split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts  = t.split(/\s+/);
      const domain = parts.length >= 2 ? parts[1] : parts[0];
      if (domain && !domain.includes("#")) addDomain(domain);
    }
    await browser.storage.local.set({
      bloomBits:  newFilter.toArray(),
      baseNames:  [...newBaseNames],
      lastUpdate: Date.now(),
    });
    console.info(`[SHC] Remote list loaded, ${newBaseNames.size} base names indexed`);
  } catch (e) {
    console.warn("[SHC] Remote fetch failed, loading cache:", e.message);
    const cache = await browser.storage.local.get(["bloomBits", "baseNames"]);
    if (cache.bloomBits) {
      domainFilter    = BloomFilter.from(cache.bloomBits);
      domainBaseNames = new Set(cache.baseNames || []);
      isInitialized   = true;
      console.info("[SHC] Loaded from cache");
      flushQueue();
      return;
    }
  }

  domainFilter    = newFilter;
  domainBaseNames = newBaseNames;
  isInitialized   = true;
  console.info(`[SHC] Ready - ${domainBaseNames.size} domains indexed`);
  flushQueue();
}

// ─── Text Processing ──────────────────────────────────────────────────────────

function normalizeText(text) {
  if (!text) return "";
  try {
    let s = String(text);
    for (let i = 0; i < 3; i++) {
      if (!s.includes("%")) break;
      s = decodeURIComponent(s);
    }
    return s.toLowerCase().replace(/[^a-z0-9\s./:?=&_-]/g, " ");
  } catch {
    return String(text).toLowerCase();
  }
}

function scoreText(text) {
  let score = 0;

  for (const [word, weight] of Object.entries(ADULT_WORD_WEIGHTS)) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re  = word.includes(" ") ? new RegExp(esc, "i") : new RegExp(`\\b${esc}\\b`, "i");
    if (re.test(text)) score += weight;
  }

  // blocked.json base names check
  for (const base of domainBaseNames) {
    if (text.includes(base)) { score += 3; break; }
  }

  return score;
}

function isAdult(urlText, titleText = "") {
  return (
    scoreText(normalizeText(urlText)) +
    scoreText(normalizeText(titleText))
  ) >= ADULT_HIT_THRESHOLD;
}

function isBlockedDomain(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase().replace(/^www\./, "");

  // O(1) bloom filter check
  if (domainFilter.has(h)) return true;

  // Subdomain check
  const parts = h.split(".");
  for (let i = 1; i < parts.length - 1; i++)
    if (domainFilter.has(parts.slice(i).join("."))) return true;

  return false;
}

// ─── Core Logic ───────────────────────────────────────────────────────────────

async function deleteUrl(url) {
  try {
    await browser.history.deleteUrl({ url });
    console.info("[SHC] Deleted:", url);
  } catch (e) {
    console.warn("[SHC] Delete failed:", e.message);
  }
}

async function checkAndDelete(rawUrl, title = "") {
  if (!rawUrl) return;

  const url = rawUrl
    .replace(/^https\s+/, "https://")
    .replace(/^http\s+/, "http://")
    .replace(/\s+/g, "");

  if (
    url.startsWith("moz-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome://")
  ) return;

  let hostname = "", searchQuery = "";
  try {
    const u     = new URL(url);
    hostname    = u.hostname;
    searchQuery = u.searchParams.get("q") || "";
  } catch { /* malformed */ }

  const h = hostname.toLowerCase().replace(/^www\./, "");

  if (SEARCH_ENGINES.has(h)) {
    if (searchQuery && isAdult(searchQuery)) await deleteUrl(url);
    return;
  }

  if (WHITELIST.has(h)) return;
  if (isBlockedDomain(hostname)) { await deleteUrl(url); return; }
  if (isAdult(url, title)) await deleteUrl(url);
}

async function cleanupHistory() {
  const results = await browser.history.search({
    text: "", startTime: Date.now() - 5 * 60 * 1000, maxResults: 500,
  });
  for (const item of results) await checkAndDelete(item.url, item.title);
}

// ─── Listeners ────────────────────────────────────────────────────────────────

browser.history.onVisited.addListener(item =>
  enqueueOrProcess(item.url, item.title)
);

browser.webNavigation.onCommitted.addListener(details => {
  if (!details.url || details.frameId !== 0 || details.transitionType === "auto_subframe") return;
  setTimeout(async () => {
    const results = await browser.history.search({ text: details.url, maxResults: 1 });
    enqueueOrProcess(details.url, results?.[0]?.title || "");
  }, 800);
});

browser.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (!details.url || details.frameId !== 0) return;
  setTimeout(async () => {
    try {
      const u = new URL(details.url);
      const h = u.hostname.toLowerCase().replace(/^www\./, "");
      const q = u.searchParams.get("q") || "";
      if (SEARCH_ENGINES.has(h) && q && isAdult(q)) await deleteUrl(details.url);
    } catch { /* malformed */ }
  }, 500);
});

// ─── Timers ───────────────────────────────────────────────────────────────────

setInterval(cleanupHistory, 60 * 1000);
setInterval(loadKeywords,   7 * 24 * 60 * 60 * 1000);

loadKeywords().then(cleanupHistory);