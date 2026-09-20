/*
 * Kindle Web Reader discovery probe.
 *
 * Open a book at https://read.amazon.com, press F12, paste this whole file into
 * the Console, press Enter, then turn ONE page forward with the arrow key.
 * Copy the JSON that gets printed (it is also put on the clipboard via copy()
 * when available) and send it back.
 *
 * Read-only: it only installs a temporary fetch/XHR logger that removes itself
 * after the first /renderer/render request.
 */
(() => {
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += `#${e.id}`;
      if (e.className && typeof e.className === 'string') {
        s += '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const describe = (el) => ({
    path: path(el),
    rect: rect(el),
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 120)])),
  });
  const allEls = (root) => {
    const out = [];
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const iframes = [...document.querySelectorAll('iframe')].map((f) => {
    let reachable = false;
    try { reachable = !!f.contentDocument; } catch (_) {}
    return { ...describe(f), reachable };
  });
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (_) {}
  }

  const els = docs.flatMap((d) => allEls(d));
  const images = els
    .filter((e) => e.tagName === 'IMG' && /^blob:|^data:/.test(e.src))
    .map((e) => ({
      ...describe(e),
      natural: { w: e.naturalWidth, h: e.naturalHeight },
      srcPrefix: e.src.slice(0, 40),
      positionedAncestor: path(e.offsetParent || e.parentElement),
    }));
  const canvases = els.filter((e) => e.tagName === 'CANVAS').map((e) => ({
    ...describe(e), size: { w: e.width, h: e.height },
  }));
  const big = els
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > innerWidth * 0.4 && r.height > innerHeight * 0.5 && e.children.length < 6;
    })
    .slice(0, 12)
    .map(describe);

  const nav = els
    .filter((e) => {
      const label = `${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''} ${e.id} ${e.className}`;
      return /next|prev|forward|back|chevron|arrow/i.test(label) && (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' || e.tagName === 'A' || e.tagName === 'DIV');
    })
    .slice(0, 20)
    .map(describe);

  const positionText = els
    .filter((e) => e.children.length === 0 && /(Location|Loc\.|Page)\s*\d+|\d+\s*%|\d+\s*(of|\/)\s*\d+/i.test(e.textContent || ''))
    .slice(0, 12)
    .map((e) => ({ ...describe(e), text: (e.textContent || '').trim().slice(0, 80) }));

  const cs = getComputedStyle(document.body);
  const theme = {
    bodyBg: cs.backgroundColor,
    bodyColor: cs.color,
    htmlClass: document.documentElement.className,
    bodyClass: document.body.className,
    dataAttrs: Object.fromEntries(
      [...document.documentElement.attributes, ...document.body.attributes]
        .filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value]),
    ),
  };
  const aa = els
    .filter((e) => /^(Aa|Font|Settings|Layout|Display)/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()) && (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button'))
    .slice(0, 6)
    .map(describe);

  const globals = Object.keys(window).filter((k) => /kindle|reader|render|webpack|KindleReader|__/i.test(k)).slice(0, 40);
  const webpackChunks = Object.keys(window).filter((k) => /^webpackChunk/.test(k));

  const report = {
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    iframes, images, canvases, bigContainers: big, nav, positionText, theme, aaMenu: aa,
    globals, webpackChunks,
    renderRequest: null,
  };

  const done = (label) => {
    const json = JSON.stringify(report, null, 1);
    console.log(`%c[kvs-probe] ${label} — copy everything between the markers`, 'color:#0a0;font-weight:bold');
    console.log('-----8<-----');
    console.log(json);
    console.log('----->8-----');
    try { copy(json); console.log('[kvs-probe] copied to clipboard'); } catch (_) {}
  };
  // Print the DOM report right away; print again with the request details if a
  // renderer request is seen on the next page turn.
  done('DOM REPORT');
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  let captured = false;
  const capture = (kind, url, headers) => {
    if (captured || !/\/renderer\/render/.test(url)) return;
    captured = true;
    const u = new URL(url, location.href);
    report.renderRequest = {
      kind, url: u.origin + u.pathname,
      params: Object.fromEntries(u.searchParams.entries()),
      hasRenderingToken: !!headers && Object.keys(headers).some((h) => /x-amz-rendering-token/i.test(h)),
    };
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
    done('REPORT WITH RENDERER REQUEST');
  };
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const headers = init && init.headers && (init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers);
    try { capture('fetch', url || '', headers); } catch (_) {}
    return origFetch.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function (m, url) {
    this.__kvsUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    (this.__kvsHeaders ||= {})[name] = value;
    try { capture('xhr', this.__kvsUrl || '', this.__kvsHeaders); } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };
  console.log('%c[kvs-probe] armed. Now turn one page forward (ArrowRight); a second report prints if a renderer request is seen.', 'color:#06c;font-weight:bold');
})();
