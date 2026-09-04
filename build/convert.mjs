// ============================================================================
// EasyList-syntax filter list → Chrome declarativeNetRequest converter
// ============================================================================
//
// Run with `node build/convert.mjs`. Reads the raw filter list text files in
// build/cache/ (downloaded fresh from easylist.to/GitHub if not already
// present — see downloadIfMissing below) and produces everything under
// rules/ that the extension actually ships and loads at runtime:
//
//   - rules/ads.dnr.json, rules/privacy.dnr.json, rules/annoyances.dnr.json
//     — Chrome declarativeNetRequest static rulesets (network blocking),
//     one per manifest.json rule_resources entry.
//   - rules/cosmetic-generic.json, rules/cosmetic-specific.json — CSS
//     selector lists for hiding leftover ad markup, read by
//     src/content/cosmetic.js at runtime.
//   - rules/blocked-domains.json — a flat list of every domain the network
//     rules block, used only as a heuristic for the popup's approximate
//     "blocked on this page" badge count (see background.js).
//
// EasyList's filter syntax is deliberately not fully supported here.
// Anything this parser can't translate with confidence — raw regex filters,
// scriptlet injections, $csp/$redirect/$removeparam options, extended
// (non-standard) CSS pseudo-selectors — is dropped rather than guessed at.
// Losing a handful of filters just means slightly less coverage; silently
// mistranslating one could break a site or fail to block what it was
// supposed to, which is worse.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, "build/cache");
const RULES_DIR = path.join(ROOT, "rules");

// EasyList/ABP filter-option names → Chrome declarativeNetRequest
// ResourceType enum values. A handful of ABP names (object-subrequest, xhr)
// are older aliases for a type DNR only has one name for, so they map to
// the same value as their modern equivalent.
const RESOURCE_TYPE_MAP = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  object: "object",
  "object-subrequest": "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  document: "main_frame",
  websocket: "websocket",
  font: "font",
  media: "media",
  ping: "ping",
  other: "other",
};

// Presence of any of these option keywords makes a rule unsafe to translate
// mechanically, so we drop the whole rule rather than mistranslate it.
const UNSUPPORTED_OPTIONS = new Set([
  "csp",
  "redirect",
  "redirect-rule",
  "removeparam",
  "replace",
  "urlskip",
  "uritransform",
  "cookie",
  "header",
  "permissions",
  "referrerpolicy",
  "hls",
  "mp4",
  "empty",
  "mp4-fallback",
]);

const NOOP_OPTIONS = new Set([
  "collapse",
  "~collapse",
  "genericblock",
  "generichide",
  "elemhide",
  "popup",
  "document",
  "doc",
  "webrtc",
  "extension",
  "app",
  "network",
  "specifichide",
]);

// Parses everything after the "$" in a filter line (e.g. "third-party,
// domain=a.com|~b.com,script") into a structured options object. Unknown
// option names are treated the same as explicitly-unsupported ones — see
// the `else` branch below — since a filter option this parser has never
// heard of could mean anything, and guessing wrong is worse than dropping
// the rule (see the file-header comment for the general philosophy here).
function parseOptions(optionsStr) {
  const tokens = optionsStr.split(",").map((t) => t.trim()).filter(Boolean);
  const out = {
    thirdParty: undefined, // true | false | undefined
    initiatorDomains: [],
    excludedInitiatorDomains: [],
    resourceTypes: new Set(),
    excludedResourceTypes: new Set(),
    important: false,
    badfilter: false,
    matchCase: false,
    unsupported: false,
  };

  for (const raw of tokens) {
    const negated = raw.startsWith("~");
    const key = negated ? raw.slice(1) : raw;
    const [name, value] = key.split("=");

    if (name === "third-party" || name === "3p") {
      out.thirdParty = !negated;
    } else if (name === "first-party" || name === "1p") {
      out.thirdParty = negated;
    } else if (name === "domain" && value) {
      for (const d of value.split("|")) {
        if (!d) continue;
        if (d.startsWith("~")) out.excludedInitiatorDomains.push(d.slice(1).toLowerCase());
        else out.initiatorDomains.push(d.toLowerCase());
      }
    } else if (name === "match-case") {
      out.matchCase = true;
    } else if (name === "important") {
      out.important = true;
    } else if (name === "badfilter") {
      out.badfilter = true;
    } else if (RESOURCE_TYPE_MAP[name]) {
      const mapped = RESOURCE_TYPE_MAP[name];
      if (negated) out.excludedResourceTypes.add(mapped);
      else out.resourceTypes.add(mapped);
    } else if (NOOP_OPTIONS.has(key)) {
      // intentionally ignored
    } else if (UNSUPPORTED_OPTIONS.has(name)) {
      out.unsupported = true;
    } else {
      // Unknown option: be conservative and drop the rule.
      out.unsupported = true;
    }
  }
  return out;
}

