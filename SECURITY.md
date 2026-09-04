# Security

Ghost Block runs entirely on-device: it has no server, no account, no
update-check callback, and no analytics. There is nothing it could leak your
data *to* — but it does hold broad `<all_urls>` host permissions and runs
code on every page you visit, so a bug here still matters.

## Reporting a vulnerability

Please open a [GitHub issue](../../issues) for anything that isn't
security-sensitive (a filter list gap, a broken site, a false positive from
the ad-detection heuristics).

For anything genuinely security-sensitive — a way for a page to detect or
fingerprint the extension despite the anti-detection design, a way for a
page to read or influence data across the ISOLATED/MAIN world boundary, or
any other way a malicious site could exploit having this extension
installed — please open a GitHub issue marked clearly as a security report,
or reach out to the maintainer directly before filing publicly if you'd
prefer the fix land first. There's no bug bounty here; this is a personal
open-source project maintained on a best-effort basis.

## What's already been hardened

- No `eval`, no `Function` constructor, no inline scripts or event handler
  attributes anywhere — the popup already satisfies Manifest V3's default
  `script-src 'self'` CSP.
- No `web_accessible_resources` — nothing in the extension is reachable by a
  URL a page can probe.
- The fingerprint guard is injected via `chrome.scripting.registerContentScripts`
  rather than a `<script src="chrome-extension://...">` tag, so its presence
  and the extension's ID never appear in the page DOM.
- Zero npm dependencies. `build/convert.mjs` and `build/make-icons.py` only
  use Node/Python standard library — nothing to audit in a dependency tree,
  nothing that can be supply-chain-compromised via a transitive package.
- All content-script DOM writes use `textContent`/`createElement`, never
  `innerHTML`, on data drawn from filter lists or page content.
