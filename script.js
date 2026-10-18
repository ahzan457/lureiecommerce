/* ==========================================================================
   LUREÍ — Fine Jewellery & Accessories | Dubai, UAE
   Direct e-commerce: catalogue rendering + cart drawer + secure checkout
   --------------------------------------------------------------------------
   Architecture:
     Google Sheets        ->  Google Apps Script Web App (doGet, returns JSON)
     script.js            ->  fetch(APPS_SCRIPT_URL)  ->  render product cards

   Catalogue behaviour:
     • The local `products` catalogue renders instantly (mock-first).
     • Both "Top Sellers" and "Collections" sections render the same catalogue.
     • Add to Cart updates the navbar badge and opens the slide-out cart drawer.
     • Proceed to Checkout opens a payment & delivery modal (card / COD).
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. Configuration
   * ------------------------------------------------------------------ */

  /* Deployed Google Apps Script Web App (Deploy > New deployment > Web app,
     Execute as: Me, Who has access: Anyone).
     Keep the trailing /exec - the /dev URL only works while you are editing. */
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbx6vzvoMXqHyK1XYW6aO68P5oP_OBosB_b-RASaM-Ji-RoWcHDssuvnDne-ghLO7jm8/exec";

  /* Shared secret for admin-only Sheet writes (add/update product, update stock,
     change or delete an order). Must match the ADMIN_API_KEY Script Property in
     Code.gs. Leave both blank to run read-only on the fallback catalogue. */
  const ADMIN_API_KEY = "";

  const CONFIG = {
    APPS_SCRIPT_URL,
    ADMIN_API_KEY,
    REQUEST_TIMEOUT_MS: 8000,
    PAGE_SIZE: 4,
    CURRENCY_RATE: 26.08, // 1 AED = 26.08 INR
    CONTACT_EMAIL: "lureiaccessories@gmail.com",
    CONTACT_WHATSAPP: "971525303886",
    CONTACT_PHONE_DISPLAY: "+971 52 530 3886",
    SMS_WEBHOOK_URL: "https://api.brevo.com/v3/sms", // SMS alert API — sends to +971525303886 on inquiries/orders
  };

