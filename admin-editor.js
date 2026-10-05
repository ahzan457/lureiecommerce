/* =====================================================================
 * LUREÍ — Live Storefront Editor & master catalogue store
 * ---------------------------------------------------------------------
 * Loaded by the catalogue pages (collections / index / new-in) and by
 * the admin dashboard. Exposes window.LureiCatalogue: the shared product
 * list that the storefront renders from, plus the edit-mode overlay.
 *
 * Precedence, lowest to highest:
 *   built-in defaults  ->  Google Sheets (if configured)  ->  this store
 * so an admin edit is never overwritten by a catalogue refresh, and a
 * deleted product stays deleted across reloads via the `removed` list.
 *
 * Everything is namespaced under `lurei-` and additive: no existing
 * storefront markup, class or CSS rule is modified by this file.
 * ===================================================================== */

(function () {
  "use strict";

  var MASTER_STORAGE_KEY = "lurei_products";
  var EDIT_MODE_STORAGE_KEY = "lurei_admin_editing";

  /* localStorage is roughly 5MB per origin and a handful of phone photos
     will blow through it, so uploads are downscaled and the total serialised
     size is checked before anything is written. */
  var MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
  var MAX_IMAGE_EDGE = 900;
  var IMAGE_QUALITY = 0.82;

  var CATEGORIES = [
    { value: "earrings", label: "Earrings" },
    { value: "rings", label: "Rings" },
    { value: "necklaces", label: "Necklaces" },
    { value: "bracelets", label: "Bracelets" },
    { value: "watches", label: "Watches" },
  ];

  /* ------------------------------------------------------------------ *
   * Edit-mode session flag
   * ------------------------------------------------------------------ */

  var readFlag = function (key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  };

  var writeFlag = function (key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  };

  var isEditModeRequested = function () {
    return readFlag(EDIT_MODE_STORAGE_KEY) === "true";
  };

  var enterEditMode = function () {
    return writeFlag(EDIT_MODE_STORAGE_KEY, "true");
  };

  var exitEditMode = function () {
    try {
      localStorage.removeItem(EDIT_MODE_STORAGE_KEY);
    } catch (error) {
      /* private mode: the query string still ends the session on reload */
    }
  };

  /* Once Supabase is configured the flag alone is not authority enough —
     an unauthenticated visitor could add ?editMode=true to their own URL.
     An admin session is then required. */
  var backend = window.LureiBackend || null;
  var backendLive = !!(backend && typeof backend.isConfigured === "function" && backend.isConfigured());

  var mayEdit = function () {
    if (!backendLive) return true;
    return typeof backend.getSession === "function" && !!backend.getSession();
  };

  var shouldEdit = function () {
    if (!isEditModeRequested()) return false;
    if (mayEdit()) return true;
    exitEditMode();
    return false;
  };

  /* ------------------------------------------------------------------ *
   * Master catalogue store
   * ------------------------------------------------------------------ */

  /* The built-in catalogue the storefront boots with. script.js hands this
     over via setDefaults() so ids, lookup and "current catalogue" all agree
     with what is actually rendered on screen. */
  var defaults = [];

  var isPlainProduct = function (value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  };

  var toNumber = function (value) {
    if (value === null || value === undefined || value === "") return null;
    var parsed = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.-]/g, ""));
    return isFinite(parsed) ? parsed : null;
  };

  /* The catalogue's price buckets. Adding a product without one would hide
     it from every price filter, so the bucket is always derived from the
     price the admin typed. Mirrors the ranges already in the dataset. */
  var priceBucketFor = function (price) {
    var value = toNumber(price);
    if (value === null) return "under-30";
    if (value <= 30) return "under-30";
    if (value <= 50) return "under-50";
    if (value <= 100) return "under-100";
    return "under-150";
  };

  /* Stock is a whole number of pieces, or null when nobody has counted the
     shelf yet. null is deliberately NOT 0: the built-in catalogue ships with no
     counts, so collapsing "unknown" into zero would publish every seeded piece
     as sold out. Only an explicit 0 (or the older outOfStock flag) means empty.

     The parse is strict for the same reason: toNumber() strips letters, so it
     reads "n/a" or "three" as 0 and would empty a shelf nobody touched. */
  var stockFor = function (value) {
    var num = null;

    if (typeof value === "number") {
      num = isFinite(value) ? value : null;
    } else if (typeof value === "string") {
      var trimmed = value.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) num = Number(trimmed);
    }

    if (num === null) return null;
    var whole = Math.floor(num);
    return whole > 0 ? whole : 0;
  };

  /* An older build wrote product images under assets/images/products/, a folder
   * that never existed on disk, so every one of those cards 404'd and fell back
   * to its placeholder. Such a value is provably dead: drop it and layer() lets
   * the corrected built-in path take over. Only that folder is cleared - admin
   * uploads (base64) and remote URLs are kept, and the rest of the stored entry
   * survives, because discarding it would also lose price/stock edits. */
  var DEAD_IMAGE_FOLDER = "assets/images/products/";
  var REMOTE_IMAGE = /^(https?:|data:|\/\/)/i;

  var sanitizeImage = function (value) {
    if (typeof value !== "string") return "";
    var trimmed = value.trim();
    if (!trimmed) return "";
    if (REMOTE_IMAGE.test(trimmed)) return trimmed;
    if (trimmed.replace(/^\.\//, "").indexOf(DEAD_IMAGE_FOLDER) === 0) return "";
    return trimmed;
  };

  var sanitize = function (raw) {
    var product = {};
    product.id = raw.id !== undefined && raw.id !== null ? raw.id : null;
    product.title = String(raw.title || raw.name || "").trim();
    product.price = toNumber(raw.price);
    product.category = String(raw.category || "").trim() || priceBucketFor(raw.price);
    product.type = String(raw.type || "").trim() || "earrings";
    product.image = sanitizeImage(raw.image);
    product.description = String(raw.description || raw.desc || "").trim();
    product.badge = raw.badge ? String(raw.badge).trim() : "";
    product.stock = stockFor(raw.stock);
    /* A real zero empties the shelf no matter how the flag was set, so the
       count and the boolean can never disagree and show a "3 LEFT" pill on a
       sold-out card. */
    product.outOfStock = product.stock === 0 || raw.outOfStock === true;
    return product;
  };

  var isUsable = function (product) {
    return !!product.title && product.price !== null && product.price > 0;
  };

  var readStore = function () {
    var parsed;
    try {
      parsed = JSON.parse(readFlag(MASTER_STORAGE_KEY) || "null");
    } catch (error) {
      return { version: 1, products: [], removed: [] };
    }

    /* Tolerate a bare array from an earlier build. */
    if (Array.isArray(parsed)) {
      return {
        version: 1,
        products: parsed.filter(isPlainProduct).map(sanitize).filter(isUsable),
        removed: [],
      };
    }

    if (!isPlainProduct(parsed)) return { version: 1, products: [], removed: [] };

    return {
      version: 1,
      products: Array.isArray(parsed.products)
        ? parsed.products.filter(isPlainProduct).map(sanitize).filter(isUsable)
        : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.map(String) : [],
    };
  };

  var writeStore = function (store) {
    var payload = {
      version: 1,
      products: store.products,
      removed: store.removed,
    };

    if (JSON.stringify(payload).length > MAX_UPLOAD_BYTES) {
      throw new Error(
        "The catalogue is too large to save. Remove an image or two and try again."
      );
    }

    try {
      localStorage.setItem(MASTER_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (error) {
      throw new Error(
        "This browser is out of storage space, so the change was not saved. Free up some space and retry."
      );
    }
  };

  /* An override only carries the fields the admin actually touched — a price
     change must not blank out the built-in image or description, so empty
     store values defer to the built-in record instead of overwriting it. */
  /* Rewrite the persisted store once if any dead image path was dropped, so the
   * corruption does not linger in localStorage across reloads. Detection reads
   * the raw payload because sanitize() has already erased the value in memory. */
  var repairStoredImages = function () {
    var parsed;
    try {
      parsed = JSON.parse(readFlag(MASTER_STORAGE_KEY) || "null");
    } catch (error) {
      return false;
    }

    var entries = Array.isArray(parsed) ? parsed : parsed && parsed.products;
    if (!Array.isArray(entries)) return false;

    var dirty = entries.some(function (entry) {
      return (
        entry &&
        typeof entry.image === "string" &&
        entry.image.trim().replace(/^\.\//, "").indexOf(DEAD_IMAGE_FOLDER) === 0
      );
    });
    if (!dirty) return false;

    try {
      writeStore(readStore());
      return true;
    } catch (error) {
      /* Storage full or blocked - the in-memory repair still applies. */
      return false;
    }
  };

  var layer = function (product, override) {
    var merged = Object.assign({}, product);
    Object.keys(override).forEach(function (key) {
      var value = override[key];
      if (value === null || value === undefined || value === "") return;
      merged[key] = value;
    });
    return merged;
  };

  /* Defaults win on identity only: the store entry is layered over the
     built-in record so a product the admin never touched still gains new
     built-in fields (image fixes, descriptions) on upgrade. */
  var resolve = function (defaults) {
    var base = Array.isArray(defaults) ? defaults : [];
    var store = readStore();
    var removed = store.removed;
    var byId = new Map();

    store.products.forEach(function (product) {
      byId.set(String(product.id), product);
    });

    var merged = [];
    var seen = new Set();

    base.forEach(function (product) {
      var key = String(product.id);
      if (removed.indexOf(key) !== -1) return;
      var override = byId.get(key);
      merged.push(override ? layer(product, override) : product);
      seen.add(key);
    });

    store.products.forEach(function (product) {
      var key = String(product.id);
      if (seen.has(key)) return;
      if (removed.indexOf(key) !== -1) return;
      merged.push(product);
      seen.add(key);
    });

    return merged;
  };

  var subscribers = [];

  var notify = function () {
    subscribers.slice().forEach(function (fn) {
      try {
        fn();
      } catch (error) {
        console.warn("[Catalogue] subscriber failed:", error && error.message);
      }
    });
  };

  var commit = function (store) {
    writeStore(store);
    notify();
    return true;
  };

  /* Every mutation goes through here so the "did the admin already change
     this product?" question is answered once. A product the admin has never
     touched has no store entry yet, so the patch seeds one — otherwise the
     built-in products would be the only ones that could not be edited. */
  var upsertOverrides = function (id, patch) {
    var store = readStore();
    var key = String(id);
    var index = store.products.findIndex(function (p) {
      return String(p.id) === key;
    });

    if (index === -1) {
      var seed = resolve(defaults).filter(function (p) {
        return String(p.id) === key;
      })[0];

      if (!seed) return { store: store, added: false };

      var created = sanitize({
        id: id,
        title: seed.title,
        price: seed.price,
        category: seed.category,
        type: seed.type,
        image: seed.image,
        description: seed.description,
        badge: seed.badge,
        stock: seed.stock,
        outOfStock: seed.outOfStock,
      });

      store.products.push(Object.assign({}, created, patch));
      return { store: store, added: true, changed: true };
    }

    store.products[index] = Object.assign({}, store.products[index], patch);
    return { store: store, added: false, changed: true };
  };

  /* The built-in ids must be taken into account as well: resolve() merges by
     id, so a new product that reused a live id would silently overwrite an
     existing piece instead of joining the catalogue. */
  var nextId = function () {
    var highest = 0;

    var consider = function (value) {
      var num = toNumber(value);
      if (num !== null && num > highest) highest = Math.floor(num);
    };

    resolve(defaults).forEach(function (product) {
      consider(product.id);
    });

    return highest + 1;
  };

  /* ------------------------------------------------------------------ *
   * Store API
   * ------------------------------------------------------------------ */

  var store = {
    storageKey: MASTER_STORAGE_KEY,
    categories: CATEGORIES,
    priceBucketFor: priceBucketFor,
    resolve: resolve,
    setDefaults: function (list) {
      defaults = Array.isArray(list) ? list : [];
      repairStoredImages();
      notify();
      return true;
    },
    read: function () {
      return resolve(defaults);
    },
    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      subscribers.push(fn);
      return function () {
        subscribers = subscribers.filter(function (entry) {
          return entry !== fn;
        });
      };
    },
    raw: readStore,

    /* The pieces the admin published, as opposed to edits to pieces that
       already shipped. The storefront's New In rail needs exactly this list:
       the catalogue itself holds every built-in product, and appending all of
       those to a curated arrivals row would bury the six pieces it is meant
       to showcase. Deleted pieces are filtered out because resolve() already
       drops them by tombstone. */
    created: function () {
      var base = new Set(
        (Array.isArray(defaults) ? defaults : []).map(function (product) {
          return String(product.id);
        })
      );

      return resolve(defaults).filter(function (product) {
        return !base.has(String(product.id));
      });
    },

    add: function (input) {
      var current = resolve(defaults);
      var id = nextId();
      var product = sanitize({
        id: id,
        title: input.title,
        price: input.price,
        category: input.category,
        type: input.type,
        image: input.image,
        description: input.description,
        badge: input.badge,
        stock: stockFor(input.stock),
        outOfStock: input.outOfStock === true || stockFor(input.stock) === 0,
      });

      if (!isUsable(product)) {
        throw new Error("A product needs a name and a price above 0 AED.");
      }

      if (current.some(function (p) {
        return String(p.title).toLowerCase() === product.title.toLowerCase();
      })) {
        throw new Error('"' + product.title + '" is already in the catalogue.');
      }

      var next = readStore();
      next.removed = next.removed.filter(function (key) {
        return key !== String(id);
      });
      next.products.push(product);
      commit(next);
      return product;
    },

    update: function (id, patch) {
      var result = upsertOverrides(id, patch);
      if (!result.changed) {
        throw new Error("That product is no longer in the catalogue. Refresh the page.");
      }
      commit(result.store);
      return true;
    },

    setOutOfStock: function (id, outOfStock) {
      return store.update(id, { outOfStock: outOfStock === true });
    },

    /* The count is the source of truth: dropping it to 0 takes the piece off
       sale, and any number above 0 puts it straight back. Both land in one
       write so a storefront tab can never see "0 left" and "add to cart" in the
       same render. */
    setStock: function (id, stock) {
      var count = stockFor(stock);
      return store.update(id, { stock: count, outOfStock: count === 0 });
    },

    /* Hard delete. Recorded as a tombstone as well, because the built-in
       defaults would otherwise put the product straight back on the next
       page load. */
    remove: function (id) {
      var key = String(id);
      var next = readStore();

      next.products = next.products.filter(function (p) {
        return String(p.id) !== key;
      });

      if (next.removed.indexOf(key) === -1) next.removed.push(key);
      commit(next);
      return true;
    },

    restore: function (id) {
      var key = String(id);
      var next = readStore();
      next.removed = next.removed.filter(function (entry) {
        return entry !== key;
      });
      commit(next);
      return true;
    },

    reset: function () {
      try {
        localStorage.removeItem(MASTER_STORAGE_KEY);
      } catch (error) {
        /* nothing to clear */
      }
      notify();
      return true;
    },
  };

  window.LureiCatalogue = {
    storageKey: MASTER_STORAGE_KEY,
    editModeKey: EDIT_MODE_STORAGE_KEY,
    categories: CATEGORIES,
    maxImageEdge: MAX_IMAGE_EDGE,
    imageQuality: IMAGE_QUALITY,
    maxBytes: MAX_UPLOAD_BYTES,
    priceBucketFor: priceBucketFor,
    resolve: resolve,
    stockFor: stockFor,
    created: store.created,
    setDefaults: store.setDefaults,
    store: store,
    subscribe: store.subscribe,
    enterEditMode: enterEditMode,
    exitEditMode: exitEditMode,
    canEdit: mayEdit,
    isEditModeRequested: isEditModeRequested,
    shouldEdit: shouldEdit,
  };

  /* Any other tab on the site re-renders the moment the catalogue moves. */
  window.addEventListener("storage", function (event) {
    if (event.key !== MASTER_STORAGE_KEY && event.key !== null) return;
    notify();
  });
})();

/* =====================================================================
 * Edit-mode overlay
 *
 * Everything below is created from script, so the catalogue pages keep
 * their existing markup untouched and the overlay simply disappears when
 * edit mode is off.
 * ===================================================================== */

(function () {
  "use strict";

  var catalogue = window.LureiCatalogue;
  if (!catalogue) return;

  var store = catalogue.store;
  var CATEGORIES = catalogue.categories;

  var GRID_IDS = ["collections-container", "products-container", "new-in-grid"];

  var grid = null;
  var editingId = null;
  var pendingImage = null;
  var observer = null;
  var unsubscribe = null;
var mounted = false;
  var lastFocus = null;

  var IMAGE_GLYPH =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect>' +
    '<circle cx="8.5" cy="9.5" r="1.6"></circle>' +
    '<path d="M21 15.5l-4.5-4.5L7 20.5"></path></svg>';

  var findGrid = function () {
    for (var i = 0; i < GRID_IDS.length; i++) {
      var found = document.getElementById(GRID_IDS[i]);
      if (found) return found;
    }
    return null;
  };

  var escapeHTML = function (value) {
    return String(value === null || value === undefined ? "" : value).replace(
      /[&<>"']/g,
      function (ch) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[ch];
      }
    );
  };

  var byId = function (id) {
    return store.read().find(function (product) {
      return String(product.id) === String(id);
    });
  };

  /* ---------------- Edit-mode session bar ---------------- */

  var leaveEditMode = function () {
    catalogue.exitEditMode();
    var url = new URL(window.location.href);
    url.searchParams.delete("editMode");
    window.history.replaceState({}, "", url.pathname + url.search);
    window.location.reload();
  };

  var buildEditBar = function () {
    var bar = document.createElement("div");
    bar.className = "lurei-edit-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Storefront edit mode");
    bar.innerHTML =
      '<span class="lurei-edit-bar__pulse" aria-hidden="true"></span>' +
      '<strong class="lurei-edit-bar__title">STOREFRONT EDIT MODE ACTIVE</strong>' +
      '<span class="lurei-edit-bar__hint">Every change saves to your live catalogue instantly</span>' +
      '<button class="lurei-edit-bar__exit" type="button">EXIT &amp; SAVE</button>';

    bar.querySelector(".lurei-edit-bar__exit").addEventListener("click", leaveEditMode);
    return bar;
  };

  /* ---------------- Add / new product ---------------- */

  var buildFab = function () {
    var fab = document.createElement("button");
    fab.className = "lurei-add-fab";
    fab.type = "button";
    fab.innerHTML = '<span aria-hidden="true">+</span> ADD NEW PRODUCT';
    fab.addEventListener("click", function () {
      openModal();
    });
    return fab;
  };

  /* ---------------- Per-card quick actions ---------------- */

  var cardToolsHTML = function (product) {
    var soldOut = product.outOfStock === true;
    /* The count is read here so the admin can see the number that is actually
       driving the storefront pill, not just whether the piece is hidden.
       "1 LEFT" reads correctly as its own singular, so no plural branch. */
    var count =
      typeof product.stock === "number" && product.stock >= 0 ? product.stock + " LEFT" : "";

    return (
      '<div class="lurei-card-tools" data-lurei-tools>' +
        '<span class="lurei-card-stock' + (soldOut ? " is-warn" : "") + '">' +
          (soldOut ? "OUT OF STOCK" : count ? "STOCK " + count : "STOCK NOT TRACKED") +
        "</span>" +
        '<button class="lurei-card-btn' + (soldOut ? " is-warn" : "") + '" type="button" ' +
          'data-lurei-action="stock" data-id="' + escapeHTML(product.id) + '">' +
          (soldOut ? "RESTOCK" : "REMOVE / OUT OF STOCK") +
        "</button>" +
        '<button class="lurei-card-btn" type="button" ' +
          'data-lurei-action="edit" data-id="' + escapeHTML(product.id) + '">' +
          "EDIT PRICE / DETAILS" +
        "</button>" +
      "</div>"
    );
  };

  var injectTools = function (card, product) {
    if (!card) return;

    var soldOut = product.outOfStock === true;
    var stockBtn = card.querySelector('[data-lurei-action="stock"]');
    var stockLabel = card.querySelector(".lurei-card-stock");

    /* Kept in step with the product on every pass, not just the first. The
       stock state drives both the card treatment and the toolbar wording, and
       neither lives where the toolbar markup can be re-read from. */
    card.classList.toggle("lurei-is-sold-out", soldOut);

    if (stockLabel) {
      var count =
        typeof product.stock === "number" && product.stock >= 0
          ? product.stock + " LEFT"
          : "";
      var label = soldOut ? "OUT OF STOCK" : count ? "STOCK " + count : "STOCK NOT TRACKED";
      if (stockLabel.textContent !== label) stockLabel.textContent = label;
      stockLabel.classList.toggle("is-warn", soldOut);
    }

    if (stockBtn) {
      /* Only write when something actually changes: this runs from a
         MutationObserver, and re-assigning textContent is itself a mutation
         that would re-trigger the observer forever. */
      var label = soldOut ? "RESTOCK" : "REMOVE / OUT OF STOCK";
      if (stockBtn.textContent !== label) stockBtn.textContent = label;
      stockBtn.classList.toggle("is-warn", soldOut);
      return;
    }

    var media = card.querySelector(".product-card__media") || card;
    var holder = document.createElement("div");
    holder.innerHTML = cardToolsHTML(product);
    media.appendChild(holder.firstElementChild);
  };

  /* ---------------- Inline quick edit ---------------- */

  var buildInlineEditor = function (card, product) {
    var wrap = document.createElement("div");
    wrap.className = "lurei-inline";
    wrap.setAttribute("data-lurei-inline", String(product.id));

    wrap.innerHTML =
      '<div class="lurei-inline__head">QUICK EDIT</div>' +
      '<label class="lurei-field">' +
        '<span class="lurei-field__label">Product name</span>' +
        '<input class="lurei-field__input" type="text" data-lurei-name maxlength="80" value="' +
          escapeHTML(product.title) + '" />' +
      "</label>" +
      '<label class="lurei-field">' +
        '<span class="lurei-field__label">Price (AED)</span>' +
        '<input class="lurei-field__input" type="number" data-lurei-price min="0" step="0.01" value="' +
          escapeHTML(product.price) + '" />' +
      "</label>" +
      '<label class="lurei-field">' +
        '<span class="lurei-field__label">Stock count</span>' +
        '<input class="lurei-field__input" type="number" data-lurei-stock min="0" step="1" value="' +
          (product.stock === null || product.stock === undefined ? "" : escapeHTML(product.stock)) + '" />' +
        '<span class="lurei-field__hint">Empty = untracked. 0 = Out of Stock.</span>' +
      "</label>" +
      '<label class="lurei-field">' +
        '<span class="lurei-field__label">Category</span>' +
        '<select class="lurei-field__input" data-lurei-type>' +
          CATEGORIES.map(function (option) {
            return (
              '<option value="' + option.value + '"' +
              (option.value === product.type ? " selected" : "") + ">" +
              option.label + "</option>"
            );
          }).join("") +
        "</select>" +
      "</label>" +
      '<label class="lurei-field">' +
        '<span class="lurei-field__label">Description <span class="lurei-field__optional">optional</span></span>' +
        '<textarea class="lurei-field__input lurei-field__input--area" data-lurei-desc rows="2" maxlength="180" ' +
          'placeholder="One short line about the piece">' + escapeHTML(product.description || "") + "</textarea>" +
      "</label>" +
      '<div class="lurei-inline__actions">' +
        '<button class="lurei-btn lurei-btn--primary" type="button" data-lurei-save>SAVE</button>' +
        '<button class="lurei-btn" type="button" data-lurei-cancel>CANCEL</button>' +
      "</div>" +
      '<button class="lurei-btn lurei-btn--danger lurei-btn--block" type="button" data-lurei-delete>' +
        "DELETE PRODUCT PERMANENTLY" +
      "</button>";

    var save = function () {
      var title = wrap.querySelector("[data-lurei-name]").value.trim();
      var price = Number(wrap.querySelector("[data-lurei-price]").value);
      var type = wrap.querySelector("[data-lurei-type]").value;
      var description = wrap.querySelector("[data-lurei-desc]").value.trim();
      var stockRaw = wrap.querySelector("[data-lurei-stock]").value.trim();

      /* A count of 0 is legitimate here - it is how a piece is taken off sale -
         so only a negative or unparseable entry is rejected, and an empty box
         keeps whatever the shelf already said. */
      var stock = null;
      if (stockRaw !== "") {
        stock = Number(stockRaw);
        if (!(stock >= 0)) {
          flashError(wrap, "Stock count must be 0 or more.");
          return;
        }
        stock = Math.floor(stock);
      }

      if (!title) {
        flashError(wrap, "A product needs a name.");
        return;
      }

      /* Price 0 would silently drop the product out of every filter, so it
         is rejected here rather than looking like a successful save. */
      if (!(price > 0)) {
        flashError(wrap, "Enter a price above 0 AED.");
        return;
      }

      try {
        store.update(product.id, {
          title: title,
          price: price,
          category: catalogue.priceBucketFor(price),
          type: type,
          description: description,
          stock: stock,
          outOfStock: stock === 0,
        });
        editingId = null;
        announce(
          stock === 0
            ? '"' + title + '" is now out of stock.'
            : '"' + title + '" updated.'
        );
      } catch (error) {
        flashError(wrap, error.message);
      }
    };

    var closeInline = function () {
      editingId = null;
      if (card) card.classList.remove("lurei-is-editing");
      wrap.remove();
    };

    wrap.querySelector("[data-lurei-save]").addEventListener("click", save);
    wrap.querySelector("[data-lurei-cancel]").addEventListener("click", closeInline);

    wrap.querySelector("[data-lurei-delete]").addEventListener("click", function () {
      if (!window.confirm('Delete "' + product.title + '" from the storefront for good?')) {
        return;
      }
      try {
        store.remove(product.id);
        announce('"' + product.title + '" deleted.');
      } catch (error) {
        flashError(wrap, error.message);
      }
    });

    wrap.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && event.target.tagName !== "TEXTAREA") {
        event.preventDefault();
        save();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeInline();
      }
    });

    return wrap;
  };

  /* ---------------- Add-product modal ---------------- */

  var modal = null;

  var buildModal = function () {
    var host = document.createElement("div");
    host.className = "lurei-modal";
    host.hidden = true;

    host.innerHTML =
      '<div class="lurei-modal__scrim" data-lurei-close></div>' +
      '<div class="lurei-modal__card" role="dialog" aria-modal="true" aria-labelledby="lurei-modal-title">' +
        '<header class="lurei-modal__head">' +
          '<div>' +
            '<h2 class="lurei-modal__title" id="lurei-modal-title">Add New Product</h2>' +
            '<p class="lurei-modal__subtitle">It appears on the live storefront the moment you publish.</p>' +
          "</div>" +
          '<button class="lurei-modal__close" type="button" data-lurei-close aria-label="Close">' +
            '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>' +
          "</button>" +
        "</header>" +
        '<form class="lurei-modal__body" novalidate>' +
          '<div class="lurei-modal__row">' +
            '<div class="lurei-upload" data-lurei-drop>' +
              '<input class="lurei-upload__input" type="file" accept="image/*" data-lurei-file aria-label="Upload product image" />' +
              '<div class="lurei-upload__preview" data-lurei-preview>' +
                '<span class="lurei-upload__placeholder">'+ IMAGE_GLYPH +'</span>' +
              "</div>" +
              '<div class="lurei-upload__meta">' +
                '<span class="lurei-upload__label">Product image</span>' +
                '<span class="lurei-upload__hint" data-lurei-filename>Tap to upload a photo</span>' +
              "</div>" +
            "</div>" +
            '<div class="lurei-modal__fields">' +
              '<label class="lurei-field">' +
                '<span class="lurei-field__label">Product name</span>' +
                '<input class="lurei-field__input" type="text" data-lurei-name maxlength="80" placeholder="e.g. Solitaire Gold Ring" required />' +
              "</label>" +
              '<label class="lurei-field">' +
                '<span class="lurei-field__label">Price (AED)</span>' +
                '<input class="lurei-field__input" type="number" data-lurei-price min="0" step="0.01" placeholder="45.00" required />' +
              "</label>" +
              '<label class="lurei-field">' +
                '<span class="lurei-field__label">Stock count</span>' +
                '<input class="lurei-field__input" type="number" data-lurei-stock min="0" step="1" placeholder="3" />' +
                '<span class="lurei-field__hint">Leave empty if untracked. 0 publishes it as Out of Stock.</span>' +
              "</label>" +
              '<label class="lurei-field">' +
                '<span class="lurei-field__label">Category</span>' +
                '<select class="lurei-field__input" data-lurei-type>' +
                  CATEGORIES.map(function (option) {
                    return '<option value="' + option.value + '">' + option.label + "</option>";
                  }).join("") +
                "</select>" +
              "</label>" +
              '<label class="lurei-field">' +
                '<span class="lurei-field__label">Description <span class="lurei-field__optional">optional</span></span>' +
                '<textarea class="lurei-field__input lurei-field__input--area" data-lurei-desc rows="2" maxlength="180" placeholder="One short line about the piece"></textarea>' +
              "</label>" +
            "</div>" +
          "</div>" +
          '<p class="lurei-modal__error" data-lurei-error hidden></p>' +
          '<footer class="lurei-modal__foot">' +
            '<button class="lurei-btn" type="button" data-lurei-close>CANCEL</button>' +
            '<button class="lurei-btn lurei-btn--primary" type="submit">CONFIRM &amp; PUBLISH PRODUCT</button>' +
          "</footer>" +
        "</form>" +
      "</div>";

    document.body.appendChild(host);
    return host;
  };

  var openModal = function () {
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("lurei-modal-open");
    modal.querySelector("[data-lurei-error]").hidden = true;
    pendingImage = "";
    renderPreview();
    var first = modal.querySelector("[data-lurei-name]");
    if (first) first.focus();
  };

  var closeModal = function () {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("lurei-modal-open");
    var form = modal.querySelector("form");
    if (form) form.reset();
    pendingImage = "";
    renderPreview();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };

  var renderPreview = function () {
    if (!modal) return;
    var preview = modal.querySelector("[data-lurei-preview]");
    var filename = modal.querySelector("[data-lurei-filename]");
    if (!preview || !filename) return;

    if (pendingImage) {
      preview.innerHTML = '<img src="' + escapeHTML(pendingImage) + '" alt="" />';
      filename.textContent = "Ready to publish";
    } else {
      preview.innerHTML = '<span class="lurei-upload__placeholder">' + IMAGE_GLYPH + "</span>";
      filename.textContent = "Tap to upload a photo";
    }
  };

  /* ---------------- Image -> Base64 ---------------- */

  var readImageAsDataURL = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        reject(new Error("Please choose an image file (JPG, PNG or WebP)."));
        return;
      }

      var reader = new FileReader();

      reader.onerror = function () {
        reject(new Error("That image could not be read. Try a different file."));
      };

      reader.onload = function () {
        var image = new Image();

        image.onerror = function () {
          reject(new Error("That file is not a usable image."));
        };

        image.onload = function () {
          /* Downscaled before encoding: a full-resolution phone photo is
             megabytes of Base64 and would fill localStorage on its own. */
          var scale = Math.min(
            1,
            catalogue.maxImageEdge / Math.max(image.naturalWidth, image.naturalHeight)
          );
          var width = Math.max(1, Math.round(image.naturalWidth * scale));
          var height = Math.max(1, Math.round(image.naturalHeight * scale));

          var canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;

          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#FAF8F5";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(image, 0, 0, width, height);

          try {
            resolve(canvas.toDataURL("image/jpeg", catalogue.imageQuality));
          } catch (error) {
            reject(new Error("That image could not be prepared for the storefront."));
          }
        };

        image.src = reader.result;
      };

      reader.readAsDataURL(file);
    });
  };

  var handleFile = function (file, previewHost, errorHost) {
    return readImageAsDataURL(file).then(function (dataURL) {
      pendingImage = dataURL;
      renderPreview();
      if (previewHost) previewHost.classList.add("is-ready");
      return dataURL;
    }).catch(function (error) {
      if (errorHost) {
        errorHost.textContent = error.message;
        errorHost.hidden = false;
      }
      throw error;
    });
  };

  /* ---------------- Toast ---------------- */

  var toast = null;
  var toastTimer = null;

  var announce = function (message) {
    if (!toast) {
      toast = document.createElement("p");
      /* Deliberately not .lurei-toast: the storefront toast helper in
         script.js adopts the first element with that class, and two owners
         for one node would make them fight over the text. */
      toast.className = "lurei-edit-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }

    toast.textContent = message;

    /* The class flip has to land a frame after the text, otherwise the
       browser coalesces both mutations and the fade-in never plays. Some
       embedded webviews and headless environments have no rAF, and this is
       the last thing wireEditMode() does -- an unguarded call there would
       abort the mount after the overlay was already in the DOM. */
    var reveal = function () {
      toast.classList.add("is-visible");
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(reveal);
    } else {
      setTimeout(reveal, 16);
    }

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("is-visible");
    }, 3200);
  };

  var flashError = function (host, message) {
    var target = host.querySelector("[data-lurei-error]");
    if (!target) {
      announce(message);
      return;
    }
    target.textContent = message;
    target.hidden = false;
  };

  /* ---------------- Wiring ---------------- */

  /* Last known good count per piece, kept only for this editing session so the
     one-click RESTOCK can return a shelf to the number it held before. */
  var lastKnownStock = {};
  var DEFAULT_RESTOCK = 3;

  var openInline = function (card, product) {
    if (editingId !== null && String(editingId) !== String(product.id)) {
      var open = grid.querySelector("[data-lurei-inline]");
      if (open) open.remove();
      editingId = null;
    }

    editingId = product.id;
    card.classList.add("lurei-is-editing");

    var media = card.querySelector(".product-card__media") || card;
    var existing = media.querySelector("[data-lurei-inline]");
    if (existing) existing.remove();
    media.appendChild(buildInlineEditor(card, product));

    var nameField = media.querySelector("[data-lurei-name]");
    if (nameField) nameField.focus();
  };

