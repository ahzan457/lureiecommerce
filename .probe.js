const fs = require("fs");
const lines = fs.readFileSync("admin-dashboard.html", "utf8").split(/\r?\n/);
const START = "/* ---------------- Executive analytics: data layer ----------------";
const END = "/* ---------------- Analytics ----------------";
const from = lines.findIndex((l) => l.includes(START)) + 1;
const to = lines.findIndex((l) => l.includes(END));
if (!from || to < 0) throw new Error("data layer section banners not found");
const dl = lines.slice(from - 1, to).join("\n");

const stubs = [
  'const escapeHTML = (v) => String(v);',
  'const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];',
  'const formatDisplayDate = (d) => String(d.getDate()).padStart(2,"0") + " " + MONTH_LABELS[d.getMonth()] + " " + d.getFullYear();',
  'const isDelivered = (o) => String(o.status || "").toLowerCase() === "delivered";',
  'const parseLocalDate = (s) => null;',
  'const startOfToday = () => new Date();',
  'const daysUntil = () => 0;',
].join("\n");

const src = '"use strict";\n' + stubs + '\n' + dl +
  '\nreturn { resolvePeriod, buildSeries, filterOrders, gulfTime, startOfGulfDay, formatGulfDate };';

const api = new Function(src)();

const FIXED = Date.parse("2026-10-15T10:00:00Z");
const R = Date;
global.Date = class extends R {
  constructor(...a) { if (!a.length) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

const w = api.resolvePeriod("month");
console.log("window", w.start.toISOString(), "->", w.end.toISOString());

const o = [{ orderId: "A", totalAED: 100, status: "pending", items: [], createdAt: "2026-10-01T12:00:00Z" }];
console.log("gulfTime", api.gulfTime(o[0].createdAt).toISOString());
console.log("dayKey ", api.startOfGulfDay(api.gulfTime(o[0].createdAt)).toISOString());
console.log("fmt    ", api.formatGulfDate(api.startOfGulfDay(api.gulfTime(o[0].createdAt))));

const s = api.buildSeries(o, w);
console.log("labels", s.labels.length, JSON.stringify(s.labels.slice(0, 3)));
console.log("revenue", JSON.stringify(s.revenue));
console.log("counts ", JSON.stringify(s.counts));

console.log("nonsense period ->", api.resolvePeriod("nonsense").id);