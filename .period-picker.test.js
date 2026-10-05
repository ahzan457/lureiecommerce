/* Boots the whole admin-dashboard inline script against a minimal DOM shim and
   drives the month dropdown and the date picker, to check that the two new
   filters actually re-scope the tables and the KPIs rather than only the header
   note. Throwaway harness: not part of the site. */
const fs = require("fs");

const html = fs.readFileSync("admin-dashboard.html", "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];

/* ---- Fixed clock: 2026-10-15T10:00Z = 14:00 GST on 15 Oct 2026. ---- */
const REAL_NOW = Date.now;
const FIXED = Date.parse("2026-10-15T10:00:00Z");
global.Date = class extends Date {
  constructor(...a) { if (!a.length) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

/* ---- DOM shim ---- */
const nodes = new Map();

const makeClassList = (node) => {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    /* toggle(cls, force) with the same signature the page relies on. */
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set,
  };
};

const makeNode = (tag) => {
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    textContent: "",
    innerHTML: "",
    value: "",
    hidden: false,
    disabled: false,
    style: new Proxy({}, { get: () => "", set: () => true }),
    dataset: new Proxy({}, { get: (t, k) => t["_" + String(k)], set: (t, k, v) => ((t["_" + String(k)] = v), true) }),
    attrs: {},
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    click() {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  node.classList = makeClassList(node);
  /* Fire every listener registered for a type. */
  node.fire = (type, event) =>
    (node.listeners[type] || []).forEach((fn) => fn({ target: node, preventDefault() {}, ...event }));
  return node;
};

const nodeFor = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, makeNode(selector));
  return nodes.get(selector);
};

/* The pills are the only element list the script binds to individually, so
   they need real nodes with their data-period values to be exercised. */
const pillNodes = ["month", "d30"].map((period) => {
  const node = makeNode("button");
  node.dataset.period = period;
  node.classList.toggle("is-active", period === "month");
  return node;
});

const querySelectorAll = (selector) => {
  if (selector === "#period-filter .period-btn") return pillNodes;
  return [];
};

const store = new Map();

global.document = {
  querySelector: (s) => nodeFor(s),
  querySelectorAll,
  getElementById: (id) => nodeFor("#" + id),
  createElement: (tag) => makeNode(tag),
  addEventListener() {},
  body: makeNode("body"),
  visibilityState: "visible",
};

global.window = {
  scrollTo() {},
  print() {},
  addEventListener() {},
  removeEventListener() {},
  location: { replace() {} },
  LureiBackend: null,
};

global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

global.sessionStorage = {
  getItem: (k) => (k === "adminLoggedIn" ? "true" : null),
  setItem() {},
  clear() {},
};
global.requestAnimationFrame = (fn) => fn();
global.navigator = { userAgent: "node" };

/* ---- Seed data: one sale in October, one in November, on both boards. ---- */
const iso = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h)).toISOString();
const order = (id, extra) => Object.assign({
  orderId: id,
  customerName: "Test " + id,
  phone: "+971500000" + id.slice(-3),
  email: id + "@example.test",
  items: [{ title: "Crystal Cherry Hoops", quantity: 1, price: 100 }],
  totalAED: 100,
  status: "delivered",
  payment: "Paid online",
  createdAt: iso(2026, 10, 2, 8),
}, extra);

/* 08:00Z is 12:00 the same day in Dubai, so the Gulf date is the named one. */
const OCT_LOG = order("OCT-LOG", { totalAED: 100, createdAt: iso(2026, 10, 2, 8), completedAt: iso(2026, 10, 4, 8) });
const NOV_LOG = order("NOV-LOG", { totalAED: 250, createdAt: iso(2026, 11, 3, 8), completedAt: iso(2026, 11, 3, 8) });
const NOV_DAY_LOG = order("NOV-DAY", { totalAED: 70, createdAt: iso(2026, 11, 20, 8), completedAt: iso(2026, 11, 20, 8) });
const OCT_LIVE = order("OCT-LIVE", { totalAED: 10, status: "pending", createdAt: iso(2026, 10, 9, 8) });
const NOV_LIVE = order("NOV-LIVE", { totalAED: 20, status: "pending", createdAt: iso(2026, 11, 20, 8) });
const OLD_LIVE = order("SEP-LIVE", { totalAED: 30, status: "pending", createdAt: iso(2026, 9, 1, 8) });

store.set("lurei_order_archive", JSON.stringify([NOV_DAY_LOG, NOV_LOG, OCT_LOG]));
store.set("lurei_orders", JSON.stringify([OLD_LIVE, OCT_LIVE, NOV_LIVE]));

new Function(script)();

/* ---- Assertions ---- */
let pass = 0;
const fail = [];
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else fail.push(name + (extra ? " -> " + String(extra) : ""));
};

const $ = (s) => nodeFor(s);
const monthSelect = $("#month-select");
const daySelect = $("#day-select");
const periodClear = $("#period-clear");

/* The rail is wired through querySelectorAll, which the shim answers with an
   empty list, so the pills are asserted through the markup instead. */
