// Download service worker.
//
// The content script resolves media URLs in the page; this worker picks the
// best video variant and hands the file to Chrome's download manager, so the
// CDN request keeps the user's cookies and needs no CORS workaround.
//
// Why the probing: Instagram encodes the same video several ways and its
// *highest-resolution* MP4 is frequently video-only — the audio track lives in
// the DASH manifest as a separate file. Downloading on resolution alone is what
// produces silent files. So each variant is checked for an audio track (by
// reading the MP4 header with a ranged request) and we keep the best one that
// actually has sound.

const FOLDER = "Insta Saver";
const KNOWN_EXT = /\.(jpe?g|png|webp|gif|mp4|mov|webm|m4v)$/i;

const HEAD_BYTES = 420 * 1024; // enough for a faststart moov on IG encodes
const TAIL_BYTES = 512 * 1024; // …and for files whose moov sits at the end
const MAX_PROBES = 4;

const probeCache = new Map(); // url -> true | false | null

// --- helpers ---------------------------------------------------------------

function sanitize(value, fallback) {
  const cleaned = String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

function extensionFor(item) {
  try {
    const match = new URL(item.url).pathname.match(KNOWN_EXT);
    if (match) return match[1].toLowerCase();
  } catch {
    /* fall through */
  }
  return item.type === "video" ? "mp4" : "jpg";
}

function areaOf(variant) {
  return (Number(variant.width) || 0) * (Number(variant.height) || 0);
}

// --- MP4 inspection --------------------------------------------------------

function readBoxes(bytes) {
  const boxes = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;

    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) break;
      const high = view.getUint32(offset + 8);
      const low = view.getUint32(offset + 12);
      size = high * 4294967296 + low;
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }

    boxes.push({ type, start: offset, size, header });
    if (size < header) break;
    offset += size;
  }

  return boxes;
}

function asciiIndexOf(bytes, needle) {
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i <= bytes.length - needle.length; i += 1) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

// An audio track announces itself in the sample description ("mp4a" for AAC)
// and in its handler box ("soun"). Checking both covers AAC and Opus.
function hasAudio(bytes) {
  return asciiIndexOf(bytes, "mp4a") !== -1 || asciiIndexOf(bytes, "soun") !== -1;
}

async function readRange(url, range, limit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: range ? { Range: range } : {},
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok || !response.body) return null;

    // A server that ignores Range (200) must not make us pull a whole video.
    if (response.status === 200) {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      controller.abort();
      const out = new Uint8Array(Math.min(total, limit));
      let at = 0;
      for (const chunk of chunks) {
        const room = out.length - at;
        if (room <= 0) break;
        out.set(chunk.subarray(0, room), at);
        at += Math.min(chunk.length, room);
      }
      return out;
    }

    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeAudio(url) {
  if (probeCache.has(url)) return probeCache.get(url);

  let result = null;
  try {
    // Fast path: moov at the front (Instagram's usual faststart layout).
    // A server that refuses the range still gets a bounded plain read below.
    const head =
      (await readRange(url, `bytes=0-${HEAD_BYTES - 1}`, HEAD_BYTES)) ||
      (await readRange(url, null, HEAD_BYTES));
    if (head && head.length > 8) {
      if (hasAudio(head)) {
        result = true;
      } else {
        const moov = readBoxes(head).find((box) => box.type === "moov");
        if (moov && moov.start + moov.size <= head.length) {
          result = false;
        } else {
          // Slow path: moov is at the end of the file.
          const tail = await readRange(url, `bytes=-${TAIL_BYTES}`, TAIL_BYTES);
          if (tail && tail.length > 8) {
            result = hasAudio(tail) ? true : null;
          }
        }
      }
    }
  } catch {
    result = null;
  }

  probeCache.set(url, result);
  return result;
}

// --- selection -------------------------------------------------------------

function variantsFor(item) {
  const list = Array.isArray(item.variants) && item.variants.length ? item.variants : [];
  const source = list.length ? list : [{ url: item.url, width: item.width, height: item.height }];
  const seen = new Set();
  return source
    .filter((variant) => variant && typeof variant.url === "string" && variant.url)
    .filter((variant) => (seen.has(variant.url) ? false : seen.add(variant.url)))
    .sort((a, b) => areaOf(b) - areaOf(a)); // Highest resolution / quality first
}

async function resolveItem(item) {
  if (!item || item.type !== "video") {
    return { url: item.url, muted: false, width: item.width, height: item.height };
  }

  const variants = variantsFor(item);
  if (!variants.length) return { url: item.url, muted: false };

  // Find any variant that is known progressive
  const progWithAudio = variants.find(
    (v) => v.type === 101 || (typeof v.url === "string" && v.url.includes("progressive"))
  );

  let unknown = false;
  // Test variants starting from the highest resolution (1080p, etc.)
  for (const variant of variants.slice(0, MAX_PROBES)) {
    const audio = await probeAudio(variant.url);
    if (audio === true) {
      // Highest resolution variant that has sound!
      return {
        url: variant.url,
        muted: false,
        width: variant.width,
        height: variant.height
      };
    }
    if (audio === null) unknown = true;
  }

  // If higher-resolution variants were probed and were video-only, fall back to known audio stream
  if (progWithAudio) {
    return {
      url: progWithAudio.url,
      muted: false,
      width: progWithAudio.width,
      height: progWithAudio.height
    };
  }

  // Fallback to highest resolution variant
  const fallback = variants[0];
  return {
    url: fallback.url,
    muted: !unknown,
    width: fallback.width,
    height: fallback.height
  };
}

// --- download --------------------------------------------------------------

async function downloadItem(url, filename) {
  const id = await chrome.downloads.download({
    url,
    filename,
    conflictAction: "uniquify", // never overwrite an earlier save
    saveAs: false
  });
  if (typeof id !== "number") throw new Error("download did not start");
  return id;
}

async function handleDownload({ items, base, username }) {
  const list = Array.isArray(items) ? items.filter((item) => item && item.url).slice(0, 30) : [];
  if (!list.length) return { ok: false, saved: 0, failed: 0, error: "no media" };

  const folder = `${FOLDER}/${sanitize(username, "instagram")}`;
  const stem = sanitize(base, `ig-${Date.now()}`);
  let saved = 0;
  let failed = 0;
  let muted = false;
  let size = null;

  for (let index = 0; index < list.length; index += 1) {
    const chosen = await resolveItem(list[index]);
    const suffix = list.length > 1 ? `_${index + 1}` : "";
    const filename = `${folder}/${stem}${suffix}.${extensionFor({ ...list[index], url: chosen.url })}`;
    try {
      await downloadItem(chosen.url, filename);
      saved += 1;
      if (chosen.muted) muted = true;
      if (!size && chosen.width && chosen.height) size = `${chosen.width}×${chosen.height}`;
    } catch {
      failed += 1;
    }
  }

  return { ok: saved > 0, saved, failed, muted, size };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "ig-download") return false;
  handleDownload(message)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, saved: 0, failed: 0, error: String(error) })
    );
  return true;
});
