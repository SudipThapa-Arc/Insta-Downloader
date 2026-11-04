// Runs in the page's own JS context (world: MAIN) at document_start.
// Instagram streams reels/stories through <video src="blob:...">, so the real
// media URL never touches the DOM. The URLs *are* present in the JSON Instagram
// fetches, so we watch fetch/XHR and keep indexes the isolated content script
// can query over postMessage:
//
//   byCode   shortcode  -> post media (feed, profile, reel page, post modal)
//   byPk     media pk   -> one story/highlight item (/stories/<user>/<pk>/)
//   byBurst  username / highlight id -> every item of one story burst
//
// Every video keeps ALL its encoded variants, largest first: Instagram serves
// some of them video-only (the audio track lives separately in the DASH
// manifest), so the worker probes them and picks the best one that has sound.

(() => {
  if (window.__instaSaverCapture) return;
  window.__instaSaverCapture = true;

  const MAX_ENTRIES = 600;
  const byCode = new Map(); // shortcode -> { items, username, at }
  const byPk = new Map(); // "pk" -> { item, username, at }
  const byBurst = new Map(); // "user:x" | "id:x" -> { items, username, at }
  const byImage = new Map(); // poster image stem -> { items, username, at }

  const num = (value) => (typeof value === "number" && isFinite(value) ? value : 0);
  const area = (entry) => num(entry.width) * num(entry.height);

  function imageStem(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split("/").pop() || "";
      const stem = filename.replace(/\.[a-z0-9]+$/i, "");
      return stem && stem.length >= 4 ? stem : null;
    } catch {
      return null;
    }
  }

  function trim(map) {
    while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  }

  function remember(map, key, value) {
    if (!key) return;
    if (map.has(key)) map.delete(key); // keep insertion order = recency
    map.set(key, value);
    trim(map);
  }

  function videoVariants(media) {
    const list = media && media.video_versions;
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list
      .filter((entry) => entry && typeof entry.url === "string" && entry.url)
      .map((entry) => ({
        url: entry.url,
        width: num(entry.width),
        height: num(entry.height),
        type: num(entry.type)
      }))
      .filter((entry) => (seen.has(entry.url) ? false : seen.add(entry.url)))
      .sort((a, b) => area(b) - area(a)); // HIGHEST QUALITY / RESOLUTION FIRST
  }

  function imageCandidates(media) {
    const list = media && media.image_versions2 && media.image_versions2.candidates;
    if (!Array.isArray(list)) return [];
    return list
      .filter((entry) => entry && typeof entry.url === "string" && entry.url)
      .map((entry) => ({ url: entry.url, width: num(entry.width), height: num(entry.height) }))
      .sort((a, b) => area(b) - area(a));
  }

  // One downloadable item: the best URL plus every video variant to choose from.
  function itemFor(media) {
    if (!media || typeof media !== "object") return null;

    const variants = videoVariants(media);
    if (variants.length) {
      const best = variants[0];
      return {
        type: "video",
        url: best.url,
        width: best.width,
        height: best.height,
        pk: media.pk != null ? String(media.pk) : null,
        variants
      };
    }

    if (typeof media.video_url === "string" && media.video_url) {
      return {
        type: "video",
        url: media.video_url,
        width: num(media.dimensions?.width),
        height: num(media.dimensions?.height),
        pk: media.pk != null ? String(media.pk) : null,
        variants: [
          {
            url: media.video_url,
            width: num(media.dimensions?.width),
            height: num(media.dimensions?.height),
            type: 101
          }
        ]
      };
    }

    const images = imageCandidates(media);
    const best =
      images[0] ||
      (typeof media.display_url === "string" && media.display_url
        ? { url: media.display_url, width: 0, height: 0 }
        : null);
    if (!best) return null;
    return {
      type: "image",
      url: best.url,
      width: num(best.width),
      height: num(best.height),
      pk: media.pk != null ? String(media.pk) : null
    };
  }

  function itemsFor(media) {
    const slides =
      Array.isArray(media.carousel_media) && media.carousel_media.length
        ? media.carousel_media
        : [media];
    const items = [];
    for (const slide of slides) {
      const item = itemFor(slide);
      if (item) items.push(item);
    }
    return items;
  }

  function isMediaNode(node) {
    return !!(
      node &&
      typeof node === "object" &&
      (node.image_versions2 || node.video_versions || node.video_url || node.display_url) &&
      (typeof node.code === "string" ||
        typeof node.shortcode === "string" ||
        node.pk != null ||
        node.id != null)
    );
  }

  // A story/highlight burst: { id: "highlight:123", user, items: [media…] }
  function isBurst(node) {
    return !!(
      node &&
      typeof node === "object" &&
      Array.isArray(node.items) &&
      node.items.length &&
      node.items.some(isMediaNode)
    );
  }

  function rememberMedia(node) {
    const username =
      (node.user && typeof node.user.username === "string" && node.user.username) ||
      (node.owner && typeof node.owner.username === "string" && node.owner.username) ||
      null;

    const code =
      (typeof node.code === "string" && node.code) ||
      (typeof node.shortcode === "string" && node.shortcode) ||
      null;

    const items = itemsFor(node);
    if (!items.length) return;
    const stored = { items, username, at: Date.now() };

    if (code) {
      remember(byCode, code, stored);
    }

    const id = node.id != null ? String(node.id) : node.pk != null ? String(node.pk) : null;
    if (id) {
      remember(byPk, id, stored);
      const bare = id.split("_")[0];
      if (bare !== id) remember(byPk, bare, stored);
    }

    // Index by image candidates (poster stems)
    const candidates = node.image_versions2 && node.image_versions2.candidates;
    if (Array.isArray(candidates)) {
      for (const c of candidates) {
        const stem = imageStem(c && c.url);
        if (stem) remember(byImage, stem, stored);
      }
    }
    if (typeof node.display_url === "string") {
      const stem = imageStem(node.display_url);
      if (stem) remember(byImage, stem, stored);
    }
  }

  function rememberBurst(node) {
    const items = [];
    for (const entry of node.items) {
      const item = itemFor(entry);
      if (item) items.push(item);
    }
    if (!items.length) return;

    const username = node.user && typeof node.user.username === "string" ? node.user.username : null;
    const stored = { items, username, at: Date.now() };
    const id = typeof node.id === "string" ? node.id : "";

    if (username) remember(byBurst, `user:${username}`, stored);
    if (id) {
      remember(byBurst, `id:${id}`, stored);
      // URLs drop the "highlight:" prefix: /stories/highlights/1791234/
      const bare = id.replace(/^highlight:/, "");
      if (bare !== id) remember(byBurst, `id:${bare}`, stored);
      else remember(byBurst, `id:highlight:${id}`, stored);
    }
  }

  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 26) return;

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }

    if (isMediaNode(node)) rememberMedia(node);
    if (isBurst(node)) rememberBurst(node);

    for (const key in node) {
      const value = node[key];
      if (value && typeof value === "object") walk(value, depth + 1);
    }
  }

  function ingest(payload) {
    if (!payload || typeof payload !== "object") return;
    try {
      walk(payload, 0);
    } catch {
      /* ignore malformed payloads */
    }
  }

  function ingestText(text) {
    if (typeof text !== "string" || text.length < 24) return;
    if (
      text.indexOf("image_versions2") === -1 &&
      text.indexOf("video_versions") === -1 &&
      text.indexOf("video_url") === -1 &&
      text.indexOf("display_url") === -1
    )
      return;
    try {
      ingest(JSON.parse(text));
    } catch {
      /* not JSON */
    }
  }

  // --- fetch hook -----------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const request = args[0];
      const url =
        typeof request === "string"
          ? request
          : request && typeof request.url === "string"
            ? request.url
            : "";

      return nativeFetch.apply(this, args).then((response) => {
        try {
          if (/instagram\.com\/(api|graphql)|graphql\/query|\/api\/v1\//i.test(url)) {
            response
              .clone()
              .json()
              .then(ingest)
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
        return response;
      });
    };
  }

  // --- XHR hook -------------------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.addEventListener("load", () => {
      try {
        if (this.responseType === "" || this.responseType === "text") {
          ingestText(this.responseText);
        } else if (this.responseType === "json") {
          ingest(this.response);
        }
      } catch {
        /* ignore opaque/cross-origin responses */
      }
    });
    return nativeOpen.call(this, method, url, ...rest);
  };

  // --- inline page data -----------------------------------------------------
  // Highlights and profile tabs often ship their first payload inside a script
  // tag, which never passes through fetch or XHR.
  function scanInline() {
    const scripts = document.querySelectorAll('script[type="application/json"], script:not([src])');
    for (const script of scripts) {
      const text = script.textContent;
      if (!text || text.length < 64) continue;
      if (text.indexOf("image_versions2") === -1 && text.indexOf("video_versions") === -1) continue;
      ingestText(text);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(scanInline, 0), { once: true });
  } else {
    setTimeout(scanInline, 0);
  }

  // --- story item matching --------------------------------------------------
  // A highlight page keeps one URL while the viewer moves through its items, so
  // the displayed media is identified by aspect ratio. Story items in a burst
  // almost always differ, and the decoded size is exact.
  function closestByAspect(items, aspect) {
    if (!aspect || !isFinite(aspect) || aspect <= 0) return null;
    let best = null;
    let bestDelta = Infinity;
    for (const item of items) {
      if (!item.width || !item.height) continue;
      const delta = Math.abs(item.width / item.height - aspect);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = item;
      }
    }
    // 8% tolerance: reels are letterboxed, so exact matches are not guaranteed.
    return best && bestDelta <= 0.08 * Math.max(1, aspect) ? best : null;
  }

  function burstFor(message) {
    const candidates = [];
    if (message.storyId) {
      const id = String(message.storyId).replace(/\/+$/, "");
      candidates.push(`id:${id}`, `id:highlight:${id}`, `id:${id.replace(/^highlight:/, "")}`);
    }
    if (message.storyUser) candidates.push(`user:${message.storyUser}`);

    for (const key of candidates) {
      const entry = byBurst.get(key);
      if (entry) return entry;
    }
    return null;
  }

  function resolve(message) {
    if (message.code) {
      const entry = byCode.get(message.code);
      if (entry) return { items: entry.items, username: entry.username };
    }

    if (message.pk) {
      const entry = byPk.get(String(message.pk));
      if (entry) return { items: Array.isArray(entry.items) ? entry.items : [entry.item], username: entry.username };
    }

    if (message.posterStem) {
      const entry = byImage.get(message.posterStem);
      if (entry) return { items: entry.items, username: entry.username };
    }

    const burst = burstFor(message);
    if (burst) {
      const picked =
        closestByAspect(burst.items, message.aspect) ||
        (burst.items.length === 1 ? burst.items[0] : null);
      if (picked) return { items: [picked], username: burst.username };
      return null;
    }

    return null;
  }

  async function resolveWithFallback(message) {
    let entry = resolve(message);

    // If we got an entry but it's image-only AND the page URL suggests this is a video post
    // (reel/video shortcode), try to fetch the real data which will have video_versions.
    const hasOnlyImages = entry && entry.items && entry.items.length > 0 &&
      entry.items.every((i) => i.type === "image");

    if ((!entry || hasOnlyImages) && message.code) {
      const urls = [
        `https://www.instagram.com/p/${encodeURIComponent(message.code)}/?__a=1&__d=dis`,
        `https://www.instagram.com/reel/${encodeURIComponent(message.code)}/?__a=1&__d=dis`
      ];
      for (const target of urls) {
        try {
          const res = await nativeFetch(target, {
            headers: {
              "X-IG-App-ID": "936619743392459",
              "X-Requested-With": "XMLHttpRequest"
            },
            credentials: "include"
          });
          if (res.ok) {
            const json = await res.json();
            ingest(json);
            const freshEntry = resolve(message);
            // Only replace the entry if the fresh data has video items
            if (freshEntry) {
              const freshHasVideo = freshEntry.items && freshEntry.items.some((i) => i.type === "video");
              if (freshHasVideo || !entry) {
                entry = freshEntry;
              }
            }
            if (entry && entry.items && entry.items.some((i) => i.type === "video")) break;
          }
        } catch {
          /* try next */
        }
      }
    }
    return entry;
  }

  // --- isolated content script bridge --------------------------------------
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__instaSaver !== "get") return;

    let entry = null;
    try {
      entry = await resolveWithFallback(data);
    } catch {
      entry = null;
    }

    window.postMessage({ __instaSaver: "media", id: data.id, entry }, "*");
  });
})();