// Parses one non-cosmetic filter-list line into { pattern, isException,
// opts }, or null if the line can't be safely translated (raw regex,
// malformed exception syntax, or any option parseOptions couldn't handle —
// see that function). `pattern` at this point is already in DNR's
// urlFilter syntax — EasyList's network-filter pattern language and DNR's
// urlFilter were both modeled on the same "Adblock Plus filter syntax"
// idea, so beyond the "||*." fixup below, translation is mostly just
// stripping the "$options" suffix off, which happens here.
function parseNetworkLine(line) {
  if (line.startsWith("/") && /\/(\$.*)?$/.test(line)) return null; // raw regex, skip

  let body = line;
  let isException = false;
  if (body.startsWith("@@")) {
    isException = true;
    body = body.slice(2);
  } else if (body.startsWith("@")) {
    // A single "@" (not "@@") isn't valid exception syntax — malformed
    // upstream line, ambiguous whether it was meant as a filter or an
    // exception. Skip rather than guess.
    return null;
  }

  const dollarIdx = body.indexOf("$");
  let pattern = dollarIdx === -1 ? body : body.slice(0, dollarIdx);
  const optionsStr = dollarIdx === -1 ? "" : body.slice(dollarIdx + 1);
  if (!pattern) return null;

  // Chrome's DNR validator rejects a literal "*" right after the "||" domain
  // anchor, but it's redundant anyway: "||" already matches the domain and
  // any subdomain of it, so "||*.example.com" and "||example.com" mean the
  // same thing as far as DNR is concerned.
  if (pattern.startsWith("||*.")) pattern = "||" + pattern.slice(4);

  const opts = parseOptions(optionsStr);
  if (opts.unsupported) return null;

  return { pattern, isException, opts };
}

// Turns one parsed filter line into an actual declarativeNetRequest rule
// object, in the exact shape Chrome's schema expects. `id` is assigned by
// the caller (processList, via capped.map) — sequential per output file,
// since rule ids only need to be unique within a single ruleset file, not
// across the whole extension.
function buildDnrRule(id, parsed) {
  const { pattern, isException, opts } = parsed;
  const condition = { urlFilter: pattern };
  if (opts.matchCase) condition.isUrlFilterCaseSensitive = true;

  if (opts.resourceTypes.size > 0) {
    condition.resourceTypes = [...opts.resourceTypes];
  } else if (opts.excludedResourceTypes.size > 0) {
    condition.excludedResourceTypes = [...opts.excludedResourceTypes];
  }

  if (opts.initiatorDomains.length > 0) {
    condition.initiatorDomains = opts.initiatorDomains;
  } else if (opts.excludedInitiatorDomains.length > 0) {
    condition.excludedInitiatorDomains = opts.excludedInitiatorDomains;
  }

  if (opts.thirdParty === true) condition.domainType = "thirdParty";
  else if (opts.thirdParty === false) condition.domainType = "firstParty";

  const rule = {
    id,
    priority: opts.important ? 2 : 1,
    action: { type: isException ? "allow" : "block" },
    condition,
  };
  return rule;
}

const SIMPLE_DOMAIN_RULE = /^\|\|([a-z0-9.-]+)\^$/i;

function isSimple(pattern) {
  return SIMPLE_DOMAIN_RULE.test(pattern);
}

