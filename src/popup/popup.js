// ============================================================================
// Ghost Block — popup UI logic
// ============================================================================
//
// Runs in the popup's own page context (a normal extension page, full
// chrome.* access, same as any content script's ISOLATED world). This file
// never touches declarativeNetRequest or chrome.scripting directly — it
// only reads/writes chrome.storage.local. background.js's
// storage.onChanged listener is what reacts to those writes and actually
// pushes the resulting configuration into declarativeNetRequest/scripting.
// That indirection means this file can stay simple: it's just a view over
// the same settings object the background worker already knows how to
// apply.

// Mirrors background.js's DEFAULT_SETTINGS for the fields this popup reads/
// displays (it doesn't need `approved`, which the popup only ever appends
// to, never reads back for display here).
const DEFAULT_SETTINGS = {
  enabled: true,
  blockingEnabled: true,
  annoyancesEnabled: true,
  consentEnabled: true,
  fingerprintGuard: true,
  learnCandidates: true,
  whitelist: [],
};

// Caps for the review-queue UI: MAX_DISMISSED bounds how large the
// "dismissed" list (domains you've clicked ✕ on) can grow — old entries
// fall off the front once the cap is hit, same reasoning as
// background.js's MAX_CANDIDATES. MAX_CANDIDATE_ROWS is purely cosmetic:
// the popup is small, so only the most recent few candidates are shown
// with a "+N more" summary for the rest.
const MAX_DISMISSED = 500;
const MAX_CANDIDATE_ROWS = 5;

// One-time lookup of every element this script touches, by the ids defined
// in popup.html — keeps the rest of the file free of repeated
// getElementById calls.
const els = {
  statusDot: document.getElementById("status-dot"),
  masterToggle: document.getElementById("master-toggle"),
  count: document.getElementById("count"),
  siteHost: document.getElementById("site-host"),
  siteToggle: document.getElementById("site-toggle"),
  protoBlocking: document.getElementById("proto-blocking"),
  protoAnnoyances: document.getElementById("proto-annoyances"),
  protoConsent: document.getElementById("proto-consent"),
  protoFingerprint: document.getElementById("proto-fingerprint"),
  protoLearn: document.getElementById("proto-learn"),
  candidatesSection: document.getElementById("candidates-section"),
  candidatesList: document.getElementById("candidates-list"),
  whitelistSection: document.getElementById("whitelist-section"),
  whitelistList: document.getElementById("whitelist-list"),
};

// The tab the popup was opened for, and its hostname — both resolved once
// in init() below and reused throughout (the popup's own lifetime is short
// and tied to one tab, so there's no need to re-query these).
let currentTab = null;
let currentHostname = null;

// Same pattern as background.js's getSettings(): read every known setting
// key out of storage, defaulting anything missing.
async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Pushes a settings object onto every control in the popup — called after
// every load and after every change (local or from another copy of the
// popup/options surface, via the storage.onChanged listener at the bottom
// of this file) so the UI never goes stale.
function render(settings) {
  els.masterToggle.checked = settings.enabled;
  els.statusDot.classList.toggle("off", !settings.enabled);
  els.protoBlocking.checked = settings.blockingEnabled;
  els.protoAnnoyances.checked = settings.annoyancesEnabled;
  els.protoConsent.checked = settings.consentEnabled;
  els.protoFingerprint.checked = settings.fingerprintGuard;
  els.protoLearn.checked = settings.learnCandidates;

  // "Paused" here means this exact hostname (not a parent domain — the
  // popup only ever adds/removes the exact current hostname, unlike the
  // content scripts' broader suffix-matching whitelist check) is in the
  // whitelist array.
  const paused = currentHostname && settings.whitelist.includes(currentHostname);
  els.siteToggle.textContent = paused ? "Resume" : "Pause";
  els.siteToggle.classList.toggle("paused", paused);

  // When the master switch is off, every finer-grained toggle is
  // meaningless (nothing they control would actually run) — disable them
  // in the UI to make that clear, rather than letting you flip a setting
  // that currently has no visible effect.
  const disableFine = !settings.enabled;
  for (const el of [els.protoBlocking, els.protoAnnoyances, els.protoConsent, els.protoFingerprint, els.protoLearn, els.siteToggle]) {
    el.disabled = disableFine;
  }
}

// Convenience wrapper: re-read settings from storage and re-render
// everything (toggles + the paused-sites list + the review queue) —
// called on init and whenever storage changes.
async function refresh() {
  const settings = await getSettings();
  render(settings);
  renderWhitelist(settings.whitelist);
  await renderCandidates();
}