ok("quarter pill removed", html.indexOf('data-period="quarter"') === -1);
ok("all-time pill removed", html.indexOf('data-period="all"') === -1);
ok("This Month pill kept", html.indexOf('data-period="month"') !== -1);
ok("Last 30 Days pill kept", html.indexOf('data-period="d30"') !== -1);

/* ---- Default state: this month, no specific day ---- */
const options = monthSelect.innerHTML.match(/<option /g) || [];
ok("month dropdown is populated", options.length === 24, options.length + " options");
ok("dropdown opens on the current month", monthSelect.value === "2026-10", monthSelect.value);
ok("dropdown first option is October 2026", monthSelect.innerHTML.indexOf("October 2026") !== -1);
ok("dropdown reaches back 24 months", monthSelect.innerHTML.indexOf("November 2024") !== -1);
ok("dropdown stops there", monthSelect.innerHTML.indexOf("October 2024") === -1);
ok("date field starts empty", daySelect.value === "", daySelect.value);
ok("clear button hidden with no date", periodClear.hidden === true);
ok("This Month pill starts pressed", pillNodes[0].classList.contains("is-active") === true);
ok("Last 30 Days pill starts unpressed", pillNodes[1].classList.contains("is-active") === false);
ok("This Month pill starts aria-pressed", pillNodes[0].getAttribute("aria-pressed") === "true");

/* The whole dashboard is already scoped to the current month on load. */
ok("default KPIs are this month", $("#kpi-revenue").textContent === "AED 100.00", $("#kpi-revenue").textContent);
ok("default order count is this month", $("#kpi-orders").textContent === "1", $("#kpi-orders").textContent);
ok("default note names the month", $("#analytics-note").textContent === "01 Oct 2026 \u2013 31 Oct 2026 \u00b7 GST",
  $("#analytics-note").textContent);

/* A rolling range does not scope the tables: the board keeps every live order. */
ok("default recent orders unfiltered", /of 3$/.test($("#recent-orders-hint").textContent),
  $("#recent-orders-hint").textContent);
ok("default log unfiltered", $("#log-hint").textContent === "3 confirmed orders across all months",
  $("#log-hint").textContent);
ok("log month pills visible by default", $("#log-month-filter").hidden === false);

/* ---- Pick November (two confirmed sales: 250 + 70) ---- */
monthSelect.value = "2026-11";
monthSelect.fire("change");

ok("month pick scopes the KPIs", $("#kpi-revenue").textContent === "AED 320.00", $("#kpi-revenue").textContent);
ok("month pick scopes the order count", $("#kpi-orders").textContent === "2", $("#kpi-orders").textContent);
ok("month pick scopes the revenue meta",
  $("#kpi-revenue-meta").textContent === "2 orders in November 2026", $("#kpi-revenue-meta").textContent);
ok("month pick scopes the note",
  $("#analytics-note").textContent === "01 Nov 2026 \u2013 30 Nov 2026 \u00b7 GST", $("#analytics-note").textContent);

/* Recent Orders must be filtered, and filtered before the last-five slice. */
ok("month pick scopes recent orders", /of 1 in November 2026$/.test($("#recent-orders-hint").textContent),
  $("#recent-orders-hint").textContent);
ok("month pick drops the September order", $("#recent-orders-hint").textContent.indexOf("of 3") === -1);

/* The completed log follows the same window. */
ok("month pick scopes the log", $("#log-hint").textContent === "2 confirmed orders in November 2026",
  $("#log-hint").textContent);
ok("month pick hides the competing log pills", $("#log-month-filter").hidden === true);
ok("month pick scopes log revenue", $("#log-revenue").textContent === "AED 320.00", $("#log-revenue").textContent);

/* ---- Pick a specific day inside November ---- */
daySelect.value = "2026-11-20";
daySelect.fire("change");

ok("day pick scopes the KPIs", $("#kpi-revenue").textContent === "AED 70.00", $("#kpi-revenue").textContent);
ok("day pick scopes the note", $("#analytics-note").textContent === "20 Nov 2026 \u00b7 GST",
  $("#analytics-note").textContent);
ok("day note is not a doubled range",
  $("#analytics-note").textContent.indexOf("\u2013") === -1, $("#analytics-note").textContent);
ok("day pick uses 'on'", $("#kpi-revenue-meta").textContent === "1 order on 20 Nov 2026",
  $("#kpi-revenue-meta").textContent);
ok("day pick scopes recent orders", /of 1 on 20 Nov 2026$/.test($("#recent-orders-hint").textContent),
  $("#recent-orders-hint").textContent);
ok("day pick scopes the log", $("#log-hint").textContent === "1 confirmed order on 20 Nov 2026",
  $("#log-hint").textContent);
ok("day pick drops the other November sale",
  $("#log-revenue").textContent === "AED 70.00", $("#log-revenue").textContent);
ok("day pick shows the clear button", periodClear.hidden === false);
ok("day pick syncs the month dropdown", monthSelect.value === "2026-11", monthSelect.value);
ok("day pick marks the day field active", daySelect.classList.contains("is-active") === true);
ok("day pick unmarks the month dropdown", monthSelect.classList.contains("is-active") === false);

