// ============================================================================
// Ghost Block — background service worker
// ============================================================================
//
// This is the "brain" of the extension. It doesn't block anything directly —
// declarativeNetRequest (a browser-native API) does the actual network
// blocking, and the content scripts (cosmetic.js, detect.js, guard.js,
// antidetect.js) do
// the on-page work. This file's job is to:
//
//   1. Own the single source of truth for settings (chrome.storage.local).
//   2. Whenever settings change, push the right configuration into
//      declarativeNetRequest (which static rulesets are on, which sites are
//      allow-listed, which domains you've personally approved for blocking)
//      and into chrome.scripting (whether the fingerprint-guard script is
//      registered, and for which sites).
//   3. Maintain an approximate "blocked request" counter for the popup badge.
//   4. Receive "I think this might be an ad" reports from detect.js and
//      turn them into the popup's review queue.
//
// Manifest V3 runs this as a service worker, which Chrome can put to sleep
// and wake up at any time — so nothing here relies on in-memory state
// surviving between calls except short-lived caches like
// blockedDomainSetPromise below, which are cheap to rebuild on wake.

// The four static rulesets declared in manifest.json's
// declarative_net_request.rule_resources. "ads"+"privacy" together are the
// "Ad & tracker blocking" toggle in the popup; "annoyances" is the separate
// "Anti-adblock-wall defeat" toggle; "consent" is "Cookie banner blocking"
// (blocks the consent-management-platform scripts — Sourcepoint, OneTrust,
// TrustArc, and similar — that render most cookie/tracking-consent
// banners, so blocking the script itself usually prevents the banner from
// ever appearing).
const BLOCKING_RULESET_IDS = ["ads", "privacy"];
const ANNOYANCE_RULESET_IDS = ["annoyances"];
const CONSENT_RULESET_IDS = ["consent"];

// Ids we register the two MAIN-world content scripts under via
// chrome.scripting.registerContentScripts. Needs to be stable across calls
// so we can look them up again later to update/unregister them.
const GUARD_SCRIPT_ID = "ghostblock-guard";
const ANTIDETECT_SCRIPT_ID = "ghostblock-antidetect";

// Everything the popup can toggle, plus the data arrays the ad-learning
// review queue and per-site pause feature read/write. getSettings() below
// always returns an object with every one of these keys present, falling
// back to these defaults for anything not yet written to storage (e.g. on
// a fresh install, or a setting added in a later version of the extension).
const DEFAULT_SETTINGS = {
  enabled: true, // master on/off switch, overrides every other toggle
  blockingEnabled: true, // EasyList/EasyPrivacy network + cosmetic rules
  annoyancesEnabled: true, // anti-adblock-killer rules
  consentEnabled: true, // EasyList cookie-consent-banner rules
  fingerprintGuard: true, // canvas/WebGL/audio noise + hardware-info rounding
  learnCandidates: true, // whether detect.js scans pages for new ad candidates
  whitelist: [], // hostnames where you've hit "Pause" — all protection off there
  approved: [], // { domain, selector, approvedAt } entries you approved from the review queue
};

// How many pending candidates the review queue keeps before evicting the
// oldest ones — keeps chrome.storage.local from growing unbounded on a
// machine that's been browsing for a long time without reviewing anything.
const MAX_CANDIDATES = 100;

// declarativeNetRequest's "dynamic rules" are a single flat id space shared
// by everything this extension adds at runtime (as opposed to the static
// rules baked into rules/*.dnr.json at build time). We put two unrelated
// kinds of dynamic rules in that same space — per-site "allow" rules from
// the Pause button, and personal "block" rules from the approved-candidates
// list — so they need non-overlapping id ranges or a rebuild of one set
// could accidentally collide with (and silently clobber) an id from the
// other. Whitelist entries are always a handful, so band 1 is effectively
// infinite headroom before it would ever reach 100000.
const WHITELIST_ID_BASE = 1;
const APPROVED_ID_BASE = 100000;

