# Chrome Web Store submission kit (T16, U7)

What the WebAgents Agent Browser 0.2.0 submission needs, in the order the developer dashboard
asks for it. Everything here is derived from the shipped extension; nothing claims more than the
code does.

| File | Dashboard field |
|---|---|
| `listing.md` | Store listing: name, summary, description, category, language |
| `privacy-policy.md` | Privacy practices: the policy text to host at a public URL, and the per-question answers of the dashboard's privacy tab |
| `single-purpose.md` | Privacy practices → single purpose |
| `permissions.md` | Privacy practices → permission justifications, one per permission |
| `screenshots/` | Store listing → screenshots (1280×800, from `npm run build && node scripts/store-screenshots.mjs`) |
| `checklist.md` | What to do, in order, with what to paste where |

The uploaded file is `dist/chrome-agent-browser-0.2.0.zip` from `npm run build && npm run pack`,
checked by `npm run check-pack` (file set, version, notices, the least-privilege manifest, no
remote code). The same sources and Node release give the same zip bytes (D-093).
