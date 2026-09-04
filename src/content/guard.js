// ============================================================================
// Ghost Block — fingerprint-hardening guard script
// ============================================================================
//
// MAIN-world script, registered dynamically by the background worker (see
// background.js's syncGuardScript) rather than declared statically in
// manifest.json — that's what lets it be excluded per whitelisted site, or
// unregistered entirely when the "Fingerprint hardening" toggle is off,
// without this file needing any extension-API access of its own. It
// couldn't have that access anyway: MAIN-world content scripts run in the
// page's own JavaScript realm — literally the same global scope the page's
// own <script> tags execute in — so there's no chrome.* bridge available
// here, by design (that world is untrusted from the extension's point of
// view, same as any other page script).
//
// Two jobs:
//   1. Make a handful of common fingerprinting reads (canvas pixel data,
//      WebGL renderer info, audio analysis output, hardware info) noisy or
//      generic enough that they stop uniquely identifying this specific
//      browser/machine.
//   2. Do it invisibly — every patched native function disguises itself
//      under Function.prototype.toString, so a site's own "is this really
//      native browser code, or has something been tampered with" check
//      (a real technique some fingerprinting/anti-adblock scripts use)
//      doesn't reveal that an extension is present.
//
// Honest scope note: this is best-effort JS-level noise, not engine-level
// fingerprint resistance the way Brave or Tor Browser provide it (they
// modify the browser's own C++ implementation of these APIs, which no
// extension can do). A sufficiently determined fingerprinting script
// combining many weak signals together can still narrow things down — see
// README's Limitations section for the fuller version of this caveat. The
// goal here is raising the cost of fingerprinting, not making it
// impossible.
(() => {
  "use strict";

  // ---- The "look native" disguise machinery ----
  //
  // A common technique some scripts use to detect tampering: call
  // `someFunction.toString()` and check whether it returns the browser's
  // standard "[native code]" stub or an actual JavaScript source listing.
  // Any function we patch below (via patchMethod/patchGetter) would
  // otherwise print as real, readable JS source when stringified — an
  // obvious giveaway that *something* modified this API. This WeakMap
  // remembers, for every function we've swapped in, which original native
  // function it replaced, so Function.prototype.toString itself can be
  // patched to print the *original* function's native-looking string
  // instead of the replacement's real source whenever it's asked about one
  // of our patched functions.
  const nativeToStringMap = new WeakMap();
  const realFunctionToString = Function.prototype.toString;

  // Registers `patched` as a disguised stand-in for `original` in the map
  // above, and returns `patched` unchanged — this lets every patch call
  // below wrap its replacement function in a single expression
  // (`disguise(newFn, oldFn)`) rather than needing a separate statement.
  function disguise(patched, original) {
    nativeToStringMap.set(patched, original);
    return patched;
  }

  // Function.prototype.toString is itself patched — using the same
  // disguise() helper on itself — so that even calling
  // `Function.prototype.toString.toString()` (checking whether toString
  // itself has been tampered with) still returns a native-looking result,
  // rather than the source of this very function.
  Function.prototype.toString = disguise(function toString() {
    if (nativeToStringMap.has(this)) return realFunctionToString.call(nativeToStringMap.get(this));
    return realFunctionToString.call(this);
  }, realFunctionToString);

  // Replaces `obj[prop]` (a method) with a new function built by
  // `factory(originalFunction)`, disguised so it stringifies as the
  // original. Silently does nothing if `obj[prop]` doesn't exist as a
  // function to begin with (e.g. running in a context/browser version
  // where some API isn't available) — nothing here should ever throw and
  // break the page it's running on.
  function patchMethod(obj, prop, factory) {
    const original = obj && obj[prop];
    if (typeof original !== "function") return;
    const replacement = disguise(factory(original), original);
    try {
      Object.defineProperty(obj, prop, { value: replacement, writable: true, configurable: true });
    } catch {
      // Some properties are non-configurable in some browser versions —
      // fail closed (leave the original in place) rather than throw.
    }
  }

  // Same idea as patchMethod, but for a getter-defined property (like
  // `navigator.hardwareConcurrency`, which is defined via a getter on
  // Navigator.prototype rather than being a plain data property).
  function patchGetter(obj, prop, getReplacement) {
    const descriptor = obj && Object.getOwnPropertyDescriptor(obj, prop);
    if (!descriptor || typeof descriptor.get !== "function") return;
    const replacement = disguise(getReplacement, descriptor.get);
    try {
      Object.defineProperty(obj, prop, { ...descriptor, get: replacement });
    } catch {}
  }

  // ---- Noise generation ----
  //
  // One random 32-bit seed, generated fresh every time this script runs
  // (i.e. once per page load/browser session — it is never written to
  // storage or otherwise persisted). Every noise value derived from it
  // below is a deterministic function of (seed, position), so repeated
  // reads of the *same* pixel/frequency-bin within one page load return
  // consistent values (a canvas re-read a moment later won't mysteriously
  // change, which would itself look broken/suspicious) — but a different
  // page load, or the same site visited again after a browser restart,
  // gets a completely different seed and therefore different noise. That's
  // what keeps this from becoming a stable fingerprint in its own right.
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];

  // A small, fast, seed-dependent pseudo-random function returning -1, 0,
  // or 1 for a given integer index `i`. Math.imul does 32-bit integer
  // multiplication (avoiding floating-point precision issues), and the
  // final shift+mod extracts a well-distributed low-order result from the
  // mixed bits.
  function noiseAt(i) {
    const h = (Math.imul(i, 2654435761) ^ seed) >>> 0;
    return ((h >>> 24) % 3) - 1; // -1, 0, or 1
  }

  // Adds ±1 (or 0) of noise to the R/G/B channels of every pixel in an
  // ImageData object, in place. Alpha (the 4th byte of each pixel) is left
  // untouched — alpha noise would risk visible transparency artifacts for
  // very little fingerprinting benefit. The noise is small enough to be
  // imperceptible to a human looking at the canvas, but large enough that
  // a fingerprinting script hashing the exact pixel bytes gets a different
  // hash than it would from an unmodified browser.
  function noisifyImageData(imageData) {
    const { data, width } = imageData;
    for (let i = 0; i < data.length; i += 4) {
      const n = noiseAt(i / 4);
      if (n === 0) continue;
      const px = (i / 4) % width;
      data[i] = Math.min(255, Math.max(0, data[i] + n));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n));
      void px; // computed for clarity/future use; not currently needed by the noise function itself
    }
    return imageData;
  }

  // ---- Canvas fingerprinting ----
  //
  // The classic "canvas fingerprint" technique: draw some text/shapes to an
  // off-screen canvas, then read back the exact pixel bytes (via
  // getImageData or a toDataURL()-encoded image) and hash them. Because
  // font rendering, anti-aliasing, and GPU/driver behavior vary subtly
  // across machines, that hash tends to be highly distinctive per device —
  // which is exactly why it's noised here.
  //
  // Design choice: never modify the *visible* canvas itself, only the data
  // handed back to the calling script. Directly mutating a canvas the page
  // might also be displaying on-screen risks visible artifacts for
  // legitimate uses (image editors, games, chart libraries, etc.) — so
  // getImageData is noised on its *return value* only (it already returns
  // a fresh copy of the pixel data, not a live view into the canvas), and
  // toDataURL/toBlob work against a temporary, invisible "shadow" copy of
  // the canvas instead of the real one (see shadowCopyWithNoise below).
  patchMethod(CanvasRenderingContext2D.prototype, "getImageData", (orig) =>
    function (...args) {
      return noisifyImageData(orig.apply(this, args));
    }
  );

  // Creates an off-screen, never-attached-to-the-page copy of `canvas`,
  // draws the original canvas's current contents onto it, then perturbs
  // that copy's pixels with noise. Used by the toDataURL/toBlob patches
  // below so the *real* canvas (whatever the page is actually displaying)
  // is never touched — only this disposable duplicate is.
  function shadowCopyWithNoise(canvas) {
    const shadow = document.createElement("canvas");
    shadow.width = canvas.width;
    shadow.height = canvas.height;
    const sctx = shadow.getContext("2d");
    sctx.drawImage(canvas, 0, 0);
    if (canvas.width > 0 && canvas.height > 0) {
      const imageData = sctx.getImageData(0, 0, canvas.width, canvas.height);
      noisifyImageData(imageData);
      sctx.putImageData(imageData, 0, 0);
    }
    return shadow;
  }

  patchMethod(HTMLCanvasElement.prototype, "toDataURL", (orig) =>
    function (...args) {
      try {
        // Call the *original*, unpatched toDataURL, but against the noised
        // shadow copy instead of `this` (the real canvas) — `orig.apply`
        // with a different `this` is exactly how you borrow a method to
        // run against a different object in JavaScript.
        return orig.apply(shadowCopyWithNoise(this), args);
      } catch {
        // drawImage throws for a tainted (cross-origin, unreadable) source
        // canvas — in that case there's nothing to noise anyway (the page
        // couldn't read meaningful pixel data from it either way), so just
        // fall back to calling the real method normally.
        return orig.apply(this, args);
      }
    }
  );

  patchMethod(HTMLCanvasElement.prototype, "toBlob", (orig) =>
    function (callback, ...rest) {
      try {
        return orig.call(shadowCopyWithNoise(this), callback, ...rest);
      } catch {
        return orig.call(this, callback, ...rest);
      }
    }
  );

  // ---- WebGL fingerprinting ----
  //
  // WEBGL_debug_renderer_info's UNMASKED_VENDOR_WEBGL/UNMASKED_RENDERER_WEBGL
  // parameters expose the real GPU model and driver string (e.g. "NVIDIA
  // GeForce RTX 4080/PCIe/SSE2"), which is highly distinctive across
  // machines. Every other getParameter() call is passed through unchanged —
  // only these two specific, well-known fingerprinting parameters are
  // replaced with generic, widely-shared strings.
  function genericizeWebGL(proto) {
    patchMethod(proto, "getParameter", (orig) =>
      function (param) {
        if (param === 0x9245) return "Google Inc. (Generic)"; // UNMASKED_VENDOR_WEBGL
        if (param === 0x9246) return "ANGLE (Generic, Generic Direct3D11 vs_5_0 ps_5_0)"; // UNMASKED_RENDERER_WEBGL
        return orig.call(this, param);
      }
    );
  }
  // Guarded with typeof checks since not every page/frame necessarily has
  // WebGL available (and patching a nonexistent global would throw).
  if (typeof WebGLRenderingContext !== "undefined") genericizeWebGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") genericizeWebGL(WebGL2RenderingContext.prototype);

  // ---- AudioContext fingerprinting ----
  //
  // Less well-known than canvas/WebGL fingerprinting, but real: subtle
  // differences in how a machine's audio stack processes a generated
  // signal (floating-point rounding, hardware-specific filtering) produce
  // a measurably distinctive output when read back via an AnalyserNode.
  // Small additive noise on the returned frequency-data arrays disrupts
  // that without making the values obviously wrong (audio analysis data is
  // inherently somewhat noisy/approximate already, so this blends in).
  if (typeof AnalyserNode !== "undefined") {
    patchMethod(AnalyserNode.prototype, "getFloatFrequencyData", (orig) =>
      function (array) {
        orig.call(this, array); // fills `array` in place with the real data first
        for (let i = 0; i < array.length; i++) array[i] += noiseAt(i) / 1000; // float dB values — keep the nudge tiny
      }
    );
    patchMethod(AnalyserNode.prototype, "getByteFrequencyData", (orig) =>
      function (array) {
        orig.call(this, array);
        for (let i = 0; i < array.length; i++) array[i] = Math.min(255, Math.max(0, array[i] + noiseAt(i))); // byte values (0-255) — clamp after adding noise
      }
    );
  }

  // ---- Coarser hardware fingerprints ----
  //
  // navigator.hardwareConcurrency (CPU core count) and navigator.deviceMemory
  // (approximate RAM in GB) are both real, legitimate browser APIs used by
  // sites for performance tuning — but their exact values also narrow down
  // which specific machine you're using. Rounding both to one common value
  // (8, chosen as a value common enough across real devices to blend in
  // rather than stand out) keeps the API functional (still returns a
  // plausible number sites can use for tuning) while erasing the
  // machine-specific precision.
  patchGetter(Navigator.prototype, "hardwareConcurrency", function () {
    return 8;
  });
  patchGetter(Navigator.prototype, "deviceMemory", function () {
    return 8;
  });
})();
