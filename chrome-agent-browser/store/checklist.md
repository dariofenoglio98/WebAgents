# U7: submitting to the Chrome Web Store

1. **Account.** Register a Chrome Web Store developer account (one-time fee) with the Google
   account that will own the listing; enable two-step verification.
2. **Build the zip.** From `chrome-agent-browser/`: `npm ci && npm run build && npm run pack &&
   npm run check-pack` (must print `"passed": true`). Upload `dist/chrome-agent-browser-0.2.0.zip`.
   Keep `dist/chrome-agent-browser-0.2.0.contents.txt` beside the commit hash: it identifies the
   build across Node releases (D-093).
3. **Store listing.** Paste `listing.md`: name, summary, description, category, language. Upload
   `screenshots/1-start-page.png` … `4-settings-security.png` (1280×800) and the 128×128 icon from
   `src/extension/icons/icon-128.png`. A promotional tile is optional.
4. **Privacy practices.** Single purpose from `single-purpose.md`; each permission's justification
   from `permissions.md`; "remote code: no"; the data-use answers at the end of
   `privacy-policy.md`; the privacy policy URL where you hosted `privacy-policy.md`.
5. **Distribution.** Visibility *Unlisted* for the first review (reachable by link, not searchable);
   *Public* once a Demo has been given with the listed build. Regions: all.
6. **Submit for review.** Reviews take a few days; a rejection names the policy. The usual asks for
   an extension like this one: a narrower permission (ours are minimal and justified), a clearer
   single purpose, a privacy policy URL that resolves.
7. **After approval.** Record the listing URL and the reviewed build's zip hash in STATE.md §10;
   loading unpacked from a checkout keeps working for development.

What cannot be done here: the account, the fee, the hosting of the privacy policy and the review
wait are the user's (U7).
