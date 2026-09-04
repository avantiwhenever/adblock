// ISOLATED-world content script: hides leftover ad containers/wrappers via
// CSS (declarativeNetRequest already blocks and auto-collapses the actual
// blocked sub-resource — this handles the wrapper markup around it).
(async () => {
  const { enabled = true, blockingEnabled = true, whitelist = [], approved = [] } = await chrome.storage.local.get([
    "enabled",
    "blockingEnabled",
    "whitelist",
    "approved",
  ]);
  if (!enabled || !blockingEnabled) return;

  const hostname = location.hostname;
  const suffixes = [];
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length - 1; i++) suffixes.push(labels.slice(i).join("."));
  if (whitelist.some((w) => suffixes.includes(w))) return;

  const [genericRes, specificRes] = await Promise.all([
    fetch(chrome.runtime.getURL("rules/cosmetic-generic.json")),
    fetch(chrome.runtime.getURL("rules/cosmetic-specific.json")),
  ]);
  const [generic, specific] = await Promise.all([genericRes.json(), specificRes.json()]);

  const selectors = new Set(generic);
  for (const suffix of suffixes) {
    const entries = specific[suffix];
    if (entries) for (const s of entries) selectors.add(s);
  }
  // Selectors you've personally approved from the review queue (see
  // background.js / detect.js) — applied globally, same as any other
  // generic cosmetic rule.
  for (const entry of approved) {
    if (entry.selector) selectors.add(entry.selector);
  }
  if (selectors.size === 0) return;

  // Selectors come from a public filter list; a handful may be invalid CSS
  // (typos, newer syntax) which would break the *entire* combined rule if
  // joined naively, so validate before joining.
  const valid = [];
  for (const sel of selectors) {
    try {
      document.createDocumentFragment().querySelector(sel);
      valid.push(sel);
    } catch {
      // skip malformed selector
    }
  }
  if (valid.length === 0) return;

  // No id/class/data attribute on purpose: a plain, unmarked <style> tag
  // gives page script nothing distinctive to grep for.
  const style = document.createElement("style");
  style.textContent = `${valid.join(",")}{display:none!important}`;
  (document.documentElement || document.head || document.body).appendChild(style);
})();
