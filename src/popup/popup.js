const DEFAULT_SETTINGS = {
  enabled: true,
  blockingEnabled: true,
  annoyancesEnabled: true,
  fingerprintGuard: true,
  whitelist: [],
};

const els = {
  statusDot: document.getElementById("status-dot"),
  masterToggle: document.getElementById("master-toggle"),
  count: document.getElementById("count"),
  siteHost: document.getElementById("site-host"),
  siteToggle: document.getElementById("site-toggle"),
  protoBlocking: document.getElementById("proto-blocking"),
  protoAnnoyances: document.getElementById("proto-annoyances"),
  protoFingerprint: document.getElementById("proto-fingerprint"),
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

  const paused = currentHostname && settings.whitelist.includes(currentHostname);
  els.siteToggle.textContent = paused ? "Resume" : "Pause";
  els.siteToggle.classList.toggle("paused", paused);

  const disableFine = !settings.enabled;
  for (const el of [els.protoBlocking, els.protoAnnoyances, els.protoFingerprint, els.siteToggle]) {
    el.disabled = disableFine;
  }
}

async function refresh() {
  render(await getSettings());
}

async function updateCount() {
  if (!currentTab) return;
  const key = `count_${currentTab.id}`;
  const { [key]: count = 0 } = await chrome.storage.session.get(key);
  els.count.textContent = String(count);
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
