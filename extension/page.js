/*
 * Kindle Vertical Scroll — page-world script.
 *
 * The Kindle web reader paints each page to a <canvas> and swaps in a blob: <img>;
 * the text never exists as HTML. So this script captures the page images the reader
 * produces, stacks them in a vertical scroller mounted inside the reader's UI layer
 * (below its menus, above its page-turn layer), drives the reader's own next/prev
 * navigation to fetch pages ahead/behind, and keeps the reader's current page in
 * sync with what the user has scrolled to (so the footer and Whispersync stay right).
 *
 * Objects, top to bottom: CONFIG, dom helpers, Reader (everything that touches
 * Amazon's DOM), Interceptor (render-request tweaks), Store (captured pages),
 * View (the overlay), App (control loop). `window.__kvs` exposes them for debugging.
 */
(() => {
  'use strict';
  if (window.__kvsLoaded) return;
  window.__kvsLoaded = true;

  // ---------------------------------------------------------------------------
  // CONFIG — everything that depends on Amazon's markup. Selectors were verified against
  // read.amazon.in (Sept 2026; Ionic/React app). A null selector falls back to a heuristic
  // (largest blob image, buttons labelled next/previous, footer text with a page number);
  // tools/probe.js dumps the current markup if Amazon changes it.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    pageImage: '#kr-renderer .kg-full-page-img img, #kr-renderer canvas', // the rendered page
    container: '#kr-renderer',                                           // element the page sits in
    nextButton: '#kr-chevron-right',                                     // React handler: needs a pointer event sequence, not .click()
    prevButton: '#kr-chevron-left',
    positionText: 'ion-title.footer-label.position',                     // "Page 13 of 275 ● 4%"
    mountIn: '#main-content',      // reader UI layer to mount the overlay in (null → <body>)
    zIndex: 5,                     // inside it: above the page-turn layer, below header (10), menus (1000), popovers (20000+)
    chrome: ['ion-header#reader-header', '.footer-label-color-dark'], // reader chrome the overlay must not cover
    nextKey: 'ArrowRight',  // keyboard fallback when the button is missing (a synthetic keydown on body works)
    prevKey: 'ArrowLeft',
    minPageSize: 200,       // px — blob images smaller than this are icons, not pages
    navTimeoutMs: 7000,     // page-turn wait; expiring means start/end of book
    settleMs: 700,          // idle time after scrolling before the reader is re-synced
    mountRadius: 6,         // pages either side of the viewport kept as <img>; others are blank slots
    storeLimit: 80,         // captured pages kept in memory
    rebuildDebounceMs: 600, // coalesce reader re-renders (font/theme/resize) into one rebuild
  };

  // Persisted in browser.storage.local via content.js; showSeams draws a debug line at each page join.
  const PREFS = { enabled: false, prefetchAhead: 3, prefetchBehind: 1, showSeams: false };

  const log = (...a) => console.debug('[kvs]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // DOM helpers (the reader may live in the top document or a same-origin iframe)
  // ---------------------------------------------------------------------------
  function docs() {
    const out = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) out.push(f.contentDocument); } catch (_) { /* cross-origin */ }
    }
    return out;
  }
  function qsa(sel) {
    return docs().flatMap((d) => [...d.querySelectorAll(sel)]);
  }
  function frameOffset(doc) {
    if (doc === document) return { x: 0, y: 0 };
    const f = [...document.querySelectorAll('iframe')].find((i) => { try { return i.contentDocument === doc; } catch (_) { return false; } });
    if (!f) return { x: 0, y: 0 };
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }
  // Bounding rect in top-window coordinates.
  function topRect(el) {
    const r = el.getBoundingClientRect();
    const o = frameOffset(el.ownerDocument);
    return { left: r.left + o.x, top: r.top + o.y, width: r.width, height: r.height,
      right: r.right + o.x, bottom: r.bottom + o.y };
  }
  function isShown(el) {
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05;
  }
  function insideOverlay(el) {
    return !!(el && el.closest && el.closest('#kvs-wrap'));
  }
  async function waitFor(pred, timeoutMs, everyMs = 50) {
    const end = performance.now() + timeoutMs;
    for (;;) {
      const v = pred();
      if (v) return v;
      if (performance.now() > end) return null;
      await sleep(everyMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Reader — adapter over Amazon's DOM
  // ---------------------------------------------------------------------------
  const Reader = {
    _posEl: null,
    _canvasIds: new WeakMap(),
    _nextCanvasId: 1,

    // Rendered page surfaces (img or canvas) that are page-sized and on screen, left→right.
    pageSurfaces() {
      const els = CONFIG.pageImage
        ? qsa(CONFIG.pageImage)
        : qsa('img[src^="blob:"], img[src^="data:image"], canvas');
      const out = [];
      for (const el of els) {
        if (insideOverlay(el) || !isShown(el)) continue;
        const r = topRect(el);
        if (r.width < CONFIG.minPageSize || r.height < CONFIG.minPageSize) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cx > innerWidth || cy < 0 || cy > innerHeight) continue; // off-screen neighbour
        if (el.tagName === 'IMG' && !(el.complete && el.naturalWidth > 0)) continue;
        out.push({ el, rect: r });
      }
      out.sort((a, b) => a.rect.left - b.rect.left);
      return out;
    },

    surfaceId(el) {
      if (el.tagName === 'IMG') return el.src;
      let id = this._canvasIds.get(el);
      if (!id) { id = `canvas#${this._nextCanvasId++}`; this._canvasIds.set(el, id); }
      return `${id}@${this.positionText()}`;
    },

    // Cheap fingerprint of what is currently on screen, used to detect page turns.
    snapshot() {
      return this.pageSurfaces().map((s) => this.surfaceId(s.el)).join('|');
    },

    container() {
      if (CONFIG.container) { const c = qsa(CONFIG.container)[0]; if (c) return c; }
      const s = this.pageSurfaces()[0];
      if (!s) return null;
      return s.el.offsetParent || s.el.parentElement;
    },

    // Overlay geometry in viewport coordinates: the page container, minus any reader chrome it overlaps.
    overlayRect() {
      const c = this.container();
      let r = c ? topRect(c) : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      let { left, top, right, bottom } = r;
      for (const sel of CONFIG.chrome) {
        for (const el of qsa(sel)) {
          if (!isShown(el)) continue;
          const b = topRect(el);
          if (b.width === 0 || b.height === 0) continue;
          if (b.bottom > top && b.top <= top) top = b.bottom;         // chrome along the top edge
          if (b.top < bottom && b.bottom >= bottom) bottom = b.top;   // chrome along the bottom edge
        }
      }
      top = Math.max(0, top); bottom = Math.min(innerHeight, bottom);
      if (bottom - top < 100 || right - left < 100) return { left: 0, top: 0, width: innerWidth, height: innerHeight };
      return { left, top, width: right - left, height: bottom - top };
    },

    findButton(dir) {
      const sel = dir > 0 ? CONFIG.nextButton : CONFIG.prevButton;
      if (sel) return qsa(sel)[0] || null;
      const re = dir > 0 ? /next|forward/i : /prev|previous|back(?!ground)/i;
      const bad = /chapter|book|menu|library|close|search/i;
      const cands = qsa('button, [role="button"], a').filter((el) => {
        if (insideOverlay(el)) return false;
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.id || ''} ${el.className || ''}`;
        return re.test(label) && !bad.test(label);
      });
      if (!cands.length) return null;
      // Prefer the one nearest the corresponding edge of the viewport, vertically centred.
      cands.sort((a, b) => {
        const ra = topRect(a), rb = topRect(b);
        const score = (r) => Math.abs(r.top + r.height / 2 - innerHeight / 2) + (dir > 0 ? innerWidth - r.right : r.left);
        return score(ra) - score(rb);
      });
      return cands[0];
    },

    trigger(dir) {
      const btn = this.findButton(dir);
      if (btn) {
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return 'disabled';
        // React's handler ignores a bare .click(); replay the pointer sequence a real click produces.
        const r = btn.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          btn.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, init));
        }
        return 'button';
      }
      const key = dir > 0 ? CONFIG.nextKey : CONFIG.prevKey;
      const s = this.pageSurfaces()[0];
      const doc = s ? s.el.ownerDocument : document;
      const target = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc.body;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true }));
      }
      return 'key';
    },

    // Turn one page. Resolves true when a different page is on screen, false at start/end of book.
    async step(dir) {
      const before = this.snapshot();
      const how = this.trigger(dir);
      if (how === 'disabled') return false;
      const after = await waitFor(() => {
        const s = this.snapshot();
        return s && s !== before ? s : null;
      }, CONFIG.navTimeoutMs);
      if (!after) { log('step', dir, 'via', how, '→ no change (bound?)'); return false; }
      await this.settle();
      return true;
    },

    // Wait until what is on screen stops changing (the reader shows a canvas, then swaps in an <img>).
    async settle(quietMs = 200, maxMs = 3000) {
      let last = this.snapshot();
      let quietSince = performance.now();
      const end = performance.now() + maxMs;
      while (performance.now() < end) {
        await sleep(50);
        const s = this.snapshot();
        if (s !== last) { last = s; quietSince = performance.now(); continue; }
        // A canvas still on screen means the <img> swap is pending; keep waiting.
        const pending = this.pageSurfaces().some((x) => x.el.tagName === 'CANVAS');
        if (!pending && performance.now() - quietSince >= quietMs) break;
      }
    },

    positionEl() {
      const ok = (el) => el && el.isConnected && POS_RE.test(el.textContent || '');
      if (ok(this._posEl)) return this._posEl;
      this._posEl = null;
      if (CONFIG.positionText) {
        this._posEl = qsa(CONFIG.positionText)[0] || null;
        return this._posEl;
      }
      for (const el of qsa('span, div, p, footer, output')) {
        if (el.children.length || insideOverlay(el)) continue;
        if (POS_RE.test(el.textContent || '')) { this._posEl = el; break; }
      }
      return this._posEl;
    },
    positionText() {
      const el = this.positionEl();
      return el ? (el.textContent || '').trim() : '';
    },
    // 0..1 progress if the footer exposes it, else null.
    progress() {
      const t = this.positionText();
      let m = t.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) return Math.min(1, parseFloat(m[1]) / 100);
      m = t.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
      if (m && +m[2] > 0) return Math.min(1, +m[1] / +m[2]);
      return null;
    },

    theme() {
      let el = this.container() || document.body;
      let bg = 'rgba(0, 0, 0, 0)';
      while (el) {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        bg = cs.backgroundColor;
        if (bg && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(bg) && bg !== 'transparent') break;
        el = el.parentElement || (el.ownerDocument !== document ? frameElementOf(el.ownerDocument) : null);
      }
      if (!bg || /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(bg) || bg === 'transparent') bg = '#ffffff';
      const m = bg.match(/\d+/g) || [255, 255, 255];
      const lum = (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
      return { bg, dark: lum < 0.5 };
    },
  };
  const POS_RE = /\b(Location|Loc\.?|Page)\s*\d+|\d+(?:\.\d+)?\s*%|\b\d+\s+of\s+\d+\b/i;
  function frameElementOf(doc) {
    return [...document.querySelectorAll('iframe')].find((i) => { try { return i.contentDocument === doc; } catch (_) { return false; } }) || null;
  }

  // ---------------------------------------------------------------------------
  // RenderInterceptor — tweak the reader's own /renderer/render requests so
  // pages stack cleanly (single column, no vertical margins).
  // ---------------------------------------------------------------------------
  const Interceptor = {
    active: false,
    installed: false,
    rewrite(url) {
      if (!this.active) return url;
      try {
        const u = new URL(url, location.href);
        if (!/\/renderer\/render/.test(u.pathname)) return url;
        u.searchParams.set('marginTop', '0');
        u.searchParams.set('marginBottom', '0');
        u.searchParams.set('maxNumberColumns', '1');
        return u.toString();
      } catch (_) { return url; }
    },
    install() {
      if (this.installed) return;
      this.installed = true;
      const self = this;
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        if (typeof input === 'string') input = self.rewrite(input);
        else if (input instanceof Request && self.active) {
          const nu = self.rewrite(input.url);
          if (nu !== input.url) input = new Request(nu, input);
        }
        return origFetch.call(this, input, init);
      };
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        return origOpen.call(this, method, self.rewrite(String(url)), ...rest);
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Store — captured pages keyed by ordinal (0 = page shown when scroll mode began)
  // ---------------------------------------------------------------------------
  const Store = {
    pages: new Map(), // ordinal → { parts: [{url, w, h}], text, progress }
    get(o) { return this.pages.get(o); },
    has(o) { return this.pages.has(o); },
    set(o, rec) { this.pages.set(o, rec); },
    evictFarFrom(center) {
      if (this.pages.size <= CONFIG.storeLimit) return [];
      const ords = [...this.pages.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
      const dropped = [];
      while (this.pages.size > CONFIG.storeLimit) {
        const o = ords.shift();
        this.drop(o);
        dropped.push(o);
      }
      return dropped;
    },
    drop(o) {
      const rec = this.pages.get(o);
      if (!rec) return;
      for (const p of rec.parts) URL.revokeObjectURL(p.url);
      this.pages.delete(o);
    },
    clear() {
      for (const o of [...this.pages.keys()]) this.drop(o);
    },
  };

  // Copy the reader's surface into our own blob URL so the reader revoking/reusing
  // its canvas or blob does not blank our column.
  async function captureSurface({ el, rect }) {
    let source = el;
    if (el.tagName === 'IMG') {
      // The reader revokes its blob: URL as soon as the image is decoded, so fetch(src)
      // fails; rasterise the decoded image instead (same-origin, so the canvas stays clean).
      const c = document.createElement('canvas');
      c.width = el.naturalWidth; c.height = el.naturalHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      source = c;
    }
    const blob = await new Promise((res, rej) => source.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
    return { url: URL.createObjectURL(blob), w: Math.round(rect.width), h: Math.round(rect.height) };
  }

  // ---------------------------------------------------------------------------
  // View — the overlay: scroller with one slot per ordinal, progress bar, pill
  // ---------------------------------------------------------------------------
  const View = {
    wrap: null, root: null, column: null, progress: null, pill: null, endMark: null,
    slots: new Map(), // ordinal → element
    first: null, last: null, // ordinals present in the column

    // Reader UI layer to live in, so the reader's own menus/popovers stack above us.
    mountParent() {
      return (CONFIG.mountIn && qsa(CONFIG.mountIn)[0]) || document.body;
    },
    ensurePill() {
      if (this.pill && this.pill.isConnected) return;
      const pill = this.pill || document.createElement('button');
      pill.id = 'kvs-pill';
      pill.type = 'button';
      pill.title = 'Toggle continuous scroll (Alt+Shift+S)';
      if (!this.pill) pill.addEventListener('click', (e) => { e.stopPropagation(); App.toggle(); });
      const parent = this.mountParent();
      pill.style.position = parent === document.body ? 'fixed' : 'absolute';
      pill.style.zIndex = parent === document.body ? '2147483001' : String(CONFIG.zIndex + 4);
      parent.appendChild(pill);
      this.pill = pill;
      if (!pill.dataset.state) this.setPill('paged');
    },
    setPill(state, extra) {
      if (!this.pill) return;
      const labels = { paged: '⇅ Scroll', scroll: '☰ Paged', busy: '… ' + (extra || 'Loading') };
      this.pill.textContent = labels[state] || state;
      this.pill.dataset.state = state;
    },

    build(theme) {
      this.teardown();
      const wrap = document.createElement('div');
      wrap.id = 'kvs-wrap';
      wrap.dataset.theme = theme.dark ? 'dark' : 'light';
      wrap.style.setProperty('--kvs-bg', theme.bg);
      const root = document.createElement('div');
      root.id = 'kvs-root';
      root.tabIndex = -1;
      const column = document.createElement('div');
      column.id = 'kvs-column';
      const progress = document.createElement('div');
      progress.id = 'kvs-progress';
      progress.innerHTML = '<div id="kvs-progress-bar"></div>';
      root.appendChild(column);
      wrap.append(root, progress);
      // Keep wheel/touch/pointer events from reaching the reader's own page-turn handlers
      // (the native reader turns pages on wheel).
      for (const t of ['wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
        wrap.addEventListener(t, (e) => e.stopPropagation());
      }
      const parent = this.mountParent();
      wrap.style.position = parent === document.body ? 'fixed' : 'absolute';
      wrap.style.zIndex = parent === document.body ? '2147483000' : String(CONFIG.zIndex);
      parent.appendChild(wrap);
      this.wrap = wrap; this.root = root; this.column = column;
      this.progress = progress;
      this.slots.clear(); this.first = this.last = null; this.endMark = null;
      this.layout();
      this.ensurePill(); // (re)append so the pill stays after the overlay in DOM order
    },
    // Re-attach if the reader's framework re-rendered our mount point away.
    ensureAttached() {
      if (this.wrap && !this.wrap.isConnected) { this.mountParent().appendChild(this.wrap); this.layout(); }
      this.ensurePill();
    },
    teardown() {
      if (this.wrap) this.wrap.remove();
      this.wrap = this.root = this.column = this.progress = this.endMark = null;
      this.slots.clear(); this.first = this.last = null;
    },
    layout() {
      if (!this.wrap) return;
      const r = Reader.overlayRect();
      const parent = this.wrap.offsetParent || this.wrap.parentElement;
      const o = parent && parent !== document.body ? topRect(parent) : { left: 0, top: 0 };
      this.wrap.style.left = `${r.left - o.left}px`;
      this.wrap.style.top = `${r.top - o.top}px`;
      this.wrap.style.width = `${r.width}px`;
      this.wrap.style.height = `${r.height}px`;
    },

    slotHeight(rec) { return rec.parts.reduce((s, p) => s + p.h, 0); },

    // Insert or refresh the slot for an ordinal, preserving what the user is looking at.
    upsert(ordinal, rec) {
      let slot = this.slots.get(ordinal);
      if (!slot) {
        slot = document.createElement('div');
        slot.className = 'kvs-slot';
        slot.dataset.ordinal = String(ordinal);
        this.slots.set(ordinal, slot);
      }
      slot.style.height = `${this.slotHeight(rec)}px`;
      slot.style.width = `${Math.max(...rec.parts.map((p) => p.w))}px`;
      if (!slot.isConnected) {
        if (this.first === null) {
          this.column.appendChild(slot);
          this.first = this.last = ordinal;
        } else if (ordinal < this.first) {
          // Fill any gap with blank slots so ordinals stay contiguous, then shift
          // scrollTop by exactly what was inserted so the view does not move.
          const before = this.column.offsetHeight;
          for (let o = this.first - 1; o > ordinal; o--) this.column.prepend(this.blankSlot(o));
          this.column.prepend(slot);
          this.first = ordinal;
          this.root.scrollTop += this.column.offsetHeight - before;
        } else {
          for (let o = this.last + 1; o < ordinal; o++) this.column.appendChild(this.blankSlot(o));
          if (this.endMark) this.column.insertBefore(slot, this.endMark); else this.column.appendChild(slot);
          this.last = Math.max(this.last, ordinal);
        }
      }
      slot.dataset.loaded = '1';
      slot.dataset.text = rec.text || '';
      this.mount(slot, rec);
      return slot;
    },
    blankSlot(o) {
      const s = document.createElement('div');
      s.className = 'kvs-slot';
      s.dataset.ordinal = String(o);
      const h = App.pageH || innerHeight;
      s.style.height = `${h}px`;
      s.style.width = `${App.pageW || 600}px`;
      this.slots.set(o, s);
      return s;
    },
    mount(slot, rec) {
      if (slot.dataset.mounted === '1' && slot.dataset.url === rec.parts[0].url) return;
      slot.dataset.url = rec.parts[0].url;
      slot.replaceChildren(...rec.parts.map((p) => {
        const img = document.createElement('img');
        img.src = p.url; img.width = p.w; img.height = p.h; img.draggable = false; img.alt = '';
        return img;
      }));
      slot.dataset.mounted = '1';
    },
    unmount(slot) {
      if (slot.dataset.mounted !== '1') return;
      slot.replaceChildren();
      slot.dataset.mounted = '0';
    },
    markUnloaded(ordinal) {
      const slot = this.slots.get(ordinal);
      if (!slot) return;
      this.unmount(slot);
      slot.dataset.loaded = '0';
    },
    setEnd(atEnd) {
      if (atEnd && !this.endMark) {
        const m = document.createElement('div');
        m.id = 'kvs-end';
        m.textContent = 'End of book';
        this.column.appendChild(m);
        this.endMark = m;
      } else if (!atEnd && this.endMark) {
        this.endMark.remove(); this.endMark = null;
      }
    },

    // Ordinal of the slot at a given offset within the column (scrollTop-based).
    ordinalAt(y) {
      if (this.first === null) return null;
      let acc = 0;
      for (let o = this.first; o <= this.last; o++) {
        const s = this.slots.get(o);
        const h = s ? s.offsetHeight : 0;
        if (y < acc + h) return o;
        acc += h;
      }
      return this.last;
    },
    visibleRange() {
      if (!this.root || this.first === null) return null;
      const top = this.ordinalAt(this.root.scrollTop + 1);
      const bottom = this.ordinalAt(this.root.scrollTop + this.root.clientHeight - 1);
      return { top, bottom };
    },
    // Keep only nearby pages as <img>; the rest become blank, fixed-height slots.
    updateMounts(center) {
      for (const [o, slot] of this.slots) {
        const near = Math.abs(o - center) <= CONFIG.mountRadius;
        if (near) { const rec = Store.get(o); if (rec && slot.dataset.mounted !== '1') this.mount(slot, rec); }
        else this.unmount(slot);
      }
    },
    setProgress(frac) {
      if (!this.progress) return;
      this.progress.querySelector('#kvs-progress-bar').style.width = frac == null ? '0' : `${(frac * 100).toFixed(2)}%`;
    },
  };

  // ---------------------------------------------------------------------------
  // App — control loop
  // ---------------------------------------------------------------------------
  const App = {
    prefs: { ...PREFS },
    enabled: false,
    readerOrdinal: 0,
    minBound: null, maxBound: null,
    pageW: 0, pageH: 0,
    navInFlight: false,
    looping: false,
    syncTarget: null,
    lastSnapshot: '',
    observer: null,
    settleTimer: null,
    rebuildTimer: null,
    busy: false, // enable/disable in progress
    rebuilds: 0,
    refreshes: 0,

    async init() {
      Interceptor.install();
      window.addEventListener('message', (ev) => {
        if (ev.source !== window || !ev.data || ev.data.source !== 'kvs-content') return;
        if (ev.data.type === 'prefs') this.onPrefs(ev.data.prefs);
        if (ev.data.type === 'toggle') this.toggle();
      });
      window.postMessage({ source: 'kvs-page', type: 'ready' }, location.origin);
      // Show the pill once the reader has rendered a page (may be after in-app navigation).
      while (!Reader.pageSurfaces().length) await sleep(500);
      View.ensurePill();
      if (this.prefs.enabled && !this.enabled) this.enable();
    },
    onPrefs(prefs) {
      const wasEnabled = this.prefs.enabled;
      this.prefs = { ...PREFS, ...prefs };
      if (View.wrap) View.wrap.dataset.seams = this.prefs.showSeams ? '1' : '0';
      if (this.prefs.enabled && !wasEnabled && !this.enabled && Reader.pageSurfaces().length) this.enable();
    },
    savePref(patch) {
      window.postMessage({ source: 'kvs-page', type: 'setPrefs', prefs: patch }, location.origin);
    },

    toggle() {
      if (this.busy) return;
      if (this.enabled) this.disable(); else this.enable();
    },

    async enable() {
      if (this.enabled || this.busy) return;
      this.busy = true;
      View.ensurePill();
      View.setPill('busy', 'Starting');
      try {
        Interceptor.active = true;
        const first = await waitFor(() => { const s = Reader.pageSurfaces(); return s.length ? s : null; }, 30000, 200);
        if (!first) { log('no page image found; cannot enable'); View.setPill('paged'); return; }
        this.readerOrdinal = 0; this.minBound = this.maxBound = null; this.syncTarget = null;
        Store.clear();
        View.build(Reader.theme());
        View.wrap.dataset.seams = this.prefs.showSeams ? '1' : '0';
        this.enabled = true;
        if (!(await this.capture(0))) throw new Error('could not capture the current page');
        View.root.scrollTop = 0;
        View.root.focus({ preventScroll: true });
        this.installListeners();
        this.savePref({ enabled: true });
        View.setPill('scroll');
        this.updateProgress();
        this.kick();
      } catch (e) {
        console.error('[kvs] enable failed:', e);
        this.enabled = false;
        this.removeListeners();
        Interceptor.active = false;
        View.teardown();
        Store.clear();
      } finally {
        this.busy = false;
        if (!this.enabled) View.setPill('paged');
      }
    },

    // Leave the reader on the page the user was looking at, then remove the overlay.
    async disable({ persist = true, sync = true } = {}) {
      if (!this.enabled || this.busy) return;
      this.busy = true;
      View.setPill('busy', 'Syncing');
      try {
        this.enabled = false;
        this.removeListeners();
        if (sync) await this.syncReaderTo(this.currentTopOrdinal());
      } finally {
        Interceptor.active = false;
        View.teardown();
        Store.clear();
        this.busy = false;
        if (persist) this.savePref({ enabled: false });
        View.setPill('paged');
      }
    },

    // Fire-and-forget version for pagehide, where we cannot await page turns.
    disableSync() {
      if (!this.enabled) return;
      const target = this.currentTopOrdinal();
      const n = target - this.readerOrdinal;
      for (let i = 0; i < Math.abs(n); i++) Reader.trigger(Math.sign(n));
      this.readerOrdinal = target;
    },

    async syncReaderTo(target) {
      let guard = 0;
      while (this.readerOrdinal !== target && guard++ < 50) {
        const dir = Math.sign(target - this.readerOrdinal);
        this.navInFlight = true;
        const ok = await Reader.step(dir);
        this.navInFlight = false;
        this.lastSnapshot = Reader.snapshot();
        if (!ok) break;
        this.readerOrdinal += dir;
      }
    },

    async capture(ordinal) {
      const surfaces = Reader.pageSurfaces();
      if (!surfaces.length) return false;
      const parts = [];
      for (const s of surfaces) parts.push(await captureSurface(s));
      if (!this.pageW) { this.pageW = parts[0].w; this.pageH = parts[0].h; }
      else if (parts[0].w !== this.pageW || parts[0].h !== this.pageH) this.scheduleRebuild('page size changed');
      const rec = { parts, text: Reader.positionText(), progress: Reader.progress() };
      Store.set(ordinal, rec);
      this.lastSnapshot = Reader.snapshot();
      if (this.enabled) View.upsert(ordinal, rec);
      return true;
    },

    currentTopOrdinal() {
      const r = View.visibleRange();
      return r ? r.top : this.readerOrdinal;
    },

    // Next ordinal the reader should be driven to, or null if nothing is needed.
    nextNeeded() {
      const r = View.visibleRange();
      if (!r) return null;
      const within = (o) => (this.minBound === null || o >= this.minBound) && (this.maxBound === null || o <= this.maxBound);
      // Visible but evicted pages come first.
      for (let o = r.top; o <= r.bottom; o++) if (!Store.has(o) && within(o)) return o;
      for (let i = 1; i <= this.prefs.prefetchAhead; i++) { const o = r.bottom + i; if (!Store.has(o) && within(o)) return o; }
      for (let i = 1; i <= this.prefs.prefetchBehind; i++) { const o = r.top - i; if (!Store.has(o) && within(o)) return o; }
      return null;
    },

    kick() { if (this.enabled && !this.looping) this.loop(); },

    async loop() {
      this.looping = true;
      try {
        while (this.enabled) {
          const need = this.nextNeeded();
          // Nothing to fetch → park the reader on the page at the top of the view so
          // Amazon's "last read position" matches what the user is reading.
          const target = need !== null ? need : (this.syncTarget ?? this.currentTopOrdinal());
          if (target === null || target === this.readerOrdinal) {
            if (need === null) this.syncTarget = null;
            break;
          }
          const dir = Math.sign(target - this.readerOrdinal);
          View.setPill('busy', need !== null ? 'Loading' : 'Syncing');
          this.navInFlight = true;
          const ok = await Reader.step(dir);
          this.navInFlight = false;
          if (!this.enabled) break;
          if (!ok) {
            if (dir > 0) { this.maxBound = this.readerOrdinal; View.setEnd(true); }
            else this.minBound = this.readerOrdinal;
            this.lastSnapshot = Reader.snapshot();
            if (need === null) break; // sync target unreachable; stop trying
            continue;
          }
          this.lastSnapshot = Reader.snapshot();
          this.readerOrdinal += dir;
          if (!Store.has(this.readerOrdinal)) await this.capture(this.readerOrdinal);
          for (const o of Store.evictFarFrom(this.currentTopOrdinal())) View.markUnloaded(o);
        }
      } catch (e) {
        console.error('[kvs] loop error', e);
      } finally {
        this.looping = false;
        this.navInFlight = false;
        if (this.enabled) View.setPill('scroll');
      }
    },

    onScroll() {
      const top = this.currentTopOrdinal();
      View.updateMounts(top);
      this.updateProgress();
      this.kick();
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.syncTarget = this.currentTopOrdinal();
        this.kick();
      }, CONFIG.settleMs);
    },
    updateProgress() {
      const top = this.currentTopOrdinal();
      const rec = Store.get(top);
      View.setProgress(rec ? rec.progress : null);
    },

    // The reader re-rendered or jumped on its own (font size, theme, resize, TOC…):
    // rebuild the column from whatever page it now shows.
    scheduleRebuild(reason) {
      if (!this.enabled) return;
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(async () => {
        if (!this.enabled) return;
        if (this.navInFlight || this.busy || this.looping) { this.scheduleRebuild(reason); return; } // re-arm
        const rec = Store.get(this.readerOrdinal);
        if (rec && rec.text && rec.text === Reader.positionText()) {
          // Same position, new pixels (late canvas→img swap, font family/theme change):
          // keep the column anchored and just refresh the pages.
          log('refresh:', reason);
          await this.refreshFromCurrent();
          return;
        }
        log('rebuild:', reason);
        this.rebuilds++;
        await this.disable({ persist: false, sync: false });
        this.pageW = this.pageH = 0;
        await this.enable();
      }, CONFIG.rebuildDebounceMs);
    },
    // Re-capture the reader's current page and drop the rest; they reload as they come into view.
    async refreshFromCurrent() {
      this.refreshes++;
      for (const o of [...Store.pages.keys()]) { Store.drop(o); View.markUnloaded(o); }
      this.pageW = this.pageH = 0;
      await this.capture(this.readerOrdinal);
      this.kick();
    },
    // The reader's own next/prev chevrons stay visible beside the column; make them scroll it.
    onChevron(e) {
      if (!this.enabled || !e.isTrusted || !View.root) return;
      const btn = e.target && e.target.closest && e.target.closest(`${CONFIG.nextButton || 'kvs-none'}, ${CONFIG.prevButton || 'kvs-none'}`);
      if (!btn) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'click') return;
      const dir = btn.matches(CONFIG.nextButton || 'kvs-none') ? 1 : -1;
      View.root.scrollBy({ top: dir * (View.root.clientHeight - 40), behavior: 'smooth' });
    },
    onMutation() {
      if (!this.enabled || this.navInFlight || this.busy) return;
      View.ensureAttached();
      const snap = Reader.snapshot();
      if (snap && snap !== this.lastSnapshot) this.scheduleRebuild('reader page changed outside our control');
    },

    onKeyDown(e) {
      if (!this.enabled || e.defaultPrevented || !e.isTrusted) return; // untrusted = our own page-turn keys
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const root = View.root;
      if (!root) return;
      const page = root.clientHeight - 40;
      const line = Math.max(24, Math.round(root.clientHeight * 0.08));
      let dy = null;
      switch (e.key) {
        case ' ': dy = e.shiftKey ? -page : page; break;
        case 'PageDown': case 'ArrowRight': dy = page; break;
        case 'PageUp': case 'ArrowLeft': dy = -page; break;
        case 'ArrowDown': case 'j': dy = line; break;
        case 'ArrowUp': case 'k': dy = -line; break;
        case 'Home': case 'End': dy = 0; break; // swallowed: would trigger enormous loads
        default: return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (dy) root.scrollBy({ top: dy, behavior: 'smooth' });
    },

    installListeners() {
      this._onScroll = () => this.onScroll();
      this._onKey = (e) => this.onKeyDown(e);
      this._onResize = () => { View.layout(); };
      this._onHide = () => { this.syncTarget = this.currentTopOrdinal(); this.kick(); };
      this._onPageHide = () => this.disableSync();
      this._onChevron = (e) => this.onChevron(e);
      View.root.addEventListener('scroll', this._onScroll, { passive: true });
      window.addEventListener('keydown', this._onKey, true);
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.addEventListener(t, this._onChevron, true);
      window.addEventListener('resize', this._onResize);
      window.addEventListener('pagehide', this._onPageHide);
      document.addEventListener('visibilitychange', this._onHide);
      this.observer = new MutationObserver(() => this.onMutation());
      for (const d of docs()) this.observer.observe(d, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class'] });
      const c = Reader.container();
      if (c && 'ResizeObserver' in window) {
        this.resizeObs = new ResizeObserver(() => View.layout());
        this.resizeObs.observe(c);
      }
    },
    removeListeners() {
      if (View.root) View.root.removeEventListener('scroll', this._onScroll);
      window.removeEventListener('keydown', this._onKey, true);
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) window.removeEventListener(t, this._onChevron, true);
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('pagehide', this._onPageHide);
      document.removeEventListener('visibilitychange', this._onHide);
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.resizeObs) { this.resizeObs.disconnect(); this.resizeObs = null; }
      clearTimeout(this.settleTimer); clearTimeout(this.rebuildTimer);
    },
  };

  window.__kvs = { App, Reader, View, Store, CONFIG }; // for console debugging
  App.init();
})();
