/* Throwaway harness for the storefront editor store.
   Loads admin-editor.js into a fake window/localStorage and exercises the
   merge, tombstone, id-allocation and validation paths. */
const fs = require("fs");
const vm = require("vm");

const PASS = [];
const FAIL = [];

const ok = (name, cond, extra) => {
  (cond ? PASS : FAIL).push(name + (cond ? "" : "  ->  " + (extra === undefined ? "" : JSON.stringify(extra))));
};

const makeWindow = () => {
  const store = new Map();
  const win = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener: () => {},
  };
  win.window = win;
  return win;
};

const load = () => {
  const win = makeWindow();
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync("admin-editor.js", "utf8"), ctx, { filename: "admin-editor.js" });
  return win;
};

/* ---------- price buckets ---------- */
{
  const c = load().LureiCatalogue;
  ok("bucket 25 -> under-30", c.priceBucketFor(25) === "under-30", c.priceBucketFor(25));
  ok("bucket 30 -> under-30", c.priceBucketFor(30) === "under-30", c.priceBucketFor(30));
  ok("bucket 31 -> under-50", c.priceBucketFor(31) === "under-50", c.priceBucketFor(31));
  ok("bucket 50 -> under-50", c.priceBucketFor(50) === "under-50", c.priceBucketFor(50));
  ok("bucket 51 -> under-100", c.priceBucketFor(51) === "under-100", c.priceBucketFor(51));
  ok("bucket 100 -> under-100", c.priceBucketFor(100) === "under-100", c.priceBucketFor(100));
  ok("bucket 130 -> under-150", c.priceBucketFor(130) === "under-150", c.priceBucketFor(130));
  ok("bucket 'AED 45.00' -> under-50", c.priceBucketFor("AED 45.00") === "under-50", c.priceBucketFor("AED 45.00"));
  ok("bucket junk -> under-30", c.priceBucketFor("abc") === "under-30", c.priceBucketFor("abc"));
}

/* ---------- empty store is transparent ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [
    { id: 1, title: "Aura Golden Stud", price: 25, category: "under-30", type: "earrings", image: "a.jpg" },
    { id: 2, title: "Cartier Inspired Bracelet", price: 30, category: "under-30", type: "bracelets", image: "b.jpg" },
  ];
  c.setDefaults(defaults);
  const out = c.resolve(defaults);
  ok("empty store returns defaults unchanged", out.length === 2 && out[0].title === "Aura Golden Stud");
  ok("defaults keep their own fields", out[0].image === "a.jpg");
}

/* ---------- price edit on a built-in product ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [
    { id: 1, title: "Aura Golden Stud", price: 25, category: "under-30", type: "earrings", image: "a.jpg", description: "d" },
    { id: 2, title: "Bracelet", price: 30, category: "under-30", type: "bracelets", image: "b.jpg" },
  ];
  c.setDefaults(defaults);
  c.store.update(1, { price: 95, category: c.priceBucketFor(95) });

  const out = c.resolve(defaults);
  const p1 = out.find((p) => String(p.id) === "1");
  ok("edited price wins", p1.price === 95, p1.price);
  ok("edited bucket wins", p1.category === "under-100", p1.category);
  ok("untouched image survives a price edit", p1.image === "a.jpg", p1.image);
  ok("untouched description survives", p1.description === "d", p1.description);
  ok("title survives", p1.title === "Aura Golden Stud");
  ok("sibling untouched", out.find((p) => String(p.id) === "2").price === 30);
}

/* ---------- add allocates a free id ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [
    { id: 1, title: "One", price: 25, category: "under-30", type: "earrings" },
    { id: 2, title: "Two", price: 30, category: "under-30", type: "earrings" },
  ];
  c.setDefaults(defaults);
  const added = c.store.add({ title: "Solitaire Gold Ring", price: 45, type: "rings", image: "data:image/jpeg;base64,AAA" });

  ok("new id is above the highest built-in id", added.id === 3, added.id);
  ok("new product bucket derived from price", added.category === "under-50", added.category);
  ok("new product appears in resolve", c.resolve(defaults).some((p) => p.title === "Solitaire Gold Ring"));
  ok("base64 image is stored verbatim", added.image === "data:image/jpeg;base64,AAA");
  ok("base products untouched", c.resolve(defaults).length === 3);

  const second = c.store.add({ title: "Another", price: 10, type: "earrings" });
  ok("second add increments", second.id === 4, second.id);
}

/* ---------- validation ---------- */
{
  const c = load().LureiCatalogue;
  c.setDefaults([{ id: 1, title: "One", price: 25, category: "under-30", type: "earrings" }]);

  let msg = "";
  try { c.store.add({ title: "", price: 20, type: "rings" }); } catch (e) { msg = e.message; }
  ok("rejects a blank name", /name/i.test(msg), msg);

  msg = "";
  try { c.store.add({ title: "Priceless", price: 0, type: "rings" }); } catch (e) { msg = e.message; }
  ok("rejects a zero price", /price/i.test(msg), msg);

  msg = "";
  try { c.store.add({ title: "one", price: 30, type: "earrings" }); } catch (e) { msg = e.message; }
  ok("rejects a duplicate name", /already/i.test(msg), msg);

  msg = "";
  try { c.store.update(999, { price: 10 }); } catch (e) { msg = e.message; }
  ok("rejects an unknown id", /no longer/i.test(msg), msg);
}

