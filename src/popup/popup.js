const DEFAULT_SETTINGS = {
  enabled: true,
  blockingEnabled: true,
  annoyancesEnabled: true,
  fingerprintGuard: true,
  learnCandidates: true,
  whitelist: [],
};

const MAX_DISMISSED = 500;
const MAX_CANDIDATE_ROWS = 5;

const els = {
  statusDot: document.getElementById("status-dot"),
  masterToggle: document.getElementById("master-toggle"),
  count: document.getElementById("count"),
  siteHost: document.getElementById("site-host"),
  siteToggle: document.getElementById("site-toggle"),
  protoBlocking: document.getElementById("proto-blocking"),
  protoAnnoyances: document.getElementById("proto-annoyances"),
  protoFingerprint: document.getElementById("proto-fingerprint"),
  protoLearn: document.getElementById("proto-learn"),
  candidatesSection: document.getElementById("candidates-section"),
  candidatesList: document.getElementById("candidates-list"),
};

let currentTab = null;
let currentHostname = null;

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

function render(settings) {
  els.masterToggle.checked = settings.enabled;
  els.statusDot.classList.toggle("off", !settings.enabled);
  els.protoBlocking.checked = settings.blockingEnabled;
  els.protoAnnoyances.checked = settings.annoyancesEnabled;
  els.protoFingerprint.checked = settings.fingerprintGuard;
  els.protoLearn.checked = settings.learnCandidates;

  const paused = currentHostname && settings.whitelist.includes(currentHostname);
  els.siteToggle.textContent = paused ? "Resume" : "Pause";
  els.siteToggle.classList.toggle("paused", paused);

  const disableFine = !settings.enabled;
  for (const el of [els.protoBlocking, els.protoAnnoyances, els.protoFingerprint, els.protoLearn, els.siteToggle]) {
    el.disabled = disableFine;
  }
}

async function refresh() {
  render(await getSettings());
  await renderCandidates();
}

async function updateCount() {
  if (!currentTab) return;
  const key = `count_${currentTab.id}`;
  const { [key]: count = 0 } = await chrome.storage.session.get(key);
  els.count.textContent = String(count);
}

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
  approveBtn.addEventListener("click", () => approveCandidate(candidate));
  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "ignore";
  ignoreBtn.title = "Not an ad, ignore";
  ignoreBtn.textContent = "✕";
  ignoreBtn.addEventListener("click", () => ignoreCandidate(candidate.domain));
  actions.append(approveBtn, ignoreBtn);

  row.append(info, actions);
  return row;
}

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

async function approveCandidate(candidate) {
  const { candidates = [], approved = [] } = await chrome.storage.local.get(["candidates", "approved"]);
  await chrome.storage.local.set({
    candidates: candidates.filter((c) => c.domain !== candidate.domain),
    approved: [...approved, { domain: candidate.domain, selector: candidate.selector || null, approvedAt: Date.now() }],
  });
}

async function ignoreCandidate(domain) {
  const { candidates = [], dismissed = [] } = await chrome.storage.local.get(["candidates", "dismissed"]);
  const nextDismissed = [...new Set([...dismissed, domain])].slice(-MAX_DISMISSED);
  await chrome.storage.local.set({
    candidates: candidates.filter((c) => c.domain !== domain),
    dismissed: nextDismissed,
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  if (currentTab?.url && /^https?:/.test(currentTab.url)) {
    currentHostname = new URL(currentTab.url).hostname;
    els.siteHost.textContent = currentHostname;
  } else {
    els.siteHost.textContent = "Not available on this page";
    els.siteToggle.disabled = true;
  }

  await refresh();
  await updateCount();

  els.masterToggle.addEventListener("change", () => {
    chrome.storage.local.set({ enabled: els.masterToggle.checked });
  });

  els.protoBlocking.addEventListener("change", () => {
    chrome.storage.local.set({ blockingEnabled: els.protoBlocking.checked });
  });
  els.protoAnnoyances.addEventListener("change", () => {
    chrome.storage.local.set({ annoyancesEnabled: els.protoAnnoyances.checked });
  });
  els.protoFingerprint.addEventListener("change", () => {
    chrome.storage.local.set({ fingerprintGuard: els.protoFingerprint.checked });
  });
  els.protoLearn.addEventListener("change", () => {
    chrome.storage.local.set({ learnCandidates: els.protoLearn.checked });
  });

  els.siteToggle.addEventListener("click", async () => {
    if (!currentHostname) return;
    const settings = await getSettings();
    const isPaused = settings.whitelist.includes(currentHostname);
    const whitelist = isPaused
      ? settings.whitelist.filter((h) => h !== currentHostname)
      : [...settings.whitelist, currentHostname];
    await chrome.storage.local.set({ whitelist });
    render({ ...settings, whitelist });
    if (currentTab?.id !== undefined) chrome.tabs.reload(currentTab.id);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});

init();
