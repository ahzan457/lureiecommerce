/* ==========================================================================
 * LUREÍ boutique backend — Google Apps Script Web App
 *
 * DEPLOY
 *   1. Extensions > Apps Script in the bound spreadsheet, replace the
 *      project code with this file, Save.
 *   2. Deploy > Manage deployments > New version (keep the same /exec URL —
 *      clients use it verbatim, so the URL must not change).
 *
 * LOCK DOWN (recommended)
 *   Project Settings > Script Properties, add:
 *     ADMIN_API_KEY      — required for every admin write once set.
 *     ADMIN_EMAIL        — operator login for the signIn action.
 *     ADMIN_PASSWORD     — operator password for the signIn action.
 *   Until ADMIN_API_KEY is set, admin writes are accepted without a key so
 *   a fresh deploy works immediately; reads were already public by design.
 *
 * SCHEMA
 *   The Orders sheet uses its literal Title Case headers
 *   ("Order ID", "Customer Name", "Email", "Phone", "Items Purchased",
 *   "Total Amount", "Delivery Address", "Status", "Date"). Every lookup and
 *   write resolves headers dynamically and falls back across spellings
 *   (Title Case / camelCase / snake_case), so column order never matters
 *   and extra columns are ignored rather than clobbered.
 *
 * ACTIONS
 *   GET  (no action)            -> bare JSON array of order rows (storefront contract)
 *   GET  ?action=orders         -> same bare array
 *   GET  ?action=products       -> { products: [...] } ([] when no Products tab)
 *   GET  ?action=health         -> { ok, configured, orders, products }
 *   POST { action: "insertOrder", order }     -> public; flat fields also accepted
 *   POST { action: "signIn", email, password }-> { ok, session } (needs ADMIN_EMAIL/PASSWORD)
  *   POST admin actions (need apiKey once ADMIN_API_KEY is set):
  *        updateOrderStatus { orderId, status }
  *        updateDeliveryDate { orderId, date } -> { ok, orderId, date }
  *        deleteOrder       { orderId } -> { status: "success", deletedId, ok: true }
  *        archiveOrder      { order }   -> marks the row delivered
  *        addProduct / updateProduct / updateStock -> generic header-mapped writes
  *
  * SYNC CONTRACT (production hardening)
  *   Reads should be fetched with cache: 'no-store' plus a cache-buster
  *   (?_t=Date.now()) — Apps Script and proxies otherwise serve stale rows
  *   for seconds after an append/delete. Writes are idempotent by Order ID
  *   (delete/status/delivery-date resolve the row by ID, never by index), so
  *   a client-side 1-second retry after a lock/transient HTML error is safe
  *   and must not create duplicates.
  * ========================================================================== */

var ORDER_HEADERS = [
  "Order ID",
  "Customer Name",
  "Email",
  "Phone",
  "Items Purchased",
  "Total Amount",
  "Delivery Address",
  "Status",
  "Date",
];

