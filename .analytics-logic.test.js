/* Extracts the analytics data layer from admin-dashboard.html and exercises
   it against a fixed clock. Throwaway harness: not part of the site. */
const fs = require("fs");

const html = fs.readFileSync("admin-dashboard.html", "utf8");
const lines = html.split(/\r?\n/);

/* Locate the data layer by its section banners rather than hardcoding line
   numbers, so edits above it don't silently shift the slice. */
const START = "/* ---------------- Executive analytics: data layer ----------------";
const END = "/* ---------------- Analytics ----------------";
const from = lines.findIndex((l) => l.includes(START)) + 1;
const to = lines.findIndex((l) => l.includes(END));
if (!from || to < 0) throw new Error("data layer section banners not found");
const dataLayer = lines.slice(from - 1, to).join("\n");

const sandbox = `
"use strict";
var __out = [];
const escapeHTML = (v) => String(v);
const formatAED = (v) => "AED " + (Number(v)||0).toFixed(2);
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const formatDisplayDate = (d) => String(d.getDate()).padStart(2,"0") + " " + MONTH_LABELS[d.getMonth()] + " " + d.getFullYear();
const isDelivered = (o) => String(o.status || "").toLowerCase() === "delivered";
const parseLocalDate = (s) => { const p = String(s).trim().match(/^(\\d{4})-(\\d{2})-(\\d{2})/); if(!p) return null; const d = new Date(+p[1], +p[2]-1, +p[3]); return isNaN(d) ? null : d; };
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const daysUntil = (d) => Math.round((d.getTime() - startOfToday().getTime()) / 86400000);
${dataLayer}
return {
  PERIODS, resolvePeriod, previousWindow, inWindow, filterOrders,
  revenueOf, customerKeyOf, aovOf, growthPercent,
  categoryOf, buildCategoryStats, buildProductStats, buildHourStats,
  buildSeries, buildExecutiveMetrics, formatDisplayDate, formatGulfDate,
  formatPercent, describeRange, periodPhrase, periodClause, periodNoun,
  gulfTime, startOfGulfDay, startOfGulfWeek,
  get activePeriodId(){ return activePeriodId; },
  set activePeriodId(v){ activePeriodId = v; },
  get activeMonthKey(){ return activeMonthKey; },
  set activeMonthKey(v){ activeMonthKey = v; },
  get activeDayKey(){ return activeDayKey; },
  set activeDayKey(v){ activeDayKey = v; },
};
`;

const api = new Function(sandbox)();

let pass = 0;
const fail = [];
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else fail.push(name + (extra ? " -> " + extra : ""));
};
const near = (name, got, want, tol) =>
  ok(name, Math.abs(got - want) <= (tol || 0.001), "got " + got + " want ~" + want);

/* Fixed clock: 2026-10-15T10:00Z = 14:00 GST on 15 Oct 2026. */
const REAL_NOW = Date.now;
const FIXED = Date.parse("2026-10-15T10:00:00Z");
global.Date = class extends Date {
  constructor(...a) { if (!a.length) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

const iso = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h)).toISOString();
const order = (id, o) => Object.assign({
  orderId: id, totalAED: 100, status: "pending", items: [], createdAt: iso(2026, 10, 1, 12),
}, o);

/* ---- Period windows ---- */
const ymd = (d) => d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate();

let w = api.resolvePeriod("month");
ok("month window starts 1 Oct", ymd(w.start) === "2026-10-1", ymd(w.start));
ok("month window ends 1 Nov", ymd(w.end) === "2026-11-1", ymd(w.end));
ok("month compare label", w.meta.compare === "vs last month", w.meta.compare);
ok("month window starts at UTC midnight", w.start.getUTCHours() === 0);

w = api.resolvePeriod("d30");
ok("30d spans 30 days", Math.round((w.end - w.start) / 86400000) === 30, Math.round((w.end - w.start) / 86400000));
ok("30d ends 16 Oct", ymd(w.end) === "2026-10-16", ymd(w.end));
ok("30d starts 16 Sep", ymd(w.start) === "2026-9-16", ymd(w.start));
ok("30d compare label", w.meta.compare === "vs previous 30 days");

ok("unknown period falls back to month", api.resolvePeriod("nonsense").id === "month");