/* ---------- out of stock / restock ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [{ id: 1, title: "One", price: 25, category: "under-30", type: "earrings", image: "a.jpg" }];
  c.setDefaults(defaults);

  c.store.setOutOfStock(1, true);
  let p = c.resolve(defaults)[0];
  ok("outOfStock set", p.outOfStock === true);
  ok("outOfStock keeps image", p.image === "a.jpg");

  c.store.setOutOfStock(1, false);
  p = c.resolve(defaults)[0];
  ok("restock clears the flag", p.outOfStock === false);
}

/* ---------- delete tombstone survives a reload ---------- */
{
  const win = makeWindow();
  const ctx = vm.createContext(win);
  const src = fs.readFileSync("admin-editor.js", "utf8");
  vm.runInContext(src, ctx, { filename: "admin-editor.js" });
  const c = win.LureiCatalogue;

  const defaults = [
    { id: 1, title: "One", price: 25, category: "under-30", type: "earrings" },
    { id: 2, title: "Two", price: 30, category: "under-30", type: "earrings" },
    { id: 3, title: "Three", price: 40, category: "under-50", type: "earrings" },
  ];
  c.setDefaults(defaults);
  c.store.remove(2);

  let out = c.resolve(defaults);
  ok("deleted product is gone", !out.some((p) => String(p.id) === "2"));
  ok("deletion did not touch siblings", out.length === 2);

  /* simulate a fresh page load: new script instance, same localStorage */
  const win2 = makeWindow();
  win2.localStorage = win.localStorage;
  const ctx2 = vm.createContext(win2);
  vm.runInContext(src, ctx2, { filename: "admin-editor.js" });
  const c2 = win2.LureiCatalogue;
  c2.setDefaults(defaults);
  out = c2.resolve(defaults);
  ok("deletion survives a reload", !out.some((p) => String(p.id) === "2"), out.map((p) => p.id));
  ok("siblings survive a reload", out.length === 2, out.length);

  c2.store.restore(2);
  ok("restore brings it back", c2.resolve(defaults).some((p) => String(p.id) === "2"));
}

/* ---------- an override never blanks a built-in field ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [{ id: 7, title: "Seven", price: 45, category: "under-50", type: "rings", image: "seven.jpg", description: "desc" }];
  c.setDefaults(defaults);
  c.store.update(7, { title: "Seven Rings", price: 60 });

  const p = c.resolve(defaults)[0];
  ok("rename applied", p.title === "Seven Rings", p.title);
  ok("blank override fields do not wipe defaults", p.image === "seven.jpg" && p.description === "desc", p);
}

/* ---------- corrupt storage falls back cleanly ---------- */
{
  const win = makeWindow();
  const ctx = vm.createContext(win);
  const src = fs.readFileSync("admin-editor.js", "utf8");
  win.localStorage.setItem("lurei_products", "{not json");
  vm.runInContext(src, ctx, { filename: "admin-editor.js" });
  const c = win.LureiCatalogue;
  const defaults = [{ id: 1, title: "One", price: 25, category: "under-30", type: "earrings" }];
  c.setDefaults(defaults);
  ok("corrupt storage does not throw", c.resolve(defaults).length === 1);

  win.localStorage.setItem("lurei_products", JSON.stringify({ version: 1, products: "nope", removed: 7 }));
  ok("wrong-typed fields fall back to defaults", c.resolve(defaults).length === 1, c.resolve(defaults));
}

/* ---------- legacy bare-array storage ---------- */
{
  const win = makeWindow();
  win.localStorage.setItem("lurei_products", JSON.stringify([{ id: 5, title: "Legacy", price: 20, type: "rings" }]));
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync("admin-editor.js", "utf8"), ctx, { filename: "admin-editor.js" });
  const c = win.LureiCatalogue;
  c.setDefaults([]);
  ok("legacy array shape still loads", c.resolve([]).length === 1, c.resolve([]));
}

