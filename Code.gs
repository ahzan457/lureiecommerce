/**
 * ============================================================================
 * LUREI Dubai — Google Apps Script backend (Google Sheets database)
 * ============================================================================
 *
 * Deploy: Deploy > New deployment > Web app
 *   - Execute as:      Me
 *   - Who has access:  Anyone            (shoppers must POST orders)
 *
 * Then set two Script Properties (Project Settings > Script Properties):
 *   SPREADSHEET_ID  the 11-char id from the Sheet URL
 *   ADMIN_API_KEY   shared secret the storefront sends on admin writes
 * and paste both into script.js:
 *   CONFIG.APPS_SCRIPT_URL and CONFIG.ADMIN_API_KEY
 *
 * Sheet tabs and their header rows are created on first run by ensureSheets().
 * Columns are matched BY HEADER NAME, never by position, so you can reorder or
 * add columns in the Sheet without breaking this script.
 *
 * Security note: ADMIN_API_KEY ships inside script.js and is therefore readable
 * by anyone who views source. It stops accidental writes, not a determined
 * attacker. Treat the Orders tab as semi-public and rotate the key if it leaks.
 * ============================================================================
 */

/* ------------------------------------------------------------------ *
 * Configuration (Script Properties, with fallbacks for quick testing)
 * ------------------------------------------------------------------ */
const SHEETS = {
  PRODUCTS: "Products",
  ORDERS: "Orders",
  MONTHLY: "MonthlyReport",
};

const ADMIN_ACTIONS = {
  signIn: "signIn",
  addProduct: "addProduct",
  updateProduct: "updateProduct",
  updateStock: "updateStock",
  updateOrderStatus: "updateOrderStatus",
  deleteOrder: "deleteOrder",
  archiveOrder: "archiveOrder",
};

const prop = (name, fallback) => {
  try {
    return PropertiesService.getScriptProperties().getProperty(name) || fallback;
  } catch (error) {
    return fallback || "";
  }
};

const SPREADSHEET_ID = prop("SPREADSHEET_ID", "");
const ADMIN_API_KEY = prop("ADMIN_API_KEY", "");

const PRODUCT_HEADERS = [
  "id", "title", "price", "originalPrice", "category", "type",
  "image", "description", "badge", "stock", "outOfStock",
];

const ORDER_HEADERS = [
  "id", "order_id", "customer_name", "phone", "email", "address",
  "payment", "payment_method", "requested_delivery_date",
  "items", "total_aed", "currency_at_order", "status", "created_at",
];

/* ------------------------------------------------------------------ *
 * HTTP entry points
 * ------------------------------------------------------------------ */
function doGet(e) {
  const param = (e && e.parameter) || {};
  const action = param.action || "products";
  try {
    switch (action) {
      case "products":
        /* Public: this is the catalogue the storefront renders from. */
        return json_({ products: readProducts() });
      case "orders":
        /* Order rows hold names, emails, phones and addresses, so a bare GET
           would publish the customer list. Keyed like the admin writes. */
        if (!isAdmin_(param.apiKey)) return json_({ error: "Unauthorized" }, 401);
        return json_({ orders: readOrders() });
      case "monthlyReport":
        if (!isAdmin_(param.apiKey)) return json_({ error: "Unauthorized" }, 401);
        return json_({ report: buildMonthlyReport_() });
      case "health":
        return json_({ ok: true, configured: !!SPREADSHEET_ID, products: readProducts().length });
      default:
        return json_({ error: "Unknown action: " + action }, 400);
    }
  } catch (error) {
    return json_({ error: String((error && error.message) || error) }, 500);
  }
}

function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (error) {
    return json_({ error: "Malformed JSON body" }, 400);
  }

  /* A form-encoded post (no JSON) is still readable from e.parameter. */
  if (!payload.action && e && e.parameter) payload = e.parameter;

  const action = payload.action;
  try {
    /* Orders are placed by shoppers, so this one action is intentionally public. */
    if (action === "insertOrder") {
      return json_({ ok: true, order: insertOrder_(payload.order || payload) });
    }

    /* Credential check, not the shared key: admin-login.html has to be able to
       prove who it is *before* it holds anything. */
    if (action === ADMIN_ACTIONS.signIn) {
      try {
        return json_({ ok: true, session: signIn_(payload.email, payload.password) });
      } catch (error) {
        return json_({ error: String((error && error.message) || error) }, 401);
      }
    }

    if (!isAdmin_(payload.apiKey)) {
      return json_({ error: "Unauthorized" }, 401);
    }

    switch (action) {
      case ADMIN_ACTIONS.addProduct:
        return json_({ ok: true, product: addProduct_(payload.product || payload) });
      case ADMIN_ACTIONS.updateProduct:
        return json_({ ok: true, product: updateProduct_(payload.product || payload) });
      case ADMIN_ACTIONS.updateStock:
        return json_({ ok: true, product: updateStock_(payload.id, payload.stock) });
      case ADMIN_ACTIONS.updateOrderStatus:
        return json_({ ok: true, order: updateOrderStatus_(payload.orderId, payload.status) });
      case ADMIN_ACTIONS.deleteOrder:
        return json_({ ok: true, deleted: deleteOrder_(payload.orderId) });
      case ADMIN_ACTIONS.archiveOrder:
        return json_({ ok: true, order: archiveOrder_(payload.order || payload) });
      default:
        return json_({ error: "Unknown action: " + action }, 400);
    }
  } catch (error) {
    return json_({ error: String((error && error.message) || error) }, 500);
  }
}