// A hand-curated list of the highest-traffic ad/tracking root domains on
// the web. Chrome's guaranteed static-rule budget (30,000 total — see
// main()) is far smaller than the ~47,000+ simple "||domain^" rules
// EasyList alone contains, so truncation is unavoidable. Truncating by
// source-file order alone means a rule for a huge, extremely common ad
// server (e.g. pagead2.googlesyndication.com) can get dropped just because
// it happens to sit late in the file, while some far more obscure one-off
// tracking domain that appears earlier survives instead — that's a real
// bug this list exists to fix. Any rule for one of these domains, or a
// subdomain of one, is guaranteed to make the cut before the cap is
// applied, regardless of where it falls in the source file.
const PRIORITY_DOMAINS = [
  // Google's ad stack (DoubleClick / Google Ad Manager / AdSense / Google Ads)
  "doubleclick.net", "googlesyndication.com", "googleadservices.com",
  "google-analytics.com", "googletagmanager.com", "googletagservices.com",
  "adservice.google.com", "2mdn.net", "admob.com", "adsense.com",
  // Meta / Facebook
  "facebook.net", "connect.facebook.net",
  // Amazon
  "amazon-adsystem.com", "assoc-amazon.com",
  // Major SSPs / DSPs / ad exchanges
  "adnxs.com", "rubiconproject.com", "pubmatic.com", "openx.net",
  "casalemedia.com", "criteo.com", "criteo.net", "adsrvr.org", "thetradedesk.com",
  "contextweb.com", "indexexchange.com", "smartadserver.com",
  "yieldmo.com", "sharethrough.com", "sovrn.com", "media.net",
  "advertising.com", "adform.net", "bidswitch.net", "gumgum.com",
  "3lift.com", "spotxchange.com", "spotx.tv", "teads.tv",
  // Content-recommendation / native ad networks
  "taboola.com", "outbrain.com", "revcontent.com", "mgid.com",
  // Major analytics / tag management / telemetry
  "scorecardresearch.com", "quantserve.com", "quantcount.com",
  "moatads.com", "chartbeat.com", "comscore.com", "adobedtm.com",
  "demdex.net", "omtrdc.net", "krxd.net", "bluekai.com",
  "newrelic.com", "nr-data.net", "mixpanel.com", "segment.io",
  "segment.com", "hotjar.com", "fullstory.com", "amplitude.com",
  "crazyegg.com", "mouseflow.com",
];

// True if `pattern` is a simple "||domain^" rule AND that domain is (or is
// a subdomain of) one of the always-keep domains above.
function isPriority(pattern) {
  const match = SIMPLE_DOMAIN_RULE.exec(pattern);
  if (!match) return false;
  const domain = match[1].toLowerCase();
  return PRIORITY_DOMAINS.some((p) => domain === p || domain.endsWith(`.${p}`));
}

// ----------------------------------------------------------------------------
// Hand-curated, evidence-based extras
// ----------------------------------------------------------------------------
// EasyList/EasyPrivacy are crowd-maintained and generally excellent, but
// they can't keep up with an ad vendor that deliberately rotates domains
// per campaign specifically to defeat domain-based blocklists — by the
// time such a domain gets added to a public list, the vendor has already
// moved to a new one. The entries below were added after a live report
// (see git history / README) of Yahoo.com serving both a display ad and a
// Taboola native-ad unit through "*.athwartwhoafat.com" — a
// randomly-generated-looking domain that's certain to rotate again. Rather
// than chase the domain, these target things that *don't* rotate: a
// stable token embedded in the URL path, and a standard accessibility
// label the ad-serving SafeFrame sets regardless of which domain hosts it.
//
// These are static observations from one investigation, not a general
// solution to domain-rotation evasion — if the same technique resurfaces
// with a different path token, it'll need a fresh rule the same way this
// one was found: from a live report with the actual markup.
const CUSTOM_NETWORK_RULES = [
  {
    // No "||" domain anchor on purpose — this matches the URL's *path*
    // wherever it's hosted, which is the whole point: it doesn't matter
    // which random domain the creative is served from this week.
    urlFilter: "*/player/*ybfqz9i9iul9ru3ss*",
  },
];

const CUSTOM_COSMETIC_GENERIC = [
  // Google Ad Manager SafeFrame creatives set this accessibility label by
  // convention — hides the ad regardless of which domain served it,
  // including via the domain-rotation trick above.
  'iframe[aria-label="Advertisement"]',
  // Taboola's ad-blocking-recovery product labels its native-ad branding
  // this way regardless of which publisher's site it's embedded in. This
  // only reaches the inner label span, not its wrapper — see
  // CUSTOM_COSMETIC_SPECIFIC below for the yahoo.com-scoped wrapper rule;
  // kept generic here too since the label text itself is distinctive
  // enough to be safe on any site.
  '[aria-label*="in Taboola advertising section"]',
];