/* Brevo v3 — welcome emails on newsletter signup (Transactional v3 API key) */
  const BREVO_CONFIG = {
    endpoint: "https://api.brevo.com/v3/smtp/email",
    apiKey: "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",
  };

  /* Formspree — newsletter subscriber delivery straight to
     lureiaccessories@gmail.com. TODO: paste your Formspree form ID
     (e.g. "xyzab", used as https://formspree.io/f/xyzab) to enable it.
     When empty, the handler falls back to the Brevo welcome email. */
  const FORMSPREE_FORM_ID = "";

  /* ------------------------------------------------------------------ *
   * 1b. Google Apps Script backend client
   *
   * Replaces the previous Supabase client with the same surface, so the
   * storefront, the editor and the dashboard call it unchanged. Everything
   * goes to one Web App URL; the action name decides which Sheet tab is hit.
   *
   * Product catalogue + completed orders live in Sheets. The cart, the
   * wishlist and the currency choice stay in LocalStorage on purpose: they
   * are per-device, and a guest cart is not data the boutique should store.
   * ------------------------------------------------------------------ */
  const gasEndpoint = (action, withKey) => {
    const base = String(CONFIG.APPS_SCRIPT_URL || "").trim();
    if (!base) return "";
    const url = new URL(base, window.location.href);
    url.searchParams.set("action", action);
    /* Orders carry names, emails, phones and addresses, so those reads are
       keyed too - a bare GET would publish the customer list to anyone. */
    if (withKey && CONFIG.ADMIN_API_KEY) {
      url.searchParams.set("apiKey", CONFIG.ADMIN_API_KEY);
    }
    return url.toString();
  };

  const gasConfigured = () => !!String(CONFIG.APPS_SCRIPT_URL || "").trim();

  /** Apps Script ignores HTTP status codes, so errors arrive as __status.
      Some deployments answer { error } without a stamp instead — either
      shape is a refusal, never a silent success. */
  const unwrapGas = (payload) => {
    const status = payload && payload.__status;
    if (status && Number(status) >= 400) {
      throw new Error((payload && payload.error) || `Apps Script HTTP ${status}`);
    }
    if (payload && !Array.isArray(payload) && payload.error) {
      throw new Error(String(payload.error));
    }
    return payload;
  };

  const gasRequest = async (action, body, withKey) => {
    /* Zero-glitch sync: every request carries cache:'no-store' plus a
       ?_t=Date.now() buster (appended in gasEndpoint callers and here as a
       fallback), and transient Apps Script failures (script lock, quota HTML
       error pages, 429/5xx) are retried once after 1s instead of surfacing
       as UI errors. Writes stay idempotent by Order ID, so the retry is safe. */
    const isTransientGasError = (err) => {
      const msg = String((err && err.message) || err || "");
      return (
        /lock/i.test(msg) ||
        /timeout|timed out|abort/i.test(msg) ||
        /service (error|unavailable)|transient|try again|temporar/i.test(msg) ||
        /HTTP (429|500|502|503|504)/.test(msg) ||
        /<!DOCTYPE|<html/i.test(msg) ||
        /ScriptError|Exception: /.test(msg)
      );
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const withBuster = (url) => {
      try {
        const u = new URL(url, window.location.href);
        u.searchParams.set("_t", String(Date.now()));
        return u.toString();
      } catch {
        const sep = url.indexOf("?") === -1 ? "?" : "&";
        return url + sep + "_t=" + Date.now();
      }
    };

    const attempt = async () => {
      const endpoint = withBuster(gasEndpoint(action, withKey));
      if (!endpoint) throw new Error("APPS_SCRIPT_URL not configured");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
      try {
        const response = body
          ? await fetch(endpoint, {
              method: "POST",
              cache: "no-store",
              signal: controller.signal,
              /* text/plain keeps this a CORS-simple request: application/json
                 triggers a preflight OPTIONS the Apps Script endpoint never
                 answers, so every admin write fails before it is sent. The
                 script parses postData.contents as JSON regardless of the
                 content type, so nothing server-side changes. */
              headers: { "Content-Type": "text/plain", Accept: "application/json" },
              body: JSON.stringify(Object.assign({ apiKey: CONFIG.ADMIN_API_KEY }, body)),
            })
          : await fetch(endpoint, {
              method: "GET",
              cache: "no-store",
              signal: controller.signal,
              headers: { Accept: "application/json" },
            });

        if (!response.ok) {
          throw new Error(`Google Apps Script responded with HTTP ${response.status}`);
        }
        const text = await response.text();
        /* Apps Script quota/lock failures arrive as an HTML error page with
           HTTP 200 — detect the markup and treat it as transient so the
           retry below fires instead of JSON.parse throwing a confusing error. */
        if (/^\s*</.test(text) && /<!DOCTYPE|<html/i.test(text)) {
          throw new Error("Apps Script returned a transient HTML error page; retrying");
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("Apps Script returned non-JSON; retrying");
        }
        return unwrapGas(parsed);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await attempt();
    } catch (firstError) {
      if (!isTransientGasError(firstError)) throw firstError;
      await sleep(1000);
      return await attempt();
    }
  };

  const ADMIN_SESSION_KEY = "adminLoggedIn";
  const SESSION_DETAIL_KEY = "lurei_gas_admin_session";

  const gasBackend = {
    isConfigured: () => gasConfigured(),

    /* A shared-key backend has no server session, so the flag admin-login.html
       writes is the authority for "is this an admin" - the same shape the
       Supabase session check had. Both admin pages hardcode "adminLoggedIn",
       so that stays the single source of truth and must hold the literal
       string "true" (the dashboard guard compares with ===). */
    getSession: () => {
      if (!gasConfigured()) return null;
      try {
        const flag = sessionStorage.getItem(ADMIN_SESSION_KEY);
        if (flag !== "true") return null;
        try {
          return JSON.parse(sessionStorage.getItem(SESSION_DETAIL_KEY) || "null") || { role: "admin" };
        } catch {
          return { role: "admin" };
        }
      } catch {
        return null;
      }
    },
    clearSession: () => {
      try {
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        sessionStorage.removeItem(SESSION_DETAIL_KEY);
      } catch {}
    },

    /* Verifies the operator against the ADMIN_EMAIL / ADMIN_PASSWORD Script
       Properties in Code.gs. On success it raises the same "adminLoggedIn"
       flag the dashboard already guards on. */
    signIn: async (email, password) => {
      const data = await gasRequest("signIn", { email, password }, true);
      try {
        sessionStorage.setItem(ADMIN_SESSION_KEY, "true");
        sessionStorage.setItem(SESSION_DETAIL_KEY, JSON.stringify(data || { role: "admin" }));
      } catch {}
      return data;
    },

    /* Shopper checkout — public by design, so this sends no api key.
       Tries a confirmed CORS-simple POST first (text/plain + no-store +
       ?_t buster, no preflight), so the Sheet append can be verified. If the
       browser still blocks it, falls back to the fire-and-forget no-cors
       send: the response is opaque then, so delivery can't be confirmed and
       the body is never parsed. Either way the order is already safe in
       localStorage (which wakes the dashboard via its storage listener) and
       the dashboard's focus/visibility re-sync picks up the Sheet row. */
    insertOrder: async (order) => {
      if (!gasConfigured()) {
        return { skipped: true, reason: "not-configured" };
      }
      const record = order && typeof order === "object" ? order : {};
      const itemsArray = Array.isArray(record.items) ? record.items : [];
      let itemsText = "";
      try {
        itemsText = JSON.stringify(itemsArray);
      } catch {
        itemsText = "";
      }
      /* Canonical nested record plus flat aliases beside it. Insert variants
         read top-level keys under different spellings ("Total Amount" vs
         totalAmount vs total, "Delivery Address" vs deliveryAddress, ...),
         and every reader ignores keys it doesn't know — so the superset can
         only add matches, never break the established action+order contract.
         IDs stay timestamp-based (a 5-digit random has a 90k space and
         collides fast); dates stay ISO (locale strings don't parse
         reliably); status stays lowercase like every other reader. */
      const payload = {
        action: "insertOrder",
        order: record,
        orderId: record.orderId,
        "Order ID": record.orderId,
        customerName: record.customerName,
        "Customer Name": record.customerName,
        customer: record.customerName,
        email: record.email,
        "Email": record.email,
        phone: record.phone,
        "Phone": record.phone,
        items: itemsArray,
        "Items Purchased": itemsText,
        Items: itemsText,
        totalAED: record.totalAED,
        total: record.totalAED,
        "Total Amount": record.totalAED,
        totalAmount: record.totalAED,
        address: record.address,
        "Delivery Address": record.address,
        deliveryAddress: record.address,
        status: record.status,
        "Status": record.status,
        date: record.date || record.createdAt,
        createdAt: record.createdAt,
        "Date": record.date || record.createdAt,
        payment: record.payment,
        paymentMethod: record.paymentMethod,
      };
      const bust = (url) => {
        try {
          const u = new URL(url, window.location.href);
          u.searchParams.set("_t", String(Date.now()));
          return u.toString();
        } catch {
          const sep = url.indexOf("?") === -1 ? "?" : "&";
          return url + sep + "_t=" + Date.now();
        }
      };
      /* Confirmed path first: CORS-simple (text/plain, no preflight). */
      try {
        const confirmed = await gasRequest("insertOrder", payload);
        return { ok: true, confirmed: true, response: confirmed };
      } catch (confirmedError) {
        /* Fall back to opaque fire-and-forget so the order still reaches the
           Sheet when the confirmed read is blocked; only a network failure
           rejects from here. */
        await fetch(bust(gasEndpoint("insertOrder")), {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(payload),
        });
        return { ok: true, unconfirmed: true };
      }
    },

    /** Public: this is the catalogue the storefront renders from. */
    fetchProducts: async () => {
      if (!gasConfigured()) throw new Error("APPS_SCRIPT_URL not configured");
      const data = unwrapGas(await gasRequest("products"));
      return Array.isArray(data.products) ? data.products : [];
    },

    /* Public read by design: the order list is fetched with no ADMIN_API_KEY
       requirement — a missing or empty key must never block this GET. The
       key is only ever attached to admin writes (status, delete, archive).
       Zero-glitch read: cache:'no-store' + ?_t=Date.now() buster, an
       AbortController timeout, and one automatic 1s retry on transient
       lock/HTML/5xx failures. */
    fetchOrders: async () => {
      if (!gasConfigured()) return [];
      const bust = (url) => {
        try {
          const u = new URL(url, window.location.href);
          u.searchParams.set("_t", String(Date.now()));
          return u.toString();
        } catch {
          const sep = url.indexOf("?") === -1 ? "?" : "&";
          return url + sep + "_t=" + Date.now();
        }
      };
      const attempt = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(bust(gasEndpoint("orders")), {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (!response.ok) {
            throw new Error(`Google Apps Script responded with HTTP ${response.status}`);
          }
          const text = await response.text();
          if (/^\s*</.test(text) && /<!DOCTYPE|<html/i.test(text)) {
            throw new Error("Apps Script returned a transient HTML error page; retrying");
          }
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error("Apps Script returned non-JSON; retrying");
          }
          const unwrapped = unwrapGas(data);
          /* The deployed Web App returns the order list as a bare JSON array of
             sheet rows; local envelope builds answer { orders: [...] }. Accept
             both, and surface an error payload instead of a silent blank table. */
          if (Array.isArray(unwrapped)) return unwrapped;
          if (unwrapped && unwrapped.error) throw new Error(String(unwrapped.error));
          return Array.isArray(unwrapped.orders) ? unwrapped.orders : [];
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        return await attempt();
      } catch (firstError) {
        const msg = String((firstError && firstError.message) || firstError || "");
        const transient =
          /lock|timeout|abort|transient|try again|temporar|non-JSON|HTML error/i.test(msg) ||
          /HTTP (429|500|502|503|504)/.test(msg);
        if (!transient) throw firstError;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return await attempt();
      }
    },

    /* The dashboard's isDelivered() treats "delivered" and "completed" as the
       same state, so the filter has to as well. */
    fetchCompletedOrders: async () => {
      const orders = await gasBackend.fetchOrders();
      return orders.filter((o) => {
        const status = String(o.status || "").toLowerCase();
        return status === "completed" || status === "delivered";
      });
    },

    updateOrder: (orderId, status) => gasRequest("updateOrderStatus", { orderId, status }),

    /* Canonical status writer the admin dashboard calls. Accepts either
       casing ("Delivered"/"delivered") and always persists Title Case, which
       is what the Sheet's Status column and the dashboard toast display. */
    updateOrderStatus: (orderId, status) => {
      const next = String(status || "").toLowerCase() === "delivered" ? "Delivered" : "Pending";
      return gasRequest("updateOrderStatus", { orderId, status: next });
    },

    getAppsScriptUrl: () => String(CONFIG.APPS_SCRIPT_URL || "").trim(),

    /* Called with the whole order record, not an id — the dashboard assembles
       it from the row. Filing means an upsert onto the completed log keyed by
       order_id, so filing the same sale twice updates the one entry. */
    archiveOrder: (record) => {
      const order = record && typeof record === "object" ? record : { orderId: String(record) };
      return gasRequest("archiveOrder", { order });
    },

    /* Delete is idempotent by Order ID: the id is trimmed before send, the
       request rides gasRequest (no-store + ?_t buster, auto-retry up to 2
       attempts on transient lock/HTML/5xx errors), and a "No order with id"
       reply means the row is already gone — treated as success so the
       dashboard never reports "refused" for a delete that already happened
       (double-click, retried request, or row filed then deleted). */
    deleteOrder: async (orderId) => {
      const id = String(orderId === undefined || orderId === null ? "" : orderId).trim();
      if (!id) throw new Error("deleteOrder needs an orderId.");
      try {
        return await gasRequest("deleteOrder", { orderId: id });
      } catch (error) {
        if (/No order with id/i.test(String((error && error.message) || error || ""))) {
          return { ok: true, alreadyGone: true, deletedId: id };
        }
        throw error;
      }
    },
    deleteCompletedOrder: async (orderId) => {
      const id = String(orderId === undefined || orderId === null ? "" : orderId).trim();
      if (!id) throw new Error("deleteOrder needs an orderId.");
      try {
        return await gasRequest("deleteOrder", { orderId: id });
      } catch (error) {
        if (/No order with id/i.test(String((error && error.message) || error || ""))) {
          return { ok: true, alreadyGone: true, deletedId: id };
        }
        throw error;
      }
    },

    /* Req. delivery-date writer the dashboard's date chip calls. Was missing
       entirely (dashboard called backend.updateOrderDeliveryDate and always
       threw TypeError in backend mode); now persists via the updateDeliveryDate
       action in Code.gs, which creates the column on legacy sheets. Retries
       ride on gasRequest's transient handling. */
    updateOrderDeliveryDate: (orderId, date) => gasRequest("updateDeliveryDate", { orderId, date }),
    updateDeliveryDate: (orderId, date) => gasRequest("updateDeliveryDate", { orderId, date }),

    /* Payment-status writer for the dashboard's interactive PAYMENT pill.
       Sends the canonical paymentStatus key (Code.gs also accepts `status`);
       kept distinct from updateOrderStatus so payment and fulfilment never
       overwrite each other. */
    updateOrderPaymentStatus: (orderId, paymentStatus) =>
      gasRequest("updateOrderPaymentStatus", { orderId, paymentStatus }),
    updateOrderPayment: (orderId, paymentStatus) =>
      gasRequest("updateOrderPaymentStatus", { orderId, paymentStatus }),

    addProduct: (product) => gasRequest("addProduct", { product }),
    updateProduct: (product) => gasRequest("updateProduct", { product }),
    updateStock: (id, stock) => gasRequest("updateStock", { id, stock }),
  };

  /* Assigned before the catalogue store below, which captures this reference
     at load time (see the mayEdit() gate). */
  window.LureiBackend = gasBackend;

  /* ------------------------------------------------------------------ *
   * 1b-ii. Order delivery-status toggle helper (admin dashboard)
   *
   * Shared logic behind the PENDING / DELIVERED badge button:
   *  - nextStatusFor(): toggles "Pending" <-> "Delivered" (Title Case, which
   *    is what the Sheet's Status column stores).
   *  - applyStatusBadge(): repaints a .status-badge element immediately —
   *    Delivered gets the luxury green (#15803d bg, #ffffff text), Pending
   *    keeps the gold badge — with the smooth CSS transition from style.css.
   *  - syncOrderStatus(): POSTs { action: 'updateOrderStatus', orderId,
   *    status } to APPS_SCRIPT_URL so Google Sheets persists the change.
   * ------------------------------------------------------------------ */
  window.LureiOrderStatus = (() => {
    const endpoint = () => String(CONFIG.APPS_SCRIPT_URL || "").trim();

    const normalize = (status) =>
      String(status || "").trim().toLowerCase() === "delivered" ? "Delivered" : "Pending";

    const isDeliveredStatus = (status) => normalize(status) === "Delivered";

    const nextStatusFor = (current) => (isDeliveredStatus(current) ? "Pending" : "Delivered");

    const applyStatusBadge = (element, status) => {
      if (!element) return normalize(status);
      const next = normalize(status);
      const delivered = next === "Delivered";
      element.classList.toggle("delivered", delivered);
      element.classList.toggle("is-delivered", delivered);
      element.classList.toggle("pending", !delivered);
      if (element.hasAttribute("aria-pressed")) {
        element.setAttribute("aria-pressed", String(delivered));
      }
      element.innerHTML = delivered ? "Delivered &#10003;" : "Pending";
      return next;
    };

    const syncOrderStatus = (orderId, status) => {
      const next = normalize(status);
      const payload = { action: "updateOrderStatus", orderId, status: next };
      if (gasBackend && typeof gasBackend.updateOrderStatus === "function") {
        return gasBackend.updateOrderStatus(orderId, next);
      }
      const url = endpoint();
      if (!url) return Promise.reject(new Error("APPS_SCRIPT_URL not configured"));
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Accept: "application/json" },
        body: JSON.stringify(payload),
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`Google Apps Script responded with HTTP ${response.status}`);
        }
        return response.json().catch(() => ({}));
      });
    };

    return {
      endpoint: endpoint(),
      normalize,
      isDeliveredStatus,
      nextStatusFor,
      applyStatusBadge,
      syncOrderStatus,
    };
  })();

  /* ------------------------------------------------------------------ *
   * 1c. Live storefront editor + master catalogue store
   * ------------------------------------------------------------------ *
   * Formerly a standalone admin-editor.js, merged here so the project ships a single
   * script. It must stay ABOVE the boot sequence below: the boot reads
   * window.LureiCatalogue synchronously, and this block is what defines it.
   *
   * Exposes window.LureiCatalogue - the shared product list the storefront
   * renders from, plus the edit-mode overlay. Precedence, lowest to highest:
   *   built-in defaults -> Google Sheets (Code.gs) -> this store
   * so an admin edit is never overwritten by a catalogue refresh, and a
   * deleted product stays deleted across reloads via the `removed` list.
   * ------------------------------------------------------------------ */
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

  /* Explicitly created custom categories: UPPERCASE keys the owner typed in
     the Add Product modal combo (e.g. "DRESSES"), persisted so their tabs
     return on reload. Tabs are rendered from this registry only — product
     data is never scanned, so type variants (necklace/ring/watch) can never
     spawn duplicate buttons. */
  var CREATED_CATEGORIES_KEY = "lurei_created_categories";

  var readCreatedCategories = function () {
    try {
      var parsed = JSON.parse(localStorage.getItem(CREATED_CATEGORIES_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (key) {
        return typeof key === "string" && key.trim() !== "";
      });
    } catch (error) {
      return [];
    }
  };

  var persistCreatedCategory = function (key) {
    try {
      var stored = readCreatedCategories();
      if (stored.indexOf(key) === -1) {
        stored.push(key);
        localStorage.setItem(CREATED_CATEGORIES_KEY, JSON.stringify(stored));
      }
    } catch (error) {}
  };

  /* Fixed-tab lookup: exact values plus singular/plural variants, so typing
     "Ring" or "WATCHES" lands on the existing tab instead of a duplicate. */
  var STATIC_CATEGORY_VALUES = ["earrings", "rings", "necklaces", "bracelets", "watches"];
  var STATIC_CATEGORY_ALIASES = {
    earring: "earrings",
    necklace: "necklaces",
    ring: "rings",
    bracelet: "bracelets",
    bangle: "bracelets",
    bangles: "bracelets",
    watch: "watches",
  };

  /* Resolves combo text to a stored type value. Fixed (incl. variants) ->
     the fixed slug, never new. Anything else -> UPPERCASE key, registered on
     first use. Returns { value, isNew }. */
  var resolveCategoryValue = function (text) {
    var raw = String(text || "").trim();
    if (!raw) return { value: "", isNew: false };
    var lower = raw.toLowerCase();
    if (STATIC_CATEGORY_VALUES.indexOf(lower) !== -1) return { value: lower, isNew: false };
    if (STATIC_CATEGORY_ALIASES[lower]) return { value: STATIC_CATEGORY_ALIASES[lower], isNew: false };
    var key = raw.toUpperCase();
    var existed = readCreatedCategories().indexOf(key) !== -1;
    if (!existed) persistCreatedCategory(key);
    return { value: key, isNew: !existed };
  };

  /* Suggestion list for the modal combo: fixed labels plus created customs.
     live in the edit-mode scope below, which owns its own escapeHTML. */
  var categorySuggestionLabels = function () {
    var labels = CATEGORIES.map(function (option) {
      return option.label;
    });
    readCreatedCategories().forEach(function (key) {
      labels.push(key);
    });
    return labels;
  };

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
     shelf yet. A 0 is a real count that means "ample stock available" — it is
     deliberately NOT a sold-out signal, so nothing below may infer the flag
     from it. The parse is strict so toNumber()-style stripping cannot turn
     "n/a" or "three" into a count at all. */
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

  /* Product photos live in exactly one folder. A second folder used to hold part
   * of the catalogue, so an admin editing the catalogue could point a card at a
   * sibling path that does not ship alongside the page. */
  var CANONICAL_IMAGE_FOLDER = "assets/products/";
  var REMOTE_IMAGE = /^(https?:|data:|\/\/)/i;

  var sanitizeImage = function (value) {
    if (typeof value !== "string") return "";
    var trimmed = value.trim();
    if (!trimmed) return "";
    if (REMOTE_IMAGE.test(trimmed)) return trimmed;
    if (trimmed.replace(/^\.\//, "").indexOf(DEAD_IMAGE_FOLDER) === 0) return "";

    /* Normalises any in-tree path onto assets/products/ so both the built-in
     * dataset and admin edits resolve the same way. */
    var relative = trimmed.replace(/^\.\//, "");
    if (relative.indexOf("assets/") === 0) {
      var leaf = relative.split("/").pop();
      if (leaf) return CANONICAL_IMAGE_FOLDER + leaf;
    }
    return trimmed;
  };

  /* A product may carry several photos now. Each is normalised through the same
     rules as the single image (remote/base64 kept, dead folder dropped), and
     duplicates are collapsed so a re-upload cannot inflate the gallery. */
  var sanitizeImages = function (value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    value.forEach(function (item) {
      var src = sanitizeImage(item);
      if (src && out.indexOf(src) === -1) out.push(src);
    });
    return out;
  };

  var sanitize = function (raw) {
    var product = {};
    product.id = raw.id !== undefined && raw.id !== null ? raw.id : null;
    product.title = String(raw.title || raw.name || "").trim();
    product.price = toNumber(raw.price);
    product.category = String(raw.category || "").trim() || priceBucketFor(raw.price);
    product.type = String(raw.type || "").trim() || "earrings";
    product.image = sanitizeImage(raw.image);
    product.images = sanitizeImages(raw.images);
    product.description = String(raw.description || raw.desc || "").trim();
    product.badge = raw.badge ? String(raw.badge).trim() : "";
    product.stock = stockFor(raw.stock);
    /* The count and the flag are now independent. A count of 0 means "ample /
       untallied" and must never be laundered into a sold-out state here, so
       only the stored boolean decides that. */
    product.outOfStock = raw.outOfStock === true;
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
      /* An empty gallery must not blank a built-in one; only a non-empty
         array counts as a real override. */
      if (Array.isArray(value) && value.length === 0) return;
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
        images: input.images,
        description: input.description,
        badge: input.badge,
        stock: stockFor(input.stock),
        outOfStock: input.outOfStock === true,
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

    /* Writes the count only. The sold-out flag is never inferred from the number —
       a 0 means ample stock, so the flag is owned solely by the admin's
       explicit OUT OF STOCK toggle via setOutOfStock(). Callers that are that
       toggle pass the third argument to land the count and the flag in a single
       write, so a storefront tab can never see a stale count beside a stale
       badge. */
    setStock: function (id, stock, outOfStock) {
      var patch = { stock: stockFor(stock) };
      if (typeof outOfStock === "boolean") patch.outOfStock = outOfStock;
      return store.update(id, patch);
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
    resolveCategoryValue: resolveCategoryValue,
    createdCategories: readCreatedCategories,
    categorySuggestionLabels: categorySuggestionLabels,
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
  /* Every photo the admin has staged for the product being added. The first
     entry is the card's primary image; the whole list ships as the product's
     gallery. */
  var pendingImages = [];
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

  /* EXIT & SAVE from the dashboard-launched editor: every SAVE already
     persisted to localStorage + backend (store.commit), so exiting only
     clears the edit-session flag and returns the owner straight to the Admin
     Dashboard - never a storefront reload. The admin preview flag is left
     intact so the dashboard guard still admits the navigation, and the target
     carries no editMode parameter so the browser can never restore a cached
     edit view. leaveEditMode above stays for the unauthorized-mount path,
     which must remain here. */
  var exitToDashboard = function () {
    catalogue.exitEditMode();
    window.location.href = "admin-dashboard.html";
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

    bar.querySelector(".lurei-edit-bar__exit").addEventListener("click", exitToDashboard);
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
    /* Read-only mirror of the storefront pill, and it mirrors it exactly: a
       positive count becomes "STOCK n LEFT", the admin's sold-out flag becomes
       "OUT OF STOCK", and a 0 or absent count produces no chip at all — the
       storefront shows nothing for those, so the editor must not invent a
       label the shopper never sees. */
    var count =
      typeof product.stock === "number" && product.stock > 0 ? product.stock + " LEFT" : "";
    var stockChip =
      soldOut || count
        ? '<span class="lurei-card-stock' + (soldOut ? " is-warn" : "") + '">' +
          (soldOut ? "OUT OF STOCK" : "STOCK " + count) +
        "</span>"
        : "";

    return (
      '<div class="lurei-card-tools" data-lurei-tools>' +
        stockChip +
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
        typeof product.stock === "number" && product.stock > 0
          ? product.stock + " LEFT"
          : "";
      /* Dropped rather than blanked: the chip carries a background, padding and
         a gold rule, so an empty span would leave a stray box on the card. The
         tools block is rebuilt wholesale on the next catalogue render, so the
         chip returns on its own once a count comes back. */
      if (!soldOut && !count) {
        stockLabel.remove();
      } else {
        var label = soldOut ? "OUT OF STOCK" : "STOCK " + count;
        if (stockLabel.textContent !== label) stockLabel.textContent = label;
        stockLabel.classList.toggle("is-warn", soldOut);
      }
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
        '<span class="lurei-field__hint">0 = Unlimited / Available Stock. Use OUT OF STOCK button to toggle availability.</span>' +
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

    /* Bound to the SAVE click and to Enter, so it takes the event defensively: the
       button is type="button" today, but if this markup ever sits inside a form
       the default submit would navigate the page out from under the save. */
    var save = function (event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();

      var title = wrap.querySelector("[data-lurei-name]").value.trim();
      var price = Number(wrap.querySelector("[data-lurei-price]").value);
      var type = wrap.querySelector("[data-lurei-type]").value;
      var description = wrap.querySelector("[data-lurei-desc]").value.trim();
      var stockRaw = wrap.querySelector("[data-lurei-stock]").value.trim();

      /* 0 is a valid count and simply means ample stock — it does not take the
         piece off sale, so only a negative or unparseable entry is rejected,
         and an empty box keeps whatever the shelf already said. */
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

/* One write closes the loop: store.update() persists to localStorage and
         notifies subscribers synchronously, and the storefront subscriber
         rebuilds the product grid from that same call - so the card behind this
         form is already showing the new values by the time the line returns.

         editingId is therefore cleared BEFORE the write, not after.
         store.update() runs decorate() as its first subscriber, and that pass
         re-opens the inline form for whichever id is still set - so leaving it
         populated until after the write made SAVE reopen the form it was trying
         to close, which is what made the first click look like it had done
         nothing and needed a second one. Restored on failure so a rejected
         save stays retryable with the values still in the fields. */
      try {
          /* outOfStock is deliberately absent from this patch: saving a count
             must never move the sold-out flag, so the OUT OF STOCK toggle stays
             the only thing that controls it. */
          editingId = null;
          store.update(product.id, {
            title: title,
            price: price,
            category: catalogue.priceBucketFor(price),
            type: type,
            description: description,
            stock: stock,
          });
          /* Idempotent whether or not the grid rebuild already detached this
             form: remove() on an orphaned node is a no-op. */
          closeInline();
          announce('"' + title + '" updated.');
        } catch (error) {
          editingId = product.id;
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
        save(event);
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

  /* Datalist suggestions for the category combo (fixed + created customs),
     HTML-escaped with this scope's own escapeHTML. */
  var categoryDatalistHTML = function () {
    return catalogue.categorySuggestionLabels().map(function (label) {
      return '<option value="' + escapeHTML(label) + '"></option>';
    }).join("");
  };

  var refreshCategoryDatalist = function () {
    if (!modal) return;
    var list = modal.querySelector("#lurei-category-list");
    if (list) list.innerHTML = categoryDatalistHTML();
  };

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
            '<div class="lurei-upload lurei-upload--multi" data-lurei-drop>' +
              '<input class="lurei-upload__input" type="file" accept="image/*" multiple data-lurei-file aria-label="Upload product images" />' +
              '<div class="lurei-upload__grid" data-lurei-preview></div>' +
              '<div class="lurei-upload__meta">' +
                '<span class="lurei-upload__label">Product images</span>' +
                '<span class="lurei-upload__hint" data-lurei-filename>Tap + to upload photos</span>' +
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
                '<span class="lurei-field__hint">0 = Unlimited / Available Stock. Use OUT OF STOCK button to toggle availability.</span>' +
              "</label>" +
              '<label class="lurei-field">' +
                '<span class="lurei-field__label">Category</span>' +
                '<input class="lurei-field__input" type="text" data-lurei-type-input list="lurei-category-list" maxlength="40" placeholder="Select or type a category (e.g. Dresses)" autocomplete="off" />' +
                '<datalist id="lurei-category-list">' +
                  categoryDatalistHTML() +
                "</datalist>" +
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
    pendingImages = [];
    refreshCategoryDatalist();
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
    pendingImages = [];
    renderPreview();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };

  var renderPreview = function () {
    if (!modal) return;
    var preview = modal.querySelector("[data-lurei-preview]");
    var filename = modal.querySelector("[data-lurei-filename]");
    var drop = modal.querySelector("[data-lurei-drop]");
    if (!preview || !filename) return;

    preview.replaceChildren();

    pendingImages.forEach(function (src, index) {
      var cell = document.createElement("div");
      cell.className = "lurei-upload__thumb";
      cell.setAttribute("data-lurei-thumb", String(index));

      var img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.decoding = "async";
      cell.appendChild(img);

      if (index === 0) {
        var tag = document.createElement("span");
        tag.className = "lurei-upload__main";
        tag.textContent = "Main";
        cell.appendChild(tag);
      }

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "lurei-upload__remove";
      remove.setAttribute("data-lurei-remove", String(index));
      remove.setAttribute("aria-label", "Remove photo " + (index + 1));
      remove.innerHTML = "&times;";
      cell.appendChild(remove);

      preview.appendChild(cell);
    });

    /* The + tile stays last and is always present, so the panel can accept a
       first upload and every additional one from the same affordance. */
    var add = document.createElement("button");
    add.type = "button";
    add.className = "lurei-upload__add";
    add.setAttribute("data-lurei-add", "");
    add.setAttribute("aria-label", "Add another photo");
    add.innerHTML = '<span aria-hidden="true">+</span>';
    preview.appendChild(add);

    if (drop) drop.classList.toggle("is-ready", pendingImages.length > 0);

    filename.textContent = pendingImages.length
      ? pendingImages.length + (pendingImages.length === 1 ? " photo ready" : " photos ready")
      : "Tap + to upload photos";
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

  /* Reads one or many chosen/dropped files and appends each usable photo to
     the staged gallery. Non-image entries are ignored rather than aborting the
     whole batch, so a mixed drop still lands its photos. */
  var handleFiles = function (fileList, previewHost, errorHost) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
      return file && /^image\//.test(file.type);
    });

    if (!files.length) {
      var error = new Error("Please choose an image file (JPG, PNG or WebP).");
      if (errorHost) {
        errorHost.textContent = error.message;
        errorHost.hidden = false;
      }
      return Promise.reject(error);
    }

    return Promise.all(files.map(function (file) {
      return readImageAsDataURL(file);
    })).then(function (dataURLs) {
      dataURLs.forEach(function (dataURL) {
        if (dataURL && pendingImages.indexOf(dataURL) === -1) pendingImages.push(dataURL);
      });
      renderPreview();
      if (previewHost) previewHost.classList.add("is-ready");
      return dataURLs;
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

    /* This button is the only thing that may set or clear the sold-out flag. The
       count still moves with it so a restock brings the previous number back
       rather than an arbitrary one, but the 0 written below is just a count —
       the flag rides alongside it explicitly. */
    if (product.outOfStock === true) {
      if (!window.confirm('Bring "' + product.title + '" back into stock?')) return;
      var restore = typeof product.stock === "number" && product.stock > 0
        ? product.stock
        : lastKnownStock[product.id] || DEFAULT_RESTOCK;
      try {
        store.setStock(product.id, restore, false);
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
      store.setStock(product.id, 0, true);
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
    /* Combo text resolved via the catalogue API to a stored value: fixed
       slug for known names, UPPERCASE key for new customs (registered on
       first use). */
    var resolved = catalogue.resolveCategoryValue(modal.querySelector("[data-lurei-type-input]").value);
    var type = resolved.value;
    var description = modal.querySelector("[data-lurei-desc]").value.trim();
    /* An empty box means "nobody counted", which is kept as null rather than 0
       so a new piece is never born sold out. */
    var stockRaw = modal.querySelector("[data-lurei-stock]").value.trim();

    if (!type) {
      errorHost.textContent = "Please choose or type a category (e.g. Dresses).";
      errorHost.hidden = false;
      return;
    }

    try {
      var created = store.add({
        title: title,
        price: price,
        category: catalogue.priceBucketFor(price),
        type: type,
        description: description,
        image: pendingImages[0] || "",
        images: pendingImages.slice(),
        stock: stockRaw === "" ? null : Number(stockRaw),
      });

      /* New customs append their nav tab only after the product saved: a
         window event bridges the edit-mode scope to the storefront scope. */
      if (resolved.isNew) {
        try {
          window.dispatchEvent(
            new CustomEvent("lurei:category-created", { detail: { key: resolved.value } })
          );
        } catch (tabError) {}
      }

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
    var preview = modal.querySelector("[data-lurei-preview]");
    var errorHost = modal.querySelector("[data-lurei-error]");

    var accept = function (chosen) {
      if (!chosen || !chosen.length) return;
      errorHost.hidden = true;
      handleFiles(chosen, drop, errorHost).catch(function () {
        /* already surfaced in the modal */
      });
    };

    file.addEventListener("change", function () {
      accept(file.files);
      /* Reset so re-selecting the same file still fires change next time. */
      file.value = "";
    });

    /* The + tile opens the picker for extra photos; the x on a tile drops just
       that one. Both stop the click here so the panel-wide handler below does
       not open the picker as well. */
    preview.addEventListener("click", function (event) {
      var remove = event.target.closest("[data-lurei-remove]");
      if (remove) {
        event.preventDefault();
        event.stopPropagation();
        var index = Number(remove.getAttribute("data-lurei-remove"));
        if (index >= 0 && index < pendingImages.length) pendingImages.splice(index, 1);
        renderPreview();
        return;
      }

      if (event.target.closest("[data-lurei-add]")) {
        event.stopPropagation();
        file.click();
      }
    });

    /* Clicking the panel chrome (not the thumbnail grid, which owns its own
       + / x buttons) opens the picker. The file input is visually hidden, so
       this is what makes a first, empty upload possible. */
    var fileDragged = false;

    drop.addEventListener("click", function (event) {
      if (fileDragged) return;
      if (event.target === file) return;
      if (event.target.closest("[data-lurei-preview]")) return;
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
      accept(dropped);
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
      if (new URLSearchParams(window.location.search).get("editMode") === "true") return true;
    } catch (error) {
      /* fall through to the raw-string check below */
    }
    /* Explicit string check as well: an embedded/in-app browser can hand back
       a search string URLSearchParams does not parse the way we expect, and an
       owner must never be dropped into a storefront without their controls. */
    return String(window.location.search || "").indexOf("editMode=true") !== -1;
  };

  /* The homepage is a pure storefront preview and never hosts the editor.
     It owns one of the GRID_IDS (products-container, the Top Selling
     carousel), so without this gate an admin who had the edit flag set would
     get the black edit bar, the ADD NEW PRODUCT fab and inline card tools
     overlaid on the live homepage.

     This is a page-identity check rather than CSS: skipping mount() means no
     bar element, no fab, no modal and no body.lurei-edit-mode class are ever
     created, so there is nothing to hide and no listener left attached.
     Editing happens on collections.html, launched from the dashboard. */
  var isStorefrontPreviewPage = function () {
    var path = String(window.location.pathname || "");
    return /(?:^|\/)index\.html?$/i.test(path);
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

    /* Storefront preview page: clear any stale flag and mount nothing, so
       the homepage stays byte-for-byte what a customer sees. Clearing the
       flag here also means ?editMode=true typed onto the homepage does not
       leak into the next page the admin opens. */
    if (isStorefrontPreviewPage()) {
      catalogue.exitEditMode();
      return false;
    }

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

  /* Exposed because the account/auth block further down the file runs in a
     separate closure and also needs to know it is on the storefront. */
  catalogue.isStorefrontPreviewPage = isStorefrontPreviewPage;

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

  /* The dashboard hand-off lands here on collections.html?editMode=true. That
     URL is an explicit instruction to render the editor, so it is checked
     directly (not only through the stored flag) and mount() is attempted on
     DOMContentLoaded as well, so the controls appear even if the grid parsed
     after this closure first ran. mount() is idempotent, so calling it from
     both paths is harmless. */
  var startFromEditUrl = function () {
    if (String(window.location.search || "").indexOf("editMode=true") === -1) return;
    start();
  };

  /* Back/forward cache: a restored page keeps the DOM and JS state from the
     earlier visit, so a storefront snapshot cached from a clean customer view
     can come back with the URL still reading ?editMode=true but no bar, FAB or
     card tools. Re-running start() is idempotent - if the editor is already
     mounted it is a no-op, otherwise mount() re-injects every control so the
     editor never reappears half-rendered. */
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("pageshow", startFromEditUrl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      startFromEditUrl();
      start();
    });
  } else {
    startFromEditUrl();
    start();
  }
})();


  /* SMS alert to the boutique — Brevo v3 SMS (same API key as email). No-op when
     no endpoint is configured. Silently resolves on failure (best-effort alert). */
  const sendSmsAlert = (content) => {
    try {
      const endpoint = CONFIG.SMS_WEBHOOK_URL.trim();
      if (!endpoint) return Promise.resolve();
      return fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "api-key": BREVO_CONFIG.apiKey,
        },
        body: JSON.stringify({
        
          type: "transactional",
          unicodeEnabled: true,
          sender: "LUREI",
          recipient: `+${CONFIG.CONTACT_WHATSAPP}`,
          content,
          tag: "lurei-alert",
        }),
      }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };

  /* ------------------------------------------------------------------ *
   * 2. Fallback product catalogue (local asset mirror)
   * ------------------------------------------------------------------ *
   * Images live in exactly two folders: ./assets/products/ (main
   * catalogue) and ./assets/products/ (later arrivals). There is NO
   * assets/images/products/ directory - an earlier build rewrote paths
   * into one, so every card 404'd and fell back to its placeholder.
   * Each entry below points at a file that exists, with its real casing,
   * because static hosts are case-sensitive.
   * ------------------------------------------------------------------ */
 const products = [
    { id: 1, name: "Aura Golden Stud", price: "AED 25.00", category: "under-30", type: "earrings", image: "./assets/products/aura-golden-stud.jpg", desc: "Textured gold aura stud earrings." },
    { id: 2, name: "Cartier Inspired Bracelet", price: "AED 30.00", category: "under-30", type: "bracelets", image: "./assets/products/cartier-inspired-bracelet.jpg", desc: "Luxury textured gold band bracelet." },
    { id: 3, name: "Crystal Ash Hoops", price: "AED 20.00", category: "under-30", type: "earrings", image: "./assets/products/crystal-ash-hoops.jpg", desc: "Sparkling crystal ash luxury hoops." },
    { id: 4, name: "The Crystal Chain", price: "AED 30.00", category: "under-30", type: "necklace", image: "./assets/products/crystal-chain.jpg", desc: "Minimal sparkling crystal accent silver chain." },
    { id: 5, name: "Crystal Cherry Hoops", price: "AED 20.00", category: "under-30", type: "earrings", image: "./assets/products/crystal-cherry-hoops.jpg", desc: "Vibrant cherry red crystal drop hoop earrings." },
    { id: 6, name: "Golden Nova Mini Hoops", price: "AED 15.00", originalPrice: "AED 20.00", category: "under-30", type: "earrings", image: "./assets/products/golden-nova-mini-hoops.jpg", desc: "Mini golden starburst huggie hoops." },
    { id: 7, name: "Golden Bamboo Drops", price: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/golden-bamboo-drops.jpg", desc: "Structured bamboo textured gold drop earrings." },
    { id: 8, name: "Lavender Bloom", price: "AED 24.00", category: "under-30", type: "ring", image: "./assets/products/lavender-bloom.jpg", desc: "Lavender crystals in rose gold accents." },
    { id: 9, name: "Melted Metal Prism", price: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/melted-metal-prism.jpg", desc: "Melted metal prism in gold luxury finish." },
    { id: 10, name: "Pearl Petals Drops", price: "AED 45.00", category: "under-50", type: "earrings", image: "./assets/products/pearl-petals-drops.jpg", desc: "Lustrous pearl petal cluster drop earrings." },
    { id: 11, name: "Petal Stud", price: "AED 20.00", category: "under-30", type: "earrings", image: "./assets/products/Petal-stud.jpg", desc: "Delicate flower petal stud earrings." },
    { id: 12, name: "Red Stone Hoops", price: "AED 20.00", category: "under-30", type: "earrings", image: "./assets/products/red-stone-hoops.jpg", desc: "Ruby red stone retro hoop collection." },
    { id: 13, name: "Retro Red Hoops", price: "AED 45.00", category: "under-50", type: "earrings", image: "./assets/products/retro-red-hoops.jpg", desc: "Ruby red accent vintage drop hoops." },
    { id: 14, name: "Sapphire Retro Hoops", price: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/sapphire-retro-hoops.jpg", desc: "Deep sapphire stone retro hoops." },
    { id: 15, name: "Screw Oval Bracelet", price: "AED 35.00", category: "under-50", type: "bracelets", image: "./assets/products/Screw-oval bracelet.jpg", desc: "Minimalist luxury screw oval gold bangles." },
    { id: 16, name: "Seashell Toggle Chain", price: "AED 40.00", category: "under-50", type: "necklace", image: "./assets/products/seashell-toggle-chain.jpg", desc: "Elegant gold toggle chain with seashell charm." },
    { id: 17, name: "Serene Heart Pendant", price: "AED 45.00", category: "under-50", type: "necklace", image: "./assets/products/serene-heart-pendant.jpg", desc: "Toggle chain with dual chains and vintage heart." },
    { id: 18, name: "Silver Selen Bangles", price: "AED 35.00", category: "under-50", type: "bracelets", image: "./assets/products/Silver-selen bangles.jpg", desc: "Sculptural wave silver selen bangle bracelet." },
    { id: 19, name: "Silver Loop Studs", price: "AED 25.00", category: "under-30", type: "earrings", image: "./assets/products/Silver-Loop-studs.jpg", desc: "Minimalist luxury silver loop stud earrings." },
    { id: 20, name: "The Eternal Love", price: "AED 35.00", category: "under-50", type: "necklace", image: "./assets/products/the-eternal-love.jpg", desc: "Vintage puffy heart pendant with a classic link." },
    { id: 21, name: "The Fourth Stone Pendant", price: "AED 30.00", category: "under-30", type: "necklace", image: "./assets/products/the-fourth-stone-pendant.jpg", desc: "Minimalist single stone gold pendant chain." },
    { id: 22, name: "The Sapphire Heart Pendant", price: "AED 30.00", category: "under-30", type: "necklace", image: "./assets/products/the-sapphire-heart-pendant.jpg", desc: "Deep sapphire stone heart gold pendant." },
    { id: 23, name: "Verdant Bloom", price: "AED 28.00", category: "under-30", type: "ring", image: "./assets/products/verdant-bloom.jpg", desc: "Emerald green floral accent statement piece." },
    { id: 24, name: "Vintage Shine", price: "AED 32.00", category: "under-50", type: "watch", image: "./assets/products/Vintage-shine.jpg", desc: "Celestial gold coin pendant chain." },
    { id: 25, name: "Winter Bloom", price: "AED 28.00", category: "under-30", type: "rings", image: "./assets/products/winter-bloom.jpg", desc: "Textured silver crystal statement ring." },
    { id: 26, name: "Zorei Zircon", price: "AED 25.00", category: "under-30", type: "rings", image: "./assets/products/zorei-zircon.jpg", desc: "Solitaire olive zircon gemstone gold ring." },
    { id: 27, name: "Melted Metal Chain (in Gold)", price: "AED 130.00", category: "under-150", type: "necklace", image: "./assets/products/melted-metal-chain-gold.jpg", desc: "Gold glided artistic statement collection chain." },
    { id: 28, name: "Melting Metal Chain (Silver)", price: "AED 130.00", category: "under-150", type: "necklace", image: "./assets/products/melting-metal-chain-silver.jpg", desc: "Silver glided statement collection chain." },
    { id: 29, name: "Pearl Layered Pendant", price: "AED 90.00", originalPrice: "AED 130.00", category: "under-100", type: "necklace", image: "./assets/products/pearl-layered-pendant.jpg", desc: "Classic elegant design with tear drop pearl layers." },
    { id: 30, name: "Golden Luna Mini Hoops", price: "AED 18.00", originalPrice: "AED 25.00", category: "under-30", type: "earrings", image: "./assets/products/golden-luna-mini-hoops.jpg", desc: "Gold mini huggie hoops." },
    { id: 31, name: "Golden Hexa Mini Hoops", price: "AED 15.00", category: "under-30", type: "earrings", image: "./assets/products/golden-hexa-mini-hoops.jpg", desc: "Hexagonal textured gold mini hoops." },
    { id: 32, name: "Golden Crystal Retro Hoops", price: "AED 20.00", originalPrice: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/golden-crystal-retro-hoops.jpg", desc: "Yellow sparkling crystal retro drop hoops." },
    { id: 33, name: "Wine Drop Hoops", price: "AED 18.00", originalPrice: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/wine-drop-hoops.jpg", desc: "Vibrant wine red drop hoop earrings." },
    { id: 34, name: "Rosé Mini Hoops", price: "AED 15.00", category: "under-30", type: "earrings", image: "./assets/products/rose-mini-hoops.jpg", desc: "Asymmetrical rose mini huggie hoops." },
    { id: 35, name: "Luna Layered Ear Cuffs Set", price: "AED 25.00", category: "under-30", type: "earrings", image: "./assets/products/Luna-layered-ear cuffs-set.jpg", desc: "Layered luxury gold ear cuff set." },
    { id: 36, name: "Honey Dew Hoops", price: "AED 18.00", originalPrice: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/honey-dew-hoops.jpg", desc: "Crystal honeydew teardrop hoop earrings." },
    { id: 37, name: "Half Hoop Drops", price: "AED 30.00", originalPrice: "AED 60.00", category: "under-30", type: "earrings", image: "./assets/products/half-hoop-drops.jpg", desc: "Convertible half hoop drop earrings." },
    { id: 38, name: "Boho Chain Earring", price: "AED 35.00", category: "under-50", type: "earrings", image: "./assets/products/boho-chain-earring.jpg", desc: "Free-spirited boho chain earrings in a refined silver finish." },
    { id: 39, name: "Chain Loop Earrings", price: "AED 30.00", category: "under-30", type: "earrings", image: "./assets/products/chain-loop-earrings.jpg", desc: "Sculptural linked loop earrings with a sleek modern edge." },
    { id: 40, name: "Chunky Silver Hoops", price: "AED 32.00", category: "under-50", type: "earrings", image: "./assets/products/chuncy-silver-hoops.jpg", desc: "Bold chunky silver hoops with a lustrous satin finish." },
    { id: 41, name: "Crystal Cherry Hoops", price: "AED 25.00", category: "under-30", type: "earrings", image: "./assets/products/crystal-cherry-hoops.jpg", desc: "Cherry red crystal drop earrings with luminous glass accents." },
    { id: 42, name: "Dual Tone Oval Drops", price: "AED 40.00", category: "under-50", type: "earrings", image: "./assets/products/dual-tone-oval-drops-earrings.jpg", desc: "Dual-tone oval drop earrings blending warm and cool metallics." },
    { id: 43, name: "Garnet Glare Asymmetrical Drops", price: "AED 55.00", category: "under-100", type: "earrings", image: "./assets/products/garnet-glare-asymmetrical-drops.jpg", desc: "Asymmetrical garnet drops with a rich ruby glare finish." },
    { id: 44, name: "Garnet Glare Drops", price: "AED 55.00", category: "under-100", type: "earrings", image: "./assets/products/garnet-glare-drops.jpg", desc: "Classic garnet glare drop earrings with deep crimson stones." },
    { id: 45, name: "Garnet Glare Hollow Drops", price: "AED 60.00", category: "under-100", type: "earrings", image: "./assets/products/garnet-glare-hollow-drops.jpg", desc: "Hollow garnet drop earrings in a radiant crimson tone." },
    { id: 46, name: "Green Crescent Earrings", price: "AED 38.00", category: "under-50", type: "earrings", image: "./assets/products/green-crescent-earrings.jpg", desc: "Emerald crescent earrings with a soft vintage glow." },
    { id: 47, name: "Luna Layered Ear Cuffs Set", price: "AED 35.00", category: "under-50", type: "earrings", image: "./assets/products/Luna-layered-ear cuffs-set.jpg", desc: "Layered lunar ear cuff set in polished gold tones." },
    { id: 48, name: "Rainbow Crystal Drops", price: "AED 52.00", category: "under-100", type: "earrings", image: "./assets/products/rainbow-crystal-drops.jpg", desc: "Iridescent rainbow crystal drop earrings with prismatic sparkle." },
    { id: 49, name: "Bianca Handcuff", price: "AED 45.00", category: "under-50", type: "bracelets", image: "./assets/products/bianca-handcuff.jpg", desc: "Sculptural bianca handcuff bracelet in a statement silhouette." },
    { id: 50, name: "Cleopatra Handcuff", price: "AED 65.00", category: "under-100", type: "bracelets", image: "./assets/products/cleopatra-handcuff.jpg", desc: "Regal cleopatra handcuff bracelet with bold engraved detailing." },
    { id: 51, name: "Kelly Gold Handcuff", price: "AED 48.00", category: "under-50", type: "bracelets", image: "./assets/products/kelly-gold-handcuff.jpg", desc: "Opulent gold handcuff bracelet with a flawless mirror shine." },
    { id: 52, name: "Melted Gold Handcuff", price: "AED 65.00", category: "under-100", type: "bracelets", image: "./assets/products/melted-gold-handcuff.jpg", desc: "Artistic melted gold handcuff bracelet in a fluid luxury form." },
];

  /* ------------------------------------------------------------------ *
   * 3. Small, dependency-free helpers
   * ------------------------------------------------------------------ */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  /* ------------------------------------------------------------------ *
   * Product image resolution - single source of truth
   *
   * Every product image lives in exactly one of the two real folders. Values
   * arrive from the built-in catalogue, the admin editor or a sheet import,
   * and older builds stored paths under an assets/images/products/ folder
   * that never existed - so resolution returns an ordered candidate list and
   * lets the browser pick the first file that actually loads.
   * ------------------------------------------------------------------ */
  const PRODUCT_IMAGE_DIR = "./assets/products/";
  const PRODUCT_IMAGE_DIR_ALT = "./assets/products/";
  const PRODUCT_IMAGE_FALLBACK = "./assets/products/aura-golden-stud.jpg";

  /** "Aura Golden Stud" -> "aura-golden-stud" */
  const slugifyProductName = (name) =>
    String(name ?? "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-");

  const isRemoteImage = (value) => /^(https?:|data:|\/\/)/i.test(value);

  /** Filename with any folder, query or hash stripped: ".../a b.jpg?x" -> "a b.jpg" */
  const imageFileName = (value) =>
    String(value || "").replace(/^\.\//, "").split(/[?#]/)[0].split("/").pop() || "";

  /**
   * Ordered candidate paths for a product image, extension stripped so
   * wireImage() can probe .jpg/.png/.jpeg. Remote uploads pass through as-is.
   */
  const productImageCandidates = (value, name) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (raw && isRemoteImage(raw)) return [raw];

    let file = raw ? imageFileName(raw) : "";
    /* No usable filename - rebuild from the product name. */
    if (!file) {
      const slug = slugifyProductName(name);
      file = slug ? `${slug}.jpg` : "";
    } else if (!/\.[a-z0-9]+$/i.test(file)) {
      file = `${slugifyProductName(file)}.jpg`;
    }
    if (!file) return [PRODUCT_IMAGE_FALLBACK];

    /* Honour the folder the value already names so its own candidates are not
       pushed behind the other folder, then offer that folder as a fallback. */
    const dir = /new[\s_]*product/i.test(raw) ? PRODUCT_IMAGE_DIR_ALT : PRODUCT_IMAGE_DIR;
    const other = dir === PRODUCT_IMAGE_DIR ? PRODUCT_IMAGE_DIR_ALT : PRODUCT_IMAGE_DIR;
    const candidates = [dir + file, other + file];

    /* A stored filename can drift from the file on disk in case or spacing
       ("Garnet Glare Drops.jpg" vs garnet-glare-drops.jpg), so also offer the
       name slug. wireImage() dedupes, so this adds no requests in the
       common case where the stored name already matches. */
    const slug = slugifyProductName(name);
    if (slug && file.toLowerCase() !== `${slug}.jpg`) {
      candidates.push(dir + `${slug}.jpg`, other + `${slug}.jpg`);
    }

    return candidates;
  };

  const toNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };

  /** Format a number into UAE Dirhams, e.g. 15 -> "AED 15.00". */
  const formatAED = (amount) => {
    const value = toNumber(amount);
    return `AED ${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  /* ------------------------------------------------------------------ *
   * Currency switcher — AED (د.إ) ⇄ INR (₹)
   *   • Market rate: 1 AED = 26.08 INR (configurable in CONFIG)
   *   • Choice persists in localStorage; 'AED' is the store default.
   *   • All shopper-visible prices render through formatPrice().
   * ------------------------------------------------------------------ */
  const AED_TO_INR = toNumber(CONFIG.CURRENCY_RATE) > 0 ? toNumber(CONFIG.CURRENCY_RATE) : 26.08;
  const CURRENCY_STORAGE_KEY = "lurei_currency";

  const readSavedCurrency = () => {
    try {
      return localStorage.getItem(CURRENCY_STORAGE_KEY) === "INR" ? "INR" : "AED";
    } catch {
      return "AED";
    }
  };

  let activeCurrency = readSavedCurrency(); // "AED" | "INR"

  const saveCurrencyPreference = (code) => {
    try {
      localStorage.setItem(CURRENCY_STORAGE_KEY, code === "INR" ? "INR" : "AED");
    } catch {}
  };

  const currencyCode = () => activeCurrency; // "AED" | "INR"
  const currencySymbolLabel = () => (activeCurrency === "INR" ? "\u20B9 (INR)" : "AED (\u062F.\u0625)");

  /** AED amount → number to display in the active currency (INR: rounded paise-free). */
  const toDisplayNumber = (amountAED) => {
    const value = toNumber(amountAED) || 0;
    return activeCurrency === "INR" ? Math.round(value * AED_TO_INR) : value;
  };

  /** Single currency-aware price formatter used by every shopper-visible render. */
  const formatPrice = (amountAED) => {
    if (activeCurrency === "INR") {
      return `\u20B9 ${toDisplayNumber(amountAED).toLocaleString("en-IN")}`;
    }
    return formatAED(amountAED);
  };

  /** MutationObserver-less convenience: applies current currency to a card's price nodes. */
  const applyCurrencyToCard = (card) => {
    if (!card) return;
    card.querySelectorAll("[data-lurei-price]").forEach((el) => {
      const aed = Number(el.dataset.lureiPrice);
      el.textContent = activeCurrency === "INR"
        ? `\u20B9 ${Math.round(aed * AED_TO_INR).toLocaleString("en-IN")}`
        : formatAED(aed);
    });
  };

  /** Navbar currency toggle — syncs UI, persists choice, re-renders shopper prices. */
  const currencyToggleEls = Array.from(document.querySelectorAll(".currency-toggle"));

  const syncCurrencySelectors = () => {
    currencyToggleEls.forEach((select) => {
      select.value = activeCurrency === "INR" ? "INR" : "AED";
    });
  };

  const applyCurrencyAcross = () => {
    syncCurrencySelectors();
    renderPriceFilterOptions();
    renderTopSellers();
    refreshCollections();
    renderNewIn();
    renderCartItems();
  };

  const bindCurrencySwitcher = () => {
    currencyToggleEls.forEach((select) => {
      select.addEventListener("change", () => {
        const next = select.value === "INR" ? "INR" : "AED";
        if (next === activeCurrency) return;
        activeCurrency = next;
        saveCurrencyPreference(activeCurrency);
        applyCurrencyAcross();
      });
    });
  };

  /** Luxury toast — bottom-centre pill, auto-dismisses. */
  const showLureiToast = (message, type = "success") => {
    let toast = document.querySelector(".lurei-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "lurei-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.classList.toggle("lurei-toast--error", type === "error");
    toast.textContent = message;
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    clearTimeout(showLureiToast._timer);
    showLureiToast._timer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
  };

  /** Two-letter initials of a title, for premium fallback placeholders. */
  const initialsOf = (title) =>
    String(title || "L")
      .split(/\s+/)
      .map((word) => word.charAt(0))
      .slice(0, 2)
      .join("")
      .toUpperCase();

  const CART_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12l1.5 13h-15L6 7z"></path><path d="M9 10V6a3 3 0 0 1 6 0v4"></path></svg>';

  const WISHLIST_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21l-8.5-8.5a5.6 5.6 0 1 1 8.5-7.5 5.6 5.6 0 1 1 8.5 7.5L12 21z"></path></svg>';

  /* Expand/maximize glyph for the product image lightbox trigger. Drawn with a
     brighter, heavier stroke so it stays legible on both dark and light photos. */
  const LIGHTBOX_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H4v5"></path><path d="M15 4h5v5"></path><path d="M15 20h5v-5"></path><path d="M9 20H4v-5"></path></svg>';

  /** Stock count as a whole number of pieces, or null when nobody has counted.
 *  null is NOT zero: most of the built-in catalogue carries no count, and
 *  reading that as an empty shelf would stamp "OUT OF STOCK" over everything.
 *  The parse is deliberately strict - toNumber() strips letters, so it turns
 *  "n/a" into 0, which would quietly sell out a perfectly healthy piece. */
const stockOf = (value) => {
  let num = null;

  if (typeof value === "number") {
    num = Number.isFinite(value) ? value : null;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) num = Number(trimmed);
  }

  if (num === null) return null;
  const whole = Math.floor(num);
  return whole > 0 ? whole : 0;
};

/** Reads whichever field the data carries: the sheet export uses `stockCount`,
 *  the local store writes `stock`. `stockCount` wins when both are present. */
const rawStockOf = (product) => {
  if (!product) return null;
  return product.stockCount !== undefined && product.stockCount !== null
    ? product.stockCount
    : product.stock;
};

/** null means "no badge" — see stockOf() for why an absent count must never be
 *  read as an empty shelf. Only a positive count comes back. */
const stockCountOf = (product) => {
  const count = stockOf(rawStockOf(product));
  return count !== null && count > 0 ? count : null;
};

/** Sold out is now the admin's explicit flag and nothing else. A count of 0, or
 *  no count at all, means the shelf was never tallied for this piece - it hides
 *  the stock badge rather than claiming the piece cannot be bought. */
const isSoldOut = (product) => !!product && product.outOfStock === true;

/** Only ever called with a positive count; 0 and unset render no badge at all. */
const stockLabelFor = (count) => `STOCK ${count} LEFT`;

/** Normalise unstructured sheet rows into consistent product objects. */
  const normalizeProducts = (payload) => {
    if (!Array.isArray(payload)) return [];
    return payload
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const image = row.image ?? row.img ?? row.image_url ?? row["Image URL"] ?? null;
        const title = row.title ?? row.name ?? row["Product Name"] ?? null;
        /* First candidate is the best local guess; wireImage() retries the rest
           if that file is missing, so a stale folder heals itself. */
        const normalizedImage = productImageCandidates(image, title)[0];
        return {
          id: row.id ?? row.ID ?? row.product_id,
          title: title,
          price: toNumber(row.price ?? row.Price ?? row["Price (AED)"]),
          category: row.category ?? row.filter ?? null,
          type: row.type ?? row.kind ?? null,
          image: normalizedImage,
          fallbackImage: row.fallback_image ?? row.fallbackImage ?? null,
          description: row.description ?? row.Description ?? row.desc ?? null,
          badge: row.badge ?? row.tag ?? row.Badge ?? null,
          /* Kept as a whole number of pieces, or null when the source sheet has
             no count at all - see stockOf() for why null must not become 0. */
          stock: stockOf(row.stockCount ?? row.stock ?? row.Stock ?? row["Stock Count"] ?? row.quantity),
          outOfStock: row.outOfStock === true,
        };
      })
      .filter((p) => p && p.title && p.price !== null && p.price > 0)
      .filter((p, i, arr) => arr.findIndex((x) => x.title === p.title) === i);
  };

  /* ------------------------------------------------------------------ *
   * 4. Product card rendering (Add to Cart)
   * ------------------------------------------------------------------ */
  const topGrid = $("#products-container");
  const collectionsGrid = $("#collections-container");
  const status = $("#trending-status");
  const loadMoreBtn = $("#load-more");

  const clearStatus = () => {
    if (status) {
      status.textContent = "";
      status.classList.remove("trending__status--error");
    }
  };

  /** Apex monogram shown when every file extension fails to load. */
  const buildPlaceholder = (className, product) => {
    const placeholder = document.createElement("div");
    placeholder.className = className;
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = initialsOf(product.title);
    return placeholder;
  };

  /* Local image resolution:
   * productImageCandidates() returns an ordered list of extension-less paths
   * (its own folder first, then the other real folder). wireImage() walks that
   * list, trying .jpg -> .png -> .jpeg (and upper-case variants) at runtime,
   * because the dataset carries no extension and casing differs on disk.
   *
   * The first URL that loads is cached per candidate key so grids, the cart and
   * the wishlist never re-probe the same file. Each error handler removes
   * itself before setting the next src, preventing listener stacking. Once
   * every candidate is exhausted the real aura-golden-stud.jpg is used as a
   * last resort, and only a genuinely dead fallback drops to the monogram.
   */
  const IMAGE_EXTENSIONS = ["jpg", "png", "jpeg", "JPG", "PNG", "JPEG"];
  const resolvedImages = new Map(); // candidate key -> working URL ("" = dead)

  const wireImage = (img, product, onExhausted) => {
    const candidates = productImageCandidates(
      product && product.image,
      (product && (product.title || product.name)) || ""
    );

    /* Uploads from the storefront editor arrive as Base64 data URLs, which are
       already complete sources and must not go through extension probing. */
    if (candidates.length === 1 && isRemoteImage(candidates[0])) {
      img.src = candidates[0];
      return;
    }

    /* Candidate keys are tried in order, deduped, with the real aura photo as
       the guaranteed last resort. */
    const keys = candidates
      .map((candidate) => candidate.replace(/\.[^.]+$/, ""))
      .filter((key, i, all) => all.indexOf(key) === i);
    const fallbackKey = PRODUCT_IMAGE_FALLBACK.replace(/\.[^.]+$/, "");
    if (keys.indexOf(fallbackKey) === -1) keys.push(fallbackKey);
    const lastIndex = keys.length - 1;

    /* Reuse a resolved URL when we have one; otherwise start at the first
       candidate nobody has tried yet. -1 means every candidate is known dead. */
    let index = -1;
    for (let i = 0; i < keys.length; i++) {
      const cached = resolvedImages.get(keys[i]);
      if (cached) {
        img.src = cached;
        return;
      }
      if (cached === undefined && index === -1) index = i;
    }
    if (index === -1) {
      onExhausted();
      return;
    }

    let extension = 0;

    const onLoaded = () => {
      resolvedImages.set(keys[index], img.src);
    };

    const onFailed = () => {
      img.removeEventListener("error", onFailed);
      img.removeEventListener("load", onLoaded);

      if (extension < IMAGE_EXTENSIONS.length - 1) {
        extension++;
        img.src = `${keys[index]}.${IMAGE_EXTENSIONS[extension]}`;
        img.addEventListener("load", onLoaded, { once: true });
        img.addEventListener("error", onFailed);
        return;
      }

      /* This candidate is exhausted - mark it dead and move to the next. */
      resolvedImages.set(keys[index], "");

      index++;
      if (index <= lastIndex) {
        extension = 0;
        img.src = `${keys[index]}.${IMAGE_EXTENSIONS[0]}`;
        img.addEventListener("load", onLoaded, { once: true });
        img.addEventListener("error", onFailed);
        return;
      }

      onExhausted();
    };

    img.addEventListener("load", onLoaded, { once: true });
    img.addEventListener("error", onFailed);
    img.src = `${keys[index]}.${IMAGE_EXTENSIONS[0]}`;
  };

  const buildCard = (product, index) => {
    const card = document.createElement("article");
    card.className = "product-card";
    card.dataset.productId = String(product.id);
    card.style.animationDelay = `${Math.min(index % CONFIG.PAGE_SIZE, 3) * 80}ms`;

    const soldOut = isSoldOut(product);
    if (soldOut) card.classList.add("lurei-is-sold-out");

    const media = document.createElement("div");
    media.className = "product-card__media";

    /* One path for every card: wireImage() slugifies the name when there is no
       stored image, and the onerror net catches anything that still 404s. */
    const img = document.createElement("img");
    img.alt = product.title;
    img.width = 500;
    img.height = 500;
    img.loading = "lazy";
    img.onerror = function () {
      this.onerror = null;
      this.src = PRODUCT_IMAGE_FALLBACK;
    };
    wireImage(img, product, () =>
      img.replaceWith(buildPlaceholder("product-card__placeholder", product))
    );
    media.appendChild(img);

    const badge = product.badge ? String(product.badge).trim() : null;
    if (badge) {
      const label = document.createElement("span");
      label.className = "product-card__badge";
      label.textContent = badge;
      media.appendChild(label);
    }

    if (soldOut) {
      const label = document.createElement("span");
      label.className = "product-card__badge product-card__badge--sold-out";
      label.textContent = "Out of Stock";
      media.appendChild(label);
    } else {
      /* Scarcity rides on the pill alone - no second line of stock copy in the
         body, so the card cannot contradict itself after a restock. */
      const count = stockCountOf(product);
      if (count) {
        const label = document.createElement("span");
        label.className = "product-card__badge product-card__badge--stock";
        label.textContent = stockLabelFor(count);
        media.appendChild(label);
      }
    }

    const was = toNumber(product.originalPrice);
    const now = toNumber(product.price);
    if (was !== null && now !== null && was > now) {
      const percent = Math.round(((was - now) / was) * 100);
      if (percent > 0 && !badge) {
        const label = document.createElement("span");
        label.className = "product-card__badge";
        label.textContent = `-${percent}%`;
        media.appendChild(label);
      }
    }

    const heart = document.createElement("button");
    heart.type = "button";
    heart.className = "wishlist-heart";
    heart.dataset.wishlistAdd = String(product.id);
    heart.dataset.wishlistTitle = product.title;
    heart.setAttribute("aria-label", `Add ${product.title} to wishlist`);
    heart.innerHTML = WISHLIST_ICON;
    if (hasWishlist(product.id)) heart.classList.add("is-wishlisted");
    media.appendChild(heart);

    /* Expand trigger — a pure absolute overlay on the image frame, so it adds
       zero width/height to the media box and cannot shrink the photo. It is a
       plain button with no cart/wishlist data attributes, so the existing
       delegation never mistakes it for an add-to-cart or wishlist action. */
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "product-card__expand";
    expand.title = "Expand image";
    expand.setAttribute("aria-label", `View ${product.title} image`);
    expand.innerHTML = LIGHTBOX_ICON;
    media.appendChild(expand);

    const body = document.createElement("div");
    body.className = "product-card__body";

    const title = document.createElement("h3");
    title.className = "product-card__title";
    title.textContent = product.title;

    body.appendChild(title);

    if (product.description && typeof product.description === "string") {
      const description = document.createElement("p");
      description.className = "product-card__desc";
      description.textContent = product.description;
      body.appendChild(description);
    }

    const price = document.createElement("p");
    price.className = "product-card__price";
    if (was !== null && now !== null && was > now) {
      const wasPrice = document.createElement("span");
      wasPrice.className = "product-card__was";
      wasPrice.textContent = formatPrice(was);
      price.appendChild(wasPrice);
      const nowPrice = document.createElement("span");
      nowPrice.textContent = formatPrice(now);
      price.appendChild(nowPrice);
    } else {
      price.textContent = formatPrice(product.price);
    }
    body.appendChild(price);

    const cta = document.createElement("button");
    cta.className = "product-card__cta";
    cta.type = "button";
    if (!soldOut) cta.dataset.add = String(product.id);
    cta.innerHTML = `${CART_ICON}<span>${soldOut ? "Out of Stock" : "Add to Cart"}</span>`;
    cta.setAttribute(
      "aria-label",
      soldOut
        ? `${product.title} is out of stock`
        : `Add ${product.title} to cart — ${formatPrice(product.price)}`
    );
    if (soldOut) cta.disabled = true;
    body.appendChild(cta);

    card.append(media, body);
    return card;
  };

  /* ------------------------------------------------------------------ *
   * 4a-ii. Product image lightbox
   *
   * A single overlay is created on first use and reused from then on. The
   * viewer never touches the product record: it simply reads the resolved
   * source straight off the card's <img>, so the backend, cart and wishlist
   * paths stay exactly as they were.
   * ------------------------------------------------------------------ */
  let lightboxEl = null;
  let lightboxReturnFocus = null;

  const ensureLightbox = () => {
    if (lightboxEl) return lightboxEl;

    const overlay = document.createElement("div");
    overlay.className = "lightbox";
    overlay.id = "product-lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Product image viewer");
    overlay.setAttribute("aria-hidden", "true");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "lightbox__close";
    closeBtn.setAttribute("aria-label", "Close image viewer");
    closeBtn.innerHTML = "&times;";

    const stage = document.createElement("figure");
    stage.className = "lightbox__stage";

    const img = document.createElement("img");
    img.className = "lightbox__img";
    img.alt = "";
    img.decoding = "async";

    stage.appendChild(img);
    overlay.append(closeBtn, stage);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      /* Tapping the backdrop or the letterboxed space around the photo closes
         the viewer; tapping the photo itself does not. */
      if (event.target === overlay || event.target === stage) closeLightbox();
    });
    closeBtn.addEventListener("click", closeLightbox);

    lightboxEl = overlay;
    return overlay;
  };

  const openLightbox = (src, alt) => {
    if (!src) return;
    const overlay = ensureLightbox();
    const img = overlay.querySelector(".lightbox__img");
    img.src = src;
    img.alt = alt || "";
    lightboxReturnFocus = document.activeElement;
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("lightbox-open");
    const closeBtn = overlay.querySelector(".lightbox__close");
    if (closeBtn) closeBtn.focus();
  };

  function closeLightbox() {
    if (!lightboxEl || !lightboxEl.classList.contains("is-open")) return;
    lightboxEl.classList.remove("is-open");
    lightboxEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("lightbox-open");
    if (
      lightboxReturnFocus &&
      typeof lightboxReturnFocus.focus === "function" &&
      document.contains(lightboxReturnFocus)
    ) {
      lightboxReturnFocus.focus();
    }
    lightboxReturnFocus = null;
  }

  /* Delegated open for the full-screen viewer. Three triggers share it:
     · the product card's expand badge,
     · the Quick View modal's expand badge,
     · the Quick View modal's main photo (tapping it whole). */
  document.addEventListener("click", (event) => {
    const cardExpand = event.target.closest(".product-card__expand");
    const quickExpand = event.target.closest(".quickview__expand");
    const quickImg = event.target.closest(".quickview__img");
    if (!cardExpand && !quickExpand && !quickImg) return;

    let img = null;
    if (cardExpand) {
      const media = cardExpand.closest(".product-card__media");
      img = media ? media.querySelector("img") : null;
    } else if (quickImg) {
      img = quickImg;
    } else {
      const stage = quickExpand.closest(".quickview__stage");
      img = stage ? stage.querySelector(".quickview__img") : null;
    }
    if (!img || !img.getAttribute("src")) return;

    event.preventDefault();
    openLightbox(img.currentSrc || img.src, img.alt || "");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    /* The viewer can sit on top of Quick View; ESC must dismiss only the
       top-most layer, so stop the event when the lightbox is the one open. */
    if (!lightboxEl || !lightboxEl.classList.contains("is-open")) return;
    event.stopImmediatePropagation();
    closeLightbox();
  });

  /* ------------------------------------------------------------------ *
   * 4b. New In — "Autumn Vault" curated arrivals
   * ------------------------------------------------------------------ */
  const NEW_IN_IDS = [1, 2, 4, 6, 20, 24];

  const NEW_IN_VAULT = {
    1: { original: "AED 40.00", stock: 5, left: 3 },
    2: { original: "AED 46.00", stock: 5, left: 2 },
    4: { original: "AED 44.00", stock: 6, left: 4 },
    6: { original: "AED 22.00", stock: 4, left: 1 },
    20: { original: "AED 52.00", stock: 6, left: 3 },
    24: { original: "AED 48.00", stock: 5, left: 4 },
  };

  const newInGridEl = $("#new-in-grid");

  /* The curated six lead the rail, then whatever the admin has published since.
     Only genuine additions are appended: the catalogue holds every built-in
     product too, and a curated arrivals row that quietly grew to the whole
     shop would stop curating anything. */
  const catalogueAdditions = () => {
    const store = window.LureiCatalogue;
    if (!store || typeof store.created !== "function") return [];
    return store.created();
  };

  const newInProducts = () => {
    const seeded = NEW_IN_IDS.map((id) =>
      catalogue.find((p) => String(p.id) === String(id))
    ).filter(Boolean);

    const seededKeys = new Set(seeded.map((p) => String(p.id)));
    const added = catalogueAdditions().filter((p) => !seededKeys.has(String(p.id)));

    return [...seeded, ...added];
  };

  const renderNewIn = () => {
    if (!newInGridEl) return;

    const fragment = document.createDocumentFragment();
    newInProducts().forEach((product, index) => {
      const id = Number(product.id);
      const vault = NEW_IN_VAULT[id] || { original: formatAED(product.price), stock: 4, left: 3 };
      const soldOut = isSoldOut(product);

      /* An admin count always wins over the curated seed number, so a restock
         is reflected here in the same render as the collections grid. The seed
         only stands in for pieces nobody has ever tallied: an explicit 0 is
         respected and drops the stock badge entirely. */
      const counted = stockCountOf(product);
      const untallied = stockOf(rawStockOf(product)) === null;
      const left = counted === null ? (untallied ? vault.left : 0) : counted;
      const showStock = soldOut || left > 0;
      const pct = soldOut ? 0 : left > 0 ? Math.max(8, Math.round((left / vault.stock) * 100)) : 0;

      const card = document.createElement("article");
      card.className = "new-in-card";
      card.dataset.productId = String(product.id);
      if (soldOut) card.classList.add("lurei-is-sold-out");
      card.style.animationDelay = `${index * 90}ms`;

      const media = document.createElement("div");
      media.className = "new-in-card__media";

      if (product.image && typeof product.image === "string") {
        const img = document.createElement("img");
        img.alt = product.title;
        img.width = 500;
        img.height = 500;
        img.loading = "lazy";
        wireImage(img, product, () =>
          img.replaceWith(buildPlaceholder("new-in-card__placeholder", product))
        );
        media.appendChild(img);
      } else {
        media.appendChild(buildPlaceholder("new-in-card__placeholder", product));
      }

      /* One stock message per card. The pill is the only one now - the long
         "remaining in Dubai stock" line underneath it said the same number a
         second time and only cluttered the card. The admin's sold-out flag
         always wins; a 0 or untallied count emits no pill and no bar. */
      const limited = document.createElement("span");
      limited.className = soldOut
        ? "new-in-card__limited new-in-card__limited--sold-out"
        : "new-in-card__limited";
      limited.textContent = soldOut ? "OUT OF STOCK" : `LIMITED VAULT \u2022 ${left} LEFT`;

      const heart = document.createElement("button");
      heart.type = "button";
      heart.className = "wishlist-heart";
      heart.dataset.wishlistAdd = String(product.id);
      heart.dataset.wishlistTitle = product.title;
      heart.setAttribute("aria-label", `Add ${product.title} to wishlist`);
      heart.innerHTML = WISHLIST_ICON;
      if (hasWishlist(product.id)) heart.classList.add("is-wishlisted");

      if (showStock) media.append(limited);
      media.append(heart);

      const body = document.createElement("div");
      body.className = "new-in-card__body";

      const title = document.createElement("h3");
      title.className = "new-in-card__title";
      title.textContent = product.title;

      const desc = document.createElement("p");
      desc.className = "new-in-card__desc";
      desc.textContent = product.description || "A handcrafted piece from the Autumn Vault.";

      const price = document.createElement("p");
      price.className = "new-in-card__price";
      const wasPrice = document.createElement("span");
      wasPrice.className = "new-in-card__was";
      wasPrice.textContent = formatPrice(toNumber(vault.original) || product.price);
      const nowPrice = document.createElement("span");
      nowPrice.className = "new-in-card__now";
      nowPrice.textContent = formatPrice(product.price);
      price.append(wasPrice, nowPrice);

      /* The slim depletion bar survives as a purely visual cue; the number now
         lives in the pill only, so there is nothing to contradict after a
         restock. Hidden alongside the pill when there is no count to show. */
      let stock = null;
      if (showStock) {
        stock = document.createElement("div");
        stock.className = "new-in-card__stock";
        const stockTrack = document.createElement("div");
        stockTrack.className = "new-in-card__stock-track";
        const stockFill = document.createElement("div");
        stockFill.className = "new-in-card__stock-fill";
        stockFill.style.width = `${pct}%`;
        stockTrack.appendChild(stockFill);
        stock.appendChild(stockTrack);
      }

      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "product-card__cta";
      if (!soldOut) cta.dataset.add = String(product.id);
      cta.setAttribute(
        "aria-label",
        soldOut
          ? `${product.title} is out of stock`
          : `Add ${product.title} to cart — ${formatPrice(product.price)}`
      );
      cta.innerHTML = `${CART_ICON}<span>${soldOut ? "Out of Stock" : "Add to Cart"}</span>`;
      if (soldOut) cta.disabled = true;

      if (stock) body.append(stock);
      body.append(title, desc, price, cta);
      card.append(media, body);
      fragment.appendChild(card);
    });

    newInGridEl.replaceChildren(fragment);
  };

  /* ------------------------------------------------------------------ *
   * 4c. Just In — everything the admin has published, on the homepage
   * ------------------------------------------------------------------ */
  /* The Top Selling carousel above is deliberately fixed: three curated
     batches of four ids, with a CSS track width and a clone-the-first-batch
     loop that only line up at exactly three batches. Feeding admin additions
     into it would mean rewriting that geometry for a variable number of
     pages, so new pieces get their own rail instead — same buildCard()
     template, same badges, same sold-out treatment, and no timing to break.
     The section stays hidden until there is something in it, so a shopper
     never sees an empty heading. */
  const justInEl = $("#just-in");
  const justInGridEl = $("#just-in-grid");

  const JUST_IN_LIMIT = 8;

  const renderJustIn = () => {
    if (!justInEl || !justInGridEl) return;

    const added = catalogueAdditions().slice(0, JUST_IN_LIMIT);
    justInEl.hidden = added.length === 0;
    if (!added.length) {
      justInGridEl.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();
    added.forEach((product, index) => {
      fragment.appendChild(buildCard(product, index));
    });
    justInGridEl.replaceChildren(fragment);
  };

  /* ------------------------------------------------------------------ *
   * 5. Catalogue state + dual-section rendering
   * ------------------------------------------------------------------ */
  let catalogue = [];
  let topVisible = 0;

  /* Homepage "Top Selling" horizontal carousel: 12 fixed products in
   * 3 batches of 4, auto-scrolling right every CAROUSEL_INTERVAL ms as a
   * continuous infinite loop (a cloned first batch creates the seam). */
  const TOP_SELLER_BATCHES = [
    [1, 5, 8, 11],
    [2, 4, 10, 16],
    [20, 27, 29, 32],
  ];
  const TOP_SELLER_IDS = TOP_SELLER_BATCHES.flat();
  const CAROUSEL_INTERVAL = 2000;

  const FILTERS = {
    all: () => catalogue,
    "under-150": () => catalogue.filter((p) => p.category === "under-150"),
    "under-100": () => catalogue.filter((p) => p.category === "under-100"),
    "under-50": () => catalogue.filter((p) => p.category === "under-50"),
    "under-30": () => catalogue.filter((p) => p.category === "under-30"),
    earrings: () => catalogue.filter((p) => p.type === "earrings" || p.type === "earring"),
    necklaces: () => catalogue.filter((p) => p.type === "necklace" || p.type === "necklaces"),
    rings: () => catalogue.filter((p) => p.type === "rings" || p.type === "ring"),
    bracelets: () => catalogue.filter((p) => p.type === "bracelets" || p.type === "bracelet" || p.type === "bangle" || p.type === "bangles"),
    watches: () => catalogue.filter((p) => p.type === "watch" || p.type === "watches"),
  };

  let activeFilter = "all";
  const filterTabs = document.querySelectorAll("[data-filter]");

  const renderInto = (container, products) => {
    if (!container) return;
    const fragment = document.createDocumentFragment();
    products.forEach((product, index) => {
      fragment.appendChild(buildCard(product, index));
    });
    container.replaceChildren(fragment);
  };

  let carouselTrack = null;
  let carouselIndex = 0;
  let carouselTimer = null;

  const topBatchProducts = (index) =>
    catalogue.filter((p) => TOP_SELLER_BATCHES[index].includes(Number(p.id)));

  const BATCH_STEP = 100 / TOP_SELLER_BATCHES.length;

  const carouselSlide = () => {
    if (!carouselTrack) return;
    /* Self-healing: if the timer was ever cleared, revive it so the loop
       can never freeze. */
    if (carouselTimer === null) {
      carouselTimer = window.setInterval(carouselSlide, CAROUSEL_INTERVAL);
    }
    carouselIndex++;
    if (carouselIndex > TOP_SELLER_BATCHES.length) {
      /* At the cloned first batch — snap back to the real one instantly. */
      carouselIndex = 0;
      carouselTrack.style.transition = "none";
      carouselTrack.style.transform = "translate3d(0, 0, 0)";
      void carouselTrack.offsetWidth; /* force reflow to commit the snap */
      carouselTrack.style.transition = "";
      return;
    }
    carouselTrack.style.transform = `translate3d(-${carouselIndex * BATCH_STEP}%, 0, 0)`;
  };

  const startTopRotation = () => {
    if (!topGrid || catalogue.length < TOP_SELLER_IDS.length) return;

    const track = document.createElement("div");
    track.className = "top-selling-track";
    TOP_SELLER_BATCHES.forEach((batchIds) => {
      const page = document.createElement("div");
      page.className = "top-selling-batch";
      catalogue
        .filter((p) => batchIds.includes(Number(p.id)))
        .forEach((product, i) => page.appendChild(buildCard(product, i)));
      track.appendChild(page);
    });
    /* Append a clone of the first batch so the loop is seamless. */
    track.appendChild(track.children[0].cloneNode(true));

    topGrid.replaceChildren(track);
    carouselTrack = track;
    carouselIndex = 0;

    /* The interval is created once and never paused, so auto-scroll always
       continues regardless of hover, focus, or tab activity. */
    if (carouselTimer !== null) window.clearInterval(carouselTimer);
    carouselTimer = window.setInterval(carouselSlide, CAROUSEL_INTERVAL);
  };

  const renderTopSellers = () => startTopRotation();

  const renderCollections = (list = catalogue) => {
    if (!collectionsGrid) return;
    const items = list && list.length ? list : [];
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "collections__empty";
      empty.textContent = "No products found";
      collectionsGrid.replaceChildren(empty);
      return;
    }
    renderInto(collectionsGrid, items);
  };

  /* Price buckets combined with the active category tab + live search.
     AED mode keeps clean 30/50 AED thresholds; INR mode matches converted
     item prices against clean 500/1,000 INR thresholds. */
  const PRICE_OPTIONS = {
    AED: [
      { value: "all", label: "All Prices" },
      { value: "under-30", label: "Under 30 AED" },
      { value: "30-50", label: "30 - 50 AED" },
      { value: "above-50", label: "Above 50 AED" },
    ],
    INR: [
      { value: "all", label: "All Prices" },
      { value: "under-30", label: "Under \u20B9500" },
      { value: "30-50", label: "\u20B9500 - \u20B91,000" },
      { value: "above-50", label: "Above \u20B91,000" },
    ],
  };

  const renderPriceFilterOptions = () => {
    const priceSelect = $("#price-filter");
    if (!priceSelect) return;
    const previous = priceSelect.value;
    const options = PRICE_OPTIONS[activeCurrency === "INR" ? "INR" : "AED"];
    priceSelect.innerHTML = options
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join("");
    priceSelect.value = options.some((o) => o.value === previous) ? previous : "all";
    priceRange = priceSelect.value;
  };

  const PRICE_RANGES = {
    all: () => (p) => true,
    "under-30": () => {
      const cap = activeCurrency === "INR" ? 500 : toDisplayNumber(30);
      return (p) => {
        const v = toDisplayNumber(p.price);
        return v > 0 && v <= cap;
      };
    },
    "30-50": () => {
      const lo = activeCurrency === "INR" ? 500 : toDisplayNumber(30);
      const hi = activeCurrency === "INR" ? 1000 : toDisplayNumber(50);
      return (p) => {
        const v = toDisplayNumber(p.price);
        return v > lo && v <= hi;
      };
    },
    "above-50": () => {
      const floor = activeCurrency === "INR" ? 1000 : toDisplayNumber(50);
      return (p) => toDisplayNumber(p.price) > floor;
    },
  };

  let searchQuery = "";
  let priceRange = "all";

  const refreshCollections = () => {
    const base = FILTERS[activeFilter]();
    const matchesPrice = PRICE_RANGES[priceRange]
      ? PRICE_RANGES[priceRange]()
      : PRICE_RANGES.all();
    const query = searchQuery.trim().toLowerCase();
    const items = base.filter((p) => {
      if (!matchesPrice(p)) return false;
      if (query && !String(p.title || "").toLowerCase().includes(query)) return false;
      return true;
    });
    renderCollections(items);
  };

  const applyFilter = (key) => {
    activeFilter = FILTERS[key] ? key : "all";
    filterTabs.forEach((tab) => {
      const isActive = tab.dataset.filter === activeFilter;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
    refreshCollections();
  };

  const bindFilters = () => {
    filterTabs.forEach((tab) => {
      tab.addEventListener("click", () => applyFilter(tab.dataset.filter));
    });
  };

  /* Custom-category tabs from explicit creations only (registry via the
     catalogue API — product data is never scanned, so type variants can never
     spawn duplicates). Appended beside WATCHES with luxury .filter-tab
     styling; static tabs, FILTERS entries and existing listeners are never
     rebuilt or rebound. A custom tab is visible only while its category holds
     at least one available product; otherwise it hides automatically. */

  /* Sellable test: the explicit out-of-stock flag always wins; an uncounted
     shelf (null) and the boutique's 0-means-ample convention read as
     available, otherwise stock > 0 is required. */
  const isProductAvailable = (p) => {
    if (!p) return false;
    if (p.outOfStock === true) return false;
    if (p.stock === null || p.stock === undefined) return true;
    const n = Number(p.stock);
    if (!Number.isFinite(n)) return true;
    return n !== 0 ? n > 0 : true;
  };

  /* Fresh catalogue read (never the possibly-stale render list), so stock
     toggles are reflected even when this runs ahead of the next seed. */
  const readLiveProducts = () => {
    try {
      const api = window.LureiCatalogue;
      if (api && api.store && typeof api.store.read === "function") return api.store.read();
    } catch {}
    return [];
  };

  const customCategoryHasStock = (key) => {
    const want = String(key || "").trim().toUpperCase();
    if (!want) return false;
    return readLiveProducts().some(
      (p) => String((p && p.type) || "").trim().toUpperCase() === want && isProductAvailable(p)
    );
  };

  /* Shows/hides every custom tab from live availability. Falls back to ALL
     COLLECTIONS when the active custom tab runs dry. Display toggling only —
     buttons (and their listeners) are preserved, so restocking re-shows the
     same node. */
  const syncCustomTabsVisibility = () => {
    const wrap = document.querySelector(".filter-tabs");
    if (!wrap) return;
    wrap.querySelectorAll('[data-filter][data-custom="true"]').forEach((btn) => {
      const visible = customCategoryHasStock(btn.dataset.filter);
      btn.style.display = visible ? "" : "none";
      if (!visible && activeFilter === btn.dataset.filter) {
        applyFilter("all");
      }
    });
  };

  const ensureCustomFilter = (key) => {
    if (!FILTERS[key]) {
      const want = key;
      FILTERS[key] = () => catalogue.filter((p) => String((p && p.type) || "").trim().toUpperCase() === want);
    }
  };

  const appendCustomTab = (key) => {
    const wrap = document.querySelector(".filter-tabs");
    if (!wrap || !key) return;
    let exists = false;
    wrap.querySelectorAll("[data-filter]").forEach((tab) => {
      if (tab.dataset.filter === key) exists = true;
    });
    ensureCustomFilter(key);
    if (!exists) {
      const btn = document.createElement("button");
      btn.className = "filter-tab cat-btn";
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(activeFilter === key));
      if (activeFilter === key) btn.classList.add("is-active");
      btn.dataset.filter = key;
      btn.dataset.custom = "true";
      /* Name text only — no manual delete affordance; visibility is
         stock-driven (see syncCustomTabsVisibility). */
      btn.textContent = key;
      /* Listener lives only on the appended button; no existing tab or
         handler is touched. applyFilter() itself is unmodified. */
      btn.addEventListener("click", () => {
        applyFilter(key);
        wrap.querySelectorAll('[data-filter][data-custom="true"].is-active').forEach((b) => {
          b.classList.remove("is-active");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-selected", "true");
      });
      wrap.appendChild(btn);
    }
    syncCustomTabsVisibility();
  };

  const renderCreatedTabs = () => {
    const wrap = document.querySelector(".filter-tabs");
    if (!wrap) return;
    if (!wrap.dataset.lureiCustomTabsBound) {
      wrap.dataset.lureiCustomTabsBound = "true";
      wrap.addEventListener("click", (event) => {
        const tab = event.target.closest("[data-filter]");
        if (!tab || tab.dataset.custom === "true") return;
        wrap.querySelectorAll('[data-filter][data-custom="true"].is-active').forEach((b) => {
          b.classList.remove("is-active");
          b.setAttribute("aria-selected", "false");
        });
      });
    }
    try {
      const api = window.LureiCatalogue;
      const created =
        api && typeof api.createdCategories === "function" ? api.createdCategories() : [];
      created.forEach((key) => appendCustomTab(key));
    } catch {}
    syncCustomTabsVisibility();
  };

  window.addEventListener("lurei:category-created", (event) => {
    const key = event && event.detail && event.detail.key;
    if (key) appendCustomTab(key);
  });

  /* Stock-change triggers (additive only — baseline store/catalogue code is
     untouched): every catalogue commit (publish, stock toggle/count update,
     out-of-stock switch, delete) re-syncs tab visibility from live data.
     Cross-tab storage writes for products or the created registry re-render
     first, then re-sync. Neither path writes anything back, so no loops. */
  if (!window.__lureiCustomStockSync) {
    window.__lureiCustomStockSync = true;
    try {
      const catalogueApi = window.LureiCatalogue;
      if (
        catalogueApi &&
        catalogueApi.store &&
        typeof catalogueApi.store.subscribe === "function"
      ) {
        catalogueApi.store.subscribe(() => syncCustomTabsVisibility());
      }
    } catch {}
    window.addEventListener("storage", (event) => {
      if (!event) return;
      /* MASTER_STORAGE_KEY ("lurei_products") or the created registry; a null
         key means storage was cleared wholesale. */
      if (
        event.key !== null &&
        event.key !== "lurei_products" &&
        event.key !== "lurei_created_categories"
      ) {
        return;
      }
      renderCreatedTabs();
      syncCustomTabsVisibility();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderCreatedTabs);
  } else {
    renderCreatedTabs();
  }

  const bindCollectionTools = () => {
    const searchInput = $("#product-search");
    const priceSelect = $("#price-filter");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        refreshCollections();
      });
    }
    if (priceSelect) {
      priceSelect.addEventListener("change", () => {
        priceRange = priceSelect.value;
        refreshCollections();
      });
    }
  };

  const updateLoadMore = () => {
    if (!loadMoreBtn) return;
    const hasMore = topVisible < catalogue.length;
    loadMoreBtn.hidden = !hasMore;
  };

  const bindLoadMore = () => {
    if (!loadMoreBtn) return;
    loadMoreBtn.addEventListener("click", () => {
      if (topVisible >= catalogue.length) return;
      topVisible = Math.min(catalogue.length, topVisible + CONFIG.PAGE_SIZE);
      renderTopSellers();
      updateLoadMore();
    });
  };

  const seedCatalogue = (input) => {
    catalogue = [...input];
    topVisible = Math.min(CONFIG.PAGE_SIZE, catalogue.length);
    renderTopSellers();
    refreshCollections();
    renderNewIn();
    renderJustIn();
    updateLoadMore();
    clearStatus();
  };

  /* ------------------------------------------------------------------ *
   * 6. Cart (state + drawer)
   * ------------------------------------------------------------------ */
  const CART_STORAGE_KEY = "lurei_cart";

  const readCart = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.id != null) : [];
    } catch {
      return [];
    }
  };

  let cart = readCart(); // [{ id, title, price, image, quantity }]

  const saveCart = () => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {}
  };

  const badge = $(".cart-badge");
  const drawer = $("#cart-drawer");
  const overlay = $("#cart-overlay");
  const cartItemsEl = $("#cart-items");
  const subtotalEl = $("#cart-subtotal");
  const checkoutBtn = $("#checkout-btn");

  const cartCount = () => cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const cartTotal = () => cart.reduce(
    (sum, item) => sum + (toNumber(item.price) || 0) * (Number(item.quantity) || 0),
    0
  );

  const updateBadge = () => {
    const count = cartCount();
    if (badge) {
      badge.textContent = String(count);
      badge.dataset.cartCount = String(count);
      badge.classList.remove("cart-badge--pulse");
      void badge.offsetWidth; // restart animation
      badge.classList.add("cart-badge--pulse");
    }
  };

  const renderCartItems = () => {
    if (!cartItemsEl || !subtotalEl || !checkoutBtn) return;
    subtotalEl.textContent = formatPrice(cartTotal());

    if (cart.length === 0) {
      checkoutBtn.disabled = true;
      drawer.classList.add("is-empty");
      cartItemsEl.replaceChildren(emptyState());
      return;
    }

    checkoutBtn.disabled = false;
    drawer.classList.remove("is-empty");

    const fragment = document.createDocumentFragment();
    cart.forEach((item) => {
      fragment.appendChild(buildCartItem(item));
    });
    cartItemsEl.replaceChildren(fragment);
  };

  const emptyState = () => {
    const wrap = document.createElement("div");
    wrap.className = "cart-empty";
    wrap.innerHTML =
      '<span class="cart-empty__icon" aria-hidden="true">&#10024;</span>' +
      '<p class="cart-empty__title">Your bag is empty</p>' +
      '<p class="cart-empty__text">Add a piece you love and it will appear here.</p>';
    return wrap;
  };

  const buildCartItem = (product) => {
    const item = document.createElement("div");
    item.className = "cart-item";
    item.dataset.id = product.id;

    const media = document.createElement("div");
    media.className = "cart-item__media";

    if (product.image && typeof product.image === "string") {
      const img = document.createElement("img");
      img.alt = product.title;
      img.width = 72;
      img.height = 72;
      img.loading = "lazy";
      wireImage(img, product, () =>
        img.replaceWith(buildPlaceholder("cart-item__placeholder", product))
      );
      media.appendChild(img);
    } else {
      media.appendChild(buildPlaceholder("cart-item__placeholder", product));
    }

    const info = document.createElement("div");
    info.className = "cart-item__info";

    const title = document.createElement("p");
    title.className = "cart-item__title";
    title.textContent = product.title;

    const price = document.createElement("p");
    price.className = "cart-item__price";
    price.textContent = `${formatPrice(product.price)} each`;

    info.append(title, price);

    const controls = document.createElement("div");
    controls.className = "cart-item__controls";

    const qtyRow = document.createElement("div");
    qtyRow.className = "cart-item__qty";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "qty-btn qty-btn--minus";
    minus.dataset.action = "minus";
    minus.setAttribute("aria-label", `Decrease quantity of ${product.title}`);
    minus.textContent = "\u2212";

    const count = document.createElement("span");
    count.className = "cart-item__count";
    count.textContent = String(product.quantity);

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "qty-btn qty-btn--plus";
    plus.dataset.action = "plus";
    plus.setAttribute("aria-label", `Increase quantity of ${product.title}`);
    plus.textContent = "+";

    qtyRow.append(minus, count, plus);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cart-item__remove";
    remove.dataset.action = "remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${product.title} from cart`);

    controls.append(qtyRow, remove);
    item.append(media, info, controls);
    return item;
  };

  const addToCart = (id) => {
    const product = catalogue.find((p) => String(p.id) === String(id));
    if (!product) return;

    const existing = cart.find((item) => String(item.id) === String(product.id));
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        id: product.id,
        title: product.title,
        price: product.price,
        image: product.image,
        quantity: 1,
      });
    }

    saveCart();
    updateBadge();
    renderCartItems();
    showLureiToast(`Added to bag \u2014 ${product.title}`);
  };

  /* Quick View adds N pieces at once. Same storage contract as addToCart() —
     it reuses the shared cart array, saveCart(), updateBadge() and
     renderCartItems() and never rewrites the cart mechanics themselves. */
  const addToCartQuantity = (id, qty) => {
    const product = catalogue.find((p) => String(p.id) === String(id));
    if (!product) return;
    const amount = Math.max(1, Math.floor(Number(qty) || 1));

    const existing = cart.find((item) => String(item.id) === String(product.id));
    if (existing) {
      existing.quantity += amount;
    } else {
      cart.push({
        id: product.id,
        title: product.title,
        price: product.price,
        image: product.image,
        quantity: amount,
      });
    }

    saveCart();
    updateBadge();
    renderCartItems();
    showLureiToast(`Added to bag \u2014 ${product.title}`);
  };

  const changeQty = (id, action) => {
    const item = cart.find((p) => String(p.id) === String(id));
    if (!item) return;

    if (action === "plus") item.quantity += 1;
    if (action === "minus") item.quantity = Math.max(1, item.quantity - 1);
    if (action === "remove") {
      cart = cart.filter((p) => String(p.id) !== String(id));
    }

    saveCart();
    updateBadge();
    renderCartItems();
  };

  const openDrawer = () => {
    renderCartItems();
    drawer.classList.add("is-open");
    overlay.classList.add("is-open");
    document.body.classList.add("lock-scroll");
  };

  const closeDrawer = () => {
    drawer.classList.remove("is-open");
    overlay.classList.remove("is-open");
    if (!modal.classList.contains("modal--open")) {
      document.body.classList.remove("lock-scroll");
    }
  };

  /* Delegated cart item controls — one listener on the parent container */
  if (cartItemsEl) {
    cartItemsEl.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("[data-action]");
      if (!actionBtn) return;
      const itemEl = actionBtn.closest("[data-id]");
      if (!itemEl) return;
      changeQty(itemEl.dataset.id, actionBtn.dataset.action);
    });
  }

  /* Restore persisted cart on load */
  updateBadge();
  renderCartItems();

  /* ------------------------------------------------------------------ *
   * 6b. Product Quick View modal
   *
   * Opens from a product photo or title in the grid. Injected once on
   * first use and reused, mirroring the lightbox/service-modal pattern.
   * It reads product data and hands the chosen quantity to the shared
   * cart helpers — no edit-mode, stock-toggle or storage logic is touched.
   * ------------------------------------------------------------------ */
  const QUICKVIEW_CLOSE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

  let quickViewEl = null;
  let quickViewProduct = null;
  let quickViewQty = 1;
  let quickViewReturnFocus = null;

  /* Gallery sources: prefer an explicit photo array, otherwise fall back to the
     single product image (and its stored fallback), de-duplicated. */
  const quickViewGalleryFor = (product) => {
    const out = [];
    const add = (value) => {
      if (typeof value !== "string") return;
      const src = value.trim();
      if (src && out.indexOf(src) === -1) out.push(src);
    };
    if (Array.isArray(product.images)) product.images.forEach(add);
    if (Array.isArray(product.gallery)) product.gallery.forEach(add);
    add(product.image);
    if (Array.isArray(product.fallbackImages)) product.fallbackImages.forEach(add);
    add(product.fallbackImage);
    return out;
  };

  /* Resolve a photo through the shared probe so local filenames heal exactly
     like they do on the cards; never replaces the node, just marks failure. */
  const resolveQuickViewImage = (img, src, product) => {
    img.classList.remove("is-missing");
    wireImage(img, { image: src, title: product.title }, () => {
      img.classList.add("is-missing");
    });
  };

  const ensureQuickView = () => {
    if (quickViewEl) return quickViewEl;

    const overlay = document.createElement("div");
    overlay.className = "quickview-overlay";
    overlay.id = "quickview-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const modal = document.createElement("div");
    modal.className = "quickview";
    modal.id = "quickview-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "quickview-title");
    modal.hidden = true;

    const card = document.createElement("div");
    card.className = "quickview__card";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "quickview__close";
    closeBtn.setAttribute("aria-label", "Close quick view");
    closeBtn.innerHTML = QUICKVIEW_CLOSE_ICON;

    /* Media column */
    const media = document.createElement("div");
    media.className = "quickview__media";

    const stage = document.createElement("div");
    stage.className = "quickview__stage";
    const mainImg = document.createElement("img");
    mainImg.className = "quickview__img";
    mainImg.alt = "";
    mainImg.decoding = "async";

    const stageExpand = document.createElement("button");
    stageExpand.type = "button";
    stageExpand.className = "quickview__expand";
    stageExpand.title = "View full size";
    stageExpand.setAttribute("aria-label", "View image full size");
    stageExpand.innerHTML = LIGHTBOX_ICON;

    stage.append(mainImg, stageExpand);

    const thumbs = document.createElement("div");
    thumbs.className = "quickview__thumbs";
    media.append(stage, thumbs);

    /* Details column */
    const info = document.createElement("div");
    info.className = "quickview__info";

    const eyebrow = document.createElement("p");
    eyebrow.className = "quickview__eyebrow";
    eyebrow.textContent = "LUR\u00C9I COLLECTION";

    const title = document.createElement("h2");
    title.className = "quickview__title";
    title.id = "quickview-title";

    const price = document.createElement("p");
    price.className = "quickview__price";

    const desc = document.createElement("p");
    desc.className = "quickview__desc";

    const qtyWrap = document.createElement("div");
    qtyWrap.className = "quickview__qty-wrap";
    const qtyLabel = document.createElement("span");
    qtyLabel.className = "quickview__qty-label";
    qtyLabel.textContent = "Quantity";
    const qty = document.createElement("div");
    qty.className = "quickview__qty";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "quickview__step";
    minus.dataset.step = "-1";
    minus.setAttribute("aria-label", "Decrease quantity");
    minus.textContent = "\u2212";

    const count = document.createElement("span");
    count.className = "quickview__count";
    count.setAttribute("aria-live", "polite");
    count.textContent = "1";

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "quickview__step";
    plus.dataset.step = "1";
    plus.setAttribute("aria-label", "Increase quantity");
    plus.textContent = "+";

    qty.append(minus, count, plus);
    qtyWrap.append(qtyLabel, qty);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "quickview__add";
    addBtn.textContent = "Add to Bag";

    info.append(eyebrow, title, price, desc, qtyWrap, addBtn);
    card.append(closeBtn, media, info);
    modal.appendChild(card);
    document.body.append(overlay, modal);

    /* ---- Wiring ---- */
    closeBtn.addEventListener("click", closeQuickView);
    overlay.addEventListener("click", closeQuickView);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeQuickView();
    });

    qty.addEventListener("click", (event) => {
      const step = event.target.closest("[data-step]");
      if (!step) return;
      setQuickViewQty(quickViewQty + Number(step.dataset.step));
    });

    addBtn.addEventListener("click", () => {
      if (!quickViewProduct || isSoldOut(quickViewProduct)) return;
      const id = quickViewProduct.id;
      addToCartQuantity(id, quickViewQty);
      closeQuickView();
      openDrawer();
    });

    quickViewEl = { overlay, modal, stage, mainImg, thumbs, title, price, desc, count, minus, plus, addBtn, closeBtn };
    return quickViewEl;
  };

  const quickViewCap = (product) => {
    if (isSoldOut(product)) return 0;
    const counted = stockCountOf(product);
    return counted && counted > 0 ? counted : Infinity;
  };

  const setQuickViewQty = (next) => {
    const cap = quickViewProduct ? quickViewCap(quickViewProduct) : Infinity;
    const upper = cap === Infinity ? Infinity : Math.max(1, cap);
    quickViewQty = Math.max(1, Math.min(Number(next) || 1, upper));
    if (quickViewEl) {
      quickViewEl.count.textContent = String(quickViewQty);
      quickViewEl.minus.disabled = quickViewQty <= 1;
      quickViewEl.plus.disabled = cap !== Infinity && quickViewQty >= upper;
    }
  };

  const buildQuickViewGallery = (ui, product) => {
    const sources = quickViewGalleryFor(product);
    ui.thumbs.replaceChildren();

    /* Swaps only the <img>, leaving the persistent expand badge in place. */
    const swapStageImage = (node) => {
      const current = ui.stage.querySelector(".quickview__img");
      if (current) current.replaceWith(node);
      else ui.stage.prepend(node);
      ui.mainImg = node;
    };

    if (!sources.length) {
      const missing = document.createElement("img");
      missing.className = "quickview__img is-missing";
      missing.alt = "";
      swapStageImage(missing);
      ui.thumbs.hidden = true;
      return;
    }

    /* Thumbnails only earn their space when there is more than one photo to
       switch between; a lone image renders clean with no empty strip. */
    ui.thumbs.hidden = sources.length <= 1;

    /* A fresh <img> per swap keeps wireImage() from stacking load/error
       probes on one node as the shopper flips between thumbnails. */
    const setMain = (index) => {
      const fresh = document.createElement("img");
      fresh.className = "quickview__img";
      fresh.alt = product.title;
      fresh.decoding = "async";
      resolveQuickViewImage(fresh, sources[index], product);
      swapStageImage(fresh);
      Array.prototype.forEach.call(ui.thumbs.children, (el, i) => {
        el.classList.toggle("is-active", i === index);
        el.setAttribute("aria-pressed", i === index ? "true" : "false");
      });
    };

    sources.forEach((src, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quickview__thumb";
      btn.setAttribute("aria-label", `Show image ${index + 1} of ${sources.length}`);
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      resolveQuickViewImage(img, src, product);
      btn.appendChild(img);
      btn.addEventListener("click", () => setMain(index));
      ui.thumbs.appendChild(btn);
    });

    setMain(0);
  };

  function openQuickView(product, trigger) {
    if (!product) return;
    const ui = ensureQuickView();

    quickViewProduct = product;
    quickViewReturnFocus = trigger || document.activeElement;

    ui.title.textContent = product.title;
    ui.desc.textContent =
      (product.description && String(product.description).trim()) ||
      "A LUR\u00C9I piece finished for quiet, everyday luxury.";

    const was = toNumber(product.originalPrice);
    const now = toNumber(product.price);
    ui.price.replaceChildren();
    if (was !== null && now !== null && was > now) {
      const wasEl = document.createElement("span");
      wasEl.className = "quickview__was";
      wasEl.textContent = formatPrice(was);
      const nowEl = document.createElement("span");
      nowEl.textContent = formatPrice(now);
      ui.price.append(wasEl, nowEl);
    } else {
      ui.price.textContent = formatPrice(product.price);
    }

    const soldOut = isSoldOut(product);
    ui.addBtn.disabled = soldOut;
    ui.addBtn.textContent = soldOut ? "Out of Stock" : "Add to Bag";

    setQuickViewQty(1);
    buildQuickViewGallery(ui, product);

    ui.overlay.classList.add("is-open");
    ui.overlay.setAttribute("aria-hidden", "false");
    ui.modal.hidden = false;
    ui.modal.classList.add("quickview--open");
    document.body.classList.add("lock-scroll");
    window.requestAnimationFrame(() => ui.closeBtn.focus());
  }

  function closeQuickView() {
    const ui = quickViewEl;
    if (!ui || ui.modal.hidden) return;
    ui.modal.classList.remove("quickview--open");
    ui.modal.hidden = true;
    ui.overlay.classList.remove("is-open");
    ui.overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("lock-scroll");

    if (
      quickViewReturnFocus &&
      typeof quickViewReturnFocus.focus === "function" &&
      document.contains(quickViewReturnFocus)
    ) {
      quickViewReturnFocus.focus();
    }
    quickViewReturnFocus = null;
    quickViewProduct = null;
  }

  /* The whole card is the tap target (photo, copy and the ivory padding alike).
     Skipped while the admin editor is active, and any tap that lands on a card
     control is handed back to that control: the Add to Cart and wishlist
     handlers stay untouched, and the expand badge stays owned by the lightbox. */
  document.addEventListener("click", (event) => {
    if (document.body.classList.contains("lurei-edit-mode")) return;

    const card = event.target.closest(".product-card");
    if (!card) return;

    if (
      event.target.closest(
        "button, a, .wishlist-heart, .product-card__cta, .lurei-card-tools, [data-lurei-action], [data-lurei-inline]"
      )
    ) {
      return;
    }

    const product = catalogue.find((p) => String(p.id) === String(card.dataset.productId));
    if (!product) return;

    event.preventDefault();
    openQuickView(product, card);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeQuickView();
  });

  /* ------------------------------------------------------------------ *
   * 7. Checkout modal
   * ------------------------------------------------------------------ */
  const modal = $("#checkout-modal");
  const modalOverlay = $("#checkout-overlay");
  const modalClose = $("#checkout-close");
  const checkoutClose = modalClose;
  const checkoutForm = $("#checkout-form");
  const checkoutSuccess = $("#checkout-success");
  const summaryLabel = $("#checkout-items-label");
  const summaryTotal = $("#checkout-summary-total");
  const submitTotal = $("#checkout-submit-total");
  const payOptions = document.querySelectorAll('input[name="payment"]');

  const openCheckout = () => {
    if (cart.length === 0) return;
    closeDrawer();

    const count = cartCount();
    summaryLabel.textContent = `Items (${count})`;
    summaryTotal.textContent = formatPrice(cartTotal());
    const submitCurrencyEl = $("#checkout-submit-currency");
    if (submitCurrencyEl) {
      submitCurrencyEl.textContent = activeCurrency === "INR" ? "\u20B9" : "AED";
    }
    submitTotal.textContent = activeCurrency === "INR"
      ? toDisplayNumber(cartTotal()).toLocaleString("en-IN")
      : cartTotal().toFixed(2);

    modal.hidden = false;
    modalOverlay.classList.add("is-open");
    modal.classList.add("modal--open");
    document.body.classList.add("lock-scroll");

    const firstField = $("#cust-name");
    if (firstField) setTimeout(() => firstField.focus(), 120);
  };

  const closeCheckout = () => {
    modal.hidden = true;
    modalOverlay.classList.remove("is-open");
    modal.classList.remove("modal--open");
    renderCartItems();
    document.body.classList.remove("lock-scroll");
  };

  const resetCheckoutView = () => {
    checkoutForm.hidden = false;
    checkoutSuccess.hidden = true;
    checkoutForm.reset();
    payOptions.forEach((radio) => {
      radio.closest(".pay-option").classList.toggle("is-selected", radio.checked);
    });
  };

  const buildOrderReference = () => `LUREI-${Date.now().toString().slice(-6)}`;

  /* The drawer, modal and overlay only exist on storefront pages. Pages that
     load this file without them (admin dashboard, admin login) must not have
     the whole script abort here, or nothing defined further down ever
     registers. */
  if (checkoutBtn) {
    checkoutBtn.addEventListener("click", openCheckout);
  }
  if (checkoutClose) {
    checkoutClose.addEventListener("click", () => {
      resetCheckoutView();
      closeCheckout();
    });
  }

  if (modalOverlay) {
    modalOverlay.addEventListener("click", () => {
      resetCheckoutView();
      closeCheckout();
    });
  }

  payOptions.forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".pay-option").forEach((option) => {
        option.classList.remove("is-selected");
      });
      radio.closest(".pay-option").classList.add("is-selected");
    });
  });

  /* High-end jsPDF invoice — luxury black & gold Order Invoice */
  const generateLureiInvoice = ({ orderId, name, phone, email, address, paymentLabel, items, totalPrice }) => {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      console.error("[Invoice] jsPDF library not loaded.");
      return;
    }
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const marginX = 48;
      const WHITE = [255, 255, 255];        // #FFFFFF — Crisp White
      const BLACK = [17, 17, 17];           // #111111 — Rich Black
      const CHARCOAL = [51, 51, 51];        // #333333 — body / customer details
      const GOLD = [212, 175, 55];          // #D4AF37 — Metallic Gold accents
      const GREY_ROW = [249, 249, 249];     // #F9F9F9 — alternating table rows
      const GRID = [229, 229, 229];         // #E5E5E5 — subtle table gridlines
      const FOOTER_GREY = [102, 102, 102];  // #666666 — footer message

      /* Crisp White canvas — pure, clean #FFFFFF background */
      doc.setFillColor(...WHITE);
      doc.rect(0, 0, pageW, pageH, "F");

      /* Deep rich black header band with a metallic gold 1pt underline */
      doc.setFillColor(...BLACK);
      doc.rect(0, 0, pageW, 96, "F");
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1);
      doc.line(0, 96, pageW, 96);

      doc.setTextColor(...WHITE);
      doc.setFont("times", "bold");
      doc.setFontSize(26);
      doc.text("LUREI DUBAI", marginX, 50);
      doc.setTextColor(...GOLD);
      doc.setFont("times", "normal");
      doc.setFontSize(9);
      doc.text("FINE JEWELLERY & ACCESSORIES", marginX, 68);
      doc.setTextColor(...WHITE);
      doc.setFont("times", "bold");
      doc.setFontSize(14);
      doc.text("OFFICIAL INVOICE", pageW - marginX, 52, { align: "right" });

      /* Order meta — rich black headings, charcoal body */
      let y = 138;
      doc.setFont("times", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...BLACK);
      doc.text(`Order Reference: #${orderId}`, marginX, y);
      doc.setFont("times", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...CHARCOAL);
      y += 18;
      doc.text(`Date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, marginX, y);
      doc.text(`Payment Method: ${paymentLabel}`, marginX + 300, y);

      /* Customer details — two-tone serif fields (black labels, charcoal values) */
      const drawInvoiceField = (labelText, value, x, yPos) => {
        doc.setFont("times", "bold");
        doc.setTextColor(...BLACK);
        doc.text(`${labelText}:`, x, yPos);
        const labelWidth = doc.getTextWidth(`${labelText}: `);
        doc.setFont("times", "normal");
        doc.setTextColor(...CHARCOAL);
        doc.text(value, x + labelWidth, yPos);
      };

      y += 34;
      doc.setFont("times", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...BLACK);
      doc.text("CUSTOMER DETAILS", marginX, y);
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(0.75);
      doc.line(marginX, y + 4, marginX + 64, y + 4);
      doc.setFontSize(10);

      y += 20;
      drawInvoiceField("Name", name, marginX, y);
      drawInvoiceField("Phone", phone, marginX + 300, y);
      y += 16;
      drawInvoiceField("Email", email, marginX, y);
      y += 20;

      /* Delivery address — wrapping, black label + charcoal value */
      const addrLabel = "Delivery Address";
      doc.setFont("times", "bold");
      doc.setTextColor(...BLACK);
      doc.text(`${addrLabel}:`, marginX, y);
      const addrLabelWidth = doc.getTextWidth(`${addrLabel}: `);
      doc.setFont("times", "normal");
      doc.setTextColor(...CHARCOAL);
      const addressLines = doc.splitTextToSize(address, pageW - marginX * 2 - addrLabelWidth);
      addressLines.slice(0, 2).forEach((line, i) => {
        doc.text(line, marginX + addrLabelWidth, y + i * 14);
      });

      y += (addressLines.length > 1 ? 32 : 16) + 10;
      y = Math.max(y, 286);

      /* Order summary — black header row, white / soft-grey alternating rows,
         fine #E5E5E5 grid lines */
      const separators = [250, 300, 410];
      const colRight = { qty: 295, price: 405, total: 542 };
      const ROW_H = 22;

      const drawTableHeader = (yPos) => {
        doc.setFillColor(...BLACK);
        doc.rect(marginX, yPos, pageW - marginX * 2, 24, "F");
        doc.setTextColor(...WHITE);
        doc.setFont("times", "bold");
        doc.setFontSize(10);
        doc.text("PRODUCT", marginX + 10, yPos + 16);
        doc.text("QTY", colRight.qty, yPos + 16, { align: "right" });
        doc.text("PRICE", colRight.price, yPos + 16, { align: "right" });
        doc.text("TOTAL", colRight.total, yPos + 16, { align: "right" });
        doc.setDrawColor(...GRID);
        doc.setLineWidth(0.4);
        doc.line(marginX, yPos + 24, pageW - marginX, yPos + 24);
      };

      drawTableHeader(y);
      y += 24;

      let rowIndex = 0;
      items.forEach(({ title, price, quantity }) => {
        if (y + ROW_H > pageH - 90) {
          doc.addPage();
          y = 60;
          drawTableHeader(y);
          y += 24;
          rowIndex = 0;
        }

        const rowTop = y;
        doc.setFillColor(rowIndex % 2 === 0 ? WHITE : GREY_ROW);
        doc.rect(marginX, rowTop, pageW - marginX * 2, ROW_H, "F");

        const unitPrice = formatPrice(price).replace(/^(AED|\u20B9)\s*/, "");
        const lineTotal = formatPrice(price * quantity).replace(/^(AED|\u20B9)\s*/, "");

        doc.setFont("times", "normal");
        doc.setFontSize(9.5);
        doc.setTextColor(...CHARCOAL);
        doc.text(String(title).slice(0, 44), marginX + 10, rowTop + 16);
        doc.text(String(quantity), colRight.qty, rowTop + 16, { align: "right" });
        doc.text(unitPrice, colRight.price, rowTop + 16, { align: "right" });
        doc.text(lineTotal, colRight.total, rowTop + 16, { align: "right" });

        doc.setDrawColor(...GRID);
        doc.setLineWidth(0.4);
        separators.forEach((x) => doc.line(x, rowTop, x, rowTop + ROW_H));
        doc.line(marginX, rowTop + ROW_H, pageW - marginX, rowTop + ROW_H);

        y = rowTop + ROW_H;
        rowIndex++;
      });

      /* Total — solid gold accent divider, bold black figures */
      y += 26;
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1.2);
      doc.line(marginX, y, pageW - marginX, y);
      y += 24;
      doc.setFont("times", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...BLACK);
      doc.text("TOTAL", marginX, y);
      doc.text(formatPrice(totalPrice), pageW - marginX, y, { align: "right" });

      /* Footer — italic serif, soft charcoal grey */
      y += 44;
      doc.setFont("times", "italic");
      doc.setFontSize(10);
      doc.setTextColor(...FOOTER_GREY);
      doc.text("Thank you for choosing LUREÍ Dubai \u2014 your order is being prepared.", pageW / 2, y, { align: "center" });

      return doc;
    } catch (error) {
      console.error("[Invoice] generation failed:", error && error.message ? error.message : error);
      return null;
    }
  };

  /** Adds `count` business days to `from`, skipping Saturday and Sunday.
   *  Returns a Date on the target day. */
  const addBusinessDays = (from, count) => {
    const date = new Date(from.getTime());
    let remaining = count;
    while (remaining > 0) {
      date.setDate(date.getDate() + 1);
      const day = date.getDay();
      if (day !== 0 && day !== 6) remaining -= 1;
    }
    return date;
  };

  /** ISO yyyy-mm-dd for a Date, in local time (not UTC, which can shift
   *  the day for shoppers east or west of Greenwich). */
  const toISODate = (date) => {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + month + "-" + day;
  };

  /** Standard quoted window: 2-3 business days out, as an ISO date. */
  const defaultDeliveryDateISO = () => toISODate(addBusinessDays(new Date(), 3));

  /* Past delivery dates are never a real request, so the native date picker
     blocks them instead of failing validation on submit. */
  const deliveryDateInput = $("#cust-delivery-date");
  if (deliveryDateInput) deliveryDateInput.min = toISODate(new Date());

  /* Bound only when the storefront checkout form is on the page: the admin
     dashboard and the admin login load this file for the shared helpers and
     must not have the script abort here. */
  if (checkoutForm) checkoutForm.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!checkoutForm.checkValidity()) {
      checkoutForm.reportValidity();
      return;
    }

    const name = $("#cust-name").value.trim();
    const phone = $("#cust-phone").value.trim();
    const emailInput = $("#cust-email");
    const email = emailInput ? emailInput.value.trim() : "N/A";
    const address = $("#cust-address").value.trim();
    const payment = document.querySelector('input[name="payment"]:checked').value;
    const paymentLabel = payment === "card" ? "Online Payment" : "Cash on Delivery";

    /* Requested delivery date. When the shopper leaves it blank we quote the
       standard 2-3 business day window as an ISO date, which is what the
       admin dashboard shows in its Req. Delivery Date column. */
    const requestedDeliveryDate = deliveryDateInput && deliveryDateInput.value
      ? deliveryDateInput.value
      : defaultDeliveryDateISO();

    const orderId = buildOrderReference();
    const items = [...cart];
    const totalPrice = cartTotal().toFixed(2);

    /* Success panel */
    const emailDd = $("#success-email");
    $("#checkout-order-ref").textContent = orderId;
    $("#success-name").textContent = name;
    $("#success-phone").textContent = phone;
    if (emailDd) emailDd.textContent = email;
    $("#success-address").textContent = address;
    $("#success-payment").textContent = paymentLabel;
    $("#success-total").textContent = formatPrice(totalPrice);

    /* Capture the current order globally so the modal's Download button can
       rebuild the jsPDF invoice reliably from memory — no stale closures
       or null doc references. */
    window.latestLureiOrder = {
      orderId,
      customerName: name,
      phone,
      email,
      address,
      payment: paymentLabel,
      items: [...cart],
      currency: currencyCode(),
      total: totalPrice,
    };

    /* Persist the placed order so the LUREÍ admin panel (admin-dashboard.html)
       can read real order objects instead of dummy data. Appended to the
       'lurei_orders' log; delivery status defaults to "pending". */
    /* Customer fields persist trimmed with a lowercased email (the "N/A"
       sentinel is kept as-is). */
    const orderRecord = {
      orderId,
      customerName: String(name || "").trim(),
      phone: String(phone || "").trim(),
      email: email === "N/A" ? email : String(email || "").trim().toLowerCase(),
      address: String(address || "").trim(),
      payment: paymentLabel,
      paymentMethod: payment,
      requestedDeliveryDate,
      items: cart.map((item) => ({
        title: item.title,
        price: item.price,
        quantity: item.quantity,
      })),
      /* Parsed from the numeric core so a formatted total ("AED 30.00")
         can never persist as NaN and vanish from the dashboard Revenue,
         Orders and Average Order Value cards. */
      totalAED: (() => {
        const match = String(totalPrice == null ? "" : totalPrice).match(/-?\d+(?:\.\d+)?/);
        const parsed = match ? Number(match[0]) : 0;
        return Number.isFinite(parsed) ? parsed : 0;
      })(),
      currencyAtOrder: currencyCode(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    /* Plain-key aliases for consumers that read `total` / `date`: total
       mirrors totalAED and date mirrors createdAt. Code.gs picks known
       fields only, so these never reach the Sheet — they just keep every
       reader of the local record working off the same values. */
    orderRecord.total = orderRecord.totalAED;
    orderRecord.date = orderRecord.createdAt;

    try {
      const ORDERS_KEY = "lurei_orders";
      let stored = [];
      try {
        const parsed = JSON.parse(localStorage.getItem(ORDERS_KEY) || "[]");
        if (Array.isArray(parsed)) stored = parsed;
      } catch {}
      stored.push(orderRecord);
      localStorage.setItem(ORDERS_KEY, JSON.stringify(stored));
    } catch (storageError) {
      /* Storage can genuinely fail (private browsing, quota exceeded, storage
         disabled). Swallowing this loses the order silently while the customer
         still completes it on WhatsApp, so make the failure visible. */
      console.warn("[Orders] could not persist order locally:", storageError && storageError.message);
      if (typeof showLureiToast === "function") {
        showLureiToast(
          "Order not saved to the boutique dashboard. Please contact us with your order reference.",
          "error"
        );
      }
    }

    /* Mirror the order into the shared Google Sheet so it reaches the
       admin dashboard on any device, not just this browser.

       Deliberately not awaited: the shopper has already paid and the
       success panel and WhatsApp handoff must not wait on a network call.
       The same orderId is written here and in the local record, so the
       dashboard, the PDF invoice and the WhatsApp message all agree. */
    if (window.LureiBackend && typeof window.LureiBackend.insertOrder === "function") {
      window.LureiBackend.insertOrder(orderRecord)
        .then((result) => {
          if (result && result.skipped && result.reason === "not-configured") {
            console.info("[Orders] Apps Script not configured; order kept in localStorage only.");
          }
        })
        .catch((uploadError) => {
          console.warn("[Orders] Sheet upload failed:", uploadError && uploadError.message);
          /* The local copy already exists, so the order is not lost — but
             the admin will not see it, so tell the shopper. */
          if (typeof showLureiToast === "function") {
            showLureiToast(
              "Order placed, but not reached our dashboard. Please contact us with your order reference.",
              "error"
            );
          }
        });
    }

    /* Attach the explicit Download Official Invoice handler — a real,
       user-initiated gesture bypasses browser pop-up suppression. Fresh
       listeners only (cloneNode clears any stale bindings). */
    const modalDownloadBtn = document.getElementById("downloadPdfBtn");
    if (modalDownloadBtn) {
      modalDownloadBtn.replaceWith(modalDownloadBtn.cloneNode(true));
      const newDownloadBtn = document.getElementById("downloadPdfBtn");
      if (newDownloadBtn) {
        newDownloadBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const order = window.latestLureiOrder;
          if (!order) return;

          try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();

            const INK = [17, 17, 17];        // #111111 deep black
            const WHITE = [255, 255, 255];
            const GOLD = [212, 175, 55];     // #D4AF37 metallic gold
            const CHARCOAL = [34, 34, 34];   // #222222 crisp charcoal body text
            const ROW_BAR = [26, 26, 26];    // #1A1A1A dark charcoal table bar
            const DIVIDER = [232, 216, 184]; // #E8D8B8 thin gold row dividers
            const GREY = [51, 51, 51];       // thank-you note
            const SOFT = [102, 102, 102];    // #666666 customer care line
            const symbol = order.currency === "INR" ? "Rs." : "AED";

            /* 1 — Sleek modern luxury header */
            doc.setFillColor(...INK);
            doc.rect(0, 0, 210, 32, "F");
            doc.setFont("times", "bold");
            doc.setFontSize(20);
            doc.setTextColor(...WHITE);
            doc.text("L U R E Í  D U B A I", 16, 21);
            doc.setFontSize(8.5);
            doc.setTextColor(...GOLD);
            doc.text("FINE JEWELLERY & ACCESSORIES", 16, 28);
            doc.setFontSize(9.5);
            doc.setTextColor(...WHITE);
            doc.text("OFFICIAL INVOICE", 194, 21, { align: "right" });
            doc.setDrawColor(...GOLD);
            doc.setLineWidth(0.5);
            doc.line(0, 32, 210, 32);

            /* 2 — Clean two-column metadata grid */
            let y = 54;
            doc.setFont("times", "bold");
            doc.setFontSize(9);
            doc.setTextColor(...GOLD);
            doc.text("CUSTOMER DETAILS", 16, y);
            doc.text("ORDER INFORMATION", 194, y, { align: "right" });

            y += 8;
            doc.setFont("times", "normal");
            doc.setFontSize(10);
            doc.setTextColor(...CHARCOAL);
            doc.text(order.customerName, 16, y);
            doc.text(`Order Reference: ${order.orderId}`, 194, y, { align: "right" });
            y += 5.5;
            doc.text(order.phone, 16, y);
            doc.text(`Order Date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, 194, y, { align: "right" });
            y += 5.5;
            doc.text(order.email, 16, y);
            doc.text(`Payment Method: ${order.payment}`, 194, y, { align: "right" });
            y += 6.5;
            const addrLines = doc.splitTextToSize(order.address, 92);
            addrLines.slice(0, 3).forEach((line, i) => {
              doc.text(line, 16, y + i * 5);
            });
            y += Math.min(addrLines.length, 3) * 5 + 6;

            /* 3 — Minimalist high-end product table */
            const tableX = 16;
            const tableW = 194;
            const rowH = 7.5;
            doc.setFillColor(...ROW_BAR);
            doc.rect(tableX, y, tableW - tableX, 8, "F");
            doc.setFont("times", "bold");
            doc.setFontSize(9);
            doc.setTextColor(...WHITE);
            doc.text("ITEM DESCRIPTION", tableX + 3, y + 5.5);
            doc.text("QTY", 130, y + 5.5, { align: "right" });
            doc.text("PRICE", 160, y + 5.5, { align: "right" });
            doc.text("TOTAL", tableW - 3, y + 5.5, { align: "right" });
            y += 8;

            doc.setFont("times", "normal");
            doc.setTextColor(...CHARCOAL);
            let calculatedSubtotal = 0;
            order.items.forEach((item) => {
              const qty = item.quantity || 1;
              const unitPrice = order.currency === "INR" ? Math.round(item.price * 26.08) : item.price;
              const itemTotal = unitPrice * qty;
              calculatedSubtotal += itemTotal;
              doc.text(String(item.title || "Jewellery Item").slice(0, 44), tableX + 3, y + 4.5);
              doc.text(String(qty), 130, y + 4.5, { align: "right" });
              doc.text(`${symbol} ${unitPrice}`, 160, y + 4.5, { align: "right" });
              doc.text(`${symbol} ${itemTotal}`, tableW - 3, y + 4.5, { align: "right" });
              doc.setDrawColor(...DIVIDER);
              doc.setLineWidth(0.2);
              doc.line(tableX, y + rowH, tableW, y + rowH);
              y += rowH;
            });

            /* 4 — Rich totals block (subtle gold-bordered container) */
            y += 4;
            const boxTop = y;
            const boxX = 108;
            doc.setDrawColor(...GOLD);
            doc.setLineWidth(0.4);
            doc.rect(boxX, boxTop, tableW - boxX, 30, "S");
            doc.setFont("times", "normal");
            doc.setFontSize(10);
            doc.setTextColor(...CHARCOAL);
            doc.text("Subtotal", boxX + 4, boxTop + 9);
            doc.text(`${symbol} ${calculatedSubtotal.toLocaleString()}`, tableW - 4, boxTop + 9, { align: "right" });
            doc.text("Shipping", boxX + 4, boxTop + 16);
            doc.text("Complimentary", tableW - 4, boxTop + 16, { align: "right" });
            doc.setFont("times", "bold");
            doc.setFontSize(12);
            doc.setTextColor(...INK);
            doc.text("Final Total", boxX + 4, boxTop + 25);
            doc.text(`${symbol} ${calculatedSubtotal.toLocaleString()}`, tableW - 4, boxTop + 25, { align: "right" });

            /* 5 — Balanced elegant footer */
            const footerY = 268;
            doc.setDrawColor(...GOLD);
            doc.setLineWidth(0.4);
            doc.line(16, footerY, 194, footerY);
            doc.setFont("times", "normal");
            doc.setFontSize(9.5);
            doc.setTextColor(...GREY);
            doc.text("Thank you for your order. We hope you love your piece.", 105, footerY + 8, { align: "center" });
            doc.setFontSize(8.5);
            doc.setTextColor(...SOFT);
            doc.text("Customer Care: +971 525303886 | LUREÍ Dubai", 105, footerY + 15, { align: "center" });

            doc.save(`LUREI_Invoice_${order.orderId}.pdf`);
          } catch (err) {
            console.error("jsPDF Execution Error:", err);
            alert("PDF generation in progress...");
          }
        });
      }
    }

    /* WhatsApp order message — clean plain text with zero asterisks,
       reliable \n newlines, and currency-aware items and total. */
    const currentCurrency = currencyCode();
    const formattedItems = items
      .map((item) => {
        const price = currentCurrency === "INR" ? Math.round(item.price * 26.08) : item.price;
        const currencySymbol = currentCurrency === "INR" ? "₹ " : "AED ";
        return `\u2022 ${item.title || "Item"} x${item.quantity || 1} \u2014 ${currencySymbol}${price}`;
      })
      .join("\n");

    const currencyLabel = currentCurrency === "INR" ? "₹ " : "AED ";
    const calculatedTotal = currentCurrency === "INR" ? Math.round(totalPrice * 26.08) : totalPrice;

    const waMessage =