/* ============================ HTTP entry points ========================= */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action;
    if (action === "products") return out_({ products: readProducts_() });
    if (action === "health") {
      return out_({
        ok: true,
        configured: true,
        orders: countRows_(ordersSheet_()),
        products: countRows_(productsSheet_()),
      });
    }
    /* Default and explicit "orders": the storefront order-list contract is a
       bare JSON array of header-keyed rows. Kept byte-compatible on purpose. */
    return out_(readOrderRows_());
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  try {
    var payload = {};
    try {
      payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    } catch (err) {
      return out_({ error: "Malformed JSON body" });
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) payload = {};
    /* Form-encoded posts (and the ?action= query the client always sends)
       fill in whatever the JSON body left out. Body values win. */
    var params = (e && e.parameter) || {};
    for (var k in params) {
      if (payload[k] === undefined) payload[k] = params[k];
    }
    var action = payload.action;
    try {
      /* Public: shoppers place orders. Missing action also inserts, preserving
         the original always-insert behaviour for bare payloads. */
      if (action === "insertOrder" || !action) {
        var record = insertOrder_(payload.order || payload);
        return out_({ ok: true, result: "success", order: record });
      }
      if (action === "signIn") {
        return out_({ ok: true, session: signIn_(payload.email, payload.password) });
      }
      if (!isAdmin_(payload.apiKey)) return out_({ error: "Unauthorized" });
      switch (action) {
        case "addProduct":
          return out_({ ok: true, product: addProduct_(payload.product || payload) });
        case "updateProduct":
          return out_({ ok: true, product: updateProduct_(payload.product || payload) });
        case "updateStock": {
          var stocked = updateStock_(payload.id, payload.stock);
          return out_({ ok: true, id: stocked.id, stock: stocked.stock });
        }
        case "updateOrderStatus":
          return out_({ ok: true, order: updateOrderStatus_(payload.orderId, payload.status) });
        case "updateDeliveryDate":
          return out_({
            ok: true,
            order: updateDeliveryDate_(payload.orderId, payload.date !== undefined ? payload.date : payload.deliveryDate),
          });
        case "deleteOrder": {
          /* Accepts every id spelling the clients send (orderId / order_id /
             id / "Order ID", or nested inside order) so a valid delete is
             never refused for a key-name mismatch. */
          var rawOrder = payload.order && typeof payload.order === "object" ? payload.order : null;
          var deleteId =
            payload.orderId !== undefined && payload.orderId !== null && payload.orderId !== ""
              ? payload.orderId
              : payload.order_id !== undefined && payload.order_id !== null && payload.order_id !== ""
                ? payload.order_id
                : payload.id !== undefined && payload.id !== null && payload.id !== ""
                  ? payload.id
                  : payload["Order ID"] !== undefined && payload["Order ID"] !== null && payload["Order ID"] !== ""
                    ? payload["Order ID"]
                    : rawOrder
                      ? rawOrder.orderId || rawOrder.order_id || rawOrder.id || rawOrder["Order ID"] || ""
                      : "";
          var deletedId = deleteOrder_(deleteId);
          return out_({
            status: "success",
            deletedId: deletedId,
            ok: true,
            deleted: deletedId,
            message: "Order deleted successfully",
          });
        }
        case "archiveOrder":
          return out_({ ok: true, order: archiveOrder_(payload.order || payload) });
        default:
          /* Unknown actions error instead of silently inserting — a mistyped
             action must never create a junk row. */
          return out_({ error: "Unknown action: " + action });
      }
    } catch (err) {
      return out_({ error: String((err && err.message) || err) });
    }
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

/* ============================ infrastructure ============================ */

function out_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function prop_(name, fallback) {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(name);
    return value === null || value === undefined ? fallback : value;
  } catch (err) {
    return fallback;
  }
}

/* Open until the owner sets ADMIN_API_KEY (see header), then enforced.
   Reads stay public either way — that is the storefront's design. */
function isAdmin_(key) {
  var expected = prop_("ADMIN_API_KEY", "");
  if (!expected) return true;
  return String(key || "") === expected;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ordersSheet_() {
  return ss_().getSheetByName("Orders") || ss_().getSheets()[0];
}

/* Null (not throw) when there is no Products tab — reads degrade to []. */
function productsSheet_() {
  var sheets = ss_().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === "Products") return sheets[i];
  }
  return null;
}

function requireProducts_() {
  var sheet = productsSheet_();
  if (!sheet) throw new Error('No "Products" sheet in this spreadsheet.');
  return sheet;
}

function headers_(sheet) {
  if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map(function (h) {
      return String(h);
    });
}

function columnIndex_(sheet, name) {
  var i = headers_(sheet).indexOf(name);
  return i === -1 ? -1 : i + 1;
}

/* First 1-based column matching any of the names, or -1. */
function columnByNames_(sheet, names) {
  for (var i = 0; i < names.length; i++) {
    var col = columnIndex_(sheet, names[i]);
    if (col !== -1) return col;
  }
  return -1;
}

function countRows_(sheet) {
  try {
    if (!sheet || sheet.getLastRow() < 2) return 0;
    return sheet.getLastRow() - 1;
  } catch (err) {
    return 0;
  }
}

/* First non-blank value across the spellings; 0/false survive (only
   undefined, null and "" fall through). Mirrors the dashboard reader. */