// Reads every key in DEFAULT_SETTINGS out of chrome.storage.local and
// layers it over the defaults, so callers never have to worry about a key
// being `undefined` (e.g. right after install, before anything's been
// written) — they always get a fully-populated settings object back.
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Builds the two match-pattern forms ("exact host" and "any subdomain of
// host") Chrome's extension APIs expect, for excluding a whitelisted site
// from the dynamically-registered guard script's `matches`.
function matchPatternsFor(hostname) {
  return [`*://${hostname}/*`, `*://*.${hostname}/*`];
}

// ----------------------------------------------------------------------------
// Static ruleset enable/disable
// ----------------------------------------------------------------------------
// The "Ad & tracker blocking", "Anti-adblock-wall defeat", and "Cookie
// banner blocking" popup toggles (plus the master switch) map directly onto
// declarativeNetRequest's updateEnabledRulesets — Chrome does the actual
// enabling/disabling of the pre-compiled rules in rules/*.dnr.json; we just
// tell it which of the four named rulesets should currently be active.
async function syncRulesets() {
  const { enabled, blockingEnabled, annoyancesEnabled, consentEnabled } = await getSettings();
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  (enabled && blockingEnabled ? enableRulesetIds : disableRulesetIds).push(...BLOCKING_RULESET_IDS);
  (enabled && annoyancesEnabled ? enableRulesetIds : disableRulesetIds).push(...ANNOYANCE_RULESET_IDS);
  (enabled && consentEnabled ? enableRulesetIds : disableRulesetIds).push(...CONSENT_RULESET_IDS);
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
}

// ----------------------------------------------------------------------------
// Dynamic rules: per-site pause (allow) + personally-approved blocks
// ----------------------------------------------------------------------------
// Unlike the static rulesets above (which are just switched on/off wholesale
// and never change their rule content), dynamic rules are rebuilt from
// scratch here every time settings change, because their *content* (which
// hostnames, which domains) is exactly what changed. The simplest correct
// approach — remove every dynamic rule we currently have, then add the full
// set back — avoids any bookkeeping about which individual rule changed.
async function syncDynamicRules() {
  const { whitelist, approved } = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // One "allow" rule per whitelisted (paused) site. Its priority (10000) is
  // set far above the highest priority any static rule can have (2, for
  // filter-list rules marked $important) so this always wins the match —
  // a paused site should never have ANY static rule block a request on it.
  // The condition matches by *initiator* domain (the page making the
  // request), not the request's own domain, so it correctly allows
  // third-party ad/tracker requests triggered *by* the paused page too.
  const allowRules = whitelist.map((hostname, i) => ({
    id: WHITELIST_ID_BASE + i,
    priority: 10000,
    action: { type: "allow" },
    condition: {
      initiatorDomains: [hostname],
      resourceTypes: [
        "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
        "object", "xmlhttprequest", "ping", "media", "websocket", "other",
      ],
    },
  }));

  // One "block" rule per domain you've approved from the ad-learning review
  // queue (see handleCandidate near the bottom of this file). These are
  // ordinary domain-anchor blocks — `||domain^` blocks that exact hostname
  // and any subdomain of it, same semantics as a normal EasyList rule.
  const blockRules = approved.map((entry, i) => ({
    id: APPROVED_ID_BASE + i,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter: `||${entry.domain}^` },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [...allowRules, ...blockRules] });
}

// ----------------------------------------------------------------------------
// Fingerprint-guard content script registration
// ----------------------------------------------------------------------------
// guard.js needs to run in the page's own JavaScript world (MAIN), not the
// extension's isolated one, because it has to patch objects like
// CanvasRenderingContext2D.prototype *before* the page's own scripts touch
// them. But MAIN-world content scripts have zero access to chrome.* APIs —
// that bridge simply doesn't exist for that world, by design (it's the same
// world untrusted page code runs in). So guard.js can't read
// chrome.storage.local itself to check "am I supposed to run on this page".
//
// The fix: don't ask guard.js (or antidetect.js, which needs the exact
// same treatment for the exact same reason) to decide. Decide here, in the
// one place that *can* read settings, and control whether/where each
// script runs by registering or unregistering it (and by listing
// whitelisted sites in excludeMatches) rather than by giving it logic to
// skip itself.
async function syncMainWorldScript(scriptId, file, shouldRun, whitelist) {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });

  if (!shouldRun) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    return;
  }

  const definition = {
    id: scriptId,
    js: [file],
    matches: ["<all_urls>"],
    // Paused sites simply never get the script injected at all — cleaner
    // than injecting it everywhere and teaching it to no-op somehow.
    excludeMatches: whitelist.flatMap(matchPatternsFor),
    runAt: "document_start", // must patch natives before the page's own scripts run
    world: "MAIN",
    allFrames: true, // ads/trackers/detection probes often run from an iframe
    persistAcrossSessions: true, // survives service-worker restarts and browser relaunches
  };

  // registerContentScripts errors if a script with this id is already
  // registered, and updateContentScripts errors if it *isn't* — so which
  // one we call depends on whether this has already run since the
  // extension was loaded (or since the last time it was turned off).
  if (existing.length) {
    await chrome.scripting.updateContentScripts([definition]);
  } else {
    await chrome.scripting.registerContentScripts([definition]);
  }
}