/* A day with nothing in it empties the tables and says why. */
daySelect.value = "2026-11-25";
daySelect.fire("change");
ok("empty day zeroes the KPIs", $("#kpi-revenue").textContent === "AED 0.00", $("#kpi-revenue").textContent);
ok("empty day names the day", /no confirmed sales/i.test($("#analytics-note").textContent),
  $("#analytics-note").textContent);
ok("empty day explains the board", /No orders were placed/.test($("#recent-orders-empty-text").innerHTML),
  $("#recent-orders-empty-text").innerHTML);
ok("empty day explains the log", /No orders were filed/.test($("#log-empty-text").innerHTML),
  $("#log-empty-text").innerHTML);

/* ---- Clearing the day returns to the month that is showing ---- */
periodClear.fire("click");
ok("clear button hides again", periodClear.hidden === true);
ok("clear falls back to the month", $("#kpi-revenue").textContent === "AED 320.00", $("#kpi-revenue").textContent);
ok("clear restores the log", $("#log-hint").textContent === "2 confirmed orders in November 2026",
  $("#log-hint").textContent);

/* Emptying the field by hand is the same gesture as the button. */
daySelect.value = "2026-11-20";
daySelect.fire("change");
daySelect.value = "";
daySelect.fire("change");
ok("emptied field falls back to the month", $("#kpi-revenue").textContent === "AED 320.00",
  $("#kpi-revenue").textContent);

/* Picking a month with nothing in it empties the board and explains why. */
monthSelect.value = "2025-04";
monthSelect.fire("change");
ok("empty month zeroes the KPIs", $("#kpi-revenue").textContent === "AED 0.00", $("#kpi-revenue").textContent);
ok("empty month names itself", $("#kpi-revenue-meta").textContent === "No orders in April 2025",
  $("#kpi-revenue-meta").textContent);
ok("empty month empties recent orders", $("#recent-orders-hint").textContent === "No orders in April 2025",
  $("#recent-orders-hint").textContent);
ok("empty month empties the log", $("#log-hint").textContent === "0 confirmed orders in April 2025",
  $("#log-hint").textContent);

/* The export is disabled rather than quietly producing an empty file. */
ok("export disabled with nothing in scope", $("#export-toggle").disabled === true);
ok("log export disabled with nothing in scope", $("#log-export").disabled === true);

/* ---- The quick-range pills still work, and clear a specific date ---- */
monthSelect.value = "2026-11";
monthSelect.fire("change");
ok("picking a month unpesses the pills", pillNodes[0].classList.contains("is-active") === false);
ok("picking a month updates aria-pressed", pillNodes[0].getAttribute("aria-pressed") === "false");

pillNodes[0].fire("click");
ok("This Month pill re-presses", pillNodes[0].classList.contains("is-active") === true);
ok("This Month pill returns to the rolling month", $("#kpi-revenue").textContent === "AED 100.00",
  $("#kpi-revenue").textContent);
ok("This Month pill unscopes the tables", /of 3$/.test($("#recent-orders-hint").textContent),
  $("#recent-orders-hint").textContent);
ok("This Month pill restores the log pills", $("#log-month-filter").hidden === false);

/* A day chosen first must not survive a pill click: the rail would otherwise
   show "This Month" pressed while a specific day did the filtering. */
daySelect.value = "2026-11-20";
daySelect.fire("change");
ok("day pick hides the clear button again after the pill", periodClear.hidden === false);
pillNodes[0].fire("click");
ok("pill click clears the specific date", daySelect.value === "" && periodClear.hidden === true,
  daySelect.value + "/" + periodClear.hidden);
/* A pill resets the date, not the month: the admin's chosen month is the thing
   they came back to, and yanking it would throw away the selection too. */
ok("pill click keeps the month dropdown value", monthSelect.value === "2026-11", monthSelect.value);

pillNodes[1].fire("click");
ok("Last 30 Days pill presses", pillNodes[1].classList.contains("is-active") === true);
ok("Last 30 Days pill reads as such", $("#kpi-revenue-meta").textContent.indexOf("the last 30 days") !== -1,
  $("#kpi-revenue-meta").textContent);

/* ---- Overview tiles stay lifetime, and say so while a scope is active ---- */
ok("overview revenue tile is lifetime",
  $("#stat-revenue").textContent === "AED 420.00", $("#stat-revenue").textContent);
ok("no all-time marker without a scope",
  $("#stat-revenue-meta").textContent === "Confirmed sales in the Monthly Report",
  $("#stat-revenue-meta").textContent);

monthSelect.value = "2026-11";
monthSelect.fire("change");
ok("overview revenue tile does not follow the scope",
  $("#stat-revenue").textContent === "AED 420.00", $("#stat-revenue").textContent);
ok("overview tile admits it is lifetime",
  $("#stat-revenue-meta").textContent === "Confirmed sales in the Monthly Report \u00b7 all time",
  $("#stat-revenue-meta").textContent);

global.Date = REAL_NOW;

console.log("passed: " + pass + " / " + (pass + fail.length));
if (fail.length) { console.log("\nFAILURES:"); fail.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("all period picker checks passed");