function pick_(obj, names, fallback) {
  for (var i = 0; i < names.length; i++) {
    var value = obj[names[i]];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function normalizeKey_(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/* Header-keyed row object straight from the sheet. */
function rowObject_(head, values) {
  var obj = {};
  for (var j = 0; j < head.length; j++) obj[head[j]] = values[j];
  return obj;
}

function findRowBy_(sheet, column, value) {
  var col = columnIndex_(sheet, column);
  if (col === -1) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  /* Normalized comparison: both sides become trimmed, case-folded strings,
     so "LUREI-123 ", "lurei-123" and "LUREI-123" all match the same row.
     Case-sensitive misses used to surface as "No order with id" and the
     dashboard reported them as "database refused to delete". */
  var key = normalizeId_(value);
  if (!key) return null;
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (normalizeId_(values[i][0]) === key) return i + 2;
  }
  return null;
}

/* Canonical ID form for every comparison in this file: trimmed and
   lowercased. Order IDs are case-insensitive identifiers (LUREI-123). */
function normalizeId_(value) {
  return String(value === undefined || value === null ? "" : value).trim().toLowerCase();
}

/* Resolves whichever identifier the caller has across every known spelling
   plus a Column A / Column B full-scan fallback for legacy sheets whose
   header differs from all of them. Comparison is normalized (trimmed +
   case-insensitive) on both sides. */
function findOrderRow_(sheet, id) {
  var key = normalizeId_(id);
  if (!key) return null;
  var names = ["Order ID", "OrderID", "Order Id", "ORDER ID", "order_id", "orderId", "ID", "id"];
  for (var n = 0; n < names.length; n++) {
    var row = findRowBy_(sheet, names[n], key);
    if (row) return row;
  }
  /* Last resort: scan columns A and B directly for legacy sheets whose
     header matches none of the spellings above. Normalized on both sides. */
  try {
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var lastCol = Math.min(Math.max(sheet.getLastColumn(), 1), 2);
      var block = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      for (var i = 0; i < block.length; i++) {
        for (var c = 0; c < block[i].length; c++) {
          if (normalizeId_(block[i][c]) === key) return i + 2;
        }
      }
    }
  } catch (err) {}
  return null;
}

function setCellByNames_(sheet, rowNumber, names, value) {
  var col = columnByNames_(sheet, names);
  if (col === -1) return false;
  sheet.getRange(rowNumber, col).setValue(value);
  return true;
}

/* Appends following the sheet's own header order; unknown layouts get the
   canonical order positionally. A missing Orders header row is bootstrapped
   (Orders tab only — never invent columns on an unknown sheet). */
function appendByHeaders_(sheet, record) {
  var head = headers_(sheet);
  if (!head.length) {
    if (sheet.getName() === "Orders") {
      sheet.appendRow(ORDER_HEADERS.slice());
      head = ORDER_HEADERS.slice();
    } else {
      sheet.appendRow(
        ORDER_HEADERS.map(function (h) {
          return record[h] === undefined || record[h] === null ? "" : record[h];
        })
      );
      return sheet.getLastRow();
    }
  }
  sheet.appendRow(
    head.map(function (h) {
      var value = record[h];
      if (value === undefined || value === null) {
        var alt = matchRecordKey_(record, h);
        value = alt === undefined || alt === null ? "" : alt;
      }
      return value;
    })
  );
  return sheet.getLastRow();
}

/* Case/punctuation-insensitive record lookup, so { totalAED } fills a
   "Total Amount" column and vice versa. */
function matchRecordKey_(record, header) {
  if (record[header] !== undefined) return record[header];
  var norm = normalizeKey_(header);
  for (var k in record) {
    if (normalizeKey_(k) === norm) return record[k];
  }
  return undefined;
}

/* ============================ orders ==================================== */

function readOrderRows_() {
  var sheet = ordersSheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var head = data[0].map(function (h) {
    return String(h);
  });
  var result = [];
  for (var i = 1; i < data.length; i++) {
    result.push(rowObject_(head, data[i]));
  }
  return result;
}

function insertOrder_(order) {
  return withLock_(function () {
    order = order && typeof order === "object" ? order : {};
    var items = pick_(order, ["items", "Items Purchased", "Items"], []);
    var total = Number(pick_(order, ["total", "totalAmount", "totalAED", "Total Amount"], 0));
    var record = {
      "Order ID":
        pick_(order, ["orderId", "order_id", "Order ID"], "") ||
        "LUREI-" + Math.floor(10000 + Math.random() * 90000),
      "Customer Name": pick_(order, ["customerName", "Customer Name", "customer", "name"], "N/A"),
      Email: pick_(order, ["email", "Email"], "N/A"),
      Phone: pick_(order, ["phone", "Phone"], "N/A"),
      "Items Purchased":
        typeof items === "object" ? JSON.stringify(items) : items === "" ? "N/A" : items,
      "Total Amount": isFinite(total) ? total : 0,
      "Delivery Address": pick_(
        order,
        ["address", "Delivery Address", "deliveryAddress", "Address"],
        "N/A"
      ),
      Status: pick_(order, ["status", "Status"], "Pending"),
      Date: pick_(order, ["date", "createdAt", "created_at", "Date"], new Date().toISOString()),
    };
    var sheet = ordersSheet_();
    var rowNumber = appendByHeaders_(sheet, record);
    record._row = rowNumber;
    return record;
  });
}

function updateOrderStatus_(orderId, status) {
  return withLock_(function () {
    var sheet = ordersSheet_();
    var row = findOrderRow_(sheet, orderId);
    if (!row) throw new Error("No order with id " + orderId);
    var next = status || "pending";
    if (!setCellByNames_(sheet, row, ["Status", "status"], next)) {
      throw new Error("No Status column on the Orders sheet.");
    }
    return { orderId: orderId, status: next };
  });
}

function deleteOrder_(orderId) {
  return withLock_(function () {
    /* ID-based, never index-based: row numbers shift after every delete, so
       the client always sends the Order ID and the row is re-resolved here
       at write time across all known ID columns (Order ID / OrderID / id /
       Column A/B fallback) with normalized comparison. On a match the row is
       deleted immediately and a clean success is returned — no strict
       post-delete blockers: the deleteRow call inside the script lock is
       authoritative, and a stale re-read must never convert a valid delete
       into a "refused" error for the dashboard. */
    var raw = String(orderId === undefined || orderId === null ? "" : orderId).trim();
    if (!raw) throw new Error("deleteOrder needs an orderId.");
    var sheet = ordersSheet_();
    var row = findOrderRow_(sheet, raw);
    if (!row) throw new Error("No order with id " + raw);
    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    return String(raw);
  });
}

/* Requested-delivery-date writer for the dashboard's Req. Delivery chip.
   Creates the "Requested Delivery Date" header when an older sheet lacks it,
   so the write never fails with "No date column" on legacy spreadsheets. */
function updateDeliveryDate_(orderId, date) {
  return withLock_(function () {
    var key = String(orderId === undefined || orderId === null ? "" : orderId).trim();
    if (!key) throw new Error("updateDeliveryDate needs an orderId.");
    var next = String(date === undefined || date === null ? "" : date).trim();
    var sheet = ordersSheet_();
    var row = findOrderRow_(sheet, key);
    if (!row) throw new Error("No order with id " + key);
    var col = columnByNames_(sheet, ["Requested Delivery Date", "requested_delivery_date", "Delivery Date"]);
    if (col === -1) {
      var headerCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, headerCol).setValue("Requested Delivery Date");
      col = headerCol;
    }
    sheet.getRange(row, col).setValue(next);
    return { orderId: key, date: next };
  });
}