// Builds one row of the "Paused sites" list: the hostname plus a single
// "×" button that resumes protection there. Unlike the current-tab
// Pause/Resume button, this can remove a site you're not currently
// visiting — there's no tab to reload, so protection simply resumes the
// next time that site is loaded.
function whitelistRow(hostname) {
  const row = document.createElement("div");
  row.className = "whitelist-row";

  const host = document.createElement("div");
  host.className = "whitelist-host";
  host.textContent = hostname;

  const removeBtn = document.createElement("button");
  removeBtn.title = "Resume protection on this site";
  removeBtn.textContent = "✕";
  removeBtn.addEventListener("click", () => removeFromWhitelist(hostname).catch(() => {}));

  row.append(host, removeBtn);
  return row;
}

// Renders the full "Paused sites" list from the whitelist array already
// fetched by refresh() — no separate storage read needed, unlike
// renderCandidates (which is called from places that don't already have
// settings in hand).
function renderWhitelist(whitelist) {
  els.whitelistList.replaceChildren();
  els.whitelistSection.hidden = whitelist.length === 0;
  for (const hostname of whitelist) {
    els.whitelistList.appendChild(whitelistRow(hostname));
  }
}

// Removes one hostname from the whitelist, regardless of whether it's the
// current tab's site — pauseOrResumeSite (below) handles the current-tab
// case and also reloads that tab; this one only updates storage, since a
// paused site you're not currently viewing has no tab to reload.
async function removeFromWhitelist(hostname) {
  const settings = await getSettings();
  const whitelist = settings.whitelist.filter((h) => h !== hostname);
  await chrome.storage.local.set({ whitelist });
  // Immediate feedback rather than waiting for the storage.onChanged
  // round-trip — matches pauseOrResumeSite's pattern below.
  render({ ...settings, whitelist });
  renderWhitelist(whitelist);
}

// The "blocked on this page" counter — reads the same per-tab count
// background.js's webRequest listener maintains in chrome.storage.session
// (see that file's bumpCount/badge-counting section for how it's computed
// and why it's only approximate).
async function updateCount() {
  if (!currentTab) return;
  const key = `count_${currentTab.id}`;
  const { [key]: count = 0 } = await chrome.storage.session.get(key);
  els.count.textContent = String(count);
}

// Builds one row of the "New ads found" review queue for a single
// candidate: the domain, a small "seen on X · Nx" caption, and the
// approve (✓) / ignore (✕) buttons. Built with createElement/textContent
// throughout rather than innerHTML — candidate.domain and pageHost
// ultimately come from page content (via detect.js), so treating them as
// trusted HTML would be an XSS risk; textContent never interprets its
// input as markup.
function candidateRow(candidate) {
  const row = document.createElement("div");
  row.className = "candidate-row";

  const info = document.createElement("div");
  info.className = "candidate-domain";
  info.textContent = candidate.domain;
  const seen = document.createElement("span");
  seen.className = "seen";
  seen.textContent = `seen on ${candidate.pageHost}${candidate.count > 1 ? ` · ${candidate.count}×` : ""}`;
  info.appendChild(seen);

  const actions = document.createElement("div");
  actions.className = "candidate-actions";
  const approveBtn = document.createElement("button");
  approveBtn.className = "approve";
  approveBtn.title = "Block this domain";
  approveBtn.textContent = "✓";
  approveBtn.addEventListener("click", () => approveCandidate(candidate).catch(() => {}));
  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "ignore";
  ignoreBtn.title = "Not an ad, ignore";
  ignoreBtn.textContent = "✕";
  ignoreBtn.addEventListener("click", () => ignoreCandidate(candidate.domain).catch(() => {}));
  actions.append(approveBtn, ignoreBtn);

  row.append(info, actions);
  return row;
}

// Re-reads the candidates list from storage and rebuilds the review-queue
// section from scratch (replaceChildren clears whatever was there before).
// The section itself is hidden entirely (via the `hidden` attribute set in
// popup.html) when there's nothing to review, so a popup with an empty
// queue doesn't show an empty "New ads found" header for no reason.
async function renderCandidates() {
  const { candidates = [] } = await chrome.storage.local.get("candidates");
  els.candidatesList.replaceChildren();
  els.candidatesSection.hidden = candidates.length === 0;
  if (candidates.length === 0) return;

  for (const candidate of candidates.slice(0, MAX_CANDIDATE_ROWS)) {
    els.candidatesList.appendChild(candidateRow(candidate));
  }
  if (candidates.length > MAX_CANDIDATE_ROWS) {
    const more = document.createElement("div");
    more.className = "candidates-more";
    more.textContent = `+${candidates.length - MAX_CANDIDATE_ROWS} more`;
    els.candidatesList.appendChild(more);
  }
}