var onGridClick = function (event) {
    var action = event.target.closest("[data-lurei-action]");
    if (!action) return;

    var id = action.getAttribute("data-id");
    var product = byId(id);
    if (!product) {
      announce("That product is no longer in the catalogue.");
      return;
    }

    var card = action.closest(".product-card");

    event.preventDefault();
    event.stopPropagation();

    if (action.getAttribute("data-lurei-action") === "edit") {
      if (card) openInline(card, product);
      return;
    }

    /* The button drives the real count rather than a lone flag: 0 empties the
       shelf, and restocking puts the previous number back so the "3 LEFT" pill
       reappears with the value it had before, not an arbitrary one. */
    if (product.outOfStock === true) {
      if (!window.confirm('Bring "' + product.title + '" back into stock?')) return;
      var restore = typeof product.stock === "number" && product.stock > 0
        ? product.stock
        : lastKnownStock[product.id] || DEFAULT_RESTOCK;
      try {
        store.setStock(product.id, restore);
        lastKnownStock[product.id] = restore;
        announce('"' + product.title + '" is back in stock — ' + restore + " left.");
      } catch (error) {
        announce(error.message);
      }
      return;
    }

    if (!window.confirm('Take "' + product.title + '" out of stock? Customers will see it as sold out.')) {
      return;
    }

    try {
      if (typeof product.stock === "number" && product.stock > 0) {
        lastKnownStock[product.id] = product.stock;
      }
      store.setStock(product.id, 0);
      announce('"' + product.title + '" marked out of stock.');
    } catch (error) {
      announce(error.message);
    }
  };

  var onModalSubmit = function (event) {
    event.preventDefault();

    var errorHost = modal.querySelector("[data-lurei-error]");
    errorHost.hidden = true;

    var title = modal.querySelector("[data-lurei-name]").value.trim();
    var price = Number(modal.querySelector("[data-lurei-price]").value);
    var type = modal.querySelector("[data-lurei-type]").value;
    var description = modal.querySelector("[data-lurei-desc]").value.trim();
    /* An empty box means "nobody counted", which is kept as null rather than 0
       so a new piece is never born sold out. */
    var stockRaw = modal.querySelector("[data-lurei-stock]").value.trim();

    try {
      var created = store.add({
        title: title,
        price: price,
        category: catalogue.priceBucketFor(price),
        type: type,
        description: description,
        image: pendingImage,
        stock: stockRaw === "" ? null : Number(stockRaw),
      });

      closeModal();
      announce('"' + created.title + '" is now live on the storefront.');
    } catch (error) {
      errorHost.textContent = error.message;
      errorHost.hidden = false;
    }
  };

  var wireModal = function () {
    modal.addEventListener("click", function (event) {
      if (event.target.closest("[data-lurei-close]")) closeModal();
    });

    modal.addEventListener("submit", onModalSubmit);

    modal.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeModal();
    });

    var drop = modal.querySelector("[data-lurei-drop]");
    var file = modal.querySelector("[data-lurei-file]");
    var errorHost = modal.querySelector("[data-lurei-error]");

    var accept = function (chosen) {
      if (!chosen) return;
      errorHost.hidden = true;
      handleFile(chosen, drop, errorHost).catch(function () {
        /* already surfaced in the modal */
      });
    };

    file.addEventListener("change", function () {
      accept(file.files && file.files[0]);
    });

    /* The hidden file input is stretched over the whole drop panel, so a
       normal click already opens the picker natively. This handler is only
       the fallback for a click that lands on the panel chrome itself --
       without the guard it would fire a second dialog on top of the first. */
    var fileDragged = false;

    drop.addEventListener("click", function (event) {
      if (fileDragged) return;
      if (event.target === file) return;
      file.click();
    });

    drop.addEventListener("dragover", function (event) {
      event.preventDefault();
      fileDragged = true;
      drop.classList.add("is-dragging");
    });

    drop.addEventListener("dragleave", function () {
      fileDragged = false;
      drop.classList.remove("is-dragging");
    });

    drop.addEventListener("drop", function (event) {
      event.preventDefault();
      fileDragged = false;
      drop.classList.remove("is-dragging");

      var dropped = event.dataTransfer && event.dataTransfer.files;
      accept(dropped && dropped[0]);
    });
  };

  var wireEditMode = function () {
    var bar = buildEditBar();
    document.body.appendChild(bar);
    document.body.classList.add("lurei-edit-mode");

    var host = grid.closest(".container") || grid.parentNode;
    host.insertBefore(buildFab(), grid);
    modal = buildModal();
    wireModal();

    grid.addEventListener("click", onGridClick);

    /* The catalogue re-renders on every change, so the overlays are
       re-applied by watching the grid rather than by re-injecting them at
       each call site. An open inline editor survives the rebuild because
       editingId is remembered here. */
    var decorate = function () {
      var cards = grid.querySelectorAll(".product-card");
      Array.prototype.forEach.call(cards, function (card) {
        var id = card.getAttribute("data-product-id");
        var product = id === null ? null : byId(id);
        if (product) injectTools(card, product);
      });

      if (editingId !== null) {
        var editing = byId(editingId);
        var target = editing
          ? grid.querySelector('.product-card[data-product-id="' + String(editingId) + '"]')
          : null;
        if (editing && target && !target.querySelector("[data-lurei-inline]")) {
          openInline(target, editing);
        }
        if (!editing) editingId = null;
      }
    };

    observer = new MutationObserver(decorate);
    observer.observe(grid, { childList: true, subtree: true });

    /* The catalogue can also move without the grid being rebuilt — most
       importantly when script.js hands over the built-in defaults after the
       overlay has already mounted. Watching the store too means the quick
       actions appear either way; decorate() is idempotent, so running it from
       both sources is safe. */
    unsubscribe = catalogue.subscribe(decorate);

    decorate();

    announce("Storefront edit mode is on. Changes save instantly.");
  };

  /* ---------------- Mount ---------------- */

  /* The admin dashboard links to collections.html?editMode=true, so the
     query string is honoured as well as the stored session flag. The flag is
     then written back so a refresh (and the EXIT & SAVE button) agree. */
  var requestedViaUrl = function () {
    try {
      return new URLSearchParams(window.location.search).get("editMode") === "true";
    } catch (error) {
      return false;
    }
  };

  var mount = function () {
    /* mount() is exposed on the public catalogue object, so guard against a
       second call: wiring twice would append a second bar, FAB and modal and
       leave two observers and two store subscriptions running. */
    if (mounted) return true;

    var viaUrl = requestedViaUrl();

    /* Either route counts: the stored session flag set by the dashboard, or
       the ?editMode=true query string the dashboard button links to. */
    if (!catalogue.isEditModeRequested() && !viaUrl) return false;

    grid = findGrid();
    if (!grid) return false;

    /* canEdit() is the authority check on its own — shouldEdit() would also
       insist on the stored flag and so would reject a first visit that only
       has the query string. Once Supabase is configured a real admin session
       is required, which is what stops ?editMode=true in a visitor's own URL. */
    if (!catalogue.canEdit()) {
      catalogue.exitEditMode();
      leaveEditMode();
      return false;
    }

    catalogue.enterEditMode();

    wireEditMode();
    mounted = true;
    return true;
  };

  catalogue.mount = mount;

  /* The tag sits at the end of <body>, so the DOM is usually already parsed;
     both paths are handled to keep the script position-independent. The
     store half above is deliberately usable without a DOM. */
  if (typeof document === "undefined") return;

  var start = function () {
    try {
      mount();
    } catch (error) {
      console.error("[Storefront Editor] could not start:", error && error.message);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();