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
    if (location.pathname.startsWith("/stories")) return false;
    if (node.closest("header, nav, .ig-saver-btn")) return false;

    // Do NOT inject floating overlay buttons if media belongs to a post with an action bar
    // (Feed posts, single /p/ or /reel/ pages, profile modal dialogs).
    // The action bar button next to Bookmark handles these cleanly!
    // Floating overlay buttons are strictly reserved for Direct Messages (inbox previews).
    if (!node.closest('[role="row"], [role="listitem"]')) {
      return false;
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
      // Priority:
      //   1. Interceptor entry video items (the real CDN mp4 URL)
      //   2. Interceptor entry image items (only if no video found)
      //   3. DOM video src (only if not blob: — direct progressive mp4)
      //   4. All entry items as fallback
      let items = null;
      if (entry && entry.items && entry.items.length) {
        // For single-media posts always use interceptor data.
        // For carousels (>1 item and not story) try to match what the user is looking at.
        if (story) {
          items = entry.items;
        } else {
          // Always prefer the video items from the entry, regardless of carousel size
          const videoItems = entry.items.filter((i) => i.type === "video");
          const imageItems = entry.items.filter((i) => i.type === "image");

          if (videoItems.length) {
            // If the DOM media is a VIDEO or the entry has only 1 video item, download it
            if (media.tagName === "VIDEO" || entry.items.length === 1 || videoItems.length === 1) {
              items = videoItems;
            } else {
              // Carousel with multiple videos — use all video items
              items = videoItems;
            }
          } else if (entry.items.length === 1) {
            // Single image post
            items = imageItems.length ? imageItems : entry.items;
          } else {
            // Multi-image carousel — user clicked a specific slide
            items = null; // fall through to domItems for the visible slide
          }
        }
      }
      // Fall back to DOM media only if interceptor had no video data
      if (!items) items = domItems(media);
      // Last resort: all entry items (image carousel)
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
    if (location.pathname.startsWith("/stories")) return;
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

  /**
   * Find the best media element for a post at CLICK TIME.
   * Prefers visible <video> (even blob:), falls back to best <img>.
   * Never returns elements inside header/nav/buttons.
   */
  function findBestMediaNow(post) {
    const isPage =
      !post ||
      post === document ||
      post.tagName === "SECTION" ||
      post === document.documentElement ||
      post === document.body;

    // Priority 1: any visible video in the post scope / page
    const videoPool = isPage
      ? Array.from(document.querySelectorAll("video"))
      : Array.from((post || document).querySelectorAll("video")).concat(
          Array.from(document.querySelectorAll("video"))
        );
    for (const v of videoPool) {
      if (v.closest("header, nav")) continue;
      const rect = v.getBoundingClientRect();
      if (rect.width >= 100 && rect.height >= 100) return v;
    }
    // Any video at all (off-screen is fine for SPA pre-renders)
    const anyVideo = document.querySelector("video:not(header video):not(nav video)");
    if (anyVideo) return anyVideo;

    // Priority 2: largest CDN image in scope
    const imgPool = isPage ? document : post || document;
    const imgs = Array.from(
      imgPool.querySelectorAll('img[srcset], img[src*="cdninstagram"], img[src*="fbcdn"]')
    );
    let bestImg = null;
    let maxArea = 0;
    for (const img of imgs) {
      if (img.closest("header, nav, button, [role='button'], .ig-saver-btn")) continue;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea && rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
        maxArea = area;
        bestImg = img;
      }
    }
    if (bestImg) return bestImg;

    // Priority 3: any CDN image in document
    const docImgs = Array.from(
      document.querySelectorAll('img[src*="cdninstagram"], img[src*="fbcdn"]')
    );
    maxArea = 0;
    for (const img of docImgs) {
      if (img.closest("header, nav, button, [role='button'], .ig-saver-btn")) continue;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea && rect.width >= 100 && rect.height >= 100) {
        maxArea = area;
        bestImg = img;
      }
    }
    return bestImg || null;
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

  // --- story bottom action bar (next to reply and react) ---------------------
  function findMediaForStory() {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.width > 150 && rect.height > 200 && rect.top < window.innerHeight && rect.bottom > 0) {
        return v;
      }
    }
    const imgs = Array.from(document.querySelectorAll("img"));
    let best = null;
    let maxArea = 0;
    for (const img of imgs) {
      if (img.closest("header, nav, button, [role='button']")) continue;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea && rect.width > 150 && rect.height > 200) {
        maxArea = area;
        best = img;
      }
    }
    return best || videos[0] || null;
  }

  function attachStoryAction() {
    if (!location.pathname.startsWith("/stories")) return;
    if (document.querySelector(".ig-saver-story-btn")) return;

    // Search for reaction/share buttons at the bottom of the story screen
    const candidateSvgs = document.querySelectorAll(
      'svg[aria-label="Direct"], svg[aria-label="Share Story"], svg[aria-label="Send"], svg[aria-label="Share"], svg[aria-label="Like"], svg[aria-label="Unlike"]'
    );

    let targetBtn = null;
    let fallbackBtn = null;

    for (const svg of candidateSvgs) {
      const btn = svg.closest("button, [role='button']");
      if (!btn) continue;
      const rect = btn.getBoundingClientRect();
      // Must be in the lower half of the viewport (story footer)
      if (rect.top > window.innerHeight * 0.5 && rect.width > 0 && rect.height > 0) {
        const label = svg.getAttribute("aria-label") || "";
        if (/Direct|Share|Send/i.test(label)) {
          targetBtn = btn;
          break;
        }
        fallbackBtn = btn;
      }
    }

    const anchor = targetBtn || fallbackBtn;
    if (!anchor) return;

    const parent = anchor.parentElement;
    if (!parent) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ig-saver-action-btn ig-saver-story-btn";
    button.dataset.state = "idle";
    button.dataset.variant = "story";
    button.title = "Download Story";
    button.setAttribute("aria-label", "Download Story");
    button.innerHTML = ICONS.download;

    const stop = (event) => event.stopPropagation();
    for (const type of ["pointerdown", "mousedown", "touchstart", "dblclick", "auxclick"]) {
      button.addEventListener(type, stop);
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const media = findMediaForStory();
      if (media) {
        onDownload(media, button);
      } else {
        toast("No story media found — try again");
      }
    });

    const comp = window.getComputedStyle(parent);
    if (comp.display !== "flex" && comp.display !== "inline-flex") {
      parent.style.display = "inline-flex";
      parent.style.alignItems = "center";
    }

    // Insert directly after the anchor (Paper airplane or Heart)
    anchor.insertAdjacentElement("afterend", button);
    liveButtons.add(button);
  }

  // --- post horizontal action bar (feed, single post /reel/ or /p/, modals) ---
  function attachPostAction(bookmarkBtn, post) {
    if (!bookmarkBtn) return;
    const parent = bookmarkBtn.parentElement;
    if (!parent || parent.querySelector(".ig-saver-action-btn")) return;

    const button = createActionButton("feed", (btn) => {
      // Re-evaluate media at click time so we always get the live video element
      const media = findBestMediaNow(post);
      if (media) {
        onDownload(media, btn);
      } else {
        toast("No media found — open the post and try again");
      }
    });

    const section = bookmarkBtn.closest("section");
    const rightGroup = section ? section.querySelector(":scope > div:last-child") : null;

    if (rightGroup && rightGroup.contains(bookmarkBtn)) {
      const comp = window.getComputedStyle(rightGroup);
      if (comp.display !== "flex" && comp.display !== "inline-flex") {
        rightGroup.style.display = "inline-flex";
        rightGroup.style.alignItems = "center";
      }
      const bookmarkItem =
        Array.from(rightGroup.children).find((c) => c.contains(bookmarkBtn)) || bookmarkBtn;
      bookmarkItem.insertAdjacentElement("beforebegin", button);
      return;
    }

    const comp = window.getComputedStyle(parent);
    if (comp.display !== "flex" && comp.display !== "inline-flex") {
      parent.style.display = "inline-flex";
      parent.style.alignItems = "center";
    }
    bookmarkBtn.insertAdjacentElement("beforebegin", button);
  }

  function scanPostActionBars() {
    if (location.pathname.startsWith("/stories")) return;

    // Find all bookmark buttons on the page (works on feed, direct post /reel/, /p/, modals, etc.)
    const bookmarkSvgs = document.querySelectorAll(
      'svg[aria-label="Save"], svg[aria-label="Remove"], svg[aria-label="Bookmark"]'
    );

    for (const bookmarkSvg of bookmarkSvgs) {
      // If this bookmark is inside a vertical Reels column, scanReelActionBars handles it
      if (findReelsActionColumn(bookmarkSvg)) continue;

      const bookmarkBtn = bookmarkSvg.closest("button, [role='button']") || bookmarkSvg;
      const bar =
        bookmarkBtn.closest("section, div[style*='flex'], div[role='presentation']") ||
        bookmarkBtn.parentElement?.parentElement;

      if (bar && bar.querySelector(".ig-saver-action-btn")) continue;
      if (bookmarkBtn.parentElement?.querySelector(".ig-saver-action-btn")) continue;

      const post =
        bookmarkBtn.closest("article, [role='dialog'], main, [role='main']") ||
        bar?.parentElement?.parentElement ||
        document;

      attachPostAction(bookmarkBtn, post);
    }
  }

  // --- reels vertical action column -----------------------------------------
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
      // findBestMediaNow prefers visible video at click time
      const media = findBestMediaNow(null);
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

  function scanReelActionBars() {
    if (location.pathname.startsWith("/stories")) return;

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
    scanPostActionBars();
    scanReelActionBars();
  }

  function scan() {
    for (const button of liveButtons) {
      if (!button.isConnected) liveButtons.delete(button);
    }

    if (location.pathname.startsWith("/stories")) {
      // In stories: clean up any stray top buttons and attach to bottom react/reply bar
      document.querySelectorAll(".ig-saver-btn").forEach((btn) => btn.remove());
      attachStoryAction();
    } else {
      // Clean up any stray floating buttons on posts that have action bars
      for (const btn of document.querySelectorAll(".ig-saver-btn")) {
        if (!btn.closest('[role="row"], [role="listitem"]')) {
          btn.remove();
        }
      }

      scanActionBars();

      for (const node of document.querySelectorAll("img, video")) {
        const existing = buttons.get(node);
        if (existing && existing.isConnected) continue;
        if (isCandidate(node)) attach(node);
      }
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

  // SPA navigation detection (history.pushState / history.replaceState / popstate)
  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleScan();
    }
  }

  const origPushState = history.pushState;
  if (origPushState) {
    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args);
      checkUrlChange();
      return ret;
    };
  }

  const origReplaceState = history.replaceState;
  if (origReplaceState) {
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args);
      checkUrlChange();
      return ret;
    };
  }

  window.addEventListener("popstate", checkUrlChange);

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  window.addEventListener("scroll", scheduleScan, { passive: true, capture: true });
  window.addEventListener("resize", scheduleScan, { passive: true });

  scan();
})();