/* ---------- quota guard ---------- */
{
  const c = load().LureiCatalogue;
  c.setDefaults([{ id: 1, title: "One", price: 25, category: "under-30", type: "earrings" }]);
  let msg = "";
  try {
    c.store.add({ title: "Huge", price: 10, type: "rings", image: "data:image/jpeg;base64," + "A".repeat(5 * 1024 * 1024) });
  } catch (e) { msg = e.message; }
  ok("oversized catalogue is refused with a readable message", /too large/i.test(msg), msg.slice(0, 60));
}

/* ---------- subscribers fire on change ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [{ id: 1, title: "One", price: 25, category: "under-30", type: "earrings" }];
  c.setDefaults(defaults);
  let hits = 0;
  c.subscribe(() => hits++);
  c.store.setOutOfStock(1, true);
  c.store.update(1, { price: 30 });
  ok("subscriber notified on every commit", hits === 2, hits);
}

/* ---------- stock counts ---------- */
{
  const c = load().LureiCatalogue;
  const defaults = [
    { id: 1, title: "Aura Golden Stud", price: 25, category: "under-30", type: "earrings", image: "a.jpg" },
  ];
  c.setDefaults(defaults);

  ok("stockFor keeps a whole number", c.stockFor(3) === 3, c.stockFor(3));
  ok("stockFor parses a numeric string", c.stockFor("5") === 5, c.stockFor("5"));
  ok("stockFor floors a decimal", c.stockFor("2.9") === 2, c.stockFor("2.9"));
  ok("stockFor keeps an explicit zero", c.stockFor(0) === 0, c.stockFor(0));
  ok("stockFor treats junk as untracked, not empty", c.stockFor("n/a") === null, c.stockFor("n/a"));
  ok("stockFor treats a missing count as untracked", c.stockFor(undefined) === null);

  /* The dangerous case: an untracked product must never publish as sold out.
     An untouched built-in comes back exactly as it went in, so the field is
     absent rather than null - either way it must not read as 0. */
  const fresh = c.resolve(defaults)[0];
  ok("an untracked built-in product is not sold out", fresh.outOfStock !== true, fresh.outOfStock);
  ok("an untracked built-in product is not zero", fresh.stock !== 0, fresh.stock);

  c.store.setStock(1, 4);
  let p = c.resolve(defaults)[0];
  ok("setStock writes the count", p.stock === 4, p.stock);
  ok("a positive count keeps it sellable", p.outOfStock === false);

  c.store.setStock(1, 0);
  p = c.resolve(defaults)[0];
  ok("zero empties the shelf", p.stock === 0, p.stock);
  ok("zero also raises outOfStock", p.outOfStock === true);

  c.store.setStock(1, 2);
  p = c.resolve(defaults)[0];
  ok("restocking clears outOfStock", p.outOfStock === false, p.outOfStock);
  ok("restocking stores the new count", p.stock === 2, p.stock);
  ok("restocking keeps the image", p.image === "a.jpg", p.image);

  /* A count of 0 must survive the override merge, which skips empty strings. */
  c.store.setStock(1, 0);
  ok("a zero survives a reload", c.resolve(defaults)[0].stock === 0, c.resolve(defaults)[0].stock);

  const made = c.store.add({ title: "Moon Signet", price: 40, category: "under-50", type: "rings", stock: 7 });
  ok("a new product records its stock", made.stock === 7, made.stock);
  ok("a new product with stock is sellable", made.outOfStock === false);

  const empty = c.store.add({ title: "Sold Piece", price: 40, category: "under-50", type: "rings", stock: 0 });
  ok("a new product at zero is born sold out", empty.outOfStock === true);
  ok("a new product at zero records 0", empty.stock === 0, empty.stock);

  const untracked = c.store.add({ title: "Uncounted Piece", price: 40, category: "under-50", type: "rings", stock: null });
  ok("a new product with no count is sellable", untracked.outOfStock === false && untracked.stock === null);

  ok("subscriber hears a stock change", (() => {
    const c2 = load().LureiCatalogue;
    c2.setDefaults(defaults);
    let hits = 0;
    c2.subscribe(() => hits++);
    c2.store.setStock(1, 0);
    c2.store.setStock(1, 3);
    return hits === 2;
  })());
}

console.log(`\nPASS ${PASS.length}`);
if (PASS.length) console.log(PASS.map((s) => "  ok  " + s).join("\n"));
if (FAIL.length) {
  console.log(`\nFAIL ${FAIL.length}`);
  console.log(FAIL.map((s) => "  XX  " + s).join("\n"));
  process.exit(1);
}
console.log("\nall store checks passed");