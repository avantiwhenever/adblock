// MAIN-world script, registered dynamically by the background worker (see
// background.js) so it can be excluded per whitelisted site or turned off
// entirely without this file needing any extension-API access of its own —
// which it can't have: MAIN-world content scripts run in the page's own JS
// realm, with no bridge to chrome.*.
//
// Two jobs:
//   1. Make a handful of common fingerprinting reads noisy/generic enough
//      that they don't uniquely identify this browser.
//   2. Do it invisibly — patched natives disguise themselves under
//      Function.prototype.toString so a site checking "is this the real
//      native function" doesn't learn an extension is present.
//
// This is best-effort JS-level noise, not engine-level fingerprint
// resistance (what Brave/Tor Browser do). A determined fingerprinter with
// enough signals can still narrow things down — see README for the honest
// version of this caveat.
(() => {
  "use strict";

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

  function patchMethod(obj, prop, factory) {
    const original = obj && obj[prop];
    if (typeof original !== "function") return;
    const replacement = disguise(factory(original), original);
    try {
      Object.defineProperty(obj, prop, { value: replacement, writable: true, configurable: true });
    } catch {}
  }

  function patchGetter(obj, prop, getReplacement) {
    const descriptor = obj && Object.getOwnPropertyDescriptor(obj, prop);
    if (!descriptor || typeof descriptor.get !== "function") return;
    const replacement = disguise(getReplacement, descriptor.get);
    try {
      Object.defineProperty(obj, prop, { ...descriptor, get: replacement });
    } catch {}
  }

  // Per-session noise seed: stable within one browser session (so repeated
  // reads by the same page are self-consistent and don't look broken), but
  // never persisted, so it can't itself become a stable fingerprint.
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  function noiseAt(i) {
    const h = (Math.imul(i, 2654435761) ^ seed) >>> 0;
    return ((h >>> 24) % 3) - 1; // -1, 0, or 1
  }

  function noisifyImageData(imageData) {
    const { data, width } = imageData;
    for (let i = 0; i < data.length; i += 4) {
      const n = noiseAt(i / 4);
      if (n === 0) continue;
      const px = (i / 4) % width;
      data[i] = Math.min(255, Math.max(0, data[i] + n));
      data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n));
      data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n));
      void px;
    }
    return imageData;
  }

  // --- Canvas fingerprinting: noise the *output*, never the visible canvas ---
  patchMethod(CanvasRenderingContext2D.prototype, "getImageData", (orig) =>
    function (...args) {
      return noisifyImageData(orig.apply(this, args));
    }
  );

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
        return orig.apply(shadowCopyWithNoise(this), args);
      } catch {
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

  // --- WebGL fingerprinting: generic GPU strings instead of the real ones ---
  function genericizeWebGL(proto) {
    patchMethod(proto, "getParameter", (orig) =>
      function (param) {
        if (param === 0x9245) return "Google Inc. (Generic)"; // UNMASKED_VENDOR_WEBGL
        if (param === 0x9246) return "ANGLE (Generic, Generic Direct3D11 vs_5_0 ps_5_0)"; // UNMASKED_RENDERER_WEBGL
        return orig.call(this, param);
      }
    );
  }
  if (typeof WebGLRenderingContext !== "undefined") genericizeWebGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== "undefined") genericizeWebGL(WebGL2RenderingContext.prototype);

  // --- AudioContext fingerprinting: tiny noise on analyser reads ---
  if (typeof AnalyserNode !== "undefined") {
    patchMethod(AnalyserNode.prototype, "getFloatFrequencyData", (orig) =>
      function (array) {
        orig.call(this, array);
        for (let i = 0; i < array.length; i++) array[i] += noiseAt(i) / 1000;
      }
    );
    patchMethod(AnalyserNode.prototype, "getByteFrequencyData", (orig) =>
      function (array) {
        orig.call(this, array);
        for (let i = 0; i < array.length; i++) array[i] = Math.min(255, Math.max(0, array[i] + noiseAt(i)));
      }
    );
  }

  // --- Coarser hardware fingerprints ---
  patchGetter(Navigator.prototype, "hardwareConcurrency", function () {
    return 8;
  });
  patchGetter(Navigator.prototype, "deviceMemory", function () {
    return 8;
  });
})();
