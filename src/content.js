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

  function posterStemFor(node) {
    if (!node) return null;
    if (node.tagName === "VIDEO") {
      const poster = node.getAttribute("poster");
      if (poster) {
        const stem = imageStem(poster);
        if (stem) return stem;
      }
      const img =
        node.parentElement?.querySelector("img") ||
        node.closest('[role="row"], [role="listitem"]')?.querySelector("img");
      if (img) {
        const stem = imageStem(img.currentSrc || img.src);
        if (stem) return stem;
      }
    }
    return imageStem(node.currentSrc || node.src);
  }

  // --- media detection ------------------------------------------------------
  function isCandidate(node) {
    if (node.closest("header, nav, .ig-saver-btn")) return false;

    // Skip IMG if it is just a poster for an adjacent or sibling VIDEO
    if (node.tagName === "IMG") {
      const container = node.parentElement;
      if (
        container &&
        (container.querySelector("video") || container.parentElement?.querySelector("video"))
      ) {
        return false;
      }
    }

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
      const posterStem = posterStemFor(media);
      let username = usernameFor(media);

      // Query page interceptor (by shortcode, story, or poster image stem)
      let entry = await askPage({
        code: shortcode || null,
        storyId: story ? story.storyId : null,
        storyUser: story ? story.storyUser : null,
        pk: story ? story.pk : null,
        posterStem,
        aspect: aspectOf(media)
      });
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
          : (items[0] && items[0].pk ? `ig-${items[0].pk}` : (posterStem ? `dm-${posterStem}` : `ig-${Date.now()}`)));

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

    // PREVENT DUPLICATE BUTTONS:
    // If this container or host already has an Insta Saver button, don't duplicate
    const existing =
      parent.querySelector(":scope > .ig-saver-btn") ||
      parent.parentElement?.querySelector(":scope > .ig-saver-btn") ||
      media.closest(".ig-saver-host")?.querySelector(".ig-saver-btn");
    if (existing) {
      buttons.set(media, existing);
      return;
    }

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

  // --- action bar injection (feed posts & reels) -----------------------------
  function findMediaForPost(post) {
    const video = post.querySelector("video");
    if (video) return video;

    const imgs = Array.from(
      post.querySelectorAll('img[srcset], img[src*="cdninstagram"], img[src*="fbcdn"]')
    );
    let best = null;
    let maxArea = 0;
    for (const img of imgs) {
      if (img.closest("header, nav, .ig-saver-btn")) continue;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
        maxArea = area;
        best = img;
      }
    }
    return best || post.querySelector("img") || null;
  }

  function findMediaForReel(column) {
    const container =
      column.closest('[role="dialog"], [tabindex="-1"], section, div[style*="height"]') ||
      document;
    const video = container.querySelector("video");
    if (video) return video;

    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 200 && rect.top < window.innerHeight && rect.bottom > 0) {
        return v;
      }
    }
    return videos[0] || null;
  }

  function createActionButton(variant, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ig-saver-action-btn";
    button.dataset.state = "idle";
    button.dataset.variant = variant;
    button.title = "Download";
    button.setAttribute("aria-label", "Download");
    button.innerHTML = ICONS.download;

    const stop = (event) => event.stopPropagation();
    for (const type of ["pointerdown", "mousedown", "touchstart", "dblclick", "auxclick"]) {
      button.addEventListener(type, stop);
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick(button);
    });

    liveButtons.add(button);
    return button;
  }

  function findReelsActionColumn(el) {
    let curr = el ? (el.nodeType === 1 ? el : el.parentElement) : null;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      const rect = curr.getBoundingClientRect();
      // Reels action columns are narrow (typically 40px to 100px) and tall (>= 120px)
      // and contain multiple action icons
      if (rect.width > 20 && rect.width <= 140 && rect.height >= 120) {
        const svgs = curr.querySelectorAll("svg");
        if (svgs.length >= 2) {
          return curr;
        }
      }
      curr = curr.parentElement;
    }
    return null;
  }

  // Feed posts and post modal dialogs: inject on the right side next to Bookmark
  function attachFeedAction(post) {
    if (!post || location.pathname.includes("/reel") || post.querySelector(".ig-saver-action-btn")) return;

    // Look for the bookmark button (Save / Remove ribbon icon)
    const bookmarkSvg = post.querySelector(
      'svg[aria-label="Save"], svg[aria-label="Remove"], svg[aria-label="Bookmark"]'
    );
    if (bookmarkSvg && findReelsActionColumn(bookmarkSvg)) {
      // This bookmark is inside a vertical Reels column, not a horizontal feed post
      return;
    }

    const bookmarkBtn = bookmarkSvg ? bookmarkSvg.closest("button, [role='button']") : null;

    const button = createActionButton("feed", (btn) => {
      const media = findMediaForPost(post);
      if (media) {
        onDownload(media, btn);
      } else {
        toast("No media found — open the post and try again");
      }
    });

    if (bookmarkBtn) {
      const section = post.querySelector("section");
      const rightGroup = section ? section.querySelector(":scope > div:last-child") : null;

      if (rightGroup && rightGroup.contains(bookmarkSvg)) {
        // Ensure right group maintains flex row alignment
        const comp = window.getComputedStyle(rightGroup);
        if (comp.display !== "flex" && comp.display !== "inline-flex") {
          rightGroup.style.display = "inline-flex";
          rightGroup.style.alignItems = "center";
        }
        const bookmarkItem =
          Array.from(rightGroup.children).find((c) => c.contains(bookmarkSvg)) || bookmarkBtn;
        bookmarkItem.insertAdjacentElement("beforebegin", button);
        return;
      }

      const parent = bookmarkBtn.parentElement;
      if (parent) {
        const comp = window.getComputedStyle(parent);
        if (comp.display !== "flex" && comp.display !== "inline-flex") {
          parent.style.display = "inline-flex";
          parent.style.alignItems = "center";
        }
        bookmarkBtn.insertAdjacentElement("beforebegin", button);
        return;
      }
    }

    // Fallback: If no bookmark button found, attach to the right side of the action section
    const section = post.querySelector("section");
    if (section) {
      button.style.marginLeft = "auto";
      section.appendChild(button);
    }
  }

  // Reels: inject into the vertical action column on the right
  function attachReelAction(column) {
    if (!column || column.querySelector(".ig-saver-action-wrap, .ig-saver-action-btn")) return;

    const shareSvg = column.querySelector('svg[aria-label="Share Post"], svg[aria-label="Share"]');
    const bookmarkSvg = column.querySelector('svg[aria-label="Save"], svg[aria-label="Remove"], svg[aria-label="Bookmark"]');
    const commentSvg = column.querySelector('svg[aria-label="Comment"]');

    const anchorSvg = shareSvg || bookmarkSvg || commentSvg;
    if (!anchorSvg) return;

    const anchorBtn = anchorSvg.closest("button, [role='button']") || anchorSvg;
    const directChild =
      Array.from(column.children).find((c) => c.contains(anchorBtn)) || anchorBtn;

    const wrapper = document.createElement("div");
    wrapper.className = "ig-saver-action-wrap";

    const button = createActionButton("reel", (btn) => {
      const media = findMediaForReel(column);
      if (media) {
        onDownload(media, btn);
      } else {
        toast("No media found — open the post and try again");
      }
    });

    const label = document.createElement("span");
    label.className = "ig-saver-action-label";
    label.textContent = "Download";

    wrapper.appendChild(button);
    wrapper.appendChild(label);

    // If anchoring to Share, place right below Share (between Share and Bookmark).
    // If anchoring to Bookmark, place right above Bookmark.
    if (shareSvg && directChild.contains(shareSvg)) {
      directChild.insertAdjacentElement("afterend", wrapper);
    } else if (bookmarkSvg && directChild.contains(bookmarkSvg)) {
      directChild.insertAdjacentElement("beforebegin", wrapper);
    } else {
      directChild.insertAdjacentElement("afterend", wrapper);
    }
  }

  function scanFeedActionBars() {
    if (location.pathname.includes("/reel")) return;
    const posts = document.querySelectorAll("article, [role='dialog']");
    for (const post of posts) {
      attachFeedAction(post);
    }
  }

  function scanReelActionBars() {
    const actionSvgs = document.querySelectorAll(
      'svg[aria-label="Save"], svg[aria-label="Remove"], svg[aria-label="Bookmark"], svg[aria-label="Share Post"], svg[aria-label="Share"], svg[aria-label="Comment"]'
    );
    const processedColumns = new Set();

    for (const svg of actionSvgs) {
      const column = findReelsActionColumn(svg);
      if (!column || processedColumns.has(column)) continue;
      processedColumns.add(column);

      attachReelAction(column);
    }
  }

  function scanActionBars() {
    scanFeedActionBars();
    scanReelActionBars();
  }

  function scan() {
    for (const button of liveButtons) {
      if (!button.isConnected) liveButtons.delete(button);
    }

    scanActionBars();

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
