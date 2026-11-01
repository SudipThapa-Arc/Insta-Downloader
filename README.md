# Insta Saver

A personal Chrome extension (Manifest V3) that puts a **one-click download button on every
Instagram photo, video, carousel slide, reel, story and highlight**. No accounts, no servers,
no third-party sites — files go straight from Instagram's CDN into your Downloads folder.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (or any Chromium browser: Edge, Brave, Arc, Vivaldi).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick this folder — the one containing `manifest.json`.
4. Open <https://www.instagram.com>, refresh the tab once, and start scrolling.

After you edit any file, press the reload arrow on the extension card and refresh Instagram.

## Use

Every piece of media gets a small round download button in its **top-right corner** — on the
reel player and the story viewer it sits just below the header controls so it never covers them.

- **Feed / profile posts** — photos, videos and every carousel slide.
- **Reels** — the `/reels/` feed and individual `/reel/…` pages.
- **Stories** — `/stories/<user>/…`, one item at a time as you tap through.
- **Highlights** — `/stories/highlights/<id>/`, same behaviour.
- **Post modal** — open a post, the button is on the media.

Click once → the button spins → turns green with a toast that also reports what was saved
(for example `Saved · 1080×1920`). Files land in
`Downloads/Insta Saver/<username>/<shortcode>.jpg|mp4`. A carousel downloads one file per click,
per slide (each slide has its own button).

## Quality and audio

Two things make the saved file the best Instagram actually serves:

1. **Highest resolution.** The page keeps *all* of Instagram's image and video variants for every
   post. Images are taken from the largest candidate rather than the 640px DOM thumbnail, and
   videos are ranked by pixel area.
2. **An audio track.** Instagram encodes the same video several ways, and its *highest-resolution*
   MP4 is often **video-only** — the sound lives in the DASH manifest as a separate file. Picking
   on resolution alone is exactly what produces silent downloads. So before saving, the worker
   reads the first 420 KB of each candidate with a ranged request and checks the MP4 header for an
   audio track (`mp4a` / `soun`, with a tail read when the header sits at the end of the file).
   It downloads the **largest variant that has sound**.

If none of the variants report an audio track, you get the highest resolution anyway and the toast
says “no audio track available” — that video is genuinely published without sound (or its audio
only exists as a separate DASH stream, which an extension can't mux without bundling a video
encoder). Probes are cached per URL, so repeat downloads cost nothing extra.

## How it works

| File | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV3 wiring: permissions, content scripts, worker. |
| [src/interceptor.js](src/interceptor.js) | Runs in the page's own JS context (`world: "MAIN"`). Hooks `fetch`/`XHR`, scans inline page data, and indexes media by shortcode (posts), `pk` (story items) and burst (story/highlight sets) — so the real URLs are known even when the player uses a `blob:` source. |
| [src/content.js](src/content.js) | Isolated world. Detects media, injects buttons, works out whether it's a post, reel, story or highlight, picks the full-quality URL, shows toasts. |
| [src/content.css](src/content.css) | Button and toast styles (injected by the manifest, so Instagram's CSP can't block them). |
| [src/background.js](src/background.js) | Audio-track probe, variant choice, and `chrome.downloads` (keeps cookies, bypasses CORS). |
| [src/popup.html](src/popup.html) | Toolbar popup with the usage hint. |
| [tools/make-icons.mjs](tools/make-icons.mjs) | Regenerates `icons/*.png` (`node tools/make-icons.mjs`). |

Why the page-context hook: reels and stories are played through Media Source Extensions with a
`blob:` URL. The DOM never exposes the real `.mp4`, but Instagram's own API response does.

How stories are matched: a highlight keeps one URL while you tap through its items, so the
displayed item is identified by decoded aspect ratio against the `pk`/burst data captured from the
page (exact `pk` match first when the URL carries it). Items in a burst almost always differ in
aspect ratio, which makes the match reliable; if it can't be resolved, the button falls back to the
image or MP4 that the DOM does expose.

## Notes & limits

- Only media you can already see while logged in is downloadable — nothing behind a paywall or
  private account you don't follow.
- DMs and profile pictures are out of scope.
- Muxing a video-only stream together with its separate DASH audio track needs a video encoder;
  this extension instead selects the best variant that already contains audio.
- Downloading someone else's content may break Instagram's Terms of Use; keep this for personal,
  permitted use.
- If a button ever reports “No media found”, open the post in its own modal and click again — that
  forces Instagram to load the media JSON for that post.
- Instagram changes class names constantly; this extension deliberately keys off element size and
  CDN hostnames instead of hashed class names, so it survives redesigns.