/* ---- Picked month and picked day ---- */
/* These two replace the quarter and all-time pills: the admin names a calendar
   month or one specific day instead of a relative range. */
ok("quarter pill is gone", !("quarter" in api.PERIODS), Object.keys(api.PERIODS).join(","));
ok("all-time pill is gone", !("all" in api.PERIODS), Object.keys(api.PERIODS).join(","));

api.activeMonthKey = "2026-11";
let cm = api.resolvePeriod("customMonth");
ok("picked month starts 1 Nov", ymd(cm.start) === "2026-11-1", ymd(cm.start));
ok("picked month ends 1 Dec", ymd(cm.end) === "2026-12-1", ymd(cm.end));
ok("picked month is pinned", cm.meta.pinned === true);
ok("picked month label", cm.meta.label === "November 2026", cm.meta.label);
ok("picked month phrase", api.periodClause(cm.meta) === "in November 2026", api.periodClause(cm.meta));

/* December rolls the year over, and January crosses back the other way. */
api.activeMonthKey = "2026-12";
ok("Dec 2026 ends Jan 2027", ymd(api.resolvePeriod("customMonth").end) === "2027-1-1");
api.activeMonthKey = "2026-01";
ok("Jan 2026 ends Feb 2026", ymd(api.resolvePeriod("customMonth").end) === "2026-2-1");

api.activeDayKey = "2026-10-05";
let cd = api.resolvePeriod("customDay");
ok("picked day starts at itself", ymd(cd.start) === "2026-10-5", ymd(cd.start));
ok("picked day ends next day", ymd(cd.end) === "2026-10-6", ymd(cd.end));
ok("picked day is pinned", cd.meta.pinned === true);
ok("picked day takes 'on'", api.periodClause(cd.meta) === "on 05 Oct 2026", api.periodClause(cd.meta));
ok("picked day baseline noun is day", api.periodNoun(cd.meta) === "day", api.periodNoun(cd.meta));

/* A day the picker cannot produce must not resolve to a window at all. */
["2026-02-31", "2026-13-01", "26-10-05", "", "not-a-date"].forEach((key) => {
  api.activeDayKey = key;
  ok("rejects day key " + JSON.stringify(key), api.resolvePeriod("customDay").id === "customMonth",
    api.resolvePeriod("customDay").id);
});
api.activeDayKey = "2026-10-05";

["2026-00", "2026-13", "", "nope"].forEach((key) => {
  api.activeMonthKey = key;
  ok("rejects month key " + JSON.stringify(key), api.resolvePeriod("customMonth").id === "month",
    api.resolvePeriod("customMonth").id);
});
api.activeMonthKey = "2026-10";

/* A cleared picker falls back to the rolling month rather than to an empty
   window, and the returned id says which window it actually describes. */
api.activeMonthKey = "";
api.activeDayKey = "";
const fallback = api.resolvePeriod("customDay");
ok("cleared pickers fall back to month", fallback.id === "month", fallback.id);
ok("fallback window is Oct 2026", ymd(fallback.start) === "2026-10-1", ymd(fallback.start));
ok("fallback baseline matches", ymd(api.previousWindow(fallback.id).start) === "2026-9-1",
  ymd(api.previousWindow(fallback.id).start));

/* ---- Previous window ---- */
let pw = api.previousWindow("month");
ok("prev month = Sep", ymd(pw.start) === "2026-9-1" && ymd(pw.end) === "2026-10-1", ymd(pw.start) + "->" + ymd(pw.end));
pw = api.previousWindow("d30");
ok("prev 30d also 30 days", Math.round((pw.end - pw.start) / 86400000) === 30);
ok("prev 30d abuts current", pw.end.getTime() === api.resolvePeriod("d30").start.getTime(),
  ymd(pw.end) + " vs " + ymd(api.resolvePeriod("d30").start));
/* Each picked window is measured against the one immediately before it. */
api.activeMonthKey = "2026-11";
pw = api.previousWindow("customMonth");
ok("prev month of Nov is Oct", ymd(pw.start) === "2026-10-1" && ymd(pw.end) === "2026-11-1",
  ymd(pw.start) + "->" + ymd(pw.end));
api.activeMonthKey = "2026-01";
pw = api.previousWindow("customMonth");
ok("prev month of Jan 2026 is Dec 2025", ymd(pw.start) === "2025-12-1" && ymd(pw.end) === "2026-1-1",
  ymd(pw.start) + "->" + ymd(pw.end));