function isAdmin_(key) {
  return !!ADMIN_API_KEY && String(key || "") === ADMIN_API_KEY;
}

/* ------------------------------------------------------------------ *
 * Sign-in
 *
 * Google Apps Script has no user store of its own, so the operator's
 * credentials are Script Properties: ADMIN_EMAIL and ADMIN_PASSWORD. Both
 * are compared here rather than in the browser, so the password never
 * needs to appear in any page.
 *
 * Set them under Project Settings > Script Properties.
 * ------------------------------------------------------------------ */
function signIn_(email, password) {
  const expectedEmail = prop("ADMIN_EMAIL", "");
  const expectedPassword = prop("ADMIN_PASSWORD", "");

  if (!expectedEmail || !expectedPassword) {
    throw new Error("Admin sign-in is not configured (ADMIN_EMAIL / ADMIN_PASSWORD).");
  }

  const emailOk = constantTimeEquals_(
    String(email || "").trim().toLowerCase(),
    expectedEmail.trim().toLowerCase()
  );
  const passwordOk = constantTimeEquals_(String(password || ""), expectedPassword);

  if (!emailOk || !passwordOk) throw new Error("Invalid admin credentials.");

  return {
    role: "admin",
    email: expectedEmail,
    issuedAt: new Date().toISOString(),
  };
}

/** Length-independent comparison so a wrong password cannot be narrowed down
 *  one character at a time by timing. */
function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** GAS web apps ignore response headers, so the payload carries the status. */
function json_(body, status) {
  /* Must be stamped before stringify - assigning afterwards left __status out
     of the JSON entirely, so unwrapGas() never saw it. */
  if (status) body.__status = status;
  const out = ContentService.createTextOutput(JSON.stringify(body));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

/* ------------------------------------------------------------------ *
 * Sheet helpers - header-keyed so column order never matters
 * ------------------------------------------------------------------ */
function sheet_(name) {
  if (!SPREADSHEET_ID) {
    throw new Error("SPREADSHEET_ID script property is not set.");
  }
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet tab: "' + name + '"');
  return sheet;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function headers_(sheet) {
  const last = sheet.getLastColumn();
  if (!last) return [];
  return sheet
    .getRange(1, 1, 1, last)
    .getValues()[0]
    .map((h) => String(h).trim());
}

/** Sheet -> array of objects keyed by the header row. */
function readObjects_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const head = headers_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, head.length).getValues();

  return values
    .map((row) => {
      const out = {};
      head.forEach((key, i) => {
        if (key) out[key] = row[i];
      });
      return out;
    })
    .filter((row) => Object.keys(row).length > 0);
}

/** Append an object, writing only the columns the tab actually declares. */
function appendObject_(sheet, obj) {
  const head = headers_(sheet);
  const row = head.map((key) => {
    if (!(key in obj)) return "";
    const v = obj[key];
    if (v === null || v === undefined) return "";
    return v instanceof Date ? v : v;
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function columnIndex_(sheet, name) {
  const head = headers_(sheet);
  const i = head.indexOf(name);
  return i === -1 ? -1 : i + 1;
}

function setCell_(sheet, rowNumber, columnName, value) {
  const col = columnIndex_(sheet, columnName);
  if (col === -1) return false;
  sheet.getRange(rowNumber, col).setValue(value);
  return true;
}

function ensureSheets_() {
  if (!SPREADSHEET_ID) throw new Error("Set the SPREADSHEET_ID script property first.");
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const make = (name, headers) => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
    return sheet;
  };
  make(SHEETS.PRODUCTS, PRODUCT_HEADERS);
  make(SHEETS.ORDERS, ORDER_HEADERS);
  make(SHEETS.MONTHLY, ["month", "orders", "revenueAED", "delivered", "generatedAt"]);
  return true;
}

/** Run once from the editor to create the three tabs. */
function setupSheets() {
  ensureSheets_();
  return "Sheets ready: " + Object.values(SHEETS).join(", ");
}

/* ------------------------------------------------------------------ *
 * Products CRUD
 * ------------------------------------------------------------------ */
function readProducts() {
  const rows = readObjects_(sheet_(SHEETS.PRODUCTS));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    price: row.price,
    originalPrice: row.originalPrice,
    category: row.category,
    type: row.type,
    image: row.image,
    description: row.description,
    badge: row.badge,
    stock: row.stock === "" ? null : Number(row.stock),
    outOfStock: row.outOfStock === true || row.outOfStock === "TRUE",
  }));
}

