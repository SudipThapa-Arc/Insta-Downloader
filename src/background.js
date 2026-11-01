// Download service worker.
// The content script finds the media URL, this worker hands it to Chrome's
// download manager so the CDN request keeps the user's cookies and no CORS
// workaround is needed.

const FOLDER = "Insta Saver";
const KNOWN_EXT = /\.(jpe?g|png|webp|gif|mp4|mov|webm|m4v)$/i;

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

async function downloadItem(item, filename) {
  // "uniquify" avoids overwriting a file that was already saved.
  const id = await chrome.downloads.download({
    url: item.url,
    filename,
    conflictAction: "uniquify",
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

  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const suffix = list.length > 1 ? `_${index + 1}` : "";
    const filename = `${folder}/${stem}${suffix}.${extensionFor(item)}`;
    try {
      await downloadItem(item, filename);
      saved += 1;
    } catch {
      failed += 1;
    }
  }

  return { ok: saved > 0, saved, failed };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "ig-download") return false;
  handleDownload(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, saved: 0, failed: 0, error: String(error) }));
  return true;
});
