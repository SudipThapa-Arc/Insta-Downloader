// Runs in the page's own JS context (world: MAIN) at document_start.
// Instagram streams reels/feed videos through <video src="blob:...">, so the
// real MP4 URL never touches the DOM. The media URLs *are* present in the JSON
// Instagram fetches, so we watch fetch/XHR and keep a shortcode -> media map
// that the isolated content script can ask for over postMessage.

(() => {
  if (window.__instaSaverCapture) return;
  window.__instaSaverCapture = true;

  const MAX_ENTRIES = 400;
  const store = new Map(); // shortcode -> { items, username, at }

  const widest = (list) =>
    Array.isArray(list) && list.length
      ? list.reduce((best, item) => ((item?.width || 0) >= (best?.width || 0) ? item : best))
      : null;

  function imageUrl(media) {
    return widest(media?.image_versions2?.candidates)?.url || null;
  }

  function videoUrl(media) {
    return widest(media?.video_versions)?.url || null;
  }

  function itemsFor(media) {
    const slides =
      Array.isArray(media.carousel_media) && media.carousel_media.length ? media.carousel_media : [media];
    const items = [];

    for (const slide of slides) {
      if (!slide || typeof slide !== "object") continue;
      const video = videoUrl(slide);
      if (video) {
        items.push({ type: "video", url: video });
        continue;
      }
      const image = imageUrl(slide);
      if (image) items.push({ type: "image", url: image });
    }

    return items;
  }

  function remember(code, media, username) {
    const items = itemsFor(media);
    if (!items.length) return;
    const owner = username || media?.user?.username || null;
    if (store.has(code)) store.delete(code);
    store.set(code, { items, username: owner, at: Date.now() });
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  }

  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 24) return;

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }

    if (
      typeof node.code === "string" &&
      (node.image_versions2 || node.video_versions || node.carousel_media)
    ) {
      remember(node.code, node);
    }

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
    if (text.indexOf("image_versions2") === -1 && text.indexOf("video_versions") === -1) return;
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
        typeof request === "string" ? request : request && typeof request.url === "string" ? request.url : "";

      return nativeFetch.apply(this, args).then((response) => {
        try {
          if (/instagram\.com\/(api|graphql)|\/graphql\/query/i.test(url)) {
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

  // --- isolated content script bridge --------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__instaSaver !== "get" || typeof data.shortcode !== "string") return;

    const entry = store.get(data.shortcode);
    window.postMessage(
      {
        __instaSaver: "media",
        id: data.id,
        entry: entry ? { items: entry.items, username: entry.username } : null
      },
      "*"
    );
  });
})();
