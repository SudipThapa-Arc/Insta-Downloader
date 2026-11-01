// Content script (isolated world). Finds post and story media, injects a
// download button, asks the page for the real media URLs, and hands the chosen
// file to the worker.
(() => {
  if (window.__instaSaverUi) return;
  window.__instaSaverUi = true;

  const CDN = /(cdninstagram\.com|fbcdn\.net)/i;
  const MIN_SIZE = 100; // px — supports feed, profile, reels and inbox DM previews
  const REPLY_TIMEOUT = 3500; // ms — allows on-demand fetch for un-cached posts/reels

  const buttons = new WeakMap(); // media element -> button
  const liveButtons = new Set();
  const pending = new Map(); // request id -> resolve
  let requestId = 0;

  const ICONS = {
    download:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.75v10.5"/><path d="M7.75 10.25 12 14.5l4.25-4.25"/><path d="M4.5 16.75v1.5A2.25 2.25 0 0 0 6.75 20.5h10.5a2.25 2.25 0 0 0 2.25-2.25v-1.5"/></svg>',
    done:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5l11 11"/><path d="M17.5 6.5l-11 11"/></svg>'
  };

  const IG_RESERVED = new Set([
    "direct",
    "explore",
    "reels",
    "reel",
    "stories",
    "accounts",
    "p",
    "tv",
    "about",
    "developer",
    "privacy",
    "help"
  ]);

  // --- page bridge ----------------------------------------------------------
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__instaSaver !== "media" || !pending.has(data.id)) return;
    const resolve = pending.get(data.id);
    pending.delete(data.id);
    resolve(data.entry || null);
  });

  function askPage(query) {
    return new Promise((resolve) => {
      const id = (requestId += 1);
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve(null);
        }
      }, REPLY_TIMEOUT);
      pending.set(id, (entry) => {
        clearTimeout(timer);
        resolve(entry);
      });
      window.postMessage({ __instaSaver: "get", id, ...query }, "*");
    });
  }

  // --- context --------------------------------------------------------------
  function codeFrom(href) {
    if (!href) return null;
    const match = String(href).match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/);
    return match ? match[1] : null;
  }

  function shortcodeFor(node) {
    const linked = node.closest("a[href]");
    if (linked) {
      const code = codeFrom(linked.getAttribute("href"));
      if (code) return code;
    }

    const scope = node.closest('article, [role="dialog"], [role="row"], [role="listitem"]');
    if (scope) {
      const link = scope.querySelector('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]');
      const code = codeFrom(link && link.getAttribute("href"));
      if (code) return code;
    }

    // Direct Messages fallback: search nearby ancestors for any reel/post link
    let current = node.parentElement;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const link = current.querySelector('a[href*="/reel/"], a[href*="/p/"], a[href*="/reels/"], a[href*="/tv/"]');
      if (link) {
        const code = codeFrom(link.getAttribute("href"));
        if (code) return code;
      }
      current = current.parentElement;
    }

    return codeFrom(location.pathname);
  }

  // /stories/<user>/<pk>/ and /stories/highlights/<id>/
  function storyContext() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "stories" || !parts[1]) return null;
    if (parts[1] === "highlights") {
      return { storyId: parts[2] || null, storyUser: null, pk: null };
    }
    return { storyId: null, storyUser: parts[1], pk: parts[2] || null };
  }

  function usernameFor(node) {
    const scope = node.closest('article, [role="dialog"], [role="row"], [role="listitem"]');
    if (scope) {
      const links = scope.querySelectorAll('a[href^="/"]');
      for (const link of links) {
        const match = (link.getAttribute("href") || "").match(/^\/([A-Za-z0-9._]{2,30})\/$/);
        if (match && !IG_RESERVED.has(match[1])) return match[1];
      }
    }
    const profile = location.pathname.match(/^\/([A-Za-z0-9._]{2,30})\/?$/);
    return profile && !IG_RESERVED.has(profile[1]) ? profile[1] : null;
  }

  function aspectOf(media) {
    const width = media.videoWidth || media.naturalWidth || media.getBoundingClientRect().width;
    const height = media.videoHeight || media.naturalHeight || media.getBoundingClientRect().height;
    return width && height ? width / height : null;
  }

  // --- media detection ------------------------------------------------------
  function isCandidate(node) {
    if (node.closest("header, nav, .ig-saver-btn")) return false;

    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false;

    if (node.tagName === "IMG") {
      const src = node.currentSrc || node.src || "";
      const srcset = node.getAttribute("srcset") || "";
      return CDN.test(src) || CDN.test(srcset);
    }

    return node.tagName === "VIDEO";
  }

  function bestImage(node) {
    const srcset = node.getAttribute("srcset");
    let best = node.currentSrc || node.src || "";
    if (!srcset) return best || null;

    let bestScore = 0;
    for (const part of srcset.split(",")) {
      const [url, descriptor = ""] = part.trim().split(/\s+/);
      if (!url) continue;
      const width = parseInt(descriptor, 10) || 0;
      const density = descriptor.endsWith("x") ? parseFloat(descriptor) * 1000 : 0;
      const score = width || density;
      if (score >= bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best || null;
  }

  function domItems(node) {
    if (node.tagName === "VIDEO") {
      const src = node.currentSrc || node.src || "";
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return null;
      return [{ type: "video", url: src }];
    }
    const url = bestImage(node);
    return url ? [{ type: "image", url }] : null;
  }

  // --- toast ----------------------------------------------------------------
  let toastEl = null;
  let toastTimer = 0;

  function toast(message) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.className = "ig-saver-toast";
      toastEl.setAttribute("role", "status");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.removeAttribute("data-show");
    // One frame so the transition replays when the same toast repeats.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toastEl && toastEl.setAttribute("data-show", "1"));
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.removeAttribute("data-show");
    }, 2100);
  }

  // --- download -------------------------------------------------------------
  function setState(button, state) {
    button.dataset.state = state;
    if (state === "busy") {
      button.innerHTML = '<span class="ig-saver-spin"></span>';
      button.setAttribute("aria-label", "Downloading");
      return;
    }
    button.innerHTML = ICONS[state] || ICONS.download;
    const label = state === "done" ? "Saved" : state === "error" ? "Download failed" : "Download";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function describe(result, count) {
    if (count > 1) return `Saved ${count} files`;
    const parts = ["Saved"];
    if (result && result.size) parts.push(result.size);
    if (result && result.muted) parts.push("no audio track available");
    return parts.join(" · ");
  }

  async function onDownload(media, button) {
    if (button.dataset.state === "busy") return;
    setState(button, "busy");

    try {
      const story = storyContext();
      const shortcode = story ? null : shortcodeFor(media);
      let username = usernameFor(media);

      let entry = null;
      if (shortcode || story) {
        entry = await askPage({
          code: shortcode || null,
          storyId: story ? story.storyId : null,
          storyUser: story ? story.storyUser : null,
          pk: story ? story.pk : null,
          aspect: aspectOf(media)
        });
      }
      if (entry && entry.username) username = entry.username;

      // One item from the page data is always the full-quality source.
      // A carousel: keep the slide that was actually clicked, from the DOM.
      let items = null;
      if (entry && entry.items && entry.items.length) {
        items = story || entry.items.length === 1 ? entry.items : null;
      }
      if (!items) items = domItems(media);
      if (!items && entry && entry.items) items = entry.items;

      if (!items || !items.length) {
        setState(button, "error");
        toast("No media found — open the post and try again");
        setTimeout(() => setState(button, "idle"), 1600);
        return;
      }

      const base =
        shortcode ||
        (story
          ? `${story.storyUser || "story"}-${(items[0] && items[0].pk) || story.pk || Date.now()}`
          : `ig-${Date.now()}`);

      const result = await chrome.runtime.sendMessage({
        type: "ig-download",
        items,
        base,
        username: username || (story && story.storyUser) || null
      });

      if (result && result.ok) {
        setState(button, "done");
        toast(describe(result, items.length));
      } else {
        setState(button, "error");
        toast("Download failed — try again");
      }
    } catch (error) {
      setState(button, "error");
      toast(
        String(error && error.message).includes("Extension")
          ? "Reload the page to reconnect Insta Saver"
          : "Download failed — try again"
      );
    }

    setTimeout(() => {
      if (button.isConnected) setState(button, "idle");
    }, 1700);
  }

  // --- button injection -----------------------------------------------------
  function attach(media) {
    const parent = media.parentElement;
    if (!parent) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ig-saver-btn";
    button.dataset.state = "idle";
    button.title = "Download";
    button.setAttribute("aria-label", "Download");
    button.innerHTML = ICONS.download;

    // Full-bleed media (reel player, story viewer) has its own header controls
    // in the top-right corner, so the button sits just below them.
    if (media.getBoundingClientRect().height >= window.innerHeight * 0.8) {
      button.dataset.placement = "inset";
    }

    const stop = (event) => event.stopPropagation();
    for (const type of ["pointerdown", "mousedown", "touchstart", "dblclick", "auxclick"]) {
      button.addEventListener(type, stop);
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDownload(media, button);
    });

    if (getComputedStyle(parent).position === "static") parent.classList.add("ig-saver-host");
    parent.appendChild(button);

    buttons.set(media, button);
    liveButtons.add(button);
  }

  function scan() {
    for (const button of liveButtons) {
      if (!button.isConnected) liveButtons.delete(button);
    }

    for (const node of document.querySelectorAll("img, video")) {
      const existing = buttons.get(node);
      if (existing && existing.isConnected) continue;
      if (isCandidate(node)) attach(node);
    }
  }

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scan();
    }, 200);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  window.addEventListener("scroll", scheduleScan, { passive: true, capture: true });
  window.addEventListener("resize", scheduleScan, { passive: true });

  scan();
})();
