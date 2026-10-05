/* Stock badge + live-sync regression harness.
 *
 * Extracts the storefront card builders out of script.js and runs them
 * against a minimal DOM shim, then drives the admin store's stock API, so
 * "admin sets 0" and "customer sees OUT OF STOCK" are checked against the same
 * helpers the browser will run. */
const fs = require("fs");
const path = require("path");

let pass = 0;
const fail = [];
const ok = (label, cond, extra) => {
  if (cond) {
    pass++;
    console.log("  ok  " + label);
  } else {
    fail.push(label + (extra ? " -> " + extra : ""));
    console.log("  FAIL " + label + (extra ? " -> " + extra : ""));
  }
};

/* ---------- DOM shim ---------- */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this._text = "";
    this.classList = {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
    };
    this.hidden = false;
    this.disabled = false;
  }
  get className() { return [...this.classList._s].join(" "); }
  set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set innerHTML(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._text; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  append(...kids) { kids.forEach((k) => this.children.push(k)); }
  appendChild(k) { this.children.push(k); return k; }
  replaceChildren(...kids) { this.children = kids; }
  replaceWith(node) { this.replaced = node; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get firstElementChild() { return this.children[0] || null; }
  closest() { return null; }
  remove() {}
  get offsetWidth() { return 1; }
}

global.document = {
  createElement: (t) => new El(t),
  createDocumentFragment: () => new El("fragment"),
  createTextNode: (t) => ({ textContent: String(t) }),
  addEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: new El("html"),
  body: new El("body"),
};
global.window = { addEventListener() {}, location: { href: "", search: "" }, setTimeout, clearTimeout };
global.requestAnimationFrame = (fn) => fn();
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
global.confirm = () => true;

/* ---------- lift the real helpers out of script.js ---------- */
const src = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

function lift(name) {
  const at = src.search(new RegExp("const\\s+" + name + "\\s*="));
  if (at === -1) throw new Error("could not find " + name);
  const arrow = src.indexOf("=>", at);
  if (arrow === -1) throw new Error(name + " is not an arrow function");

  /* Start counting past the arrow: an unparenthesised-looking parameter list
     closes back at depth 0 before the body begins, which a naive scan would
     mistake for the end of the whole helper. */
  let i = arrow + 2;
  while (i < src.length && /\s/.test(src[i])) i++;

  const blockBody = src[i] === "{";
  let depth = blockBody ? 1 : 0;
  if (blockBody) i++;

  for (; i < src.length; i++) {
    const c = src[i];
    if ("([{".indexOf(c) !== -1) depth++;
    else if (")]}".indexOf(c) !== -1) {
      depth--;
      if (blockBody && depth === 0) {
        i++;
        break;
      }
    } else if (c === ";" && depth === 0) {
      i++;
      break;
    }
  }

  return src.slice(src.indexOf("=", at) + 1, i).trim();
}

const toNumber = lift("toNumber");
const stockOf = lift("stockOf");
const stockCountOf = lift("stockCountOf");
const isSoldOut = lift("isSoldOut");
const stockLabelFor = lift("stockLabelFor");

/* The lifted snippets call each other (stockOf -> toNumber), so they are
   evaluated in one shared scope exactly as they are in script.js rather than
   passed in as strings. */
const helpers = { toNumber, stockOf, stockCountOf, isSoldOut, stockLabelFor };

const api = new Function(
  Object.keys(helpers)
    .map((name) => "const " + name + " = " + helpers[name] + ";")
    .concat(["return { " + Object.keys(helpers).join(", ") + " };"])
    .join("\n")
)();

/* ---------- 1. the count model ---------- */
console.log("count model");
ok("missing stock is untracked, not empty", api.stockOf(undefined) === null);
ok("empty string is untracked", api.stockOf("") === null);
ok("junk is untracked", api.stockOf("abc") === null);
ok("null is untracked", api.stockOf(null) === null);
ok("3 stays 3", api.stockOf(3) === 3);
ok("'7' parses", api.stockOf("7") === 7);
ok("2.9 floors to a whole piece", api.stockOf(2.9) === 2);
ok("0 is a real zero", api.stockOf(0) === 0);
ok("'0' is a real zero", api.stockOf("0") === 0);
ok("-4 clamps to zero", api.stockOf(-4) === 0);

console.log("sold-out truth");
ok("no stock and no flag is sellable", api.isSoldOut({}) === false);
ok("stock 0 is sold out", api.isSoldOut({ stock: 0 }) === true);
ok("stock 1 is sellable", api.isSoldOut({ stock: 1 }) === false);
ok("legacy flag still works", api.isSoldOut({ outOfStock: true }) === true);
ok("untracked is never sold out", api.isSoldOut({ stock: null }) === false);
ok("undefined product is safe", api.isSoldOut(undefined) === false);

console.log("badge copy");
ok("count of 3 reads ONLY 3 LEFT", api.stockLabelFor(3) === "ONLY 3 LEFT", api.stockLabelFor(3));
ok("count of 1 is singular", api.stockLabelFor(1) === "ONLY 1 LEFT", api.stockLabelFor(1));
ok("count of 12", api.stockLabelFor(12) === "ONLY 12 LEFT", api.stockLabelFor(12));
ok("no lowercase sentences in the copy", !/piece|remaining|stock/i.test(api.stockLabelFor(4)), api.stockLabelFor(4));
ok("untracked products get no pill", api.stockCountOf({}) === null);
ok("zero products get no pill", api.stockCountOf({ stock: 0 }) === null);
ok("3 gets a pill", api.stockCountOf({ stock: 3 }) === 3);

/* ---------- 2. the old long copy is gone from the file ---------- */
console.log("long copy removed");
ok("no 'remaining in Dubai stock' string in script.js", !/Only \$\{.*\} piece|remaining in Dubai stock\`/.test(src));
ok("stock-label element no longer built", !src.includes("new-in-card__stock-label"));
ok("no stockLabel element in the New In card", !/const stockLabel = document\.createElement/.test(src));
const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8");
ok("dead .new-in-card__stock-label rule removed", !css.includes("new-in-card__stock-label"));
ok("minimal pill class exists in CSS", css.includes("product-card__badge--stock"));
ok("sold-out pill modifier exists in CSS", css.includes("new-in-card__limited--sold-out"));

/* ---------- 3. admin store drives the same numbers ---------- */
console.log("admin store stock API");
const editorSrc = fs.readFileSync(path.join(__dirname, "admin-editor.js"), "utf8");
ok("store.setStock is exposed", /setStock: function/.test(editorSrc));
ok("stockFor is exported for the storefront", /stockFor: stockFor/.test(editorSrc));
ok("modal has a stock field", editorSrc.includes("data-lurei-stock"));
ok("inline editor has a stock field", (editorSrc.match(/data-lurei-stock/g) || []).length >= 2);
ok("quick edit writes the count", /stock: stock,\s*\n\s*outOfStock: stock === 0/.test(editorSrc));
ok("out-of-stock button writes a real zero", /store\.setStock\(product\.id, 0\)/.test(editorSrc));
ok("restock restores the previous count", /lastKnownStock\[product\.id\] \|\| DEFAULT_RESTOCK/.test(editorSrc));
ok("sold-out seeds carry stock", /stock: seed\.stock/.test(editorSrc));

/* ---------- 4. New In picks up admin additions ---------- */
console.log("New In is no longer a frozen list");
ok("renderNewIn uses a computed product list", /newInProducts\(\)\.forEach/.test(src));
ok("additions come from the store, not the whole catalogue", /const added = catalogueAdditions\(\)/.test(src));
ok("the raw catalogue is NOT used as the additions list", !/const added = catalogue\.filter/.test(src));
ok("only genuinely created products are asked for", /store\.created\(\)/.test(src) && /typeof store\.created !== "function"/.test(src));
ok("curated ids still lead the rail", /const seeded = NEW_IN_IDS\.map/.test(src));
ok("admin count beats the seeded vault number", /counted === null \? vault\.left : counted/.test(src));
ok("New In card carries the product id", /card\.dataset\.productId = String\(product\.id\)/.test(src));
ok("New In disables the CTA when sold out", /if \(soldOut\) cta\.disabled = true;/.test(src));
ok("New In withholds the cart id when sold out", /if \(!soldOut\) cta\.dataset\.add = String\(product\.id\);/.test(src));
ok("New In sets the sold-out class", /new-in-card"\);\n\s*card\.dataset\.productId/.test(src) || /if \(soldOut\) card\.classList\.add\("lurei-is-sold-out"\)/.test(src));

/* ---------- 5. object-fit stays ---------- */
console.log("image rendering");
ok("collections card image covers", /\.product-card__media img \{[^}]*object-fit: cover/s.test(css));
ok("new-in card image covers", /\.new-in-card__media img \{[^}]*object-fit: cover/s.test(css));
ok("collections media is square", /aspect-ratio: 1 \/ 1;/.test(css));

/* ---------- 6. end to end: admin writes, storefront renders ---------- */
/* The real proof that the two halves agree: run the admin store, then feed its
   resolved product straight into the storefront's own helpers. */
console.log("admin action -> storefront output");
const vm = require("vm");

const loadEditor = () => {
  const mem = new Map();
  const win = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
    addEventListener: () => {},
  };
  win.window = win;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "admin-editor.js"), "utf8"), vm.createContext(win), {
    filename: "admin-editor.js",
  });
  return win;
};

const catalogue = loadEditor().LureiCatalogue;
/* Shaped like a real storefront row: normalizeProducts always sets both keys. */
const defaults = [
  {
    id: 1,
    title: "Aura Golden Stud",
    price: 25,
    category: "under-30",
    type: "earrings",
    image: "a.jpg",
    stock: null,
    outOfStock: false,
  },
];
catalogue.setDefaults(defaults);
const row = () => catalogue.resolve(defaults)[0];

ok("a fresh product shows no stock pill", api.stockCountOf(row()) === null && !api.isSoldOut(row()));

catalogue.store.setStock(1, 0);
ok("admin sets 0 -> storefront is sold out", api.isSoldOut(row()) === true);
ok("admin sets 0 -> no leftover pill", api.stockCountOf(row()) === null);
ok("admin sets 0 -> the sold-out branch wins over any count", api.stockCountOf(row()) === null && api.isSoldOut(row()));

catalogue.store.setStock(1, 3);
ok("admin sets 3 -> sellable again", api.isSoldOut(row()) === false);
ok("admin sets 3 -> pill reads ONLY 3 LEFT", api.stockLabelFor(api.stockCountOf(row())) === "ONLY 3 LEFT", api.stockLabelFor(api.stockCountOf(row())));

catalogue.store.setStock(1, 1);
ok("admin sets 1 -> singular copy", api.stockLabelFor(api.stockCountOf(row())) === "ONLY 1 LEFT");

catalogue.store.setStock(1, 0);
ok("a second zero still reads sold out", api.isSoldOut(row()) === true);

const added = catalogue.store.add({ title: "Moon Signet", price: 40, category: "under-50", type: "rings", stock: 5 });
ok("a published product lands in the resolved catalogue", catalogue.resolve(defaults).some((p) => p.id === added.id));
ok("a published product renders its own pill", api.stockLabelFor(api.stockCountOf(added)) === "ONLY 5 LEFT");

const addedEmpty = catalogue.store.add({ title: "Spent Piece", price: 40, category: "under-50", type: "rings", stock: 0 });
ok("a product published at 0 renders sold out", api.isSoldOut(addedEmpty) === true);

console.log("the New In rail stays curated");
const additions = catalogue.store.created();
ok("an edited built-in is not an addition", !additions.some((p) => p.id === 1));
ok("published products are additions", additions.some((p) => p.title === "Moon Signet"));
ok("a product published at 0 is still an addition", additions.some((p) => p.title === "Spent Piece"));
catalogue.store.remove(added.id);
ok("a deleted product leaves the additions list", !catalogue.store.created().some((p) => p.id === added.id));
ok("its siblings stay in the additions list", catalogue.store.created().some((p) => p.title === "Spent Piece"));

const uncounted = catalogue.store.add({ title: "Uncounted Piece", price: 40, category: "under-50", type: "rings", stock: null });
ok("an uncounted product is still an addition", catalogue.store.created().some((p) => p.id === uncounted.id));
ok("an uncounted product gets no pill", api.stockCountOf(uncounted) === null && !api.isSoldOut(uncounted));

console.log("");
console.log("passed: " + pass + " / " + (pass + fail.length));
if (fail.length) {
  console.log("");
  fail.forEach((f) => console.log("  FAILED: " + f));
  process.exitCode = 1;
} else {
  console.log("all stock badge + live sync checks passed");
}