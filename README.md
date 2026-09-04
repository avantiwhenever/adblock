# Ghost Block

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-informational)
![Zero npm dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

A Manifest V3 Chrome extension that blocks ads and trackers, fights back
against anti-adblock walls, and makes itself and your browser harder for
sites to fingerprint. No telemetry, no phone-home, no account, zero npm
dependencies.

## What it does

- **Ad & tracker blocking** — network-level blocking via
  `declarativeNetRequest`, compiled from EasyList and EasyPrivacy (~26,000
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
- **Learns new ads locally (beta)** — a heuristic scanner flags likely-ad
  iframes/images that the filter lists missed (third-party origin, IAB
  standard ad dimensions, or `ad-`/`sponsor`-style container classes on a
  word boundary) and lists them in the popup for you to approve or ignore.
  Nothing blocks automatically — see *Local ad-learning* below.
- **Hides itself from page JS** — no `web_accessible_resources`, the
  fingerprint guard is injected via `chrome.scripting.registerContentScripts`
  (not a `<script src="chrome-extension://...">` tag, which would leak the
  extension's ID into the page's DOM), and patched native functions disguise
  themselves under `Function.prototype.toString` so a site checking "is this
  really native code" doesn't learn an extension is present.
- **No telemetry** — nothing here calls home. Ever.

## Installing it

Official (non-Chromium) Google Chrome builds no longer honor the
`--load-extension` command-line flag, so this has to go through the UI:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right toggle)
3. Click **Load unpacked**, and select this repo's folder
4. Pin it from the puzzle-piece icon in Chrome's toolbar so it's visible

Tabs that were already open at install time get protection injected
automatically once; tabs opened after that are covered as they load
normally. If you ever see a red "Errors" badge on the extension's card in
`chrome://extensions`, click it — that'll show the exact failure.

## How to use it

Click the Ghost Block icon to open the popup.

| Control | What it does |
|---|---|
| Top-right switch | Master on/off for everything, on every site |
| Blocked count | Approximate ads/trackers blocked on the current page (see *Limitations*) |
| **Pause** / **Resume** on "This site" | Turns off *all* protection (blocking, cosmetic hiding, fingerprint guard) for the current site only, and reloads the page. Use this first if a site looks broken. |
| Ad & tracker blocking | Toggles the EasyList/EasyPrivacy network + cosmetic rules |
| Anti-adblock-wall defeat | Toggles the anti-adblock-killer rules |
| Fingerprint hardening | Toggles the canvas/WebGL/audio noise and hardware-info rounding |
| Learn new ads (beta) | Toggles the local heuristic scanner described below |

**If a site breaks after installing:** open the popup on that site and hit
**Pause**. That's a per-site allowlist — it doesn't touch any other site,
and you can **Resume** protection there any time from the same button.

### Local ad-learning (review queue)

With "Learn new ads" on, a content script watches each page for likely ads
that the static filter lists didn't catch — a third-party iframe/image at a
standard ad size (300×250, 728×90, etc.) or sitting in a container whose
class/id contains a whole word like `ad`, `sponsor`, or `advert`. Matches
are **not** blocked automatically. They show up in the popup under "New ads
found on this device" with two buttons:

- **✓ (approve)** — adds a personal block rule for that domain (and hides
  its container via CSS), effective immediately, on every site, from then on.
- **✕ (ignore)** — dismisses it permanently; it won't be suggested again.

Everything here — candidates, approvals, dismissals — lives in
`chrome.storage.local` on your machine only. Nothing is uploaded, and the
list isn't shared back into this repo's `rules/*.json` automatically (see
*Rebuilding the filter lists* if you want to fold something you've learned
back into the shipped rules yourself).

Heuristic detection has false positives. If something you didn't expect
gets hidden, disable "Learn new ads" or use the site Pause button, and
please open an issue with the domain/site so the heuristic can be tightened.

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
                                 registration, ad-learning review queue,
                                 approximate badge counter
src/content/cosmetic.js         ISOLATED world — hides ad containers via CSS
src/content/detect.js           ISOLATED world — heuristic ad-candidate scanner
src/content/guard.js            MAIN world — fingerprint noise (registered
                                 dynamically, never in manifest.json, so it
                                 can be excluded per whitelisted site)
src/popup/                      toggle UI + ad-learning review queue
rules/*.dnr.json                declarativeNetRequest static rulesets
rules/cosmetic-*.json           CSS selectors for cosmetic.js
rules/blocked-domains.json      flat domain list, badge-count heuristic only
build/convert.mjs               EasyList-syntax → DNR/cosmetic converter
build/make-icons.py             generates icons/*.png
```

## Limitations (read before relying on this)

- **Blocked-count badge is approximate.** Chrome doesn't expose a
  production-safe "this exact request was blocked by rule X" event
  (`onRuleMatchedDebug` only works for unpacked extensions in dev mode, and
  even then only while DevTools-adjacent tooling is watching). The badge
  instead checks each request's hostname against the same domain list the
  DNR rules were built from — a close proxy, not a direct readout.
- **The ad-learning heuristics will misfire sometimes.** Third-party iframes
  at common sizes, or containers with ad-adjacent class names, aren't always
  ads (embedded video players, widgets, etc.). That's exactly why approval
  is manual rather than automatic — see *Local ad-learning* above.
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
- **The Chrome install prompt will say "Read and change all your data on
  all websites."** That's `<all_urls>` host permission, which any extension
  that blocks network requests and hides ads sitewide genuinely needs — the
  same permission uBlock Origin and every other real adblocker requests.
  There's no way to block ads without it.

## Security

See [SECURITY.md](SECURITY.md) for what's already hardened and how to
report a security issue.

## License & attribution

Ghost Block's own code (everything under `src/`, `build/`, `manifest.json`)
is licensed under [GPL-3.0](LICENSE).

The compiled rules in `rules/` are derived from third-party filter lists,
which keep their own licenses regardless of the format they're compiled
into here:

- `rules/ads.dnr.json`, `rules/privacy.dnr.json`, and the bulk of
  `rules/cosmetic-*.json` are compiled from
  [EasyList and EasyPrivacy](https://easylist.to/), © The EasyList authors,
  dual-licensed
  [GPLv3 / CC BY-SA 3.0](https://easylist.to/pages/licence.html).
- `rules/annoyances.dnr.json` is compiled from
  [anti-adblock-killer](https://github.com/reek/anti-adblock-killer),
  © Reek, licensed
  [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Contributing

Issues and PRs welcome — false positives/negatives in blocking, sites the
anti-adblock-wall defeat doesn't cover, or heuristic tuning for the
ad-learning scanner are all useful reports even without a code fix attached.