// Moves a candidate from "pending review" to "approved": removes it from
// the `candidates` array and appends it to `approved`. Writing to
// `approved` is what actually matters here — background.js's
// storage.onChanged listener sees that write, calls applyAll(), and
// syncDynamicRules() turns this entry into a real declarativeNetRequest
// block rule (see that file for the full chain). This function itself
// never talks to declarativeNetRequest or messages the background worker —
// the storage write alone is enough to trigger everything downstream.
async function approveCandidate(candidate) {
  const { candidates = [], approved = [] } = await chrome.storage.local.get(["candidates", "approved"]);
  await chrome.storage.local.set({
    candidates: candidates.filter((c) => c.domain !== candidate.domain),
    approved: [...approved, { domain: candidate.domain, selector: candidate.selector || null, approvedAt: Date.now() }],
  });
}

// Moves a candidate from "pending review" to "permanently dismissed" — it
// won't be suggested again (background.js's handleCandidate checks the
// `dismissed` array and skips anything already in it). Uses a Set to dedupe
// before re-truncating to MAX_DISMISSED, since ignoring the same domain
// twice (e.g. seen again on a different page before the queue refreshed)
// shouldn't create a duplicate entry.
async function ignoreCandidate(domain) {
  const { candidates = [], dismissed = [] } = await chrome.storage.local.get(["candidates", "dismissed"]);
  const nextDismissed = [...new Set([...dismissed, domain])].slice(-MAX_DISMISSED);
  await chrome.storage.local.set({
    candidates: candidates.filter((c) => c.domain !== domain),
    dismissed: nextDismissed,
  });
}

// The Pause/Resume button toggles this exact hostname's membership in the
// whitelist array, then reloads the tab so the change (blocking on/off,
// cosmetic hiding on/off, fingerprint guard registered/not) takes effect
// immediately rather than only on the *next* navigation.
async function pauseOrResumeSite() {
  if (!currentHostname) return;
  const settings = await getSettings();
  const isPaused = settings.whitelist.includes(currentHostname);
  const whitelist = isPaused
    ? settings.whitelist.filter((h) => h !== currentHostname)
    : [...settings.whitelist, currentHostname];
  await chrome.storage.local.set({ whitelist });
  // Render immediately with the new value rather than waiting for the
  // storage.onChanged round-trip, so the button's label/state flips the
  // instant you click it.
  render({ ...settings, whitelist });
  renderWhitelist(whitelist);
  if (currentTab?.id !== undefined) chrome.tabs.reload(currentTab.id);
}

async function init() {
  // The popup always opens scoped to whichever tab was active when you
  // clicked the toolbar icon.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  if (currentTab?.url && /^https?:/.test(currentTab.url)) {
    currentHostname = new URL(currentTab.url).hostname;
    els.siteHost.textContent = currentHostname;
  } else {
    // chrome://, the Web Store, a local file, etc. — there's no meaningful
    // "pause this site" action on a page like that, so the button is
    // disabled rather than left clickable with nothing sensible to do.
    els.siteHost.textContent = "Not available on this page";
    els.siteToggle.disabled = true;
  }

  await refresh();
  await updateCount();

  // Every toggle follows the same pattern: on change, write exactly one
  // key to chrome.storage.local. Nothing here decides what that change
  // *means* — background.js's storage.onChanged listener does that, by
  // recomputing the full runtime configuration from scratch (see that
  // file's applyAll).
  //
  // Every write below is fire-and-forget (no await — the checkbox should
  // feel instant, not wait on a round-trip) with a .catch(() => {}): the
  // popup can close mid-write the moment you click a checkbox and move
  // your mouse away, which is completely normal and not worth surfacing
  // as an unhandled promise rejection in the console.
  els.masterToggle.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: els.masterToggle.checked }).catch(() => {});
  });

  els.protoBlocking.addEventListener("change", () => {
    chrome.storage.local.set({ blockingEnabled: els.protoBlocking.checked }).catch(() => {});
  });
  els.protoAnnoyances.addEventListener("change", () => {
    chrome.storage.local.set({ annoyancesEnabled: els.protoAnnoyances.checked }).catch(() => {});
  });
  els.protoConsent.addEventListener("change", () => {
    chrome.storage.local.set({ consentEnabled: els.protoConsent.checked }).catch(() => {});
  });
  els.protoFingerprint.addEventListener("change", () => {
    chrome.storage.local.set({ fingerprintGuard: els.protoFingerprint.checked }).catch(() => {});
  });
  els.protoLearn.addEventListener("change", () => {
    chrome.storage.local.set({ learnCandidates: els.protoLearn.checked }).catch(() => {});
  });

  els.siteToggle.addEventListener("click", () => {
    pauseOrResumeSite().catch(() => {});
  });
}

// Keeps the popup in sync if settings change from somewhere other than this
// popup instance's own event handlers above — e.g. if you have the popup
// open in one window and change a toggle from a second window's popup, or
// (more commonly) right after init()'s own writes echo back through
// storage.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh().catch(() => {});
});

init().catch(() => {});
