/* =====================================================================
 * LUREÍ — Supabase connection layer
 * ---------------------------------------------------------------------
 * Shared by the storefront (script.js) and the admin pages.
 * Loaded as a classic script; exposes globals, no build step required.
 *
 * Uses the plain REST + Auth HTTP endpoints via fetch, so there is no
 * SDK dependency to keep up to date.
 *
 * ---------------------------------------------------------------------
 * SETUP (one time)
 *   1. Run supabase-schema.sql in the Supabase SQL Editor.
 *   2. Create the admin login under Authentication > Users.
 *   3. Paste the Project URL and anon public key below.
 *
 * The anon key IS public — it ships in the page source. It is safe to
 * commit only because Row Level Security (see supabase-schema.sql)
 * decides what it can reach. If you ever change those policies, your
 * customers' names, phone numbers, emails and addresses become public.
 * ===================================================================== */

window.LUREI_BACKEND = {
  /* Paste your own values here. Both are safe to expose publicly. */
  url: "https://YOUR-PROJECT-REF.supabase.co",
  anonKey: "YOUR-ANON-PUBLIC-KEY",

  /* Where the admin's Supabase session is kept between page loads. */
  sessionKey: "lurei_admin_session",
};

/* Mirrors the orders table columns. */
window.LUREI_ORDER_COLUMNS = [
  "id",
  "order_id",
  "customer_name",
  "phone",
  "email",
  "address",
  "payment",
  "payment_method",
  "requested_delivery_date",
  "items",
  "total_aed",
  "currency_at_order",
  "status",
  "created_at",
  "updated_at",
];

/* Mirrors the completed_orders table columns: the same order details plus the
   two timestamps the Monthly Report needs - when it was placed (order_date)
   and when the admin filed it (completed_at). */
window.LUREI_COMPLETED_COLUMNS = [
  "id",
  "order_id",
  "customer_name",
  "phone",
  "email",
  "address",
  "payment",
  "payment_method",
  "requested_delivery_date",
  "items",
  "total_aed",
  "currency_at_order",
  "status",
  "order_date",
  "completed_at",
  "updated_at",
];