api.activeDayKey = "2026-10-05";
pw = api.previousWindow("customDay");
ok("prev day of 05 Oct is 04 Oct", ymd(pw.start) === "2026-10-4" && ymd(pw.end) === "2026-10-5",
  ymd(pw.start) + "->" + ymd(pw.end));
api.activeDayKey = "2026-01-01";
pw = api.previousWindow("customDay");
ok("prev day of 01 Jan 2026 is 31 Dec 2025", ymd(pw.start) === "2025-12-31" && ymd(pw.end) === "2026-1-1",
  ymd(pw.start) + "->" + ymd(pw.end));

/* The baseline must abut the window exactly, or the growth figure would
   double-count orders sitting in the overlap. */
api.activeMonthKey = "2026-11";
const nov = api.resolvePeriod("customMonth");
ok("picked month baseline abuts it", api.previousWindow("customMonth").end.getTime() === nov.start.getTime(),
  ymd(api.previousWindow("customMonth").end) + " vs " + ymd(nov.start));
api.activeMonthKey = "2026-10";

/* ---- Period windows, read through UTC getters ---- */
/* gulfTime must be read via getUTC*, otherwise the host timezone leaks in.
   This machine is not UTC, so a local-getter implementation fails here. */
const g = api.gulfTime("2026-10-15T22:00:00Z");
ok("22:00 UTC is 02:00 next day GST",
  g.getUTCFullYear() === 2026 && g.getUTCMonth() === 9 && g.getUTCDate() === 16 && g.getUTCHours() === 2,
  g.toISOString());
ok("gulfTime shifts exactly 4h", g.getTime() - Date.parse("2026-10-15T22:00:00Z") === 4 * 3600000);
ok("gulfTime rejects junk", api.gulfTime("not-a-date") === null);

ok("formatGulfDate renders UTC fields",
  api.formatGulfDate(g) === "16 Oct 2026", api.formatGulfDate(g));

const d = api.startOfGulfDay(g);
ok("startOfGulfDay truncates via UTC",
  d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCDate() === 16, d.toISOString());

/* A Dubai 23:30 order belongs to the same Gulf day even though UTC says
   otherwise - the case that proves the shift is applied before bucketing. */
const lateNight = api.gulfTime("2026-10-10T19:30:00Z");
ok("19:30 UTC -> 23:30 same day GST",
  lateNight.getUTCDate() === 10 && lateNight.getUTCHours() === 23, lateNight.toISOString());
ok("startOfGulfDay keeps that date", api.startOfGulfDay(lateNight).getUTCDate() === 10);

/* Monday-based weeks: 04 Oct 2026 is a Sunday, so it belongs to the week
   beginning Mon 29 Sep, and startOfGulfWeek must say so. */
const sun = api.gulfTime("2026-10-04T10:00:00Z");
ok("Sunday week starts previous Monday",
  api.startOfGulfWeek(sun).getUTCMonth() === 8 && api.startOfGulfWeek(sun).getUTCDate() === 28,
  api.startOfGulfWeek(sun).toISOString());
const mon = api.gulfTime("2026-10-05T04:00:00Z");
ok("Monday week starts itself",
  api.startOfGulfWeek(mon).getUTCDate() === 5, api.startOfGulfWeek(mon).toISOString());

/* ---- GST hour bucketing ---- */
const hours = api.buildHourStats([
  order("A", { createdAt: iso(2026, 10, 2, 12) }), /* 16:00 GST */
  order("B", { createdAt: iso(2026, 10, 3, 12) }), /* 16:00 GST */
  order("C", { createdAt: iso(2026, 10, 4, 0) }),  /* 04:00 GST */
]);
ok("hour counts in GST", hours.counts[16] === 2 && hours.counts[4] === 1, JSON.stringify(hours.counts));
ok("peak is 16", hours.peak === 16);
ok("all 24 buckets exist", hours.counts.length === 24);
ok("timed counts every valid order", hours.timed === 3);
near("peak share 2/3", hours.peakShare, 2 / 3);

/* An order placed at 02:00 Dubai time is 22:00 UTC the previous day. If the
   shift were missing it would be counted at hour 22 instead of 2. */
