// Bridge between the extension (isolated world) and page.js (page world).
// page.js needs to run in the page world so it can wrap window.fetch and see the
// reader's blob: images; this file only relays messages and persists preferences.

const DEFAULT_PREFS = { enabled: false, prefetchAhead: 3, prefetchBehind: 1, showSeams: false };

function postToPage(msg) {
  window.postMessage({ source: 'kvs-content', ...msg }, location.origin);
}

async function loadPrefs() {
  const stored = await browser.storage.local.get(DEFAULT_PREFS);
  return { ...DEFAULT_PREFS, ...stored };
}

function injectPageScript() {
  const s = document.createElement('script');
  s.src = browser.runtime.getURL('page.js');
  s.async = false;
  s.addEventListener('load', () => s.remove());
  (document.head || document.documentElement).appendChild(s);
}

window.addEventListener('message', async (ev) => {
  if (ev.source !== window || !ev.data || ev.data.source !== 'kvs-page') return;
  const { type } = ev.data;
  if (type === 'ready') {
    postToPage({ type: 'prefs', prefs: await loadPrefs() });
  } else if (type === 'setPrefs') {
    await browser.storage.local.set(ev.data.prefs);
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'kvs:toggle') postToPage({ type: 'toggle' });
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  postToPage({ type: 'prefs', prefs: await loadPrefs() });
});

injectPageScript();