async function syncGuardScript() {
  const { enabled, fingerprintGuard, whitelist } = await getSettings();
  await syncMainWorldScript(GUARD_SCRIPT_ID, "src/content/guard.js", enabled && fingerprintGuard, whitelist);
}

// antidetect.js is gated by "Anti-adblock-wall defeat" (annoyancesEnabled),
// not "Fingerprint hardening" — it's a different concern (defeating active
// ad-blocker-detection probes, not fingerprint noise) that happens to need
// the same MAIN-world registration mechanics as guard.js.
async function syncAntidetectScript() {
  const { enabled, annoyancesEnabled, whitelist } = await getSettings();
  await syncMainWorldScript(ANTIDETECT_SCRIPT_ID, "src/content/antidetect.js", enabled && annoyancesEnabled, whitelist);
}

// The one function that actually needs to run whenever *any* setting
// changes — re-derives every piece of runtime configuration (rulesets,
// dynamic rules, both MAIN-world script registrations) from current
// settings. Cheap enough to just always run all of them rather than
// figuring out which specific one a given settings change actually affects.
async function applyAll() {
  await Promise.all([syncRulesets(), syncDynamicRules(), syncGuardScript(), syncAntidetectScript()]);
}

// Fires once when the extension is first installed, and again on every
// update (including "reload" from chrome://extensions during development).
chrome.runtime.onInstalled.addListener(() => {
  applyAll();
  reinjectIntoOpenTabs();
});
// Fires when Chrome itself starts up with the extension already installed —
// dynamic rules and content-script registrations set with
// persistAcrossSessions survive this automatically, but we resync anyway in
// case settings were somehow edited while the browser was closed.
chrome.runtime.onStartup.addListener(applyAll);

// The popup writes directly to chrome.storage.local for every toggle and
// for the review-queue approve/ignore actions (see popup.js) — it never
// calls into this file directly. This listener is what actually reacts to
// those writes and pushes the resulting configuration out to
// declarativeNetRequest / chrome.scripting.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = ["enabled", "blockingEnabled", "annoyancesEnabled", "consentEnabled", "fingerprintGuard", "whitelist", "approved"];
  if (keys.some((k) => k in changes)) applyAll();
});

// manifest.json's content_scripts only auto-attach to *new* page loads from
// the moment the extension is registered. A tab that was already open
// before you clicked "Load unpacked" (or before an update finished) won't
// get cosmetic.js/detect.js until it navigates or reloads on its own — so
// on install/update we walk every currently-open http(s) tab and inject
// them manually, once, so protection is active immediately everywhere.
async function reinjectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    // .catch(() => {}) because this can legitimately fail for tabs Chrome
    // won't let extensions inject into (chrome://, the Web Store, etc.) —
    // those are filtered out by the http(s)-only query above in the common
    // case, but a failed injection here isn't worth surfacing as an error.
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["src/content/cosmetic.js"] })
      .catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["src/content/detect.js"] })
      .catch(() => {});
  }
}