/* The dashboard keeps the confirmed log itself; server-side filing just marks
   the live row delivered so a re-fetch never resurrects it as pending. */
function archiveOrder_(order) {
  return withLock_(function () {
    order = order && typeof order === "object" ? order : {};
    var orderId = pick_(order, ["orderId", "order_id", "Order ID"], "");
    if (!orderId) throw new Error("archiveOrder needs an orderId.");
    var sheet = ordersSheet_();
    var row = findOrderRow_(sheet, orderId);
    if (!row) throw new Error("No order with id " + orderId);
    setCellByNames_(sheet, row, ["Status", "status"], "delivered");
    return { orderId: orderId, status: "delivered" };
  });
}

/* ============================ products ================================== */

function readProducts_() {
  var sheet = productsSheet_();
  if (!sheet || sheet.getLastRow() < 1) return [];
  var head = headers_(sheet);
  if (!head.length) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, head.length).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    var blank = true;
    for (var j = 0; j < data[i].length; j++) {
      if (data[i][j] !== "" && data[i][j] !== null) {
        blank = false;
        break;
      }
    }
    if (!blank) result.push(rowObject_(head, data[i]));
  }
  return result;
}

function addProduct_(product) {
  return withLock_(function () {
    product = product && typeof product === "object" ? product : {};
    var sheet = requireProducts_();
    var head = headers_(sheet);
    if (!head.length) throw new Error("The Products sheet has no header row.");
    var row = head.map(function (h) {
      var value = matchRecordKey_(product, h);
      return value === undefined || value === null ? "" : value;
    });
    sheet.appendRow(row);
    return rowObject_(head, row);
  });
}