function addProduct_(product) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.PRODUCTS);
    const id = product.id || Utilities.getUuid();
    const stock = Number(product.stock);
    const record = {
      id: id,
      title: product.title || product.name || "",
      price: Number(product.price) || 0,
      originalPrice: product.originalPrice || "",
      category: product.category || "",
      type: product.type || "earrings",
      image: product.image || product.image_url || "",
      description: product.description || product.desc || "",
      badge: product.badge || "",
      stock: Number.isFinite(stock) ? stock : "",
      outOfStock: product.outOfStock === true,
    };
    appendObject_(sheet, record);
    return record;
  });
}

function updateProduct_(product) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.PRODUCTS);
    const row = findRowBy_(sheet, "id", product.id);
    if (!row) throw new Error("No product with id " + product.id);
    Object.keys(product).forEach((key) => {
      if (key === "id" || key === "apiKey") return;
      setCell_(sheet, row, key, product[key]);
    });
    return product;
  });
}

/** Stock is the field the dashboard edits most, so it gets a focused path. */
function updateStock_(id, stock) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.PRODUCTS);
    const row = findRowBy_(sheet, "id", id);
    if (!row) throw new Error("No product with id " + id);
    const count = Number(stock);
    setCell_(sheet, row, "stock", Number.isFinite(count) ? count : "");
    /* A real zero must also flip the flag, or the card shows "0 LEFT" *and*
       "Out of Stock" at the same time. */
    setCell_(sheet, row, "outOfStock", Number.isFinite(count) && count === 0);
    return { id: id, stock: count };
  });
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */
function readOrders() {
  return readObjects_(sheet_(SHEETS.ORDERS));
}

function insertOrder_(order) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.ORDERS);
    const record = {
      id: Utilities.getUuid(),
      order_id: order.orderId || "",
      customer_name: order.customerName || "",
      phone: order.phone || "",
      email: order.email || "",
      address: order.address || "",
      payment: order.payment || "",
      payment_method: order.paymentMethod || "",
      requested_delivery_date: order.requestedDeliveryDate || "",
      items: typeof order.items === "string" ? order.items : JSON.stringify(order.items || []),
      total_aed: Number(order.totalAED) || 0,
      currency_at_order: order.currencyAtOrder || "AED",
      status: order.status || "pending",
      created_at: order.createdAt || new Date().toISOString(),
    };
    const rowNumber = appendObject_(sheet, record);
    /* Decrement stock so the storefront reflects a sale without a second call. */
    decrementStockFor_(record.items);
    return Object.assign({ row: rowNumber }, record);
  });
}

/** The dashboard holds two identifiers per order: the Sheet row id and the
 *  storefront's own order_id. Accept either so a delete or a status change
 *  works whichever one the caller has to hand. */
function findOrderRow_(sheet, id) {
  if (id === undefined || id === null || id === "") return null;
  const byId = findRowBy_(sheet, "id", id);
  if (byId) return byId;
  return findRowBy_(sheet, "order_id", id);
}

function updateOrderStatus_(orderId, status) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.ORDERS);
    const row = findOrderRow_(sheet, orderId);
    if (!row) throw new Error("No order with id " + orderId);
    setCell_(sheet, row, "status", status || "pending");
    if (status === "delivered" || status === "completed") {
      setCell_(sheet, row, "completed_at", new Date().toISOString());
    }
    return { orderId: orderId, status: status };
  });
}

function deleteOrder_(orderId) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.ORDERS);
    const row = findOrderRow_(sheet, orderId);
    if (!row) throw new Error("No order with id " + orderId);
    sheet.deleteRow(row);
    return true;
  });
}

