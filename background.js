let blockedKeywords = [];
const REMOTE_KEYWORD_URL = "https://raw.githubusercontent.com/coffee-and-fun/google-search-porn-filter/main/blocked_keywords.json"; 

async function loadKeywords() {
    try {
        const localResponse = await fetch(browser.runtime.getURL("blocked.json"));
        const localData = await localResponse.json();
        blockedKeywords = Array.isArray(localData) ? localData : localData.keywords || [];
        console.log("✅ Local keywords loaded:", blockedKeywords.length);
    } catch (err) {
        console.warn("⚠️ Failed to load local blocked.json:", err);
    }

    // Try updating from remote source
    try {
        const response = await fetch(REMOTE_KEYWORD_URL, { cache: "no-store" });
        if (response.ok) {
            const remoteData = await response.json();
            if (Array.isArray(remoteData) && remoteData.length > 0) {
                blockedKeywords = remoteData;
                console.log("🌐 Remote keyword list updated:", blockedKeywords.length);
                await browser.storage.local.set({
                    blockedKeywordsCache: blockedKeywords,
                    lastUpdate: Date.now()
                });
            }
        }
    } catch (err) {
        console.warn("⚠️ Remote keyword update failed:", err);
        // fallback: load from cache if available
        const cache = await browser.storage.local.get("blockedKeywordsCache");
        if (cache.blockedKeywordsCache) {
            blockedKeywords = cache.blockedKeywordsCache;
            console.log("♻️ Loaded keywords from cache:", blockedKeywords.length);
        }
    }
}

// 🔹 Normalize & decode URLs
function normalizeText(text) {
    try {
        let decoded = text;
        while (decoded.includes("%")) decoded = decodeURIComponent(decoded);
        return decoded.toLowerCase();
    } catch {
        return text.toLowerCase();
    }
}

// 🔹 Core filter & delete
async function checkAndDelete(url) {
    const cleanUrl = normalizeText(url);
    try {
        const urlObj = new URL(cleanUrl);

        // ✅ Check Google searches
        if (urlObj.hostname.includes("google.") && urlObj.pathname.includes("/search")) {
            const query = normalizeText(urlObj.searchParams.get("q") || "");
            for (const keyword of blockedKeywords) {
                const regex = new RegExp(`\\b${keyword}\\b`, "i");
                if (regex.test(query) || regex.test(cleanUrl)) {
                    await browser.history.deleteUrl({ url });
                    console.log("🗑️ Deleted Google search with:", keyword);
                    return true;
                }
            }
        }

        // ✅ Normal URLs
        for (const keyword of blockedKeywords) {
            const regex = new RegExp(`\\b${keyword}\\b`, "i");
            if (regex.test(cleanUrl)) {
                await browser.history.deleteUrl({ url });
                console.log("🗑️ Deleted URL:", url);
                return true;
            }
        }
    } catch (err) {
        console.error("URL parsing error:", err);
    }
    return false;
}

// 🔹 Listeners
browser.history.onVisited.addListener(async (item) => {
    await checkAndDelete(item.url);
});

browser.webNavigation.onCommitted.addListener(async (details) => {
    if (details.url && details.transitionType !== "auto_subframe") {
        setTimeout(() => checkAndDelete(details.url), 2000);
    }
});

// 🔹 Periodic cleanup
async function cleanupHistory() {
    const since = Date.now() - 2 * 60 * 1000;
    const results = await browser.history.search({
        text: "",
        startTime: since,
        maxResults: 100
    });
    for (const item of results) {
        await checkAndDelete(item.url);
    }
}
setInterval(cleanupHistory, 2 * 60 * 1000);

// ✅ Initial load
loadKeywords();

// 🔄 Refresh local keywords every 5 min
setInterval(loadKeywords, 5 * 60 * 1000);

// 🌐 Full remote update every 24h
setInterval(loadKeywords, 24 * 60 * 60 * 1000);