// Same idea as CUSTOM_COSMETIC_GENERIC, but for selectors only safe to
// apply on specific domains — "branding"/"composite-branding" are common
// enough class names that hiding them site-wide could plausibly catch
// something that isn't an ad on some other site, so this one is scoped to
// where it was actually observed.
const CUSTOM_COSMETIC_SPECIFIC = {
  "yahoo.com": [".branding.composite-branding"],
};

// Parses one "##selector" or "domain1,domain2##selector" cosmetic
// Matches any of EasyList/uBlock Origin's cosmetic-rule marker forms
// wherever they appear in a line: "##"/"#@#" (plain hide / unhide
// exception), "#?#"/"#@?#" (extended/procedural hide, e.g. uBO's
// :has-text()), "#$#"/"#@$#" (arbitrary CSS injection), "#%#"/"#@%#"
// (scriptlet/JS injection). All eight share the shape
// "#" + optional "@" + optional one of "$%?" + "#".
//
// This has to be checked in *addition* to (and before) treating a line as
// a network filter — the earlier version of this file only recognized
// "##" and "#@#", so lines using the other six marker forms fell through
// undetected and got misparsed as network urlFilter patterns instead,
// producing DNR rules Chrome's validator correctly rejected (e.g. a
// "urlFilter" containing raw non-ASCII text from an uBO :has-text()
// selector, which isn't valid in that field at all).
const COSMETIC_MARKER_RE = /#@?[$%?]?#/;

// Parses one cosmetic (element-hiding-family) filter line into
// { domains, selector }, or null if it isn't a hideable, plain-CSS
// selector this converter can use. `domains` is empty for a generic rule
// (applies everywhere) — see processList below for how generic vs.
// per-domain selectors get sorted into cosmetic-generic.json vs.
// cosmetic-specific.json.
//
// Only the plain "##" marker (unconditional element hiding) is actually
// supported. Everything else recognized by COSMETIC_MARKER_RE — unhide
// exceptions, extended/procedural selectors, CSS injection, scriptlet/JS
// injection — is deliberately unsupported and returns null: unhide
// exceptions are a documented limitation (see README), extended selectors
// use non-standard pseudo-classes plain CSS can't express, CSS injection
// isn't a simple hide, and scriptlet injection would mean executing
// arbitrary third-party JavaScript — never something to do sight-unseen
// from a public list.
function parseCosmeticLine(line) {
  const match = COSMETIC_MARKER_RE.exec(line);
  if (!match || match[0] !== "##") return null;

  const idx = match.index;
  const domainsPart = line.slice(0, idx);
  const selector = line.slice(idx + match[0].length).trim();
  if (!selector) return null;
  // Belt-and-suspenders: even a plain "##" line's selector text can still
  // itself contain scriptlet/extended syntax on some list variants (rare,
  // but seen in the wild) — reject those rather than trust the marker
  // alone.
  if (selector.startsWith("+js(") || selector.includes(":-abp-") || selector.includes(":matches-css") || selector.includes(":xpath(") || selector.includes(":upward(") || selector.includes(":has-text(")) {
    return null;
  }

  const domains = domainsPart
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d && !d.startsWith("~"));

  return { domains, selector };
}

// Where each cached source file comes from, so it can be fetched fresh on
// a machine that doesn't have build/cache/ populated yet (a first checkout
// of this repo, or after `rm -rf build/cache`). Filenames here must match
// what main()'s processList() calls expect.
const EASYLIST_COOKIE_BASE = "https://raw.githubusercontent.com/easylist/easylist/master/easylist_cookie";

const SOURCES = {
  "easylist.txt": "https://easylist.to/easylist/easylist.txt",
  "easyprivacy.txt": "https://easylist.to/easylist/easyprivacy.txt",
  "anti-adblock-killer.txt":
    "https://raw.githubusercontent.com/reek/anti-adblock-killer/master/anti-adblock-killer-filters.txt",
  // EasyList's dedicated cookie/consent-banner list, split across several
  // files upstream (general vs. per-site vs. international vs. the
  // third-party consent-management-platform scripts that render most of
  // these banners in the first place). COOKIE_FILES below is the set we
  // actually use — see that constant for which pieces are included/why.
  "cookie-general-block.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_general_block.txt`,
  "cookie-general-hide.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_general_hide.txt`,
  "cookie-specific-block.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_specific_block.txt`,
  "cookie-specific-hide.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_specific_hide.txt`,
  "cookie-intl-block.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_international_specific_block.txt`,
  "cookie-intl-hide.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_international_specific_hide.txt`,
  "cookie-thirdparty.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_thirdparty.txt`,
  "cookie-allowlist.txt": `${EASYLIST_COOKIE_BASE}/easylist_cookie_allowlist.txt`,
};