/** Files a delivered sale onto the Orders tab. Upserted on order_id so filing the
 *  same sale twice updates the one entry instead of duplicating it, which is
 *  what the Monthly Report groups on. */
function archiveOrder_(order) {
  return withLock_(() => {
    const sheet = sheet_(SHEETS.ORDERS);
    const orderId = order.orderId || order.order_id || "";
    if (!orderId) throw new Error("archiveOrder needs an orderId.");

    const existing = findRowBy_(sheet, "order_id", orderId);
    const now = new Date().toISOString();
    const record = {
      id: order.id || (existing ? undefined : Utilities.getUuid()),
      order_id: orderId,
      customer_name: order.customerName || order.customer_name || "Unknown",
      phone: order.phone || "",
      email: order.email || "",
      address: order.address || "",
      payment: order.payment || "",
      payment_method: order.paymentMethod || order.payment_method || "",
      requested_delivery_date: order.requestedDeliveryDate || order.requested_delivery_date || "",
      items: typeof (order.items || "") === "string"
        ? order.items
        : JSON.stringify(order.items || []),
      total_aed: Number(order.totalAED || order.total_aed) || 0,
      currency_at_order: order.currencyAtOrder || order.currency_at_order || "AED",
      status: "delivered",
      created_at: order.createdAt || order.created_at || now,
      completed_at: order.completedAt || order.completed_at || now,
    };

    if (existing) {
      Object.keys(record).forEach((key) => {
        if (record[key] === undefined) return;
        setCell_(sheet, existing, key, record[key]);
      });
      return Object.assign({ row: existing }, record);
    }
    return Object.assign({ row: appendObject_(sheet, record) }, record);
  });
}

/** items is a JSON string; unknown titles are skipped rather than failing the order. */
function decrementStockFor_(itemsJson) {
  var items = [];
  try {
    items = typeof itemsJson === "string" ? JSON.parse(itemsJson) : (itemsJson || []);
  } catch (error) {
    return;
  }
  var sheet = sheet_(SHEETS.PRODUCTS);
  var rows = readObjects_(sheet);
  var head = headers_(sheet);
  var titleCol = head.indexOf("title") + 1;
  var stockCol = head.indexOf("stock") + 1;
  var soldOutCol = head.indexOf("outOfStock") + 1;
  if (titleCol < 1 || stockCol < 1) return;

  items.forEach(function (item) {
    var title = String((item && item.title) || "");
    var qty = Number((item && item.quantity) || 0);
    if (!title || !qty) return;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].title || "").trim() !== title.trim()) continue;
      var rowNumber = i + 2;
      var current = Number(rows[i].stock);
      if (!Number.isFinite(current)) return;
      var next = Math.max(0, current - qty);
      sheet.getRange(rowNumber, stockCol).setValue(next);
      if (soldOutCol > 0) sheet.getRange(rowNumber, soldOutCol).setValue(next === 0);
      return;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Monthly report
 * ------------------------------------------------------------------ */
function buildMonthlyReport_() {
  const rows = readObjects_(sheet_(SHEETS.ORDERS));
  const buckets = new Map();

  rows.forEach((row) => {
    const stamp = row.created_at ? new Date(row.created_at) : null;
    if (!stamp || isNaN(stamp.getTime())) return;
    const key = Utilities.formatDate(stamp, Session.getScriptTimeZone(), "yyyy-MM");
    const bucket = buckets.get(key) || { month: key, orders: 0, revenueAED: 0, delivered: 0 };
    bucket.orders += 1;
    bucket.revenueAED += Number(row.total_aed) || 0;
    if (String(row.status || "").toLowerCase() === "delivered") bucket.delivered += 1;
    buckets.set(key, bucket);
  });

  const report = Array.from(buckets.values())
    .map((b) => ({
      month: b.month,
      orders: b.orders,
      revenueAED: b.revenueAED,
      delivered: b.delivered,
      generatedAt: new Date().toISOString(),
    }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  const sheet = sheet_(SHEETS.MONTHLY);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).clearContent();
  }
  if (report.length) {
    sheet
      .getRange(2, 1, report.length, 5)
      .setValues(report.map((r) => [r.month, r.orders, r.revenueAED, r.delivered, r.generatedAt]));
  }
  return report;
}

function findRowBy_(sheet, column, value) {
  const col = columnIndex_(sheet, column);
  if (col === -1) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const key = String(value);
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === key) return i + 2;
  }
  return null;
}

/** Convenience entry point for a quick manual check from the Apps Script editor. */
function testConnection() {
  ensureSheets_();
  return JSON.stringify({
    products: readProducts().length,
    orders: readOrders().length,
  });
}