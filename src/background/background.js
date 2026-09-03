// Service worker: owns settings, keeps declarativeNetRequest rulesets and
// the dynamically-registered fingerprint-guard content script in sync with
// them, and maintains an approximate per-tab blocked-request counter for
// the popup's badge (approximate because Chrome doesn't expose a
// production-safe "this exact rule matched" event — see README).

const BLOCKING_RULESET_IDS = ["ads", "privacy"];
const ANNOYANCE_RULESET_IDS = ["annoyances"];
const GUARD_SCRIPT_ID = "ghostblock-guard";

const DEFAULT_SETTINGS = {
  enabled: true,
  blockingEnabled: true,
  annoyancesEnabled: true,
  fingerprintGuard: true,
  whitelist: [],
};

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

function matchPatternsFor(hostname) {
  return [`*://${hostname}/*`, `*://*.${hostname}/*`];
}

async function syncRulesets() {
  const { enabled, blockingEnabled, annoyancesEnabled } = await getSettings();
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  (enabled && blockingEnabled ? enableRulesetIds : disableRulesetIds).push(...BLOCKING_RULESET_IDS);
  (enabled && annoyancesEnabled ? enableRulesetIds : disableRulesetIds).push(...ANNOYANCE_RULESET_IDS);
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
}

async function syncWhitelistDynamicRules() {
  const { whitelist } = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = whitelist.map((hostname, i) => ({
    id: i + 1,
    priority: 10000, // comfortably above any static rule's priority (max 2)
    action: { type: "allow" },
    condition: {
      initiatorDomains: [hostname],
      resourceTypes: [
        "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
        "object", "xmlhttprequest", "ping", "media", "websocket", "other",
      ],
    },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// The fingerprint guard runs in the page's own JS world (MAIN), which means
// it can never read chrome.storage itself — content scripts declared for
// the MAIN world have no bridge to extension APIs. So instead of teaching
// guard.js to ask permission, we register/unregister/rescope it from here,
// and a site that's off or whitelisted simply never gets the script at all.
async function syncGuardScript() {
  const { enabled, fingerprintGuard, whitelist } = await getSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [GUARD_SCRIPT_ID] });

  if (!enabled || !fingerprintGuard) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [GUARD_SCRIPT_ID] });
    return;
  }

  const definition = {
    id: GUARD_SCRIPT_ID,
    js: ["src/content/guard.js"],
    matches: ["<all_urls>"],
    excludeMatches: whitelist.flatMap(matchPatternsFor),
    runAt: "document_start",
    world: "MAIN",
    allFrames: true,
    persistAcrossSessions: true,
  };

  if (existing.length) {
    await chrome.scripting.updateContentScripts([definition]);
  } else {
    await chrome.scripting.registerContentScripts([definition]);
  }
}

async function applyAll() {
  await Promise.all([syncRulesets(), syncWhitelistDynamicRules(), syncGuardScript()]);
}

chrome.runtime.onInstalled.addListener(() => {
  applyAll();
  reinjectIntoOpenTabs();
});
chrome.runtime.onStartup.addListener(applyAll);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = ["enabled", "blockingEnabled", "annoyancesEnabled", "fingerprintGuard", "whitelist"];
  if (keys.some((k) => k in changes)) applyAll();
});

// Content scripts only auto-attach to *new* navigations; without this, tabs
// that were already open at install/update time keep running unprotected
// until the user reloads them.
async function reinjectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["src/content/cosmetic.js"] })
      .catch(() => {});
  }
}

// ---- Approximate per-tab blocked-request badge ----
//
// Chrome does not give production extensions a "this request was blocked by
// rule X" event (onRuleMatchedDebug is unpacked/dev-mode only). Instead we
// passively observe requests and count the ones whose hostname is in our
// own blocked-domain set — an approximation of what declarativeNetRequest
// is actually blocking, not a direct readout of it.
let blockedDomainSetPromise;
function getBlockedDomainSet() {
  if (!blockedDomainSetPromise) {
    blockedDomainSetPromise = fetch(chrome.runtime.getURL("rules/blocked-domains.json"))
      .then((r) => r.json())
      .then((list) => new Set(list));
  }
  return blockedDomainSetPromise;
}

function isBlockedHostname(hostname, domainSet) {
  const parts = hostname.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (domainSet.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

async function bumpCount(tabId, delta, reset = false) {
  const key = `count_${tabId}`;
  const current = reset ? 0 : ((await chrome.storage.session.get(key))[key] ?? 0);
  const next = current + delta;
  await chrome.storage.session.set({ [key]: next });
  chrome.action.setBadgeText({ tabId, text: next > 0 ? String(next) : "" }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: "#5b5bd6" });

chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") {
      await bumpCount(details.tabId, 0, true);
      return;
    }
    let hostname;
    try {
      hostname = new URL(details.url).hostname;
    } catch {
      return;
    }
    const domainSet = await getBlockedDomainSet();
    if (isBlockedHostname(hostname, domainSet)) {
      const { enabled, blockingEnabled, whitelist } = await getSettings();
      if (!enabled || !blockingEnabled) return;
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      if (tab?.url) {
        const tabHost = new URL(tab.url).hostname;
        if (whitelist.includes(tabHost)) return;
      }
      await bumpCount(details.tabId, 1);
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`count_${tabId}`);
});
