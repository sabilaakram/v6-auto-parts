/*
 * V6 wishlist + compare (site-wide).
 * - Any element with [data-wishlist-toggle] or [data-compare-toggle] and
 *   data-product-id (+ data-product-handle) toggles that product in the list.
 * - Lists live in localStorage: "v6-wishlist" / "v6-compare" (product ids) and
 *   "v6-wishlist-handles" / "v6-compare-handles" (id -> handle map, used by the
 *   Wishlist and Compare pages to load products).
 * - [data-wishlist-count] / [data-compare-count] elements show live counts.
 * - Shows a small confirmation toast with a link to the list page.
 * Exposes window.V6Lists for the Wishlist / Compare page sections.
 */
(function () {
  if (window.V6Lists) return;

  // Saved hearts render solid red everywhere.
  var baseStyle = document.createElement('style');
  baseStyle.textContent = '[data-wishlist-toggle].is-active svg{fill:#a50000;stroke:#a50000}';
  document.head.appendChild(baseStyle);

  var cfg = window.v6ListsConfig || {};
  var LISTS = {
    wishlist: {
      key: 'v6-wishlist',
      handlesKey: 'v6-wishlist-handles',
      attr: 'data-wishlist-toggle',
      max: 100,
      url: cfg.wishlistUrl || '/pages/wishlist',
      added: 'Added to your wishlist',
      removed: 'Removed from your wishlist',
      link: 'View wishlist',
    },
    compare: {
      key: 'v6-compare',
      handlesKey: 'v6-compare-handles',
      attr: 'data-compare-toggle',
      max: 4,
      url: cfg.compareUrl || '/pages/compare',
      added: 'Added to compare',
      removed: 'Removed from compare',
      link: 'Compare now',
      full: 'You can compare up to 4 products. Remove one first.',
    },
  };

  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function ids(name) {
    var list = readJSON(LISTS[name].key, []);
    return Array.isArray(list) ? list.map(String) : [];
  }

  function handles(name) {
    var map = readJSON(LISTS[name].handlesKey, {});
    return map && typeof map === 'object' ? map : {};
  }

  function save(name, list, map) {
    writeJSON(LISTS[name].key, list);
    if (map) writeJSON(LISTS[name].handlesKey, map);
    document.dispatchEvent(new CustomEvent('v6:lists-change', { detail: { name: name, ids: list } }));
    sync();
  }

  function add(name, id, handle) {
    var list = ids(name);
    var map = handles(name);
    if (list.indexOf(id) === -1) list.push(id);
    if (handle) map[id] = handle;
    save(name, list, map);
  }

  function remove(name, id) {
    var list = ids(name).filter(function (x) {
      return x !== String(id);
    });
    var map = handles(name);
    delete map[id];
    save(name, list, map);
  }

  function clear(name) {
    save(name, [], {});
  }

  /* ---------- UI sync ---------- */
  var syncQueued = false;
  function sync() {
    syncQueued = false;
    Object.keys(LISTS).forEach(function (name) {
      var conf = LISTS[name];
      var list = ids(name);
      var map = handles(name);
      var mapChanged = false;

      document.querySelectorAll('[' + conf.attr + ']').forEach(function (btn) {
        var id = btn.getAttribute('data-product-id');
        var on = list.indexOf(id) !== -1;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        // Backfill handles for items saved before handles were stored.
        var h = btn.getAttribute('data-product-handle');
        if (on && h && !map[id]) {
          map[id] = h;
          mapChanged = true;
        }
      });
      if (mapChanged) writeJSON(conf.handlesKey, map);

      document.querySelectorAll('[data-' + name + '-count]').forEach(function (el) {
        el.textContent = list.length;
        el.classList.toggle('is-empty', list.length === 0);
      });
    });
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    (window.requestAnimationFrame || setTimeout)(sync);
  }

  /* ---------- Toast ---------- */
  var toastTimer;
  function toast(message, linkText, linkUrl) {
    var el = document.getElementById('v6-list-toast');
    if (!el) {
      var style = document.createElement('style');
      style.textContent =
        '#v6-list-toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);z-index:2147483000;' +
        'display:flex;align-items:center;gap:14px;max-width:calc(100vw - 32px);padding:12px 18px;border-radius:999px;' +
        'background:#111;color:#fff;font-size:14px;line-height:1.3;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:0;' +
        'pointer-events:none;transition:opacity .2s ease,transform .2s ease}' +
        '#v6-list-toast.is-visible{opacity:1;transform:translate(-50%,0);pointer-events:auto}' +
        '#v6-list-toast a{color:#fff;font-weight:700;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}' +
        '#v6-list-toast a:hover{color:#ffb3b3}';
      document.head.appendChild(style);
      el = document.createElement('div');
      el.id = 'v6-list-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (linkText && linkUrl) {
      var a = document.createElement('a');
      a.href = linkUrl;
      a.textContent = linkText;
      el.appendChild(a);
    }
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
    }, 3500);
  }

  /* ---------- Clicks ---------- */
  document.addEventListener(
    'click',
    function (event) {
      var btn = event.target.closest && event.target.closest('[data-wishlist-toggle],[data-compare-toggle]');
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();

      var name = btn.hasAttribute('data-wishlist-toggle') ? 'wishlist' : 'compare';
      var conf = LISTS[name];
      var id = btn.getAttribute('data-product-id');
      if (!id) return;
      var handle = btn.getAttribute('data-product-handle');
      var list = ids(name);

      if (list.indexOf(id) !== -1) {
        remove(name, id);
        toast(conf.removed, list.length > 1 ? conf.link : null, conf.url);
      } else if (list.length >= conf.max) {
        toast(conf.full || 'This list is full', conf.link, conf.url);
      } else {
        add(name, id, handle);
        toast(conf.added, conf.link, conf.url);
      }
    },
    true
  );

  // Keep buttons in sync when other tabs change the lists.
  window.addEventListener('storage', function (e) {
    if (e.key && e.key.indexOf('v6-') === 0) queueSync();
  });

  // Keep buttons in sync when product grids are re-rendered (filters, quick view, tabs).
  function observe() {
    sync();
    if (window.MutationObserver) {
      new MutationObserver(queueSync).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }

  window.V6Lists = {
    ids: ids,
    handles: handles,
    add: add,
    remove: remove,
    clear: clear,
    sync: sync,
    toast: toast,
    config: LISTS,
  };
})();