// ============================================================================
// Approximate per-tab "blocked requests" badge
// ============================================================================
//
// Chrome deliberately does not give production (Chrome-Web-Store-installed)
// extensions a "this exact request was blocked by rule X" event —
// declarativeNetRequest.onRuleMatchedDebug exists, but only fires for
// extensions running unpacked in Developer Mode, specifically so a
// installed-from-the-store extension can't use it to build a detailed log
// of everything blocked on every site you visit.
//
// So instead of a precise readout, we approximate: watch requests (without
// blocking them ourselves — declarativeNetRequest already does the actual
// blocking) and count the ones whose hostname appears in the same
// blocked-domain list the static rules were compiled from. It's a close
// proxy — anything in that list that declarativeNetRequest blocks, this
// counts — but it's not a perfect readout of DNR's internal rule matching
// (e.g. it can't see rule-level exceptions from other extensions' rulesets,
// which don't apply here anyway since we're a single extension, but in
// principle this counts "looks blockable" rather than "was blocked").

// Lazily loads rules/blocked-domains.json (built by build/convert.mjs — see
// that file) into a Set the first time it's needed, and caches the promise
// so concurrent/later calls reuse the same in-memory Set rather than
// re-fetching and re-parsing a ~2MB JSON file on every single request.
let blockedDomainSetPromise;
function getBlockedDomainSet() {
  if (!blockedDomainSetPromise) {
    blockedDomainSetPromise = fetch(chrome.runtime.getURL("rules/blocked-domains.json"))
      .then((r) => r.json())
      .then((list) => new Set(list));
  }
  return blockedDomainSetPromise;
}

