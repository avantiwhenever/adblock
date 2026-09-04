// ============================================================================
// Ghost Block — cosmetic ad-hiding content script
// ============================================================================
//
// Runs in every frame of every page (ISOLATED world — it has full access to
// chrome.storage/chrome.runtime, unlike guard.js which runs in the page's
// own MAIN world and has none). Its one job: hide the leftover HTML markup
// around ads.
//
// Why this is needed on top of network blocking: declarativeNetRequest
// (configured in the background worker) stops the ad's actual iframe/image
// *request* from ever loading, and Chrome automatically collapses that
// specific blocked element to zero size. But sites almost always wrap ads in
// their own container markup — a <div class="ad-slot"> with padding/borders/
// a "Advertisement" label — and that wrapper is ordinary page content, not a
// blocked network request, so it's left behind as an empty box unless
// something hides it too. That's what this file does, using the same
// EasyList-style cosmetic (CSS) rules real ad blockers use for this.
(async () => {
  // Settings this script cares about:
  //   enabled/blockingEnabled — same master + "Ad & tracker blocking"
  //     toggles the background worker uses to decide whether to enable the
  //     static declarativeNetRequest rulesets. If either is off, there's
  //     nothing to hide (nothing was blocked), so bail immediately.
  //   whitelist — hostnames where the popup's "Pause" button was hit; this
  //     script has no other way to know that (unlike guard.js, it doesn't
  //     get excluded via chrome.scripting registration, since it's declared
  //     statically in manifest.json — so it checks storage itself instead).
  //   approved — domains/selectors you personally approved from the
  //     ad-learning review queue (see background.js/detect.js); their
  //     selectors get hidden the same way as the built-in filter list ones.
  const { enabled = true, blockingEnabled = true, whitelist = [], approved = [] } = await chrome.storage.local.get([
    "enabled",
    "blockingEnabled",
    "whitelist",
    "approved",
  ]);
  if (!enabled || !blockingEnabled) return;

  // Build every parent-domain suffix of the current hostname — e.g. for
  // "www.example.co.uk" this produces ["www.example.co.uk",
  // "example.co.uk", "co.uk"] — so both an exact whitelist/rule match and a
  // parent-domain match are found by simple array membership below. (This
  // is a deliberately simple heuristic, not true public-suffix-list-aware
  // domain parsing — see README's Limitations section.)
  const hostname = location.hostname;
  const suffixes = [];
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length - 1; i++) suffixes.push(labels.slice(i).join("."));

  // If this site (or any parent domain of it) was paused from the popup,
  // stop here — no cosmetic hiding at all on a paused site.
  if (whitelist.some((w) => suffixes.includes(w))) return;

  // rules/cosmetic-generic.json and rules/cosmetic-specific.json are built
  // by build/convert.mjs from EasyList/EasyPrivacy/anti-adblock-killer's
  // "##selector" cosmetic rules. "Generic" selectors (no domain prefix in
  // the source filter list) apply on every site; "specific" ones are keyed
  // by the domain(s) the original filter list line named. Both are fetched
  // via chrome.runtime.getURL rather than declared in
  // web_accessible_resources, so a page's own JavaScript has no way to
  // request these URLs itself — only this extension's own content-script
  // code can (see README's "hides itself from page JS" point).
  const [genericRes, specificRes] = await Promise.all([
    fetch(chrome.runtime.getURL("rules/cosmetic-generic.json")),
    fetch(chrome.runtime.getURL("rules/cosmetic-specific.json")),
  ]);
  const [generic, specific] = await Promise.all([genericRes.json(), specificRes.json()]);

  // Start with every generic selector, then layer in any domain-specific
  // ones that match this page's hostname or one of its parent domains.
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
  // (typos, syntax the list author's target browser supports but this one
  // doesn't yet, etc). Standard CSS parsing treats a comma-separated
  // selector list as all-or-nothing — one invalid selector anywhere in the
  // list would silently drop every selector in that single combined rule,
  // hiding nothing at all. So each selector is tested individually first
  // (calling querySelector against a detached, empty DocumentFragment is a
  // cheap way to trigger CSS's selector-parsing validation without
  // actually querying real page content), and only the ones that parse
  // cleanly get joined into the final rule.
  const valid = [];
  for (const sel of selectors) {
    try {
      document.createDocumentFragment().querySelector(sel);
      valid.push(sel);
    } catch {
      // Malformed selector — skip it, not worth hiding the whole batch over.
    }
  }
  if (valid.length === 0) return;

  // Inject one combined CSS rule that hides everything matched. Deliberately
  // no id/class/data-* attribute on this <style> element: an unmarked tag
  // gives a page's own JavaScript nothing distinctive to search the DOM
  // for, consistent with this extension's goal of not being detectable by
  // the sites it's protecting you on. Appending to documentElement (rather
  // than waiting for <head> to exist) works even before the page has
  // finished parsing its own <head>, since this runs at document_start.
  const style = document.createElement("style");
  style.textContent = `${valid.join(",")}{display:none!important}`;
  (document.documentElement || document.head || document.body).appendChild(style);
})();
