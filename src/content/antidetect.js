// ============================================================================
// Ghost Block — anti-adblock-detection defeat script
// ============================================================================
//
// MAIN-world script, registered dynamically by the background worker (see
// background.js's syncAntidetectScript) — same reasoning as guard.js for
// why it has to be MAIN-world and registered rather than declared
// statically: it needs to act before the page's own detection code runs,
// and MAIN-world scripts have no chrome.* access to ask permission first,
// so the background worker decides whether/where this runs instead.
//
// Gated by the "Anti-adblock-wall defeat" toggle (annoyancesEnabled), not
// "Fingerprint hardening" — this is a different concern from guard.js and
// deliberately kept in its own file so the two toggles stay independent.
//
// What this actually defeats, concretely (reverse-engineered from Yahoo's
// live "AdShield" detection code — see git history for the investigation):
// most ad-block detectors don't just check "did an ad appear", they run an
// active probe and act on the *result of that probe*, and the most common
// probe by far is: fetch Google Publisher Tag's well-known script URL
// (https://securepubads.g.doubleclick.net/tag/js/gpt.js, or the older
// googletagservices.com path) and check whether the response looks like
// the real thing. Blocking that URL — which every real ad blocker does,
// since GPT is what actually renders most display ads — is exactly what
// makes the probe fail and trips the "please disable your ad blocker"
// wall. This patches fetch to answer that specific probe with a synthetic
// "looks fine" response, without ever loading (or executing) the real
// script — the ad-rendering code the real gpt.js contains never runs, so
// blocking is completely unaffected; only the probe is fooled.
(() => {
  "use strict";

  // Same disguise machinery as guard.js (kept self-contained here rather
  // than shared, since this script is independently toggled and MAIN-world
  // scripts can't easily share module state with each other) — see that
  // file for the full explanation of why this exists.
  const nativeToStringMap = new WeakMap();
  const realFunctionToString = Function.prototype.toString;
  function disguise(patched, original) {
    nativeToStringMap.set(patched, original);
    return patched;
  }
  Function.prototype.toString = disguise(function toString() {
    if (nativeToStringMap.has(this)) return realFunctionToString.call(nativeToStringMap.get(this));
    return realFunctionToString.call(this);
  }, realFunctionToString);

  // Matches Google Publisher Tag's script path regardless of which of its
  // known hostnames serves it — this is a fixed, well-documented path
  // Google itself specifies for GPT integration, not something specific to
  // Yahoo; any site probing for GPT's presence this way gets the same
  // synthetic response.
  const GPT_PATH = "/tag/js/gpt.js";

  // A minimal, inert stand-in for gpt.js's response body. Passes the
  // common validation checks detection scripts run against it (contains
  // "googletag", doesn't contain the tells of an obvious no-op stub like
  // "noopFunc"/"noopfn" that some circumvention tools use and some
  // detectors specifically check for) without containing any of the real
  // script's actual ad-rendering logic — window.googletag ends up defined
  // as an inert command-queue object, exactly like the real library
  // exposes before it finishes loading, but nothing here ever renders an
  // ad or makes another network request.
  const FAKE_GPT_BODY = "(function(){window.googletag=window.googletag||{cmd:[]};})();";

  function isGptProbe(url) {
    try {
      return new URL(url, location.href).pathname.endsWith(GPT_PATH);
    } catch {
      return false;
    }
  }

  function fakeGptResponse() {
    return new Response(FAKE_GPT_BODY, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/javascript; charset=UTF-8" },
    });
  }

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = disguise(function fetch(input, init) {
      const url = typeof input === "string" ? input : input?.url;
      if (url && isGptProbe(url)) return Promise.resolve(fakeGptResponse());
      // Bind explicitly to `window` rather than passing through `this`:
      // fetch is very commonly called bare (`fetch(url)`, not
      // `window.fetch(url)`), which under "use strict" makes `this`
      // undefined here — and some native implementations throw "illegal
      // invocation" if fetch is invoked with a non-window receiver.
      return originalFetch.apply(window, arguments);
    }, originalFetch);
  }
})();