// True if `hostname` or any of its parent domains (but not the bare TLD) is
// in `domainSet`. Mirrors declarativeNetRequest's own `||domain^` matching
// semantics, where a rule for "example.com" also matches "ads.example.com".
// e.g. for "a.b.example.com" this checks "a.b.example.com", "b.example.com",
// and "example.com" — but never just "com".
function isBlockedHostname(hostname, domainSet) {
  const parts = hostname.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (domainSet.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

// Adds `delta` to the stored count for a tab (or resets it to 0 first, when
// `reset` is true — used on navigation to a new page) and immediately
// reflects the new total on the extension's toolbar badge for that tab.
// Counts live in chrome.storage.session rather than a plain in-memory
// variable because the service worker can be killed and restarted by
// Chrome between requests; session storage survives that (but not a full
// browser restart, which is fine — a fresh page load resets the count
// anyway).
async function bumpCount(tabId, delta, reset = false) {
  const key = `count_${tabId}`;
  const current = reset ? 0 : ((await chrome.storage.session.get(key))[key] ?? 0);
  const next = current + delta;
  await chrome.storage.session.set({ [key]: next });
  chrome.action.setBadgeText({ tabId, text: next > 0 ? String(next) : "" }).catch(() => {});
}

chrome.action.setBadgeBackgroundColor({ color: "#5b5bd6" });

// webRequest.onBeforeRequest here is purely observational — we never
// register a "blocking" listener (Manifest V3 doesn't allow that for
// regular extensions anyway; only declarativeNetRequest can actually block
// in MV3). This listener exists solely to drive the approximate badge
// count described above.
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    // tabId is -1 for requests not associated with any tab (e.g. the
    // browser's own background fetches) — nothing to badge for those.
    if (details.tabId < 0) return;

    if (details.type === "main_frame") {
      // A new top-level navigation starting in this tab — reset the count
      // to 0 so it reflects "this page", not a running total across every
      // page the tab has ever visited.
      await bumpCount(details.tabId, 0, true);
      return;
    }

    let hostname;
    try {
      hostname = new URL(details.url).hostname;
    } catch {
      return; // malformed/non-standard URL, nothing sensible to check
    }

    const domainSet = await getBlockedDomainSet();
    if (isBlockedHostname(hostname, domainSet)) {
      const { enabled, blockingEnabled, whitelist } = await getSettings();
      if (!enabled || !blockingEnabled) return; // blocking is off; nothing was actually blocked

      // Even though this specific request's *own* domain is on the blocked
      // list, if the *page* it's loading into is paused (whitelisted), the
      // dynamic allow-rule in syncDynamicRules means declarativeNetRequest
      // actually let it through — so don't count it as blocked.
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

// Free the stored count once a tab closes — nothing else ever needs it
// again, and leaving it around would slowly leak session-storage entries
// for every tab you've ever opened.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`count_${tabId}`);
});

// ============================================================================
// Local ad-learning review queue
// ============================================================================
//
// detect.js runs on every page (when the "Learn new ads" toggle is on) and
// heuristically flags third-party iframes/images that look like ads but
// aren't covered by the static filter lists — see that file for exactly how
// it decides "looks like an ad". It sends what it finds here via
// chrome.runtime.sendMessage; this is where those reports turn into the
// popup's "New ads found on this device" list.
//
// Nothing from detect.js ever becomes an active block automatically. A
// candidate only turns into a real declarativeNetRequest rule once you
// personally click the ✓ (approve) button on it in the popup — see
// popup.js's approveCandidate, which writes into the `approved` settings
// array that syncDynamicRules (above) turns into block rules.
async function handleCandidate({ domain, selector, pageHost }) {
  if (!domain) return;

  // If the static filter lists already cover this domain, there's nothing
  // new to learn — surfacing it in the review queue would just be noise.
  const domainSet = await getBlockedDomainSet();
  if (isBlockedHostname(domain, domainSet)) return;

  const { candidates = [], approved = [], dismissed = [] } = await chrome.storage.local.get([
    "candidates",
    "approved",
    "dismissed",
  ]);
  // Already decided (either way) — don't re-surface it.
  if (dismissed.includes(domain) || approved.some((a) => a.domain === domain)) return;

  const idx = candidates.findIndex((c) => c.domain === domain);
  if (idx !== -1) {
    // Seen this domain before (maybe on a different page, or the same page
    // reloaded) — just bump its sighting count/timestamp rather than adding
    // a duplicate row to the review queue.
    candidates[idx].count = (candidates[idx].count || 1) + 1;
    candidates[idx].lastSeen = Date.now();
    if (selector && !candidates[idx].selector) candidates[idx].selector = selector;
  } else {
    // New candidate — added to the front so the popup shows the most
    // recently-seen ones first.
    candidates.unshift({ domain, selector: selector || null, pageHost, firstSeen: Date.now(), lastSeen: Date.now(), count: 1 });
    // Cap the list so a machine that's been browsing for weeks without
    // anyone reviewing the queue doesn't grow chrome.storage.local
    // unboundedly — oldest (least recently added) candidates fall off.
    if (candidates.length > MAX_CANDIDATES) candidates.length = MAX_CANDIDATES;
  }
  await chrome.storage.local.set({ candidates });
}

// The only message type any content script in this extension sends. Note
// this can only ever receive messages from this extension's own scripts —
// a page's own JavaScript has no way to call chrome.runtime.sendMessage
// into this listener (externally_connectable isn't declared in
// manifest.json), so there's no path for a malicious site to inject fake
// candidates.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "candidate-found") handleCandidate(message).catch(() => {});
});

// Note: there's no equivalent "approveCandidate"/"ignoreCandidate" message
// handler here — the popup performs those writes directly against
// chrome.storage.local (see popup.js). That's enough on its own: writing to
// the `approved` array trips the storage.onChanged listener above, which
// calls applyAll(), which calls syncDynamicRules(), which turns the new
// approved entry into a real block rule. No message round-trip needed.
