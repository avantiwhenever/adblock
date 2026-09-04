# Ghost Block — Technical Reference

This is the deep-dive companion to the [README](../README.md). If you just
want to install and use the extension, you don't need any of this. If
you're auditing the code, contributing, or curious how it actually works,
read on.

## Contents

- [Architecture](#architecture)
- [How each protection actually works](#how-each-protection-actually-works)
- [Local ad-learning (review queue)](#local-ad-learning-review-queue)
- [Rebuilding the filter lists](#rebuilding-the-filter-lists)
- [Limitations](#limitations-read-before-relying-on-this)
- [Security](#security)
- [License & attribution](#license--attribution)

## Architecture

```
manifest.json                   MV3 manifest
src/background/background.js    settings, ruleset sync, MAIN-world script
                                 registration, ad-learning review queue,
                                 approximate badge counter
src/content/cosmetic.js         ISOLATED world — hides ad containers via CSS
src/content/detect.js           ISOLATED world — heuristic ad-candidate scanner
src/content/guard.js            MAIN world — fingerprint noise (registered
                                 dynamically, never in manifest.json, so it
                                 can be excluded per whitelisted site)
src/content/antidetect.js       MAIN world — defeats ad-blocker-detection
                                 probes (registered the same way as guard.js)
src/popup/                      toggle UI, paused-sites list, ad-learning
                                 review queue
rules/*.dnr.json                declarativeNetRequest static rulesets
rules/cosmetic-*.json           CSS selectors for cosmetic.js
rules/blocked-domains.json      flat domain list, badge-count heuristic only
build/convert.mjs               EasyList-syntax → DNR/cosmetic converter
build/make-icons.py             generates icons/*.png
```

Manifest V3 background scripts run as a **service worker** — Chrome can
suspend and restart it at any time, so nothing in `background.js` relies on
in-memory state surviving between calls. It's the single source of truth
for settings (`chrome.storage.local`) and the only place that talks to
`declarativeNetRequest`/`chrome.scripting`; every other file either does
its own narrow job (cosmetic hiding, heuristic detection, fingerprint
noise, probe defeat) or is a thin UI layer over the same settings object.

### Why two content scripts run in the page's own JS world

`guard.js` and `antidetect.js` run in the **MAIN world** — literally the
same JavaScript realm the page's own `<script>` tags execute in — because
they have to patch objects (`CanvasRenderingContext2D.prototype`,
`window.fetch`) *before* the page's own code touches them. The tradeoff:
MAIN-world scripts have zero access to `chrome.*` APIs, by design — that
bridge doesn't exist for untrusted-equivalent code. So they can't check
"am I supposed to run on this page" themselves. Instead, `background.js`
decides that for them, registering or unregistering each script via
`chrome.scripting.registerContentScripts()` — a paused site just never gets
the script injected at all, rather than being injected and told to no-op.

Both scripts also disguise every function they patch under
`Function.prototype.toString`, so a site checking "is this really native
browser code" (a real technique some detection scripts use) can't tell
anything was modified.

## How each protection actually works

| Protection | Mechanism |
|---|---|
| Ad & tracker blocking | `declarativeNetRequest` static rules compiled from EasyList + EasyPrivacy, plus CSS selectors that hide the leftover container markup around a blocked ad |
| Anti-adblock-wall defeat | Network rules from the [anti-adblock-killer](https://github.com/reek/anti-adblock-killer) list block known detector scripts outright; `antidetect.js` additionally intercepts `fetch()` calls to Google Publisher Tag's script path and returns a synthetic valid-looking response, so a site's "did the ad script actually load" probe passes without the real ad-rendering script ever running |
| Cookie banner blocking | Network rules compiled from EasyList's dedicated cookie-consent-banner list block the consent-management-platform scripts (OneTrust, TrustArc, Sourcepoint, Quantcast, etc.) that render most of these banners |
| Fingerprint hardening | `guard.js` adds small noise to canvas/WebGL/AudioContext reads and rounds `hardwareConcurrency`/`deviceMemory` to common values — see *Limitations* for how far this actually goes |
| Local ad-learning | See the dedicated section below |

## Local ad-learning (review queue)

With "Learn new ads" on, `detect.js` watches each page for likely ads the
static filter lists didn't catch: a third-party iframe/image at a standard
IAB ad size (300×250, 728×90, etc.), or sitting in a container whose
class/id contains a whole word like `ad`, `sponsor`, or `advert` (word-
boundary matched, so "adobe" or "headphones" don't false-positive).

Nothing is blocked automatically. Matches show up in the popup under "New
ads found on this device":

- **✓ (approve)** — adds a personal block rule for that domain, and hides
  its container via CSS, effective immediately, on every site, from then on
- **✕ (ignore)** — dismisses it permanently; it won't be suggested again

Everything — candidates, approvals, dismissals — lives in
`chrome.storage.local` on your machine only. It isn't shared back into this
repo's `rules/*.json` automatically; run `node build/convert.mjs` yourself
and edit the source if you want to fold something you've learned back into
the shipped rules.

Heuristic detection has false positives by design — that's exactly why
approval is manual. If something unexpected gets hidden, use the Pause
button or turn off "Learn new ads," and open an issue with the domain/site.

## Rebuilding the filter lists

The compiled rules in `rules/*.json` are checked in, but you can regenerate
them from fresh upstream lists at any time:

```
node build/convert.mjs
```

This downloads the source lists into `build/cache/` if they aren't already
there, and rewrites everything in `rules/`. Run it periodically to pick up
upstream updates — there's no auto-update mechanism baked into the
extension itself (a browser extension that quietly fetches new rules from
a remote server on its own is exactly the kind of behavior this project is
trying to avoid, even in service of a good cause).

### How the EasyList-syntax parser works

`build/convert.mjs` translates EasyList/ABP filter syntax into two things:
Chrome `declarativeNetRequest` rule objects (network blocking) and CSS
selector lists (cosmetic hiding). Its guiding rule: anything it can't
translate with confidence — raw regex filters, scriptlet injections,
`$csp`/`$redirect`/`$removeparam` options, non-standard extended CSS
pseudo-selectors — is **dropped, not guessed at**. Losing a handful of
filters costs a little coverage; mistranslating one can silently break a
site or fail to block what it was supposed to, which is worse.

Chrome guarantees every extension a **30,000 static rule** budget
regardless of what else is installed, but EasyList alone contains
~47,000+ simple domain-block rules — far more than fits. Rather than
truncate by raw file order (which was an actual bug here once — a
hand-curated priority list now guarantees major ad/tracker networks
survive truncation regardless of where they happen to sit in the source
file; see `PRIORITY_DOMAINS` in `build/convert.mjs`), rules are sorted into
three tiers before capping: known major networks first, then other simple
domain-anchor rules, then everything else.

A few rules are hand-curated rather than derived from any filter list —
see `CUSTOM_NETWORK_RULES`/`CUSTOM_COSMETIC_GENERIC`/`CUSTOM_COSMETIC_SPECIFIC`
in `build/convert.mjs`. These exist for specific, evidence-based cases
found through live investigation (e.g. an ad network serving creatives
through randomly-rotating domains specifically to evade static
blocklists — matched by a stable URL-path token instead of the domain,
so it survives the next rotation) — not general solutions, just concrete
fixes for concrete things that were found and verified.

## Limitations (read before relying on this)

- **Blocked-count badge is approximate.** Chrome doesn't expose a
  production-safe "this exact request was blocked by rule X" event
  (`onRuleMatchedDebug` only works for unpacked extensions in developer
  mode). The badge instead checks each request's hostname against the same
  domain list the network rules were built from — a close proxy, not a
  direct readout.
- **The ad-learning heuristics will misfire sometimes.** Third-party
  iframes at common sizes, or containers with ad-adjacent class names,
  aren't always ads (embedded video players, widgets, etc.) — exactly why
  approval is manual rather than automatic.
- **Cosmetic unhide exceptions (`#@#` in EasyList syntax) aren't applied.**
  A small number of entries say "don't hide this selector on this specific
  site" to fix over-hiding; those are currently ignored, so on rare pages a
  real element could be hidden that shouldn't be.
- **Regex filters, scriptlet injections, and `$csp`/`$redirect`/`$removeparam`
  rules are skipped**, not translated. This trims some coverage versus a
  full uBlock-Origin-style engine, in exchange for never mistranslating one
  into something that breaks a site.
- **Static network rules are capped at ~29,000** across four categories, to
  stay inside Chrome's guaranteed budget. See *How the EasyList-syntax
  parser works* above for how coverage loss is minimized when truncating.
- **Fingerprint hardening is JS-level, not engine-level.** A sufficiently
  determined fingerprinting script combining many weak signals can still
  narrow things down — real resistance to that requires changes at the
  browser-engine level, which is why Brave and Tor Browser exist as forks
  rather than extensions. This raises the cost of fingerprinting; it
  doesn't eliminate it.
- **Anti-adblock-detection defeat is reverse-engineered per-site, not
  universal.** `antidetect.js` defeats specific, verified detection
  techniques (a Google-Publisher-Tag network probe, in particular). A site
  using a different detection approach needs its own investigation — there
  is no generic "defeat all detection" mechanism, on this project or any
  other.
- **The Chrome install prompt will say "Read and change all your data on
  all websites."** That's the `<all_urls>` host permission, which any
  extension that blocks network requests and hides ads sitewide genuinely
  needs — the same permission uBlock Origin and every other real ad
  blocker requests. There's no way to block ads without it.

## Security

Ghost Block runs entirely on-device: no server, no account, no
update-check callback, no analytics. Already-hardened details:

- No `eval`, `Function` constructor, inline scripts, or inline event
  handlers anywhere — the popup already satisfies Manifest V3's default
  `script-src 'self'` CSP, which is also declared explicitly in
  `manifest.json` rather than left implicit.
- No `web_accessible_resources` — nothing in the extension is reachable by
  a URL a page can probe.
- The fingerprint guard and anti-detection scripts are injected via
  `chrome.scripting.registerContentScripts` rather than a
  `<script src="chrome-extension://...">` tag, so their presence — and the
  extension's ID — never appear in the page DOM.
- Zero npm dependencies. `build/convert.mjs` and `build/make-icons.py` only
  use Node's/Python's standard library — nothing to audit in a dependency
  tree, nothing that can be supply-chain-compromised via a transitive
  package.
- All content-script DOM writes use `textContent`/`createElement`, never
  `innerHTML`, on data drawn from filter lists or page content — including
  candidate domains/selectors from the ad-learning scanner, which
  ultimately originate from third-party (adversarial) page content.
- Every generated `declarativeNetRequest` rule uses only the `block` or
  `allow` action — never `redirect` or `modifyHeaders`, which convert.mjs's
  parser deliberately excludes at the source rather than attempt to
  translate.
- Cosmetic CSS injection is safe by construction: the property list in
  every injected rule (`display:none!important`) is fixed by this
  extension's own code, never influenced by filter-list or page content —
  only the *selector* text is external, and CSS selectors can't smuggle
  arbitrary declarations even if a page adversarially controls an
  element's `id`/`class` (which candidate selectors are built from, via
  `CSS.escape()`).

See [SECURITY.md](../SECURITY.md) for how to report a security issue.

## License & attribution

Ghost Block's own code (everything under `src/`, `build/`, `manifest.json`)
is licensed under [GPL-3.0](../LICENSE).

The compiled rules in `rules/` are derived from third-party filter lists,
which keep their own licenses regardless of the format they're compiled
into here:

- `rules/ads.dnr.json`, `rules/privacy.dnr.json`, `rules/consent.dnr.json`,
  and the bulk of `rules/cosmetic-*.json` are compiled from
  [EasyList and EasyPrivacy](https://easylist.to/), © The EasyList authors,
  dual-licensed [GPLv3 / CC BY-SA 3.0](https://easylist.to/pages/licence.html).
- `rules/annoyances.dnr.json` is compiled from
  [anti-adblock-killer](https://github.com/reek/anti-adblock-killer),
  © Reek, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Contributing

Issues and PRs welcome — false positives/negatives in blocking, sites the
anti-adblock-wall defeat or cookie-banner blocking doesn't cover, or
heuristic tuning for the ad-learning scanner are all useful reports even
without a code fix attached. For a detection-defeat request specifically,
include the live markup/behavior (right-click → Inspect → copy the
relevant HTML, or the detection script if you can find it) — precise fixes
come from evidence, not guessing.
