# Ghost Block

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-informational)
![Zero npm dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)

**A free Chrome extension that blocks ads and trackers — and doesn't let sites know it's there.**

Most ad blockers get spotted. Sites run scripts that check whether their ads
loaded, and if they didn't, you get a "please disable your ad blocker"
message. Ghost Block blocks those detector scripts too, and takes extra
steps to keep your browser from being fingerprinted (tracked by its unique
characteristics) by the sites you visit.

No account, no settings synced to a server, nothing tracked about you or
sent anywhere — everything it does stays on your own computer.

Free and open source, for anyone to read, use, or improve.

## What it does

- 🚫 **Blocks ads and trackers** on every site you visit
- 🛡️ **Gets past "please disable your ad blocker" walls** — many sites try
  to detect ad blockers and guilt or block you into turning them off; this
  fights back
- 🍪 **Blocks cookie/tracking-consent pop-ups** — the "we value your
  privacy, accept all cookies?" banners that clutter nearly every site
- 🕵️ **Makes your browser harder to track** by the subtle technical details
  sites use to fingerprint visitors, even ones who block ads
- 🧠 **Learns as you browse** — flags new ads it doesn't recognize yet and
  lets you approve or dismiss them with one click, right from the popup
- 👻 **Doesn't advertise its own presence** — nothing about how it works
  gives away to a website that it's installed
- 🔒 **Collects nothing** — no accounts, no analytics, no data leaving your
  computer, ever

## Installing it

1. Download this repository (green **Code** button above → **Download ZIP**,
   then unzip it — or `git clone` it if you're comfortable with git)
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked**, and select the unzipped/cloned folder
5. Pin it from the puzzle-piece icon in Chrome's toolbar so it's always visible

That's it — it's now protecting every site you visit.

## Using it

Click the Ghost Block icon in your toolbar to open its popup:

- The switch at the top turns everything on/off
- **Pause** turns protection off just for the site you're currently on —
  use this first if a page looks broken. **Paused sites** lists every site
  you've paused, in one place, with a button to resume each one
- Below that are five separate switches, one per protection listed above,
  so you can turn any of them off individually if you want
- **New ads found on this device** shows ads it spotted that weren't
  already on its list — click ✓ to block one, or ✕ to ignore it

## Something looks broken?

Open the popup on that site and hit **Pause**. If that doesn't fix it, or
if you want to report an ad/tracker that got through, please
[open an issue](../../issues) — real reports are what make this better.

## Want the technical details?

Everything about how it actually works under the hood — the architecture,
what each file does, how the filter lists are compiled, known limitations,
and the security model — is in **[docs/TECHNICAL.md](docs/TECHNICAL.md)**.

## License

Ghost Block's own code is [GPL-3.0](LICENSE) licensed — free to use, study,
modify, and share. The compiled ad/tracker lists it ships with come from
third-party sources that keep their own licenses; see
[docs/TECHNICAL.md](docs/TECHNICAL.md#license--attribution) for details.

See [SECURITY.md](SECURITY.md) for how to report a security issue.