(function () {
  "use strict";

  var CFG = window.LUREI_BACKEND;
  var SESSION_KEY = CFG.sessionKey;

  /* ------------------------------------------------------------------ *
   * Availability
   * ------------------------------------------------------------------ */

  /* True only once the placeholders above have been replaced, so the
     site keeps working on localStorage alone if the backend is not set
     up yet instead of throwing on every page. */
  function isConfigured() {
    return (
      typeof CFG.url === "string" &&
      CFG.url.indexOf("YOUR-PROJECT-REF") === -1 &&
      typeof CFG.anonKey === "string" &&
      CFG.anonKey.length > 20 &&
      CFG.anonKey.indexOf("YOUR-ANON-PUBLIC-KEY") === -1
    );
  }

  function baseHeaders(extra) {
    var headers = { apikey: CFG.anonKey, "Content-Type": "application/json" };
    if (extra) {
      Object.keys(extra).forEach(function (k) {
        headers[k] = extra[k];
      });
    }
    return headers;
  }

  /* ------------------------------------------------------------------ *
   * Admin session storage
   * ------------------------------------------------------------------ */

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.access_token ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      /* Private mode: the admin simply re-authenticates next visit. */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  /* Expiry is stored in seconds since epoch; refresh a minute early so a
     request never fails purely because the token lapsed mid-flight. */
  function sessionIsFresh(session, skewSeconds) {
    if (!session || !session.expires_at) return false;
    var skew = typeof skewSeconds === "number" ? skewSeconds : 60;
    return session.expires_at - skew > Math.floor(Date.now() / 1000);
  }

  /* ------------------------------------------------------------------ *
   * Auth
   * ------------------------------------------------------------------ */

  function signIn(email, password) {
    return fetch(CFG.url + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ email: email, password: password }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) {
            var message =
              (body && (body.error_description || body.msg || body.message)) ||
              "Invalid admin credentials.";
            throw new Error(message);
          }
          return body;
        });
      })
      .then(function (session) {
        setSession(session);
        return session;
      });
  }

  function refreshSession() {
    var current = getSession();
    if (!current || !current.refresh_token) {
      return Promise.reject(new Error("No admin session to refresh."));
    }
    return fetch(CFG.url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ refresh_token: current.refresh_token }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Session refresh failed.");
        return res.json();
      })
      .then(function (session) {
        setSession(session);
        return session;
      })
      .catch(function (err) {
        clearSession();
        throw err;
      });
  }

  /* Returns a valid access token, refreshing first if it is close to
     expiry. Rejects when there is no usable admin session. */
  function getAccessToken() {
    var session = getSession();
    if (!session) return Promise.reject(new Error("Not signed in."));
    if (sessionIsFresh(session)) return Promise.resolve(session.access_token);
    return refreshSession().then(function (s) {
      return s.access_token;
    });
  }

  /* ------------------------------------------------------------------ *
   * Authenticated request with automatic retry after a 401
   * ------------------------------------------------------------------ */

  function authedRequest(path, options) {
    var opts = options || {};

    return getAccessToken().then(function (token) {
      var headers = baseHeaders({
        Authorization: "Bearer " + token,
        Prefer: "return=minimal",
      });
      if (opts.headers) {
        Object.keys(opts.headers).forEach(function (k) {
          headers[k] = opts.headers[k];
        });
      }
      return fetch(CFG.url + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    }).then(function (res) {
      /* One retry: the token may have been revoked server-side since it
         was cached, in which case a refresh gives us a usable one. */
      if (res.status === 401) {
        return refreshSession().then(function (session) {
          var headers = baseHeaders({
            Authorization: "Bearer " + session.access_token,
            Prefer: "return=minimal",
          });
          if (opts.headers) {
            Object.keys(opts.headers).forEach(function (k) {
              headers[k] = opts.headers[k];
            });
          }
          return fetch(CFG.url + path, {
            method: opts.method || "GET",
            headers: headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
          });
        });
      }
      if (!res.ok) {
        return res.text().then(function (detail) {
          throw new Error(
            (opts.label || "Request") + " failed (" + res.status + "): " + detail
          );
        });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  /* ------------------------------------------------------------------ *
   * Orders
   * ------------------------------------------------------------------ */

  /* Storefront checkout. Uses the anon key with no Authorization header,
     so the insert is governed by the "checkout can create orders"
     policy — anyone may add an order, nobody may read any. */
  function insertOrder(order) {
    if (!isConfigured()) {
      return Promise.resolve({ skipped: true, reason: "not-configured" });
    }

    return fetch(CFG.url + "/rest/v1/orders", {
      method: "POST",
      headers: baseHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        order_id: order.orderId,
        customer_name: order.customerName,
        phone: order.phone || null,
        email: order.email || null,
        address: order.address || null,
        payment: order.payment || null,
        payment_method: order.paymentMethod || null,
        requested_delivery_date: order.requestedDeliveryDate || null,
        items: order.items || [],
        total_aed: Number(order.totalAED) || 0,
        currency_at_order: order.currencyAtOrder || "AED",
        status: "pending",
        created_at: new Date().toISOString(),
      }),
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (detail) {
          throw new Error("Order upload failed (" + res.status + "): " + detail);
        });
      }
      return { skipped: false };
    });
  }

  /* Admin: newest first, for the dashboard tables. */
  function fetchOrders() {
    var columns = window.LUREI_ORDER_COLUMNS.join(",");
    var query = "/rest/v1/orders?select=" + columns + "&order=created_at.desc";
    return authedRequest(query, { method: "GET", label: "Load orders" });
  }

  /* Admin: flip delivery status. Scoped to the two columns the admin
     is allowed to change. */
  function updateOrderStatus(rowId, status) {
    /* Orders cached before this dashboard had Supabase ids have no primary
       key, so there is nothing to address the row with. Failing loudly
       beats silently PATCHing every row via `id=eq.null`. */
    if (!rowId) {
      return Promise.reject(new Error("This order has no database id. Refresh the dashboard."));
    }
    return authedRequest("/rest/v1/orders?id=eq." + encodeURIComponent(rowId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { status: status },
      label: "Update status",
    });
  }

  /* Rejects malformed and impossible dates (2026-13-45) alike, and treats
     an empty string as "clear the target". */
  function toSqlDate(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    const valid = !Number.isNaN(date.getTime()) &&
      date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day;
    return valid ? raw : null;
  }

  /* Admin: set or clear the target delivery date straight from the table.
     An empty string is stored as SQL NULL so the dashboard can tell
     "no target set" apart from a real date. */
  function updateOrderDeliveryDate(rowId, isoDate) {
    if (!rowId) {
      return Promise.reject(new Error("This order has no database id. Refresh the dashboard."));
    }
    const value = toSqlDate(isoDate);
    return authedRequest("/rest/v1/orders?id=eq." + encodeURIComponent(rowId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { requested_delivery_date: value },
      label: "Update delivery date",
    });
  }

  /* ------------------------------------------------------------------ *
   * Permanent delete
   *
   * Backs both of the dashboard's per-order actions. "Add to Monthly Report"
   * files the order to completed_orders first (see archiveOrder), then removes
   * the live row here, so the sale survives in the report while every revenue,
   * order-count and chart figure on the dashboard recalculates. "Delete Order"
   * skips the archive step entirely and calls this on its own, which is what
   * keeps a deleted test order out of the numbers and out of future reports.
   *
   * Permitted only by the "admins can delete orders" RLS policy in
   * supabase-schema.sql, so this needs an admin session and the anon key that
   * ships with the storefront still gets a refusal. A 401/403 here is a real
   * refusal, so it must reject rather than resolve - the caller reports it
   * instead of dropping the row locally and claiming a delete the database
   * never performed.
   * ------------------------------------------------------------------ */
  function deleteOrder(rowId) {
    if (!rowId) {
      return Promise.reject(new Error("This order has no database id. Refresh the dashboard."));
    }
    return authedRequest("/rest/v1/orders?id=eq." + encodeURIComponent(rowId), {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
      label: "Delete order",
    });
  }

  /* ------------------------------------------------------------------ *
   * Completed orders log
   *
   * The Monthly Report's permanent record. admin-only on every verb: unlike
   * the orders table there is no anon insert policy, so a shopper cannot
   * fabricate revenue history here.
   * ------------------------------------------------------------------ */

  /* Admin: newest completion first, which is the order the log reads in. */
  function fetchCompletedOrders() {
    var columns = window.LUREI_COMPLETED_COLUMNS.join(",");
    var query =
      "/rest/v1/completed_orders?select=" + columns + "&order=completed_at.desc";
    return authedRequest(query, { method: "GET", label: "Load completed orders" });
  }

  /* Admin: file one order into the log on its way out of the live dashboard.
   *
   * Upserted on order_id, so filing the same order twice updates the one entry
   * instead of creating a second. resolution=merge-duplicates is what PostgREST
   * needs to turn the POST into that upsert. */
  function archiveOrder(record) {
    return authedRequest("/rest/v1/completed_orders?on_conflict=order_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: {
        order_id: record.orderId,
        customer_name: record.customerName || "Unknown",
        phone: record.phone || null,
        email: record.email || null,
        address: record.address || null,
        payment: record.payment || null,
        payment_method: record.paymentMethod || null,
        requested_delivery_date: toSqlDate(record.requestedDeliveryDate),
        items: record.items || [],
        total_aed: Number(record.totalAED) || 0,
        currency_at_order: record.currencyAtOrder || "AED",
        status: "delivered",
        order_date: record.createdAt || new Date().toISOString(),
        completed_at: record.completedAt || new Date().toISOString(),
      },
      label: "Archive order",
    });
  }

  /* Admin: drop one log entry. Only used to undo an archive whose live row
   * could not actually be removed, so the two tables cannot disagree about a
   * single sale. */
  function deleteCompletedOrder(orderId) {
    if (!orderId) return Promise.reject(new Error("No order id given."));
    return authedRequest(
      "/rest/v1/completed_orders?order_id=eq." + encodeURIComponent(orderId),
      {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
        label: "Delete completed order",
      }
    );
  }

  /* ------------------------------------------------------------------ *
   * Exposed API
   * ------------------------------------------------------------------ */
  window.LureiBackend = {
    isConfigured: isConfigured,
    signIn: signIn,
    getSession: getSession,
    clearSession: clearSession,
    getAccessToken: getAccessToken,
    refreshSession: refreshSession,
    insertOrder: insertOrder,
    fetchOrders: fetchOrders,
    updateOrderStatus: updateOrderStatus,
    updateOrderDeliveryDate: updateOrderDeliveryDate,
    deleteOrder: deleteOrder,
    fetchCompletedOrders: fetchCompletedOrders,
    archiveOrder: archiveOrder,
    deleteCompletedOrder: deleteCompletedOrder,
  };
})();