const smallHours = api.buildHourStats([order("N", { createdAt: iso(2026, 10, 9, 22) })]);
ok("02:00 GST counted at hour 2", smallHours.counts[2] === 1 && smallHours.counts[22] === 0,
  "h2=" + smallHours.counts[2] + " h22=" + smallHours.counts[22]);

/* ---- Growth ---- */
ok("growth null on zero base", api.growthPercent(50, 0) === null);
ok("growth up", Math.abs(api.growthPercent(150, 100) - 50) < 0.01);
ok("growth down", Math.abs(api.growthPercent(75, 100) + 25) < 0.01);

/* ---- AOV ---- */
near("aov", api.aovOf([order("A"), order("B", { totalAED: 300 })]), 200);

/* ---- Categories (rule order matters) ---- */
ok("ear cuff set -> Earrings", api.categoryOf("Luna Layered Ear Cuffs Set") === "Earrings", api.categoryOf("Luna Layered Ear Cuffs Set"));
ok("handcuff -> Bracelets", api.categoryOf("Bianca Handcuff") === "Bracelets");
ok("hoops -> Hoops", api.categoryOf("Crystal Cherry Hoops") === "Hoops");
ok("chain -> Chains", api.categoryOf("The Crystal Chain") === "Chains");
ok("eternal love -> Chains", api.categoryOf("The Eternal Love") === "Chains");
ok("selen bangles -> Bracelets", api.categoryOf("Silver Selen Bangles") === "Bracelets");
ok("cartier bracelet -> Bracelets", api.categoryOf("Cartier Inspired Bracelet") === "Bracelets");
ok("stud -> Earrings", api.categoryOf("Petal Stud") === "Earrings");
ok("vintage shine watch", api.categoryOf("Vintage Shine") === "Watches", api.categoryOf("Vintage Shine"));
ok("unknown -> Other", api.categoryOf("Zzz Novelty") === "Other");

const cat = api.buildCategoryStats([
  order("A", { items: [{ title: "Crystal Cherry Hoops", quantity: 2, price: 20 }, { title: "Petal Stud", quantity: 1, price: 20 }] }),
  order("B", { items: [{ title: "Crystal Cherry Hoops", quantity: 1, price: 20 }] }),
]);
ok("category totals", cat.total === 4, "total " + cat.total);
ok("category sorted desc", cat.rows[0].label === "Hoops" && cat.rows[0].units === 3, JSON.stringify(cat.rows));
near("category share 0.75", cat.rows[0].share, 0.75);

/* ---- Products ---- */
const prods = api.buildProductStats([
  order("A", { items: [{ title: "Hoops", quantity: 2, price: 20 }, { title: "Stud", quantity: 1, price: 20 }] }),
  order("B", { items: [{ title: "Hoops", quantity: 3, price: 20 }] }),
]);
ok("top product by units", prods[0].title === "Hoops" && prods[0].units === 5, JSON.stringify(prods[0]));
ok("product revenue", prods[0].revenue === 100, "rev " + prods[0].revenue);

/* ---- Daily series ---- */
api.activePeriodId = "month";
const mw = api.resolvePeriod("month");
const s = api.buildSeries([
  order("A", { createdAt: iso(2026, 10, 1, 12), totalAED: 100 }),
  order("B", { createdAt: iso(2026, 10, 15, 12), totalAED: 250 }),
], mw);
ok("daily series unit", s.unit === "day");
ok("daily labels = Oct 1..31", s.labels.length === 31, "len " + s.labels.length);
ok("daily label is day number", s.labels[0] === "1" && s.labels[30] === "31", s.labels[0] + "/" + s.labels[30]);
ok("day 1 revenue", s.revenue[0] === 100);
ok("day 15 revenue", s.revenue[14] === 250);
ok("day 15 count", s.counts[14] === 1);
ok("empty days zero", s.revenue[10] === 0 && s.counts[10] === 0);
ok("series sums equal revenue", s.revenue.reduce((a, b) => a + b, 0) === 350);

/* Oct 31 order must land, not be dropped */
const sEnd = api.buildSeries([order("Z", { createdAt: iso(2026, 10, 30, 12), totalAED: 999 })], mw);
ok("last-day order is captured", sEnd.revenue[29] === 999, "r30=" + sEnd.revenue[29]);

