// ISOLATED-world content script: heuristically spots ads that slipped past
// the static filter lists, and reports candidates to the background worker
// for your review (popup → "New ads found"). Nothing here auto-blocks —
// see background.js's handleCandidate for why, and README for the
// false-positive tradeoffs of heuristic detection in general.
(async () => {
  const { enabled = true, blockingEnabled = true, learnCandidates = true, whitelist = [] } =
    await chrome.storage.local.get(["enabled", "blockingEnabled", "learnCandidates", "whitelist"]);
  if (!enabled || !blockingEnabled || !learnCandidates) return;

  const hostname = location.hostname;
  const labels = hostname.split(".");
  const suffixes = [];
  for (let i = 0; i < labels.length - 1; i++) suffixes.push(labels.slice(i).join("."));
  if (whitelist.some((w) => suffixes.includes(w))) return;

  const AD_SIZES = new Set([
    "300x250", "728x90", "160x600", "320x50", "300x600", "970x250", "336x280",
    "300x50", "320x100", "970x90", "468x60", "234x60", "120x600", "300x100",
  ]);
  // Whole-word match only, after splitting camelCase/kebab/snake into words —
  // avoids false positives like "adobe", "headphones", "leads", "shadow".
  const AD_WORD_RE = /(^|[-_ ])(ad|ads|advert|advertisement|advertising|sponsor|sponsored|promoted)([-_ ]|$)/i;

  function toWords(el) {
    const raw = [el.id, typeof el.className === "string" ? el.className : ""].join(" ");
    return raw.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  }

  function isThirdParty(url) {
    try {
      return new URL(url, location.href).hostname !== hostname;
    } catch {
      return false;
    }
  }

  function selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (typeof el.className === "string" && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/)[0];
      if (cls) return `.${CSS.escape(cls)}`;
    }
    return null;
  }

  const reported = new Set();
  function report(domain, selector) {
    if (!domain || reported.has(domain)) return;
    reported.add(domain);
    chrome.runtime.sendMessage({ type: "candidate-found", domain, selector, pageHost: hostname }).catch(() => {});
  }

  function inspect(el) {
    if (el.tagName === "IFRAME" || el.tagName === "IMG") {
      const src = el.tagName === "IFRAME" ? el.src : el.currentSrc || el.src;
      if (!src || !isThirdParty(src)) return;
      const w = el.width || el.getBoundingClientRect().width;
      const h = el.height || el.getBoundingClientRect().height;
      const sizeMatch = AD_SIZES.has(`${Math.round(w)}x${Math.round(h)}`);
      const wordMatch = AD_WORD_RE.test(toWords(el)) || AD_WORD_RE.test(toWords(el.parentElement || {}));
      if (!sizeMatch && !wordMatch) return;
      let domain;
      try {
        domain = new URL(src, location.href).hostname;
      } catch {
        return;
      }
      report(domain, selectorFor(el.parentElement && (el.parentElement.id || el.parentElement.className) ? el.parentElement : el));
    }
  }

  function scan(root) {
    root.querySelectorAll("iframe,img").forEach(inspect);
  }

  scan(document);

  let pending = false;
  const observer = new MutationObserver((mutations) => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "IFRAME" || node.tagName === "IMG") inspect(node);
          else if (node.querySelectorAll) scan(node);
        }
      }
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
