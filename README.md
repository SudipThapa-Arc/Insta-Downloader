# Insta Saver

A personal Chrome extension (Manifest V3) that puts a **one-click download button on every
Instagram photo, video, carousel slide and reel**. No accounts, no servers, no third-party
sites — files go straight from Instagram's CDN into your Downloads folder.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc, Vivaldi).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick this folder — the one containing `manifest.json`.
4. Open <https://www.instagram.com>, refresh the tab once, and start scrolling.

After you edit any file, press the reload arrow on the extension card and refresh Instagram.

## Use

Every piece of post media gets a small round download button in its **top-right corner**:

- **Feed / profile posts** — photos, videos and every slide of a carousel.
- **Reels** — both the `/reels/` feed and individual `/reel/…` pages.
- **Post modal** — open a post, the button is on the media.

Click once → the button spins → turns green with a “Saved to your downloads” toast.
Files land in `Downloads/Insta Saver/<username>/<shortcode>.jpg|mp4`.
A carousel downloads one file per click, per slide (each slide has its own button).

## How it works

| File | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV3 wiring: permissions, content scripts, worker. |
| [src/interceptor.js](src/interceptor.js) | Runs in the page's own JS context (`world: "MAIN"`). Hooks `fetch`/`XHR` and keeps a `shortcode → media URLs` map from Instagram's own JSON, so high-res stills and MP4s are known even when the player uses a `blob:` source. |
| [src/content.js](src/content.js) | Isolated world. Detects post media, injects buttons, picks the best URL (page data first, `srcset` fallback), shows toasts. |
| [src/content.css](src/content.css) | Button and toast styles (injected by the manifest, so Instagram's CSP can't block them). |
| [src/background.js](src/background.js) | Sends the URL to `chrome.downloads`, which keeps cookies and bypasses CORS entirely. |
| [src/popup.html](src/popup.html) | Toolbar popup with the three-step usage hint. |
| [tools/make-icons.mjs](tools/make-icons.mjs) | Regenerates `icons/*.png` (`node tools/make-icons.mjs`). |

Why the page-context hook: reels and some feed videos are played through Media Source Extensions
with a `blob:` URL. The DOM never exposes the real `.mp4`, but Instagram's own API response does.
Reading that response is what lets reels download at source quality instead of grabbing a screenshot.

## Notes & limits

- Only media you can already see while logged in is downloadable — nothing behind a paywall or
  private account you don't follow.
- Stories, highlights, DMs and profile pictures are out of scope.
- Downloading someone else's content may break Instagram's Terms of Use; keep this for personal,
  permitted use.
- If a button ever reports “No media found”, open the post in its own modal and click again — that
  forces Instagram to load the media JSON for that post.
- Instagram changes class names constantly; this extension deliberately keys off element size and
  CDN hostnames instead of hashed class names, so it survives redesigns.
