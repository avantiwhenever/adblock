// ============================================================================
// Ghost Block — local ad-learning heuristic scanner
// ============================================================================
//
// Runs once per top-level page (ISOLATED world, like cosmetic.js — it needs
// chrome.runtime.sendMessage). Its job is narrow and deliberately
// conservative: look at the third-party iframes/images actually on the
// page, apply a couple of cheap heuristics for "this looks like an ad", and
// tell the background worker about anything that matches but isn't already
// covered by the static filter lists.
//
// Nothing here blocks anything. It only *reports candidates* — see
// background.js's handleCandidate and popup.js's approve/ignore handling
// for what happens next. That's intentional: these heuristics have real
// false-positive potential (a third-party video embed at a common size
// isn't necessarily an ad), so a human stays in the loop before anything
// becomes an actual block rule. See README's "Local ad-learning" section
// for the full explanation of that tradeoff.
(async () => {
  try {
    await run();
  } catch {
    // See cosmetic.js for why this is swallowed rather than left as an
    // uncaught rejection (most commonly: "Extension context invalidated"
    // after reloading the extension while this tab was already open).
  }
})();

async function run() {
  // Same settings pattern as cosmetic.js, plus the "learnCandidates" toggle
  // specific to this feature (the popup's "Learn new ads (beta)" checkbox).
  const { enabled = true, blockingEnabled = true, learnCandidates = true, whitelist = [] } =
    await chrome.storage.local.get(["enabled", "blockingEnabled", "learnCandidates", "whitelist"]);
  if (!enabled || !blockingEnabled || !learnCandidates) return;

  // Same parent-domain-suffix trick as cosmetic.js, used the same way: skip
  // entirely on a paused (whitelisted) site.
  const hostname = location.hostname;
  const labels = hostname.split(".");
  const suffixes = [];
  for (let i = 0; i < labels.length - 1; i++) suffixes.push(labels.slice(i).join("."));
  if (whitelist.some((w) => suffixes.includes(w))) return;

  // IAB (Interactive Advertising Bureau) standard ad unit dimensions, in
  // "widthxheight" form. Real ad networks overwhelmingly serve creatives at
  // one of these exact sizes, because ad exchanges/publishers coordinate on
  // them — so an iframe/image at one of these sizes, loaded from a
  // different domain than the page itself, is a meaningfully strong signal
  // even before looking at any class names or ids.
  const AD_SIZES = new Set([
    "300x250", "728x90", "160x600", "320x50", "300x600", "970x250", "336x280",
    "300x50", "320x100", "970x90", "468x60", "234x60", "120x600", "300x100",
  ]);

  // Matches "ad", "ads", "advert", "advertisement", "advertising", "sponsor",
  // "sponsored", or "promoted" only as a *whole word* within a class/id —
  // i.e. surrounded by a separator (hyphen/underscore/space) or the start/
  // end of the string. Without the word-boundary requirement, this would
  // false-positive constantly: "adobe", "headphones", "leads", "shadow",
  // "gradient", and "already" all contain the substring "ad" but have
  // nothing to do with advertising.
  const AD_WORD_RE = /(^|[-_ ])(ad|ads|advert|advertisement|advertising|sponsor|sponsored|promoted)([-_ ]|$)/i;

  // Turns an element's id+className into a lowercase, hyphen-separated word
  // string so AD_WORD_RE's word-boundary matching works regardless of
  // whether the site names things "ad-slot" (kebab-case), "ad_slot"
  // (snake_case), or "adSlot" (camelCase) — the camelCase-to-hyphen
  // conversion below normalizes the third form to look like the first.
  function toWords(el) {
    const raw = [el.id, typeof el.className === "string" ? el.className : ""].join(" ");
    return raw.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  }

  // "Third-party" here means "loaded from a different hostname than the
  // page itself" — the same definition EasyList's own $third-party filter
  // option uses. First-party embeds (a site's own images/iframes) are
  // deliberately never flagged, even if they happen to match an ad size or
  // an ad-ish class name, since those are far more likely to be the site's
  // own legitimate content than something worth blocking.
  function isThirdParty(url) {
    try {
      return new URL(url, location.href).hostname !== hostname;
    } catch {
      return false;
    }
  }

  // Picks the most useful CSS selector to eventually hide this element
  // with, if you approve it from the review queue: prefer its own id (most
  // specific), fall back to its first class, or give up (null) if it has
  // neither. CSS.escape guards against ids/classes containing characters
  // that would otherwise break the selector syntax (e.g. a literal ":" or
  // "." inside the id itself, which does happen on some sites).
  function selectorFor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (typeof el.className === "string" && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/)[0];
      if (cls) return `.${CSS.escape(cls)}`;
    }
    return null;
  }

  // Per-page de-dupe: once a given domain has been reported from this page
  // load, don't send another message for it even if more matching elements
  // turn up (background.js also de-dupes across pages/time, but there's no
  // reason to send five identical messages from one page).
  const reported = new Set();
  function report(domain, selector) {
    if (!domain || reported.has(domain)) return;
    reported.add(domain);
    // .catch(() => {}) — the background service worker can occasionally be
    // mid-restart when this fires; a dropped candidate report isn't worth
    // surfacing as an error, it just means this particular sighting is
    // missed (and the same ad will very likely be seen again on a later
    // page load anyway).
    chrome.runtime.sendMessage({ type: "candidate-found", domain, selector, pageHost: hostname }).catch(() => {});
  }

  // The actual heuristic: given one iframe or img element, decide whether
  // it's worth reporting. Requires it to be third-party AND (a standard ad
  // size OR an ad-word-matching class/id on itself or its immediate
  // parent) — third-party alone is far too common (CDNs, video embeds,
  // widgets) to be a useful signal by itself.
  function inspect(el) {
    if (el.tagName === "IFRAME" || el.tagName === "IMG") {
      // <img> exposes both `src` and `currentSrc` (the latter accounts for
      // responsive images with a `srcset`); `currentSrc` is more accurate
      // when present.
      const src = el.tagName === "IFRAME" ? el.src : el.currentSrc || el.src;
      if (!src || !isThirdParty(src)) return;

      // Prefer the element's declared width/height attributes (what the ad
      // network actually requested) over its rendered bounding box, since
      // CSS can stretch/shrink the rendered size in ways that don't reflect
      // the ad unit's real dimensions.
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

      // Hide the parent container if it has an id/class to target (usually
      // the actual ad-slot wrapper, which looks better hidden than just the
      // iframe/img itself, mirroring how the shipped cosmetic rules work);
      // otherwise fall back to hiding the element itself.
      report(domain, selectorFor(el.parentElement && (el.parentElement.id || el.parentElement.className) ? el.parentElement : el));
    }
  }

  function scan(root) {
    root.querySelectorAll("iframe,img").forEach(inspect);
  }

  // Initial pass over whatever's already in the DOM by the time this script
  // runs (document_idle — see manifest.json — so most of the initial page
  // content is already there).
  scan(document);

  // Many ads load well after initial page render (lazy-loaded as you
  // scroll, inserted by the page's own ad-serving JavaScript after some
  // delay, etc.), so a one-time scan at load isn't enough — this watches
  // for new elements being added anywhere in the page for as long as the
  // page stays open.
  let pending = false;
  const observer = new MutationObserver((mutations) => {
    // Debounce: pages can mutate the DOM dozens of times per second during
    // normal interaction (React re-renders, etc.). Batching all mutations
    // from a 500ms window into one pass keeps this from re-scanning on
    // every single tiny DOM change.
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue; // skip text/comment nodes, only elements matter
          if (node.tagName === "IFRAME" || node.tagName === "IMG") inspect(node);
          // A newly-added node might not itself be an iframe/img but could
          // *contain* one or more nested inside it (e.g. a whole ad-slot
          // wrapper div inserted at once) — scan its subtree too.
          else if (node.querySelectorAll) scan(node);
        }
      }
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
