// Converts EasyList-syntax filter lists into:
//   - Chrome declarativeNetRequest static rulesets (network blocking)
//   - cosmetic selector maps (element hiding, applied by a content script)
//   - a flat blocked-domain list (used only for approximate badge counts)
//
// Unsupported syntax (raw regex filters, scriptlet injections, $csp/$redirect/
// $removeparam, extended CSS pseudo-selectors) is skipped rather than
// guessed at — dropping a filter just means slightly less coverage, while
// mis-translating one can silently break sites or under-block.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, "build/cache");
const RULES_DIR = path.join(ROOT, "rules");

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

  const opts = optionsStr ? parseOptions(optionsStr) : parseOptions("");
  if (opts.unsupported) return null;
  if (opts.thirdParty !== undefined && opts.resourceTypes.has("main_frame")) {
    // third-party main_frame navigations are not meaningful; drop the modifier
  }

  return { pattern, isException, opts };
}

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

function parseCosmeticLine(line) {
  const idx = line.indexOf("#@#");
  if (idx !== -1) return null; // per-site unhide exception — not applied (documented limitation)

  const hideIdx = line.indexOf("##");
  if (hideIdx === -1) return null;

  const domainsPart = line.slice(0, hideIdx);
  const selector = line.slice(hideIdx + 2).trim();
  if (!selector) return null;
  // Skip scriptlet injections and ABP/uBO extended (non-CSS) pseudo-selectors.
  if (selector.startsWith("+js(") || selector.includes(":-abp-") || selector.includes(":matches-css") || selector.includes(":xpath(") || selector.includes(":upward(")) {
    return null;
  }

  const domains = domainsPart
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d && !d.startsWith("~"));

  return { domains, selector };
}

async function loadList(file) {
  const text = await readFile(path.join(CACHE, file), "utf8");
  return text.split("\n").map((l) => l.trim());
}

async function processList(file, { networkCap }) {
  const lines = await loadList(file);
  const badfilters = new Set();
  const networkCandidates = [];
  const cosmeticGeneric = new Set();
  const cosmeticSpecific = new Map(); // domain -> Set(selector)
  const blockedDomains = new Set();

  // First pass: collect $badfilter targets.
  for (const line of lines) {
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    if (line.includes("#@#") || line.includes("##")) continue;
    if (line.includes("$badfilter")) {
      const withoutFilter = line.replace(/@@/, "");
      const dollarIdx = withoutFilter.indexOf("$");
      const pattern = dollarIdx === -1 ? withoutFilter : withoutFilter.slice(0, dollarIdx);
      badfilters.add(pattern);
    }
  }

  for (const line of lines) {
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;

    if (line.includes("##") || line.includes("#@#")) {
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

  // Prefer simple, reliable domain-anchor rules first when we must truncate
  // to stay inside Chrome's guaranteed static-rule budget.
  networkCandidates.sort((a, b) => Number(isSimple(b.pattern)) - Number(isSimple(a.pattern)));
  const capped = networkCandidates.slice(0, networkCap);

  // Only rules that actually made the cut count as "blocked" for badge purposes.
  for (const parsed of capped) {
    const domainMatch = SIMPLE_DOMAIN_RULE.exec(parsed.pattern);
    if (domainMatch && !parsed.isException) blockedDomains.add(domainMatch[1].toLowerCase());
  }

  const dnrRules = capped.map((parsed, i) => buildDnrRule(i + 1, parsed));

  return { dnrRules, cosmeticGeneric, cosmeticSpecific, blockedDomains, droppedNetwork: networkCandidates.length - capped.length };
}

function mergeCosmetic(target, source) {
  for (const s of source) target.add(s);
}

function mergeSpecific(target, source) {
  for (const [domain, selectors] of source) {
    if (!target.has(domain)) target.set(domain, new Set());
    mergeCosmetic(target.get(domain), selectors);
  }
}

async function main() {
  await mkdir(RULES_DIR, { recursive: true });

  const [ads, privacy, annoyances] = await Promise.all([
    processList("easylist.txt", { networkCap: 16000 }),
    processList("easyprivacy.txt", { networkCap: 10000 }),
    processList("anti-adblock-killer.txt", { networkCap: 2000 }),
  ]);

  await writeFile(path.join(RULES_DIR, "ads.dnr.json"), JSON.stringify(ads.dnrRules));
  await writeFile(path.join(RULES_DIR, "privacy.dnr.json"), JSON.stringify(privacy.dnrRules));
  await writeFile(path.join(RULES_DIR, "annoyances.dnr.json"), JSON.stringify(annoyances.dnrRules));

  const cosmeticGeneric = new Set();
  const cosmeticSpecific = new Map();
  for (const src of [ads, privacy, annoyances]) {
    mergeCosmetic(cosmeticGeneric, src.cosmeticGeneric);
    mergeSpecific(cosmeticSpecific, src.cosmeticSpecific);
  }

  await writeFile(
    path.join(RULES_DIR, "cosmetic-generic.json"),
    JSON.stringify([...cosmeticGeneric])
  );
  await writeFile(
    path.join(RULES_DIR, "cosmetic-specific.json"),
    JSON.stringify(Object.fromEntries([...cosmeticSpecific].map(([d, s]) => [d, [...s]])))
  );

  const blockedDomains = new Set();
  for (const src of [ads, privacy, annoyances]) mergeCosmetic(blockedDomains, src.blockedDomains);
  await writeFile(path.join(RULES_DIR, "blocked-domains.json"), JSON.stringify([...blockedDomains]));

  console.log("ads:        %d rules kept, %d dropped (cap)", ads.dnrRules.length, ads.droppedNetwork);
  console.log("privacy:    %d rules kept, %d dropped (cap)", privacy.dnrRules.length, privacy.droppedNetwork);
  console.log("annoyances: %d rules kept, %d dropped (cap)", annoyances.dnrRules.length, annoyances.droppedNetwork);
  console.log("cosmetic generic selectors: %d", cosmeticGeneric.size);
  console.log("cosmetic domain-specific entries: %d", cosmeticSpecific.size);
  console.log("blocked-domain set (for badge counts): %d", blockedDomains.size);
  console.log(
    "total static DNR rules: %d (Chrome's guaranteed-safe budget is 30000)",
    ads.dnrRules.length + privacy.dnrRules.length + annoyances.dnrRules.length
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