`Hello LUREÍ Dubai Team,

I would like to place a new order:

Order Reference: ${orderId}
Customer Name: ${name}
Phone: ${phone}
Email: ${email}
Delivery Address: ${address}
Payment Choice: ${paymentLabel}

Selected Products:
${formattedItems}

Total Amount: ${currencyLabel}${calculatedTotal}

Note: I confirm my order and will download my Official PDF Invoice. Please confirm delivery timeline.

Thank you!`;

    const encodedWaUrl = `https://wa.me/971525303886?text=${encodeURIComponent(waMessage)}`;

    /* WhatsApp routing — opened safely (noopener) after a 500ms delay so the
       Order Placed panel renders first and the user-initiated PDF download
       is not affected by pop-up suppression. */
    setTimeout(() => {
      if (encodedWaUrl) {
        window.open(encodedWaUrl, "_blank", "noopener,noreferrer");
      }
    }, 500);

    /* Order alert email to lureiaccessories@gmail.com (FormSubmit) */
    fetch(`https://formsubmit.co/ajax/${CONFIG.CONTACT_EMAIL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone,
        address,
        payment: paymentLabel,
        orderId,
        message: waMessage,
        _subject: `New LUREÍ order ${orderId} from ${name}`,
        _template: "table",
        _captcha: "false",
      }),
    }).catch(() => {});

    /* Order SMS alert to the boutique (Brevo v3 SMS) */
    sendSmsAlert(
      `New LUREÍ order ${orderId}\n` +
        `Customer: ${name}\n` +
        `Phone: ${phone}\n` +
        `Total: AED ${totalPrice}\n` +
        `Payment: ${paymentLabel}`
    );

    checkoutForm.hidden = true;
    checkoutSuccess.hidden = false;

    cart = [];
    saveCart();
    updateBadge();
    renderCartItems();
  });

  const checkoutDoneBtn = $("#checkout-done");
  if (checkoutDoneBtn) {
    checkoutDoneBtn.addEventListener("click", () => {
      resetCheckoutView();
      closeCheckout();
    });
  }

  /* ------------------------------------------------------------------ *
   * 7c. Wishlist (localStorage + slide-out drawer)
   * ------------------------------------------------------------------ */
  const WISHLIST_STORAGE_KEY = "lurei_wishlist";

  const readWishlist = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(WISHLIST_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  let wishlist = readWishlist();

  const saveWishlist = () => {
    try {
      localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(wishlist));
    } catch {}
  };

  const hasWishlist = (id) => wishlist.some((p) => String(p.id) === String(id));

  const toggleWishlist = (id, productDetails) => {
    const index = wishlist.findIndex((p) => String(p.id) === String(id));
    if (index !== -1) {
      wishlist.splice(index, 1);
    } else if (productDetails) {
      wishlist.push(productDetails);
    }
    saveWishlist();
    syncWishlistHearts();
    renderWishlist();
    updateWishlistBadge();
  };

  const wishlistBadge = $(".wishlist-badge");

  const updateWishlistBadge = () => {
    if (!wishlistBadge) return;
    const count = wishlist.length;
    wishlistBadge.textContent = String(count);
    wishlistBadge.dataset.wishlistCount = String(count);
    wishlistBadge.classList.toggle("is-hidden", count === 0);
  };

  const syncWishlistHearts = () => {
    document.querySelectorAll(".wishlist-heart").forEach((heart) => {
      const active = hasWishlist(heart.dataset.wishlistAdd);
      heart.classList.toggle("is-wishlisted", active);
      const productName = heart.dataset.wishlistTitle || "item";
      heart.setAttribute("aria-label", `${active ? "Remove" : "Add"} ${productName} ${active ? "from" : "to"} wishlist`);
    });
  };

  const wishlistDrawerEl = $("#wishlistDrawer");
  const wishlistOverlayEl = $("#wishlist-overlay");
  const wishlistItemsEl = $("#wishlist-items");
  const wishlistCloseEl = $("#wishlist-close");

  const openWishlist = () => {
    renderWishlist();
    if (wishlistDrawerEl) wishlistDrawerEl.classList.add("is-open");
    if (wishlistOverlayEl) wishlistOverlayEl.classList.add("is-open");
    document.body.classList.add("lock-scroll");
  };

  const closeWishlist = () => {
    if (wishlistDrawerEl) wishlistDrawerEl.classList.remove("is-open");
    if (wishlistOverlayEl) wishlistOverlayEl.classList.remove("is-open");
    if (!overlay.classList.contains("is-open") && !modal.classList.contains("modal--open")) {
      document.body.classList.remove("lock-scroll");
    }
  };

  const buildWishlistEmpty = () => {
    const wrap = document.createElement("div");
    wrap.className = "wishlist-empty";
    wrap.innerHTML =
      '<span class="wishlist-empty__icon" aria-hidden="true">&#9825;</span>' +
      '<p class="wishlist-empty__title">Your Wishlist is Empty</p>' +
      '<p class="wishlist-empty__text">Tap the heart on any piece to save it here.</p>';
    return wrap;
  };

  const buildWishlistItem = (product) => {
    const item = document.createElement("div");
    item.className = "wishlist-item";
    item.dataset.id = product.id;

    const media = document.createElement("div");
    media.className = "wishlist-item__media";

    if (product.image && typeof product.image === "string") {
      const img = document.createElement("img");
      img.alt = product.title;
      img.width = 72;
      img.height = 72;
      img.loading = "lazy";
      wireImage(img, product, () =>
        img.replaceWith(buildPlaceholder("wishlist-item__placeholder", product))
      );
      media.appendChild(img);
    } else {
      media.appendChild(buildPlaceholder("wishlist-item__placeholder", product));
    }

    const info = document.createElement("div");
    info.className = "wishlist-item__info";

    const title = document.createElement("p");
    title.className = "wishlist-item__title";
    title.textContent = product.title;

    const price = document.createElement("p");
    price.className = "wishlist-item__price";
    price.textContent = formatPrice(product.price);

    info.append(title, price);

    const actions = document.createElement("div");
    actions.className = "wishlist-item__actions";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "wishlist-item__remove";
    remove.dataset.wishlistRemove = String(product.id);
    remove.setAttribute("aria-label", `Remove ${product.title} from wishlist`);
    remove.textContent = "Remove";

    const bag = document.createElement("button");
    bag.type = "button";
    bag.className = "wishlist-item__bag";
    bag.dataset.wishlistToBag = String(product.id);
    bag.innerHTML = `${CART_ICON}<span>Add to Bag</span>`;
    bag.setAttribute("aria-label", `Add ${product.title} to bag`);

    actions.append(remove, bag);
    item.append(media, info, actions);
    return item;
  };

  const renderWishlist = () => {
    if (!wishlistItemsEl) return;
    if (wishlistDrawerEl) wishlistDrawerEl.classList.toggle("is-empty", wishlist.length === 0);
    if (wishlist.length === 0) {
      wishlistItemsEl.replaceChildren(buildWishlistEmpty());
      return;
    }
    const fragment = document.createDocumentFragment();
    wishlist.forEach((product) => fragment.appendChild(buildWishlistItem(product)));
    wishlistItemsEl.replaceChildren(fragment);
  };

  /* ------------------------------------------------------------------ *
   * 8. Global event wiring (delegation + keyboard)
   * ------------------------------------------------------------------ */
  document.addEventListener("click", (event) => {
    const openWishBtn = event.target.closest("#wishlist-open");
    if (openWishBtn) {
      openWishlist();
      return;
    }

    const heartBtn = event.target.closest("[data-wishlist-add]");
    if (heartBtn) {
      const wishId = heartBtn.dataset.wishlistAdd;
      const product = catalogue.find((p) => String(p.id) === String(wishId));
      toggleWishlist(wishId, product || { id: wishId });
      return;
    }

    const wishRemoveBtn = event.target.closest("[data-wishlist-remove]");
    if (wishRemoveBtn) {
      toggleWishlist(wishRemoveBtn.dataset.wishlistRemove, null);
      return;
    }

    const toBagBtn = event.target.closest("[data-wishlist-to-bag]");
    if (toBagBtn) {
      closeWishlist();
      addToCart(toBagBtn.dataset.wishlistToBag);
      return;
    }

    const addBtn = event.target.closest("[data-add]");
    if (addBtn) {
      addToCart(addBtn.dataset.add);
      return;
    }

    const cartIcon = event.target.closest(".cart-btn");
    if (cartIcon) {
      openDrawer();
      return;
    }

    if (event.target === overlay) closeDrawer();
    if (event.target.closest("#cart-close")) closeDrawer();
    if (event.target === wishlistOverlayEl) closeWishlist();
    if (event.target.closest("#wishlist-close")) closeWishlist();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (!modal.hidden) {
      resetCheckoutView();
      closeCheckout();
      return;
    }

    if (drawer.classList.contains("is-open")) closeDrawer();
    if (wishlistDrawerEl && wishlistDrawerEl.classList.contains("is-open")) closeWishlist();
  });

  /* ------------------------------------------------------------------ *
   * 8b. Service modals — Contact & Customer Care (footer links)
   * ------------------------------------------------------------------ */
  const SERVICE_MODAL_HTML = `
    <div class="modal-overlay" id="contact-overlay" aria-hidden="true"></div>
    <div class="modal" id="contact-modal" role="dialog" aria-modal="true" aria-labelledby="contact-title" hidden>
      <div class="modal__card">
        <header class="modal__head">
          <h2 class="modal__title" id="contact-title">Contact Us</h2>
          <button class="modal__close" type="button" data-close-service="contact" aria-label="Close contact">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </header>
        <p class="checkout-success__note">Customer Care &mdash; lureiaccessories@gmail.com &bull; WhatsApp &amp; SMS &mdash; +971 52 530 3886. We reply within 24 hours.</p>
        <form class="checkout-form" id="contact-modal-form" data-lurei-contact onsubmit="return false;">
          <div class="field">
            <label class="field__label" for="contact-name">YOUR NAME</label>
            <input class="field__input" id="contact-name" name="name" type="text" placeholder="Your full name" autocomplete="name" required />
          </div>
          <div class="field">
            <label class="field__label" for="contact-email">EMAIL ADDRESS</label>
            <input class="field__input" id="contact-email" name="email" type="email" placeholder="you@email.com" autocomplete="email" required />
          </div>
          <div class="field">
            <label class="field__label" for="contact-phone">PHONE NUMBER</label>
            <input class="field__input" id="contact-phone" name="phone" type="tel" placeholder="+971 50 123 4567" autocomplete="tel" required />
          </div>
          <div class="field">
            <label class="field__label" for="contact-message">MESSAGE</label>
            <textarea class="field__input" id="contact-message" name="message" rows="4" placeholder="How can we help you?" required></textarea>
          </div>
          <button class="btn btn--checkout btn--checkout-block" type="submit">SEND MESSAGE</button>
        </form>
      </div>
    </div>

    <div class="modal-overlay" id="stores-overlay" aria-hidden="true"></div>
    <div class="modal" id="stores-modal" role="dialog" aria-modal="true" aria-labelledby="stores-title" hidden>
      <div class="modal__card">
        <header class="modal__head">
          <h2 class="modal__title" id="stores-title">Connect With Us</h2>
          <button class="modal__close" type="button" data-close-service="stores" aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </header>
        <p class="checkout-success__note">LURE&Iacute; Dubai is an exclusive online jewellery store. We are always here to help you pick the perfect piece, answer questions, or track your order.</p>
        <div class="checkout-summary">
          <div class="checkout-summary__row"><span><strong>WhatsApp Support</strong></span><span>24/7 Digital Assistant</span></div>
          <p style="margin:0.4rem 0 0.8rem;font-size:0.8rem;color:var(--color-muted);">Instant help for order status, styling suggestions, and delivery queries.</p>
          <a class="btn btn--gold" style="width:100%;" href="https://wa.me/971525303886" target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a>
        </div>
        <div class="checkout-summary">
          <div class="checkout-summary__row"><span><strong>Official Instagram</strong></span><span>Daily Styling Notes &amp; DMs</span></div>
          <p style="margin:0.4rem 0 0.8rem;font-size:0.8rem;color:var(--color-muted);">Follow us for new designs, video previews, and direct messages.</p>
          <a class="btn btn--gold" style="width:100%;" href="https://www.instagram.com/lurei.ae/" target="_blank" rel="noopener noreferrer">Visit Instagram (@lurei.ae)</a>
        </div>
      </div>
    </div>
  `;

  const buildServiceModals = () => {
    if (!document.getElementById("contact-modal")) {
      document.body.insertAdjacentHTML("beforeend", SERVICE_MODAL_HTML);
    }
  };

  const openServiceModal = (name) => {
    const overlayEl = document.getElementById(`${name}-overlay`);
    const modalEl = document.getElementById(`${name}-modal`);
    if (!overlayEl || !modalEl) return;
    closeServiceModals();
    if (drawer.classList.contains("is-open")) closeDrawer();
    if (wishlistDrawerEl && wishlistDrawerEl.classList.contains("is-open")) closeWishlist();
    overlayEl.classList.add("is-open");
    modalEl.hidden = false;
    modalEl.classList.add("modal--open");
    document.body.style.overflow = "hidden";
  };

  const closeServiceModals = () => {
    ["contact", "stores"].forEach((name) => {
      const overlayEl = document.getElementById(`${name}-overlay`);
      const modalEl = document.getElementById(`${name}-modal`);
      if (modalEl) modalEl.hidden = true;
      if (overlayEl) overlayEl.classList.remove("is-open");
    });
    document.body.style.overflow = "";
  };

  /* Sleek brand toast — injected locally, no shared styles touched */
  const showAppToast = (message) => {
    let toast = $("#app-toast");
    if (!toast) {
      const style = document.createElement("style");
      style.textContent =
        "#app-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:999;" +
        "background:#1A1815;color:#FAF8F5;font-family:'Plus Jakarta Sans',sans-serif;font-size:0.82rem;font-weight:500;" +
        "letter-spacing:0.02em;line-height:1.5;padding:0.85rem 1.4rem;border-radius:999px;" +
        "border:1px solid rgba(197,160,89,0.55);box-shadow:0 18px 40px -18px rgba(26,26,26,0.65);" +
        "opacity:0;pointer-events:none;transition:opacity 0.35s ease, transform 0.35s ease;max-width:min(92vw, 540px);text-align:center}" +
        "#app-toast.is-visible{opacity:1;transform:translateX(-50%) translateY(0)}";
      document.head.appendChild(style);
      toast = document.createElement("div");
      toast.id = "app-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove("is-visible"), 5200);
  };

  /* Multi-channel inquiry — WhatsApp redirect + Email (FormSubmit) + SMS webhook */
  const handleLureiContactSubmit = (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;

    if (form.checkValidity && !form.checkValidity()) {
      if (form.reportValidity) form.reportValidity();
      return;
    }

    const field = (name) => {
      const el = form.querySelector(`[name="${name}"]`);
      return el ? String(el.value || "").trim() : "";
    };
    const name = field("name");
    const email = field("email");
    const phone = field("phone");
    const message = field("message") || "No message provided.";

    /* Trigger 1 — WhatsApp redirect with pre-filled inquiry template */
    const messageTemplate =
      `Hello LUREÍ Dubai Team,\n\n` +
      `My name is ${name}.\n\n` +
      `Inquiry:\n${message}\n\n` +
      `Kindly reach back to me using my details below:\n` +
      `• Email: ${email}\n` +
      `• Phone: ${phone}\n\n` +
      `Thank you!`;

    const waUrl = `https://wa.me/971525303886?text=${encodeURIComponent(messageTemplate)}`;
    window.open(waUrl, "_blank", "noopener,noreferrer");

    /* Trigger 2 — Email alert to lureiaccessories@gmail.com (FormSubmit AJAX) */
    fetch(`https://formsubmit.co/ajax/${CONFIG.CONTACT_EMAIL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone,
        message,
        _subject: `New LUREÍ Dubai customer inquiry from ${name}`,
        _template: "table",
        _body: messageTemplate,
        _captcha: "false",
      }),
    }).catch(() => {});

    /* Trigger 3 — SMS alert to the boutique (Brevo v3 SMS) */
    sendSmsAlert(
      `LUREÍ customer inquiry from ${name}: ${message} — reach back at ${phone}`
    );

    showAppToast(
      "Message sent. We reply within 24 hours."
    );

    form.reset();

    if (form.closest(".modal")) setTimeout(closeServiceModals, 600);
  };

  const bindServiceModals = () => {
    buildServiceModals();

    document.addEventListener("submit", (event) => {
      if (event.target.matches("form[data-lurei-contact]")) {
        handleLureiContactSubmit(event);
      }
    });

    document.addEventListener("click", (event) => {
      const opener = event.target.closest("[data-open-service]");
      if (opener) {
        event.preventDefault();
        openServiceModal(opener.dataset.openService);
        return;
      }
      const closer = event.target.closest("[data-close-service]");
      if (closer) {
        event.preventDefault();
        closeServiceModals();
        return;
      }
      const serviceModalEl = event.target.closest("[id$='-modal']");
      if (serviceModalEl && event.target === serviceModalEl) closeServiceModals();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeServiceModals();
    });
  };

  /* In-page anchors — smooth scroll with shared CSS fallback */
  const bindSmoothAnchors = () => {
    document.addEventListener("click", (event) => {
      const anchor = event.target.closest('a[href^="#"]');
      if (!anchor) return;
      const hrefAttr = anchor.getAttribute("href");
      if (hrefAttr === "#" || anchor.hasAttribute("data-open-service")) return;
      const anchorTarget = document.getElementById(hrefAttr.slice(1));
      if (!anchorTarget) return;
      event.preventDefault();
      anchorTarget.scrollIntoView({ behavior: "smooth", block: "start" });
      /* Only the hash changes: rebuilding the URL from hrefAttr alone would
         drop the current path AND query string, collapsing parameters the page
         depends on - most importantly collections.html?editMode=true, which
         would silently strip the admin editor from the address bar. */
      if (history.replaceState) {
        history.replaceState(null, "", window.location.pathname + window.location.search + hrefAttr);
      }
    });
  };

  /* ------------------------------------------------------------------ *
   * 9. Data loading (Google Sheets via Apps Script; mock-first)
   * ------------------------------------------------------------------ */
  /* Goes through the shared backend client rather than building its own URL, so
     there is a single place that knows the Apps Script action contract. */
  const fetchFromSheets = async () => {
    const raw = await window.LureiBackend.fetchProducts();
    const products = normalizeProducts(raw);
    if (!products.length) {
      throw new Error("Sheets API returned no usable products.");
    }
    return products;
  };

  /* ------------------------------------------------------------------ *
   * 10. Boot
   * ------------------------------------------------------------------ */
  /* The storefront editor (defined above) layers locally owned changes
     over whichever defaults are used here, so admin edits survive a page
     reload and are never discarded by a Google Sheets refresh. */
  const catalogueStore = window.LureiCatalogue || null;

  const applyCatalogue = (defaults) => {
    seedCatalogue(catalogueStore ? catalogueStore.resolve(defaults) : defaults);
  };

  /* admin-dashboard.html and admin-login.html load this same bundle purely for
     the catalogue store and the backend client - neither carries storefront
     markup. Every storefront-only binding below is gated on this. */
  const hasStorefrontMarkup = () =>
    !!document.querySelector(
      ".cart-drawer, #cart-drawer, #products-container, #collections-container"
    );

  (async () => {
    const defaults = normalizeProducts(products);
    if (catalogueStore && typeof catalogueStore.setDefaults === "function") catalogueStore.setDefaults(defaults);

    const isStorefront = hasStorefrontMarkup();

    /* Mock-first: the built-in catalogue paints before the Sheet is consulted,
       so a slow or unconfigured backend never delays the storefront. */
    if (isStorefront) {
      bindFilters();
      bindCollectionTools();
      bindLoadMore();
      bindCurrencySwitcher();
      syncCurrencySelectors();
      renderPriceFilterOptions();

      const activeParams = new URLSearchParams(window.location.search);
      const selectedCat = activeParams.get("category");
      if (selectedCat && Object.prototype.hasOwnProperty.call(FILTERS, selectedCat)) {
        activeFilter = selectedCat;
      }

      applyCatalogue(defaults);
      applyFilter(activeFilter);
      renderCartItems();
      resetCheckoutView();

      /* Keeps this tab in step with the admin tab and with any other tab that
         the store change came from. */
      if (catalogueStore && typeof catalogueStore.subscribe === "function") {
        catalogueStore.subscribe(() => applyCatalogue(defaults));
      }
    }

    try {
      const live = await fetchFromSheets();
      if (live && live.length) {
        /* The storefront re-renders; the admin pages only need the store to
           hand the dashboard its refreshed list. */
        if (isStorefront) {
          applyCatalogue(live);
        } else if (catalogueStore && typeof catalogueStore.setDefaults === "function") {
          catalogueStore.setDefaults(live);
        }
        console.info("LUREÍ products loaded from Google Sheets.");
      }
    } catch (error) {
      console.info("LUREÍ kept fallback catalogue:", error.message);
    }
  })();

  document.addEventListener("DOMContentLoaded", () => {
    /* Footer year */
    const yearEl = $("[data-year]");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* Header search — redirect to collections with fluid auto-focus */
    const searchBtn = $('.icon-btn[aria-label="Search"]');
    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        if ($("#product-search")) {
          const searchInput = $("#product-search");
          searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => searchInput.focus(), 450);
        } else {
          window.location.href = "collections.html?focusSearch=true";
        }
      });
    }

    /* Auto-focus: collections.html?focusSearch=true -> smooth scroll + focus */
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("focusSearch") === "true") {
      const searchInput =
        document.getElementById("product-search") ||
        document.getElementById("search-input") ||
        document.querySelector(".collection-search__input") ||
        document.querySelector(".search-input");
      if (searchInput) {
        searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => searchInput.focus(), 400);
      }
    }

    /* Wishlist — restore heart states, badge, and drawer on load */
    syncWishlistHearts();
    updateWishlistBadge();
    renderWishlist();

    /* Hero image fallback (local model.jpg may not exist yet) */
    const heroImg = $("#hero-model");
    if (heroImg) {
      heroImg.addEventListener(
        "error",
        () => {
          if (!heroImg.dataset.fallbackApplied && heroImg.dataset.fallbackSrc) {
            heroImg.dataset.fallbackApplied = "1";
            heroImg.src = heroImg.dataset.fallbackSrc;
          }
        },
        { once: false }
      );
    }

    /* Mobile navigation */
    const toggle = $(".nav-toggle");
    const nav = $(".nav");
    if (toggle && nav) {
      toggle.addEventListener("click", () => {
        const open = nav.classList.toggle("nav--open");
        toggle.setAttribute("aria-expanded", String(open));
      });
    }

    /* Footer service modals (Contact / Stores) + in-page smooth anchors */
    bindServiceModals();
    bindSmoothAnchors();

    /* Newsletter form — Formspree onto lureiaccessories@gmail.com, with a
       Brevo welcome-email fallback while FORMSPREE_FORM_ID is unset.
       Single validated listener, trimmed sanitized payload, loading state. */
    const form = $("#newsletter-form");
    const newsletterNote = $("#newsletter-note");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();

        const nameInput = form.querySelector("#newsletter-name");
        const emailInput = form.querySelector("#newsletter-email");
        const nameValue = nameInput ? nameInput.value.trim() : "";
        const emailValue = emailInput ? emailInput.value.trim() : "";

        const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailValue);
        if (!emailValid) {
          showLureiToast("Please enter a valid email address.", "error");
          if (emailInput) emailInput.focus();
          return;
        }

        const submitBtn = form.querySelector("#newsletter-submit");
        const originalButtonHTML = submitBtn ? submitBtn.innerHTML : "";
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.setAttribute("aria-busy", "true");
          submitBtn.innerHTML = "SUBSCRIBING...";
        }

        let sendPromise;
        if (FORMSPREE_FORM_ID) {
          /* Formspree: forwards subscriber data straight to the linked inbox. */
          sendPromise = fetch("https://formspree.io/f/" + FORMSPREE_FORM_ID, {
            method: "POST",
            headers: {
              "accept": "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              name: nameValue || "Valued Customer",
              email: emailValue,
              _subject: "New LUREÍ Circle subscriber",
            }),
          })
            .then((response) => {
              if (!response.ok) {
                return response.json().catch(() => null).then((err) => {
                  const detail =
                    (err && err.errors && err.errors.map((e) => e.message).join(", ")) ||
                    (err && err.error) ||
                    "Formspree responded with status " + response.status;
                  throw new Error(detail);
                });
              }
            });
        } else {
          /* Brevo fallback — welcome email while FORMSPREE_FORM_ID is unset. */
          const displayName = nameValue || "Valued Customer";
          const htmlContent =
            "<div style='font-family:Arial,sans-serif;padding:30px;max-width:600px;margin:0 auto;border:1px solid #eeeeee;'>" +
            "<h1 style='color:#d4af37;text-align:center;'>L U R E &Iacute;</h1>" +
            "<p style='text-align:center;color:#777;'>DUBAI &bull; FINE JEWELRY</p>" +
            "<hr style='border:0;border-top:1px solid #eee;margin:20px 0;'>" +
            "<p>Welcome to LURE&Iacute; Circle, <strong>" + displayName + "</strong>!</p>" +
            "<p>Thank you for subscribing to our exclusive styling updates.</p>" +
            "<p style='color:#999;margin-top:30px;'>Best regards,<br><strong>LURE&Iacute; Team</strong></p></div>";

          const payload = {
            sender: { name: "LUREÍ Dubai", email: "lureiaccessories.s925@gmail.com" },
            to: [{ email: emailValue, name: displayName }],
            subject: "Welcome to LUREÍ Circle!",
            htmlContent: htmlContent,
          };

          sendPromise = fetch(BREVO_CONFIG.endpoint, {
            method: "POST",
            headers: {
              "accept": "application/json",
              "api-key": BREVO_CONFIG.apiKey,
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          }).then((response) => {
            if (!response.ok) {
              return response.json().catch(() => null).then((err) => {
                throw new Error((err && err.message) || "Brevo responded with status " + response.status);
              });
            }
          });
        }

        sendPromise
          .then(() => {
            showLureiToast("Thank you for subscribing!");
            if (newsletterNote) newsletterNote.hidden = false;
            form.reset();
          })
          .catch((error) => {
            console.error("[Newsletter] send failed:", error && error.message ? error.message : error);
            showLureiToast("Something went wrong. Please try again.", "error");
          })
          .finally(() => {
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.removeAttribute("aria-busy");
              submitBtn.innerHTML = originalButtonHTML;
            }
          });
      });
    }

    /* ------------------------------------------------------------------ *
     * 10b. Account auth — Google One-Tap + Auth Modal + profile badge
     * ------------------------------------------------------------------ */
    const GOOGLE_CLIENT_ID = ""; // TODO: paste your Google Cloud OAuth Client ID here
    const AUTH_STORAGE_KEY = "lurei_user";
    /* Admin preview state. grantAdminSession() raises this on a successful
       Admin Access sign-in; the navbar badge and the Administrator card are
       driven off it, so an admin who lands straight on index.html is
       recognised as an admin without authenticating again. */
    const ADMIN_PREVIEW_KEY = "isAdminLoggedIn";

    const authModal = document.getElementById("auth-modal");
    const authClose = document.getElementById("auth-close");
    const authGuest = document.getElementById("auth-guest");
    const navProfileBtn = document.getElementById("nav-profile");
    const authTabs = Array.from(document.querySelectorAll(".auth-tab"));
    const signInForm = document.getElementById("auth-signin-form");
    const createForm = document.getElementById("auth-create-form");
    const signInEmail = document.getElementById("loginEmail") || document.getElementById("auth-signin-email");
    const signInPw = document.getElementById("loginPassword") || document.getElementById("passwordInput") || document.getElementById("auth-signin-password");
    const createName = document.getElementById("auth-create-name");
    const createEmail = document.getElementById("auth-create-email");
    const createPw = document.getElementById("auth-create-password");
    /* Admin Access tab (present on index.html; absent on other pages — guarded) */
    const adminForm = document.getElementById("auth-admin-form");
    const adminEmail = document.getElementById("admin-access-email");
    const adminPw = document.getElementById("admin-access-password");

    /* Force-clear login fields — global, used on load and back-arrow exit */
    window.clearLoginInputs = () => {
      const emailField = document.getElementById("loginEmail");
      const passwordField = document.getElementById("loginPassword");
      if (emailField) emailField.value = "";
      if (passwordField) passwordField.value = "";
      const adminEmailField = document.getElementById("admin-access-email");
      const adminPasswordField = document.getElementById("admin-access-password");
      if (adminEmailField) adminEmailField.value = "";
      if (adminPasswordField) adminPasswordField.value = "";
    };

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", window.clearLoginInputs);
    } else {
      window.clearLoginInputs();
    }

    const readStoredUser = () => {
      try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null"); }
      catch { return null; }
    };
    let currentUser = readStoredUser();

    /* Single authority for "is this browser showing the storefront as an
       admin?". Kept in localStorage (not sessionStorage) so it survives the
       VIEW STORE / Back to Dashboard hand-off between tabs. */
    const isAdminPreviewActive = () => {
      try { return localStorage.getItem(ADMIN_PREVIEW_KEY) === "true"; }
      catch { return false; }
    };

    const firstNameOf = (n) => String(n || "Guest").trim().split(/\s+/)[0] || "Friend";
    const initialsOf = (n) => String(n || "?").trim().split(/\s+/).map((w) => w.charAt(0)).slice(0, 2).join("").toUpperCase();
    const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    /* JWT decode helper for Google credential tokens */
    const decodeJwt = (token) => {
      try {
        const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const json = decodeURIComponent(Array.prototype.map.call(atob(b64), (c) =>
          "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)
        ).join(""));
        return JSON.parse(json);
      } catch { return {}; }
    };

    /* Modal open / close */
    const openAuthModal = (panel = "signin") => {
      if (!authModal) return;
      /* Wipe every field and reset the forms BEFORE the modal is shown so the
         inputs are always empty on open, no matter how it was last closed. */
      resetAuthModal();
      authTabs.forEach((tab) => {
        const p = document.getElementById("auth-panel-" + tab.dataset.authPanel);
        const active = tab.dataset.authPanel === panel;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        if (p) { p.hidden = !active; p.classList.toggle("is-active", active); }
      });
      authModal.hidden = false;
      authModal.style.display = "";
      authModal.removeAttribute("aria-hidden");
      requestAnimationFrame(() => authModal.classList.add("is-open"));
      document.body.style.overflow = "hidden";
    };

    const closeAuthModal = () => {
      if (!authModal) return;
      resetAuthModal();
      authModal.classList.remove("is-open");
      authModal.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
      setTimeout(() => { authModal.hidden = true; }, 280);
    };

    /* Single place that clears every trace of an admin session from the
       storefront, shared by the storefront Sign Out and the storefront
       belt-and-braces cleanup below. */
    const removeAdminPreviewUi = () => {
      try { localStorage.removeItem(ADMIN_PREVIEW_KEY); } catch {}
      try {
        sessionStorage.removeItem("adminLoggedIn");
        sessionStorage.removeItem("lurei_gas_admin_session");
      } catch {}
      /* grantAdminSession() stores the Administrator placeholder as the
         profile, so it has to go too or a stale name would be rebuilt. */
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
      currentUser = null;
      /* No edit UI may survive a sign-out, on any page. */
      document.body.classList.remove("lurei-edit-mode");
      document.querySelectorAll(".lurei-edit-bar, .lurei-add-fab").forEach(function (el) {
        el.remove();
      });
    };

    /* Belt-and-braces: the editor refuses to mount on the homepage, but a flag
       left over from an earlier session must never leave the black bar or
       body padding behind on a customer-facing page. */
    if (window.LureiCatalogue && window.LureiCatalogue.isStorefrontPreviewPage()) {
      document.body.classList.remove("lurei-edit-mode");
      document.querySelectorAll(".lurei-edit-bar, .lurei-add-fab").forEach(function (el) {
        el.remove();
      });
    }

    /* Profile badge + dropdown */
    const patchProfile = () => {
      if (!navProfileBtn) return;
      const old = navProfileBtn.querySelector(".nav-profile__badge");
      if (old) old.remove();
      const oldMenu = navProfileBtn.querySelector(".nav-profile__menu");
      if (oldMenu) oldMenu.remove();

      /* Admin preview takes the badge over with a champagne "A", so an admin
         browsing the storefront is never mistaken for a shopper. Rendered
         from scratch on every patch, so the badge follows sign-in and
         sign-out with no separate state to keep in sync. */
      if (isAdminPreviewActive()) {
        const badge = document.createElement("span");
        badge.className = "nav-profile__badge nav-profile__badge--admin";
        badge.textContent = "A";
        badge.title = "Administrator — storefront preview";
        badge.setAttribute("aria-hidden", "true");
        navProfileBtn.appendChild(badge);
        navProfileBtn.setAttribute("aria-label", "Administrator — account menu");
      } else if (currentUser) {
        const badge = document.createElement("span");
        badge.className = "nav-profile__badge";
        badge.textContent = initialsOf(currentUser.name);
        badge.title = "Hi, " + currentUser.name;
        badge.setAttribute("aria-hidden", "true");
        navProfileBtn.appendChild(badge);
        navProfileBtn.setAttribute("aria-label", "Hi, " + firstNameOf(currentUser.name) + " — account menu");
      } else {
        navProfileBtn.setAttribute("aria-label", "Your account");
      }
    };

    /* Successful auth handler (Google or email) */
    const handleAuthenticated = (user) => {
      currentUser = { name: user.name, email: user.email, photo: user.photo || "" };
      try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(currentUser)); } catch {}
      patchProfile();
      closeAuthModal();
      showLureiToast("Welcome to LUREÍ, " + firstNameOf(currentUser.name) + "!");
    };

    /* Sign-out — also drops any admin session so dashboard guard re-locks */
    const handleSignOut = () => {
      currentUser = null;
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
      try { localStorage.removeItem(ADMIN_PREVIEW_KEY); } catch {}
      try {
        sessionStorage.removeItem("adminLoggedIn");
        sessionStorage.removeItem("lurei_gas_admin_session");
      } catch {}
      patchProfile();
      const m = navProfileBtn ? navProfileBtn.querySelector(".nav-profile__menu") : null;
      if (m) m.remove();
      showLureiToast("You have been signed out.");
    };

    /* Admin sign-out — drops the admin preview flag and every dashboard
       guard key, then reloads so index.html renders the standard customer
       view. Reloading (rather than patching in place) guarantees no stale
       admin badge or Administrator card survives the reset, and re-runs the
       same load path a normal visitor gets. */
    const handleAdminSignOut = () => {
      removeAdminPreviewUi();
      window.location.reload();
    };

    /* Customer Login tab — standard shopper session only. Admin routing
       lives exclusively under the Admin Access tab below. */
    const signInWithEmail = (email) => {
      const normalizedEmail = String(email || "").trim();
      const label = (normalizedEmail.split("@")[0] || "Guest").replace(/[._-]+/g, " ");
      handleAuthenticated({ name: label.charAt(0).toUpperCase() + label.slice(1), email: normalizedEmail });
    };

    /* Raises every flag the dashboard guard accepts, plus the localStorage
       admin session and navbar profile so the storefront renders the
       Administrator card with BACK TO DASHBOARD. */
    const grantAdminSession = (email) => {
      try {
        sessionStorage.setItem("adminLoggedIn", "true");
        sessionStorage.setItem("lurei_gas_admin_session", JSON.stringify({ role: "admin", email: email }));
        localStorage.setItem(ADMIN_PREVIEW_KEY, "true");
        const adminUser = { name: "Administrator", email: email, photo: "", role: "admin" };
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(adminUser));
        currentUser = adminUser;
      } catch {}
      patchProfile();
    };

    /* Create-account (mock) */
    const createAccount = (name, email) => {
      handleAuthenticated({ name: name || "Guest", email: email });
    };

    /* Tab switching */
    authTabs.forEach((tab) => {
      tab.addEventListener("click", () => openAuthModal(tab.dataset.authPanel));
    });

    /* Close handlers */
    if (authClose) authClose.addEventListener("click", () => { resetAuthModal(); closeAuthModal(); });
    if (authGuest) authGuest.addEventListener("click", () => { resetAuthModal(); closeAuthModal(); });
    /* Backdrop click (directly on the scrim, outside the card) resets every
       field and closes the modal. Clicks inside the card — tabs, inputs,
       Google button — bubble here but are ignored, so nothing else changes. */
    if (authModal) {
      authModal.addEventListener("click", (e) => {
        const onScrim = e.target === authModal ||
          (e.target.classList && e.target.classList.contains("auth-modal__wrap"));
        if (onScrim) { resetAuthModal(); closeAuthModal(); }
      });
    }
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAuthModal(); });

    /* Back arrow exit button (#modalBackBtn) — clears fields and closes the auth modal */
    const modalBackBtn = document.getElementById("modalBackBtn");
    if (modalBackBtn) modalBackBtn.addEventListener("click", () => {
      window.clearLoginInputs();
      if (authModal) authModal.style.display = "none";
      closeAuthModal();
    });

    /* Show/Hide password eye toggle (#togglePasswordBtn / #eyeSvg / #passwordInput) */
    const togglePasswordBtn = document.getElementById("togglePasswordBtn");
    const eyeSvg = document.getElementById("eyeSvg");
    if (togglePasswordBtn && eyeSvg) {
      togglePasswordBtn.addEventListener("click", () => {
        if (!signInPw) return;
        const show = signInPw.type === "password";
        signInPw.type = show ? "text" : "password";
        eyeSvg.style.color = show ? "#C5A059" : "#888275";
        togglePasswordBtn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      });
    }

    /* Reset auth form inputs whenever the modal exits or closes */
    const resetAuthModal = () => {
      if (signInEmail) signInEmail.value = "";
      if (signInPw) {
        signInPw.value = "";
        signInPw.type = "password";
      }
      if (adminEmail) adminEmail.value = "";
      if (adminPw) adminPw.value = "";
      if (signInForm) signInForm.reset();
      if (createForm) createForm.reset();
      if (adminForm) adminForm.reset();
      if (togglePasswordBtn) togglePasswordBtn.setAttribute("aria-label", "Show password");
      if (eyeSvg) eyeSvg.style.color = "#888275";
    };

    /* Customer Login form — standard shopper session, modal closes */
    if (signInForm) {
      signInForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const email = signInEmail ? signInEmail.value.trim() : "";
        const pw = signInPw ? signInPw.value : "";
        if (!email) return showLureiToast("Please enter your email.");
        if (!pw) return showLureiToast("Please enter your password.");
        signInWithEmail(email);
      });
    }

    /* Admin Access form — credential-checked authentication.
       Only the exact boutique-owner address + password is admitted and taken
       straight to the dashboard. Anything else gets an alert and stays on
       the storefront: no session flags, no redirect.

       NOTE: this is a client-side convenience gate, not a security control —
       the password lives in this file, so anyone reading the source can see
       it. The dashboard itself re-checks ADMIN_API_KEY server-side (see
       Code.gs), so a hand-edited flag can reveal the shell but cannot read
       or write a Sheet. Sign out in admin-dashboard.html drops the flag. */
    const ADMIN_ACCESS_EMAIL = "lureiaccessories.s925@gmail.com";
    const ADMIN_ACCESS_PASSWORD = "LuReI123";
    if (adminForm) {
      adminForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const email = adminEmail ? adminEmail.value.trim() : "";
        const pw = adminPw ? adminPw.value.trim() : "";
        if (email === ADMIN_ACCESS_EMAIL && pw === ADMIN_ACCESS_PASSWORD) {
          grantAdminSession(email);
          closeAuthModal();
          window.location.href = "admin-dashboard.html";
          return;
        }
        alert("Invalid Admin Email or Password!");
      });
    }

    /* Create-account form */
    if (createForm) {
      createForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const name = createName ? createName.value.trim() : "";
        const email = createEmail ? createEmail.value.trim() : "";
        const pw = createPw ? createPw.value : "";
        if (!name) return showLureiToast("Please enter your full name.");
        if (!email) return showLureiToast("Please enter your email.");
        if (!pw || pw.length < 6) return showLureiToast("Password must be at least 6 characters.");
        createAccount(name, email);
      });
    }

    /* Profile icon click — open modal or toggle dropdown */
    if (navProfileBtn) {
      navProfileBtn.addEventListener("click", (e) => {
        /* Ignore clicks on the dropdown itself */
        if (e.target.closest && e.target.closest(".nav-profile__menu")) return;

        /* Admin preview opens the Administrator card even when no shopper
           profile exists, so the way back to the dashboard is always
           reachable from the storefront. */
        if (currentUser || isAdminPreviewActive()) {
          const existing = navProfileBtn.querySelector(".nav-profile__menu");
          if (existing) { existing.remove(); return; }

          const menu = document.createElement("div");
          menu.className = "nav-profile__menu";

          if (isAdminPreviewActive()) {
            menu.innerHTML =
              '<p class="nav-profile__menu-name">Administrator</p>' +
              '<p class="nav-profile__menu-role">Storefront preview</p>' +
              (currentUser ? '<p class="nav-profile__menu-email">' + escapeHtml(currentUser.email) + "</p>" : "") +
              '<div class="nav-profile__actions">' +
                '<button type="button" class="nav-profile__dashboard" id="nav-dashboard">Back to Dashboard</button>' +
                '<button type="button" class="nav-profile__signout" id="nav-admin-signout">Sign Out</button>' +
              "</div>";
            navProfileBtn.appendChild(menu);

            menu.querySelector("#nav-dashboard").addEventListener("click", (ev) => {
              ev.stopPropagation();
              /* Straight navigation — the admin session is deliberately left
                 intact so the dashboard guard still admits the navigation. */
              window.location.href = "admin-dashboard.html";
            });

            menu.querySelector("#nav-admin-signout").addEventListener("click", (ev) => {
              ev.stopPropagation();
              handleAdminSignOut();
            });
          } else {
            menu.innerHTML =
              '<p class="nav-profile__menu-name">' + escapeHtml(currentUser.name) + "</p>" +
              '<p class="nav-profile__menu-email">' + escapeHtml(currentUser.email) + "</p>" +
              '<button type="button" class="nav-profile__signout" id="nav-signout">Sign Out</button>';
            navProfileBtn.appendChild(menu);

            const so = menu.querySelector("#nav-signout");
            if (so) so.addEventListener("click", (ev) => { ev.stopPropagation(); handleSignOut(); });
          }

          const closeDropdown = (ev) => {
            if (!navProfileBtn.contains(ev.target)) { menu.remove(); document.removeEventListener("click", closeDropdown); }
          };
          setTimeout(() => document.addEventListener("click", closeDropdown), 0);
        } else {
          openAuthModal("signin");
        }
      });
    }

    /* Google Identity Services — delayed init (SDK loads async) */
    const initGoogleAuth = () => {
      if (!GOOGLE_CLIENT_ID) return;
      let tries = 0;
      const attempt = () => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            auto_select: false,
            cancel_on_tap_outside: true,
            callback: (resp) => {
              if (!resp || !resp.credential) return;
              const p = decodeJwt(resp.credential);
              handleAuthenticated({
                name: p.name || p.given_name || "Guest",
                email: p.email || "",
                photo: p.picture || "",
              });
            },
          });

          const wrap = document.getElementById("g_id_signin_wrap");
          if (wrap) {
            window.google.accounts.id.renderButton(wrap, {
              type: "standard",
              theme: "filled_black",
              size: "large",
              shape: "pill",
              text: "continue_with",
              logo_alignment: "left",
              width: wrap.offsetWidth || 300,
            });
          }

          /* Auto-prompt One-Tap once per session if not logged in */
          /* Admin preview counts as "in", so the One-Tap sheet never interrupts an
             admin browsing the storefront in preview mode. */
          if (!currentUser && !isAdminPreviewActive() && !sessionStorage.getItem("lurei_onetap_seen")) {
            window.google.accounts.id.prompt((moment) => {
              sessionStorage.setItem("lurei_onetap_seen", "1");
              if (moment && (moment.isNotDisplayed() || moment.isSkippedMoment() || moment.isDismissedMoment())) {
                sessionStorage.setItem("lurei_onetap_seen", "1");
              }
            });
          }
        } else if (tries < 40) {
          tries++;
          setTimeout(attempt, 250);
        }
      };
      attempt();
    };

    /* Restore profile badge on load + init Google GIS */
    patchProfile();
    initGoogleAuth();

    /* ------------------------------------------------------------------ *
     * 10c. Login / Signup page — runs only on login.html (.login-page)
     * ------------------------------------------------------------------ */
    if (document.querySelector(".login-page")) {
      const loginTabs = Array.from(document.querySelectorAll(".login-tab"));
      const loginSigninForm = document.getElementById("login-signin-form");
      const loginCreateForm = document.getElementById("login-create-form");
      const loginSigninSubmit = document.getElementById("login-signin-submit");
      const loginCreateSubmit = document.getElementById("login-create-submit");
      const loginFootText = document.getElementById("login-foot-text");
      const loginForgot = document.getElementById("login-forgot");
      const rememberMe = document.getElementById("login-remember");
      const getValue = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : "";
      };

      /* Top-left back arrow exit button — leave login and return to the shop */
      const modalBackBtn = document.getElementById("modalBackBtn");
      if (modalBackBtn) {
        modalBackBtn.addEventListener("click", () => {
          window.location.href = "index.html";
        });
      }

      /* Outside-click close is disabled: login.html has no modal overlay, so
         the card is never dismissed by backdrop clicks. */

      /* Smooth toggle between Sign In / Create Account panels */
      const loginIndicator = document.querySelector(".login-toggle__indicator");
      loginTabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          loginTabs.forEach((t) => {
            const panel = document.getElementById("login-panel-" + t.dataset.loginPanel);
            const active = t === tab;
            t.classList.toggle("is-active", active);
            t.setAttribute("aria-selected", String(active));
            if (panel) {
              panel.hidden = !active;
              panel.classList.toggle("is-active", active);
            }
          });
          if (loginIndicator) {
            loginIndicator.style.transform = tab.dataset.loginPanel === "create" ? "translateX(100%)" : "translateX(0)";
          }
          const isCreate = tab.dataset.loginPanel === "create";
          if (loginSigninSubmit) loginSigninSubmit.textContent = isCreate ? "Join the Circle" : "Enter the Circle";
          if (loginCreateSubmit) loginCreateSubmit.textContent = isCreate ? "Join the Circle" : "Enter the Circle";
          if (loginFootText) {
            loginFootText.textContent = isCreate
              ? "By joining, you accept our privacy policy. Welcome to the Circle."
              : "Already a member? Sign in to unlock private previews.";
          }
        });
      });

      /* Password eye toggles — swap input type and eye/slash icon state */
      document.querySelectorAll(".login-eye").forEach((eye) => {
        eye.addEventListener("click", () => {
          const input = document.getElementById(eye.dataset.eyeFor);
          if (!input) return;
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
          eye.classList.toggle("is-visible", show);
          const eyeIcon = eye.querySelector(".login-eye__icon.is-eye");
          const slashIcon = eye.querySelector(".login-eye__icon.is-eye-slash");
          if (eyeIcon) eyeIcon.classList.toggle("is-active", !show);
          if (slashIcon) slashIcon.classList.toggle("is-active", show);
        });
      });

      /* Forced Show/Hide password toggle — inline eye icon (#togglePassword / #eyeIcon) */
      const togglePassword = document.getElementById("togglePassword");
      const eyeIconEl = document.getElementById("eyeIcon");
      if (togglePassword && eyeIconEl) {
        togglePassword.addEventListener("click", () => {
          const input = document.getElementById("password");
          if (!input) return;
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          eyeIconEl.style.color = show ? "#C5A059" : "#888275";
          togglePassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
        });
      }

      /* Prefill remembered email */
      try {
        const savedEmail = localStorage.getItem("lurei_remember_email");
        if (savedEmail) {
          const emailInput = document.getElementById("login-email");
          if (emailInput) emailInput.value = savedEmail;
          if (rememberMe) rememberMe.checked = true;
        }
      } catch {}

      /* Sign In submit */
      if (loginSigninForm) {
        loginSigninForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const email = getValue("login-email");
          const password = getValue("password");
          if (!email) return showLureiToast("Please enter your email address.", "error");
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showLureiToast("Please enter a valid email address.", "error");
          if (!password) return showLureiToast("Please enter your password.", "error");

          try {
            if (rememberMe && rememberMe.checked) {
              localStorage.setItem("lurei_remember_email", email);
            } else {
              localStorage.removeItem("lurei_remember_email");
            }
            localStorage.setItem("lurei_user", JSON.stringify({ name: "Circle Member", email: email, photo: "" }));
          } catch {}

          showLureiToast("Welcome back to LUREÍ!");
          setTimeout(() => { window.location.href = "index.html"; }, 1200);
        });
      }

      /* Create Account submit */
      if (loginCreateForm) {
        loginCreateForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const name = getValue("create-name");
          const email = getValue("create-email");
          const password = getValue("create-password");
          if (!name) return showLureiToast("Please enter your full name.", "error");
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showLureiToast("Please enter a valid email address.", "error");
          if (!password || password.length < 6) return showLureiToast("Password must be at least 6 characters.", "error");

          try {
            localStorage.setItem("lurei_user", JSON.stringify({ name: name, email: email, photo: "" }));
          } catch {}

          showLureiToast("Welcome to LUREÍ Circle!");
          setTimeout(() => { window.location.href = "index.html"; }, 1200);
        });
      }

      /* Forgot Password (mock reset link) */
      if (loginForgot) {
        loginForgot.addEventListener("click", (event) => {
          event.preventDefault();
          showLureiToast("Password reset link sent to your email.");
        });
      }
    }
  });

  /* ------------------------------------------------------------------ *
   * 11. Hero slideshow (2s crossfade loop)
   * ------------------------------------------------------------------ */
  const heroSlides = Array.from(document.querySelectorAll(".hero-slide"));
  if (heroSlides.length) {
    let heroSlideIndex = 0;
    heroSlides[0].classList.add("active");
    setInterval(() => {
      heroSlides[heroSlideIndex].classList.remove("active");
      heroSlideIndex = (heroSlideIndex + 1) % heroSlides.length;
      heroSlides[heroSlideIndex].classList.add("active");
    }, 2000);
  }

  /* ------------------------------------------------------------------ *
   * 12. FAQ accordion (expand / collapse)
   * ------------------------------------------------------------------ */
  Array.from(document.querySelectorAll(".lurei-faq-item")).forEach((item) => {
    const q = item.querySelector(".lurei-faq-item__q");
    const answer = item.querySelector(".lurei-faq-item__a");
    if (!q || !answer) return;

    q.addEventListener("click", () => {
      const isOpen = item.classList.toggle("is-open");
      q.setAttribute("aria-expanded", String(isOpen));
      answer.style.maxHeight = isOpen ? answer.scrollHeight + "px" : "0px";
    });
  });

  /* ------------------------------------------------------------------ *
   * 13. Perks scroll-pop animation (infinite loop while in view)
   * ------------------------------------------------------------------ */
  const perksSection = document.querySelector(".lurei-brand-perks-section");
  const perkCards = document.querySelectorAll(".perk-card");
  const hidePerkCards = () =>
    perkCards.forEach((card) => card.classList.remove("in-view"));

  let perkLoop = null;
  let perkTimers = [];

  const clearPerkTimers = () => {
    perkTimers.forEach((timer) => clearTimeout(timer));
    perkTimers = [];
  };

  const stopPerkLoop = () => {
    if (perkLoop) {
      clearInterval(perkLoop);
      perkLoop = null;
    }
    clearPerkTimers();
  };

  const runPerkLoop = () => {
    clearPerkTimers();
    hidePerkCards();

    const schedule = (index, delay) =>
      perkTimers.push(
        setTimeout(() => {
          if (perkCards[index]) perkCards[index].classList.add("in-view");
        }, delay)
      );

    schedule(0, 100);
    schedule(1, 1000);
    schedule(2, 1900);
    schedule(3, 2800);
    perkTimers.push(
      setTimeout(() => {
        hidePerkCards();
      }, 5500)
    );
  };

  if (perksSection && perkCards.length) {
    if ("IntersectionObserver" in window) {
      const perksObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              stopPerkLoop();
              runPerkLoop();
              perkLoop = setInterval(runPerkLoop, 6500);
            } else {
              stopPerkLoop();
              hidePerkCards();
            }
          });
        },
        { threshold: 0.2 }
      );
      perksObserver.observe(perksSection);
    } else {
      perkCards.forEach((card) => card.classList.add("in-view"));
    }
  }

  /* ------------------------------------------------------------------ *
   * 14. Newsletter stagger entrance (footer)
   * ------------------------------------------------------------------ */
  const newsletterCol = document.querySelector(".footer__col--newsletter");
  const newsletterEls = document.querySelectorAll(
    ".footer-newsletter-title, .footer-newsletter-sub, .footer-newsletter-input-wrap"
  );
  if (newsletterCol && newsletterEls.length) {
    if ("IntersectionObserver" in window) {
      const newsletterObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              newsletterEls.forEach((el) => el.classList.add("in-view"));
              newsletterObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 }
      );
      newsletterObserver.observe(newsletterCol);
    } else {
      newsletterEls.forEach((el) => el.classList.add("in-view"));
    }
  }

  /* ------------------------------------------------------------------ *
   * 14c. Gift Cards page — interactive card selection, live preview
   * ------------------------------------------------------------------ */
  const gcCards = Array.from(document.querySelectorAll(".gc-card"));
  const gcPreviewCard = document.querySelector("#gc-preview-card");
  const gcAmountEl = document.querySelector("#gc-amount");
  const gcRecipientEl = document.querySelector("#gc-recipient");
  const gcMessageEl = document.querySelector("#gc-message");
  const gcSenderInput = document.querySelector("#gc-sender");
  const gcNameInput = document.querySelector("#gc-name");
  const gcNoteInput = document.querySelector("#gc-note");
  const gcCustomField = document.querySelector("#gc-custom-amount-field");
  const gcCustomInput = document.querySelector("#gc-custom-amount");
  const gcForm = document.querySelector("#gc-form");
  const gcSuccess = document.querySelector("#gc-success");
  const gcDateWrap = document.querySelector("#gc-date-wrap");
  const gcDateInput = document.querySelector("#gc-date");
  const gcDeliveryRadios = Array.from(
    document.querySelectorAll('input[name="gc-delivery"]')
  );
  const gcPassRadios = Array.from(
    document.querySelectorAll('input[name="gc-pass"]')
  );

  if (gcCards.length && gcPreviewCard) {
    let gcAmount = 50;
    let gcCustom = false;

    const gcAmountDisplay = () =>
      gcCustom ? (toNumber(gcCustomInput.value) || 0) : gcAmount;

    const gcRefreshPreview = () => {
      const value = gcAmountDisplay();
      gcAmountEl.textContent = gcCustom && value === 0 ? "Custom Amount" : `AED ${value}`;
      if (gcRecipientEl) {
        gcRecipientEl.textContent =
          gcNameInput && gcNameInput.value.trim()
            ? gcNameInput.value.trim()
            : "Your Recipient";
      }
      if (gcMessageEl) {
        gcMessageEl.textContent =
          gcNoteInput && gcNoteInput.value.trim()
            ? gcNoteInput.value.trim()
            : "A spark of elegance, just for you.";
      }
    };

    const gcSelectCard = (card) => {
      gcCards.forEach((c) => {
        const active = c === card;
        c.classList.toggle("is-selected", active);
        c.setAttribute("aria-checked", String(active));
      });

      const isCustom = card.dataset.gcAmount === "custom";
      gcCustom = isCustom;
      if (!isCustom) {
        gcAmount = toNumber(card.dataset.gcAmount) || gcAmount;
        if (gcCustomField) gcCustomField.hidden = true;
      } else {
        if (gcCustomField) {
          gcCustomField.hidden = false;
          gcCustomInput.focus();
        }
      }

      /* Tier modifier to preview theme. Modifier names predate the metallic
         re-theme (champagne is the Ruby tier, sapphire the Emerald tier,
         rosegold the Gold tier), so the mapping is explicit rather than
         derived — and every past or legacy theme class is dropped first so
         two gradients can never stack. */
      const GC_PREVIEW_THEMES = {
        "gc-card--silver": "is-silver",
        "gc-card--champagne": "is-ruby",
        "gc-card--sapphire": "is-emerald",
        "gc-card--rosegold": "is-gold",
        "gc-card--onyx": "is-onyx",
      };
      const GC_PREVIEW_THEME_CLASSES = [
        "is-silver",
        "is-ruby",
        "is-emerald",
        "is-gold",
        "is-onyx",
        "is-sapphire",
        "is-rosegold",
        "is-champagne",
      ];
      const modifier = Array.from(card.classList).find(
        (cls) => /^gc-card--/.test(cls) && cls !== "gc-card--wide"
      );
      gcPreviewCard.classList.remove(...GC_PREVIEW_THEME_CLASSES);
      const theme = (modifier && GC_PREVIEW_THEMES[modifier]) || "";
      if (theme) gcPreviewCard.classList.add(theme);

      gcRefreshPreview();
    };

    gcCards.forEach((card) => {
      card.addEventListener("click", () => gcSelectCard(card));
    });

    /* Sync the preview with the pre-selected tier on load — otherwise the
       foil keeps its neutral base while a tier already shows selected. */
    const preselectedGcCard =
      gcCards.find((card) => card.classList.contains("is-selected")) || gcCards[0];
    if (preselectedGcCard) gcSelectCard(preselectedGcCard);

    if (gcCustomInput) {
      gcCustomInput.addEventListener("input", gcRefreshPreview);
    }

    if (gcNameInput) {
      gcNameInput.addEventListener("input", gcRefreshPreview);
    }

    if (gcNoteInput) {
      gcNoteInput.addEventListener("input", gcRefreshPreview);
    }

    if (gcDeliveryRadios.length && gcDateWrap) {
      gcDeliveryRadios.forEach((radio) => {
        radio.addEventListener("change", () => {
          const scheduling = radio.value === "schedule";
          gcDateWrap.hidden = !scheduling;
          /* Only demand a date while scheduling. A required control inside a
             hidden [hidden] wrapper is unfocusable, which makes reportValidity()
             fail silently — so this must stay in step with the wrapper. */
          if (gcDateInput) gcDateInput.required = scheduling;
        });
      });
    }

    if (gcPassRadios.length) {
      const gcSyncPassState = () => {
        gcPassRadios.forEach((radio) => {
          const option = radio.closest(".pay-option");
          if (option) option.classList.toggle("is-selected", radio.checked);
        });
      };
      gcPassRadios.forEach((radio) => {
        radio.addEventListener("change", gcSyncPassState);
      });
      gcSyncPassState();
    }

    /* Renders the native date picker value as "05 March 2026" for the DM. */
    const gcFormatDeliveryDate = (iso) => {
      if (!iso) return "";
      const parsed = new Date(`${iso}T00:00:00`);
      if (Number.isNaN(parsed.getTime())) return iso;
      return parsed.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      });
    };

    if (gcForm) {
      gcForm.addEventListener("submit", (event) => {
        event.preventDefault();

        /* novalidate suppresses the automatic bubble, so run it by hand and
           bail before opening WhatsApp. Matches the checkout flow. */
        if (!gcForm.reportValidity()) return;

        const passRadio = gcPassRadios.find((radio) => radio.checked);
        const pass = passRadio ? passRadio.value : "";
        const sender = gcSenderInput ? gcSenderInput.value.trim() : "";
        const recipient = gcNameInput ? gcNameInput.value.trim() : "";
        const note = gcNoteInput ? gcNoteInput.value.trim() : "";
        const scheduling = gcDeliveryRadios.some(
          (radio) => radio.checked && radio.value === "schedule"
        );
        const deliveryDate = scheduling
          ? gcFormatDeliveryDate(gcDateInput && gcDateInput.value)
          : "Send Now";

        const waMessage = `Hello LUREÍ Team! 👋

I have selected a Luxury Gift Pass for my loved one:

• Selected Pass: ${pass}
• Purchased By: ${sender}
• Recipient Name: ${recipient}
• Scheduled Delivery Date: ${deliveryDate}
• Personal Gift Note: ${note || "No personal note added"}

Could you please share the exact benefits, items, and advantages that come under the ${pass} so we can finalize the delivery details?`;

        const waUrl = `https://wa.me/${CONFIG.CONTACT_WHATSAPP}?text=${encodeURIComponent(waMessage)}`;

        /* Opens in a new tab, so the storefront never navigates away or
           reloads — no layout or style state is lost. */
        window.open(waUrl, "_blank", "noopener,noreferrer");

        /* Left the form in place so returning from WhatsApp keeps the
           customer's details. */
        if (gcSuccess) {
          gcSuccess.hidden = false;
          gcSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    gcRefreshPreview();
  }
})();