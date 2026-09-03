# Ghost Block

A Manifest V3 Chrome extension that blocks ads and trackers, fights back
against anti-adblock walls, and makes itself and your browser harder for
sites to fingerprint. No telemetry, no phone-home, no account.

## What it does

- **Ad & tracker blocking** — network-level blocking via
  `declarativeNetRequest`, compiled from EasyList and EasyPrivacy (~27,000
  rules, the most reliable/general ones prioritized to fit Chrome's
  guaranteed static-rule budget). Plus cosmetic CSS hiding for ~13,600
  generic ad-container selectors and ~8,000 site-specific ones.
- **Anti-adblock-wall defeat** — blocks the scripts sites use to detect an
  adblocker and nag/paywall you, sourced from the
  [anti-adblock-killer](https://github.com/reek/anti-adblock-killer) list.
- **Fingerprint hardening** — adds noise to canvas/WebGL/AudioContext reads
  and rounds off `hardwareConcurrency`/`deviceMemory`, so those signals
  can't be used to uniquely identify your browser. This is best-effort
  JS-level noise, not engine-level resistance like Brave/Tor Browser — see
  *Limitations* below.
- **Hides itself from page JS** — no `web_accessible_resources`, the
  fingerprint guard is injected via `chrome.scripting.registerContentScripts`
  (not a `<script src="chrome-extension://...">` tag, which would leak the
  extension's ID into the page's DOM), and patched native functions disguise
  themselves under `Function.prototype.toString` so a site checking "is this
  really native code" doesn't learn an extension is present.
- **No telemetry** — nothing here calls home. Ever.

The popup lets you pause protection on the current site, toggle each
protection layer independently, and see an approximate blocked-request count.

## Loading it in Chrome

Official (non-Chromium) Google Chrome builds no longer honor the
`--load-extension` command-line flag, so this has to go through the UI:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, and select this folder
   (`/Users/avanti/codebase/content/adblock`)
4. Pin it from the extensions toolbar menu if you want the icon visible

After installing, tabs that were already open need a reload to pick up
protection — the extension does this automatically for tabs open at
install/update time, but can't do it retroactively for tabs opened before
that fix ran on first install.

## Rebuilding the filter lists

The compiled rules in `rules/*.json` are checked in, but you can regenerate
them from fresh upstream lists at any time:

```
node build/convert.mjs
```

This re-downloads `build/cache/{easylist,easyprivacy,anti-adblock-killer}.txt`
if missing, and rewrites everything in `rules/`. Run it periodically to pick
up upstream list updates — there's no auto-update mechanism (an extension
that fetches rule updates from a remote server on its own would itself be
a tracking-adjacent behavior we're deliberately avoiding).

## Architecture

```
manifest.json                   MV3 manifest
src/background/background.js    settings, ruleset sync, guard-script
                                 registration, approximate badge counter
src/content/cosmetic.js         ISOLATED world — hides ad containers via CSS
src/content/guard.js            MAIN world — fingerprint noise (registered
                                 dynamically, never in manifest.json, so it
                                 can be excluded per whitelisted site)
src/popup/                      toggle UI
rules/*.dnr.json                declarativeNetRequest static rulesets
rules/cosmetic-*.json           CSS selectors for cosmetic.js
rules/blocked-domains.json      flat domain list, badge-count heuristic only
build/convert.mjs               EasyList-syntax → DNR/cosmetic converter
```

## Limitations (read before relying on this)

- **Blocked-count badge is approximate.** Chrome doesn't expose a
  production-safe "this exact request was blocked by rule X" event
  (`onRuleMatchedDebug` only works for unpacked extensions in dev mode, and
  even then only while DevTools-adjacent tooling is watching). The badge
  instead checks each request's hostname against the same domain list the
  DNR rules were built from — a close proxy, not a direct readout.
- **Cosmetic unhide exceptions (`#@#`) aren't applied.** A small number of
  EasyList entries say "don't hide this selector on this specific site" to
  fix over-hiding; those are currently ignored, so on rare pages a real
  element could be hidden that shouldn't be. Low-frequency in practice.
- **Regex filters, scriptlet injections, and `$csp`/`$redirect`/`$removeparam`
  rules are skipped**, not translated — mistranslating any of these could
  silently break a site or under-block, so they're dropped rather than
  guessed at. This trims some coverage versus a full uBlock-style engine.
- **Static rules are capped at ~27,000** (16k EasyList + 10k EasyPrivacy +
  1.1k anti-adblock) to stay safely inside Chrome's *guaranteed* 30,000
  static-rule budget per extension, regardless of what else is installed.
  The simplest, most reliable domain-block rules are prioritized when
  truncating, so the coverage loss is concentrated in narrow path-specific
  rules rather than whole-domain blocks.
- **Fingerprint hardening is JS-level, not engine-level.** A sufficiently
  determined fingerprinting script combining many weak signals can still
  narrow things down. Real resistance to that requires changes at the
  browser-engine level (this is why Brave/Tor Browser exist as forks rather
  than extensions). Treat this as raising the cost of fingerprinting, not
  eliminating it.
- **The Chrome Web Store install prompt will say "Read and change all your
  data on all websites."** That's `<all_urls>` host permission, which any
  extension that blocks network requests and hides ads sitewide genuinely
  needs — the same permission uBlock Origin and every other real adblocker
  requests. There's no way to block ads without it.