function updateProduct_(product) {
  return withLock_(function () {
    product = product && typeof product === "object" ? product : {};
    var id = pick_(product, ["id", "ID", "product_id", "Product ID"], "");
    if (!id) throw new Error("updateProduct needs an id.");
    var sheet = requireProducts_();
    var row = findRowBy_(sheet, "ID", id) || findRowBy_(sheet, "id", id);
    if (!row) {
      var head = headers_(sheet);
      for (var i = 0; i < head.length; i++) {
        if (normalizeKey_(head[i]) === "productid") {
          row = findRowBy_(sheet, head[i], id);
          if (row) break;
        }
      }
    }
    if (!row) throw new Error("No product with id " + id);
    var writeHead = headers_(sheet);
    for (var key in product) {
      for (var c = 0; c < writeHead.length; c++) {
        if (normalizeKey_(writeHead[c]) === normalizeKey_(key)) {
          sheet.getRange(row, c + 1).setValue(product[key]);
          break;
        }
      }
    }
    var values = sheet.getRange(row, 1, 1, writeHead.length).getValues()[0];
    return rowObject_(writeHead, values);
  });
}

function updateStock_(id, stock) {
  return withLock_(function () {
    if (id === undefined || id === null || id === "") throw new Error("updateStock needs an id.");
    var sheet = requireProducts_();
    var row =
      findRowBy_(sheet, "ID", id) ||
      findRowBy_(sheet, "id", id) ||
      (function () {
        var head = headers_(sheet);
        for (var i = 0; i < head.length; i++) {
          if (normalizeKey_(head[i]) === "productid") return findRowBy_(sheet, head[i], id);
        }
        return null;
      })();
    if (!row) throw new Error("No product with id " + id);
    var next = Number(stock);
    if (!isFinite(next)) throw new Error("Stock must be a number.");
    if (!setCellByNames_(sheet, row, ["Stock", "stock", "quantity", "Quantity", "Qty", "inventory", "Inventory"], next)) {
      throw new Error("No stock column on the Products sheet.");
    }
    return { id: id, stock: next };
  });
}

/* ============================ auth ====================================== */

function signIn_(email, password) {
  var expectedEmail = prop_("ADMIN_EMAIL", "");
  var expectedPassword = prop_("ADMIN_PASSWORD", "");
  if (!expectedEmail || !expectedPassword) {
    throw new Error("Admin sign-in is not configured (ADMIN_EMAIL / ADMIN_PASSWORD).");
  }
  var emailOk =
    String(email || "")
      .trim()
      .toLowerCase() === expectedEmail.trim().toLowerCase();
  var passwordOk = String(password || "") === expectedPassword;
  if (!emailOk || !passwordOk) throw new Error("Invalid admin credentials.");
  return { role: "admin", email: expectedEmail };
}

/* Convenience entry point for a quick manual check from the Apps Script editor. */
function testConnection() {
  return JSON.stringify({
    orders: countRows_(ordersSheet_()),
    products: countRows_(productsSheet_()),
  });
}