/* ---- Weekly rollup for long windows ---- */
/* Hand-built rather than resolved: no pill selects an unbounded window any
   more, but buildSeries still handles one, and that path is what keeps a long
   custom month span readable. */
const allW = { id: "customMonth", meta: api.PERIODS.customMonth, start: null, end: null };
const longOrders = [
  order("A", { createdAt: iso(2024, 1, 3, 12) }),
  order("B", { createdAt: iso(2026, 10, 8, 12) }),
];
const long = api.buildSeries(longOrders, allW);
ok("long span uses weeks", long.unit === "week", long.unit);
ok("weekly count is small", long.labels.length < 160, "len " + long.labels.length);
ok("weekly sums all orders", long.counts.reduce((a, b) => a + b, 0) === 2, "got " + long.counts.reduce((a, b) => a + b, 0));
ok("weekly first label w/c", long.labels[0].startsWith("w/c "), long.labels[0]);
/* The last order must land on the final bucket, not one past the end. */
ok("last order hits final bucket", long.counts[long.counts.length - 1] === 1,
  "last=" + long.counts[long.counts.length - 1] + " len=" + long.counts.length);

/* Week bucket must be Monday-aligned and capture an order early in the week */
const sundayOrder = { createdAt: iso(2026, 10, 4, 12) }; /* Sun 04 Oct 2026 */
const wk = api.buildSeries([order("S", sundayOrder)], allW);
ok("weekend order still bucketed", wk.counts.reduce((a, b) => a + b, 0) === 1, "got " + wk.counts.reduce((a, b) => a + b, 0));

/* ---- Executive metrics ---- */
const all = [
  order("A", { createdAt: iso(2026, 10, 2, 12), totalAED: 100, status: "delivered", phone: "111" }),
  order("B", { createdAt: iso(2026, 10, 3, 12), totalAED: 300, phone: "111" }),
  order("C", { createdAt: iso(2026, 10, 4, 12), totalAED: 200, status: "delivered", phone: "222" }),
];
const m = api.buildExecutiveMetrics(all, mw);
ok("revenue scoped", m.revenue === 600, "rev " + m.revenue);
ok("order count scoped", m.orderCount === 3);
ok("pending split", m.pending === 1 && m.delivered === 2);
near("aov scoped", m.aov, 200);
ok("buyers deduped", m.buyers === 2, "buyers " + m.buyers);
ok("repeat buyer counted once", m.repeatBuyers === 1, "repeat " + m.repeatBuyers);
near("repeat rate 50%", m.repeatRate, 50);
near("orders per buyer 1.5", m.ordersPerBuyer, 1.5);

/* Growth against a real prior period. September revenue must equal October's
   for 0%, and half of it for +100% - the sign and the denominator both matter. */
const withPrev = all.concat([order("D", { createdAt: iso(2026, 9, 10, 12), totalAED: 600, phone: "999" })]);
const m2 = api.buildExecutiveMetrics(withPrev, mw);
near("prior period revenue picked up", m2.previousRevenue, 600, 0.001);
near("growth vs Sep = 0%", m2.revenueGrowth, 0, 0.001);

const withHalfPrev = all.concat([order("D", { createdAt: iso(2026, 9, 10, 12), totalAED: 300, phone: "999" })]);
near("growth vs half prior = +100%", api.buildExecutiveMetrics(withHalfPrev, mw).revenueGrowth, 100, 0.001);

const withMorePrev = all.concat([order("D", { createdAt: iso(2026, 9, 10, 12), totalAED: 900, phone: "999" })]);
near("growth vs larger prior = -33%", api.buildExecutiveMetrics(withMorePrev, mw).revenueGrowth, -100 / 3, 0.1);

/* The prior window must not overlap the current one or revenue double-counts. */
const pwv = api.previousWindow("month");
const overlap = withPrev.filter((o) => api.inWindow(o, pwv.start, pwv.end)).map((o) => o.orderId);
ok("only the Sep order is prior", overlap.length === 1 && overlap[0] === "D", JSON.stringify(overlap));
const m3 = api.buildExecutiveMetrics([all[0]], mw);
ok("growth null with empty prior", m3.revenueGrowth === null, String(m3.revenueGrowth));