// The cookie-consent-banner category is spread across 8 upstream files
// rather than EasyList/EasyPrivacy's one-file-each — processList() below
// accepts an array here and concatenates them before parsing, same as if
// they were one file. Deliberately excludes
// easylist_cookie_allowlist_general_hide.txt (cosmetic *unhide* exceptions
// — already a documented limitation that #@# lines aren't applied, same as
// for the other lists) and the ABP/uBO-specific variant files (mostly
// scriptlet injections, which parseCosmeticLine already skips wherever
// they'd appear, so fetching those extra files would add little).
const COOKIE_FILES = [
  "cookie-general-block.txt",
  "cookie-general-hide.txt",
  "cookie-specific-block.txt",
  "cookie-specific-hide.txt",
  "cookie-intl-block.txt",
  "cookie-intl-hide.txt",
  "cookie-thirdparty.txt",
  "cookie-allowlist.txt",
];

// Downloads `file` into build/cache/ if it isn't already there. Doesn't
// re-download an existing cached copy — if you want fresher upstream data,
// delete the file (or the whole build/cache/ directory) first. Using
// Node's built-in fetch keeps this dependency-free (see README's Security
// section on why that matters).
async function downloadIfMissing(file) {
  const dest = path.join(CACHE, file);
  try {
    await readFile(dest);
    return; // already cached
  } catch {
    // not cached yet — fall through and fetch it
  }
  const url = SOURCES[file];
  console.log(`fetching ${url} -> build/cache/${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(dest, await res.text());
}

// Accepts either one filename or an array of them (see COOKIE_FILES above
// for why a category might span multiple upstream files) and returns every
// line from all of them concatenated into one flat array, as if they were
// a single file — parseNetworkLine/parseCosmeticLine below don't care
// which original file a line came from.
async function loadList(files) {
  const list = Array.isArray(files) ? files : [files];
  const allLines = [];
  for (const file of list) {
    await downloadIfMissing(file);
    const text = await readFile(path.join(CACHE, file), "utf8");
    allLines.push(...text.split("\n").map((l) => l.trim()));
  }
  return allLines;
}

// Parses one whole filter list file end-to-end: separates cosmetic rules
// from network rules, applies $badfilter cancellations, sorts network rules
// by priority tier and truncates to `networkCap`, and returns everything
// main() needs to write out (DNR rules for this file, this file's
// contribution to the two cosmetic-selector maps, and the domains it
// actually ended up blocking after truncation).
async function processList(files, { networkCap }) {
  const lines = await loadList(files);
  const badfilters = new Set();
  const networkCandidates = [];
  const cosmeticGeneric = new Set();
  const cosmeticSpecific = new Map(); // domain -> Set(selector)
  const blockedDomains = new Set();

  // First pass: collect every $badfilter target *before* the main pass
  // below, since a $badfilter line can appear anywhere in the file
  // relative to the rule it's meant to cancel — including earlier than it
  // (badfilter is meant to let one filter list retroactively cancel a rule
  // from an *earlier-loaded* list, though in practice it's also used
  // within the same list). Matching is by exact pattern-text equality
  // (the filter text before its own "$" options), which handles the common
  // case of a $badfilter line targeting the exact same pattern text as the
  // rule it's meant to cancel.
  for (const line of lines) {
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    if (COSMETIC_MARKER_RE.test(line)) continue;
    if (line.includes("$badfilter")) {
      const withoutFilter = line.replace(/@@/, "");
      const dollarIdx = withoutFilter.indexOf("$");
      const pattern = dollarIdx === -1 ? withoutFilter : withoutFilter.slice(0, dollarIdx);
      badfilters.add(pattern);
    }
  }

  for (const line of lines) {
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;

    if (COSMETIC_MARKER_RE.test(line)) {
      const cosmetic = parseCosmeticLine(line);
      if (!cosmetic) continue;
      if (cosmetic.domains.length === 0) {
        cosmeticGeneric.add(cosmetic.selector);
      } else {
        for (const d of cosmetic.domains) {
          if (!cosmeticSpecific.has(d)) cosmeticSpecific.set(d, new Set());
          cosmeticSpecific.get(d).add(cosmetic.selector);
        }
      }
      continue;
    }

    if (line.includes("$badfilter")) continue;

    const parsed = parseNetworkLine(line);
    if (!parsed) continue;

    const dollarIdx = line.indexOf("$");
    const rawPattern = (dollarIdx === -1 ? line : line.slice(0, dollarIdx)).replace(/^@@/, "");
    if (badfilters.has(rawPattern)) continue;

    networkCandidates.push(parsed);
  }

  // Three-tier priority when truncating to stay inside Chrome's guaranteed
  // static-rule budget: (2) known major ad/tracker domains first — these
  // are the ones that actually matter most in practice, and file order
  // alone was previously letting some of them get truncated away; (1) other
  // simple, reliable domain-anchor rules next; (0) everything else (path-
  // specific, option-qualified rules) last. Array.prototype.sort is stable,
  // so relative source-file order is preserved within each tier.
  function tier(pattern) {
    if (isPriority(pattern)) return 2;
    if (isSimple(pattern)) return 1;
    return 0;
  }
  networkCandidates.sort((a, b) => tier(b.pattern) - tier(a.pattern));
  const capped = networkCandidates.slice(0, networkCap);

  // Only rules that actually made the cut count as "blocked" for badge purposes.
  for (const parsed of capped) {
    const domainMatch = SIMPLE_DOMAIN_RULE.exec(parsed.pattern);
    if (domainMatch && !parsed.isException) blockedDomains.add(domainMatch[1].toLowerCase());
  }

  const dnrRules = capped.map((parsed, i) => buildDnrRule(i + 1, parsed));

  // Safety net for exactly the bug class this file has already shipped
  // once: a cosmetic-marker-family line (see COSMETIC_MARKER_RE) getting
  // missed by the dispatch check above and misparsed as a network pattern
  // instead. If that ever happens again — a new marker variant, a parsing
  // edge case — fail the build loudly here rather than only finding out
  // when Chrome's manifest loader rejects the whole ruleset at install
  // time. (This checks the *shape* COSMETIC_MARKER_RE matches, not merely
  // "contains a #" — a lone "#" can legitimately appear in an ordinary URL
  // pattern and isn't itself a sign of anything wrong.)
  const stillCosmetic = dnrRules.filter((r) => r.condition.urlFilter && COSMETIC_MARKER_RE.test(r.condition.urlFilter));
  if (stillCosmetic.length > 0) {
    throw new Error(
      `${stillCosmetic.length} generated rule(s) still look like cosmetic syntax, e.g.: ${stillCosmetic[0].condition.urlFilter}`
    );
  }

  return { dnrRules, cosmeticGeneric, cosmeticSpecific, blockedDomains, droppedNetwork: networkCandidates.length - capped.length };
}

// Union of two Sets of cosmetic selectors, mutating `target` in place —
// used to combine the generic-selector Sets from all three source files
// into one before writing cosmetic-generic.json.
function mergeCosmetic(target, source) {
  for (const s of source) target.add(s);
}

// Same idea as mergeCosmetic, but for the domain → Set(selector) maps —
// used to combine the three source files' per-domain selector maps into
// one before writing cosmetic-specific.json. If two different source files
// both have selectors for the same domain, they end up unioned into one
// Set for that domain rather than one overwriting the other.
function mergeSpecific(target, source) {
  for (const [domain, selectors] of source) {
    if (!target.has(domain)) target.set(domain, new Set());
    mergeCosmetic(target.get(domain), selectors);
  }
}

// Entry point: processes all four source categories (in parallel — they're
// entirely independent of each other), writes every file under rules/, and
// prints a summary of what was kept/dropped. The per-category network caps
// here (16000/10000/2000/2000, totalling 30000) are chosen to stay exactly
// at Chrome's 30,000 guaranteed-static-rule-per-extension budget, with
// EasyList (general ads) getting the largest share since it's the
// highest-traffic-impact category.
async function main() {
  await mkdir(RULES_DIR, { recursive: true });

  const [ads, privacy, annoyances, consent] = await Promise.all([
    processList("easylist.txt", { networkCap: 16000 }),
    processList("easyprivacy.txt", { networkCap: 10000 }),
    processList("anti-adblock-killer.txt", { networkCap: 2000 }),
    processList(COOKIE_FILES, { networkCap: 2000 }),
  ]);
  const categories = [ads, privacy, annoyances, consent];

  // Append the hand-curated custom rules (see CUSTOM_NETWORK_RULES above)
  // to the "ads" category, with fresh ids continuing on from wherever
  // processList's capping left off — avoids any id collision with the
  // EasyList-derived rules already in ads.dnrRules.
  const nextId = ads.dnrRules.length + 1;
  for (const [i, custom] of CUSTOM_NETWORK_RULES.entries()) {
    ads.dnrRules.push({
      id: nextId + i,
      priority: 1,
      action: { type: "block" },
      condition: { urlFilter: custom.urlFilter },
    });
  }

  // Each source category's compiled network rules become their own DNR
  // ruleset file, matching manifest.json's rule_resources entries
  // (id "ads" → ads.dnr.json, etc.) one-to-one.
  await writeFile(path.join(RULES_DIR, "ads.dnr.json"), JSON.stringify(ads.dnrRules));
  await writeFile(path.join(RULES_DIR, "privacy.dnr.json"), JSON.stringify(privacy.dnrRules));
  await writeFile(path.join(RULES_DIR, "annoyances.dnr.json"), JSON.stringify(annoyances.dnrRules));
  await writeFile(path.join(RULES_DIR, "consent.dnr.json"), JSON.stringify(consent.dnrRules));

  // Cosmetic selectors, by contrast, are pooled from all four categories
  // into two single combined files — cosmetic.js doesn't care which
  // original list a selector came from, only whether it's generic
  // (applies everywhere) or scoped to specific domains. (This means cookie-
  // banner cosmetic hiding rides along with the "Ad & tracker blocking"
  // toggle rather than having its own — the "Cookie banner blocking"
  // toggle controls the network-level rules only, i.e. whether the
  // consent-management scripts that render most banners are blocked from
  // loading at all. Splitting cosmetic selectors by category too would be
  // a reasonable future improvement but adds real complexity for a
  // secondary effect — the network blocking is what does most of the work.)
  const cosmeticGeneric = new Set();
  const cosmeticSpecific = new Map();
  for (const src of categories) {
    mergeCosmetic(cosmeticGeneric, src.cosmeticGeneric);
    mergeSpecific(cosmeticSpecific, src.cosmeticSpecific);
  }
  mergeCosmetic(cosmeticGeneric, CUSTOM_COSMETIC_GENERIC);
  mergeSpecific(
    cosmeticSpecific,
    new Map(Object.entries(CUSTOM_COSMETIC_SPECIFIC).map(([d, sels]) => [d, new Set(sels)]))
  );

  await writeFile(
    path.join(RULES_DIR, "cosmetic-generic.json"),
    JSON.stringify([...cosmeticGeneric])
  );
  // cosmetic-specific.json is a plain object (domain -> [selectors]) rather
  // than an array, since cosmetic.js needs to look entries up by domain
  // directly at runtime — Object.fromEntries here converts the
  // domain -> Set map into domain -> array pairs suitable for that lookup.
  await writeFile(
    path.join(RULES_DIR, "cosmetic-specific.json"),
    JSON.stringify(Object.fromEntries([...cosmeticSpecific].map(([d, s]) => [d, [...s]])))
  );

  // blocked-domains.json is a similar pool-everything-together file, used
  // only by background.js's approximate badge-count heuristic — see that
  // file for why a flat domain list (rather than the full rule set) is
  // enough for that purpose.
  const blockedDomains = new Set();
  for (const src of categories) mergeCosmetic(blockedDomains, src.blockedDomains);
  await writeFile(path.join(RULES_DIR, "blocked-domains.json"), JSON.stringify([...blockedDomains]));

  console.log("ads:        %d rules kept, %d dropped (cap)", ads.dnrRules.length, ads.droppedNetwork);
  console.log("privacy:    %d rules kept, %d dropped (cap)", privacy.dnrRules.length, privacy.droppedNetwork);
  console.log("annoyances: %d rules kept, %d dropped (cap)", annoyances.dnrRules.length, annoyances.droppedNetwork);
  console.log("consent:    %d rules kept, %d dropped (cap)", consent.dnrRules.length, consent.droppedNetwork);
  console.log("cosmetic generic selectors: %d", cosmeticGeneric.size);
  console.log("cosmetic domain-specific entries: %d", cosmeticSpecific.size);
  console.log("blocked-domain set (for badge counts): %d", blockedDomains.size);
  console.log(
    "total static DNR rules: %d (Chrome's guaranteed-safe budget is 30000)",
    categories.reduce((sum, c) => sum + c.dnrRules.length, 0)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