/* Empty period must not produce NaN */
const emptyM = api.buildExecutiveMetrics([], mw);
ok("empty aov is 0", emptyM.aov === 0);
ok("empty repeat rate 0", emptyM.repeatRate === 0);
ok("empty buyers 0", emptyM.buyers === 0);
ok("empty series", api.buildSeries([], mw).labels.length === 31);
ok("empty hours peak -1", api.buildHourStats([]).peak === -1);
ok("empty categories", api.buildCategoryStats([]).total === 0);

/* Undated / invalid orders must not crash or be silently counted */
const junk = [order("J", { createdAt: "not-a-date" }), order("K", { createdAt: "", totalAED: 50 })];
ok("invalid timestamp filtered out", api.filterOrders(junk, mw).length === 0);
ok("invalid timestamp ignored in series", api.buildSeries(junk, mw).counts.reduce((a, b) => a + b, 0) === 0);
ok("invalid timestamp ignored in hours", api.buildHourStats(junk).timed === 0);

/* ---- Filtering to a picked month or a picked day ----
   The tables are scoped by exactly the window the KPIs are computed from, so
   these check the window narrows the order list rather than only the totals. */
/* Times are chosen so the Gulf date is the one named: 08:00Z is 12:00 the same
   day in Dubai, whereas 20:00Z would already be the next day there. */
const spread = [
  order("OCT-EARLY", { createdAt: iso(2026, 10, 2, 8), totalAED: 100 }),
  order("OCT-LATE", { createdAt: iso(2026, 10, 9, 8), totalAED: 400 }),
  order("NOV", { createdAt: iso(2026, 11, 3, 8), totalAED: 900 }),
];

api.activeMonthKey = "2026-11";
api.activeDayKey = "";
const novRows = api.filterOrders(spread, api.resolvePeriod("customMonth"));
ok("picked month keeps only November", novRows.length === 1 && novRows[0].orderId === "NOV",
  JSON.stringify(novRows.map((o) => o.orderId)));
ok("picked month KPIs use that slice", api.buildExecutiveMetrics(spread, api.resolvePeriod("customMonth")).revenue === 900,
  api.buildExecutiveMetrics(spread, api.resolvePeriod("customMonth")).revenue);
ok("picked month series is Nov 1-30", api.buildSeries(novRows, api.resolvePeriod("customMonth")).labels.length === 30,
  api.buildSeries(novRows, api.resolvePeriod("customMonth")).labels.length);

api.activeDayKey = "2026-10-09";
const dayRows = api.filterOrders(spread, api.resolvePeriod("customDay"));
ok("picked day keeps only that day", dayRows.length === 1 && dayRows[0].orderId === "OCT-LATE",
  JSON.stringify(dayRows.map((o) => o.orderId)));
ok("picked day KPI is that order's value",
  api.buildExecutiveMetrics(spread, api.resolvePeriod("customDay")).revenue === 400,
  api.buildExecutiveMetrics(spread, api.resolvePeriod("customDay")).revenue);
const daySeries = api.buildSeries(dayRows, api.resolvePeriod("customDay"));
ok("picked day series is a single bucket", daySeries.labels.length === 1 && daySeries.counts[0] === 1,
  daySeries.labels.length + "/" + daySeries.counts[0]);

/* A picked day compares against the day before, so both the current and the
   prior figures have to come out of the same 24-hour buckets. */
const dayGrowth = api.buildExecutiveMetrics(
  spread.concat([order("OCT-8", { createdAt: iso(2026, 10, 8, 8), totalAED: 200 })]),
  api.resolvePeriod("customDay")
);
near("picked day growth vs previous day", dayGrowth.revenueGrowth, 100, 0.001);

api.activeDayKey = "";
api.activeMonthKey = "2026-10";

/* Boundary: end is exclusive, start is inclusive */
const edge = api.filterOrders(
  [order("S", { createdAt: iso(2026, 10, 1, 0) }), order("E", { createdAt: iso(2026, 10, 31, 20) })],
  mw
);
ok("first instant included, last excluded", edge.length === 1 && edge[0].orderId === "S", JSON.stringify(edge.map((o) => o.orderId)));

global.Date = REAL_NOW;

console.log("passed: " + pass + " / " + (pass + fail.length));
if (fail.length) { console.log("\nFAILURES:"); fail.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("all analytics logic checks passed");