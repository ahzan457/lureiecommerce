const fs = require("fs");

/* Brace balance + the specific selectors this change introduced. */
["styles.css", "admin-editor.css"].forEach((file) => {
  const css = fs.readFileSync(file, "utf8");
  const stripped = css.replace(/url\([^)]*\)/g, "url()");
  const o = (stripped.match(/\{/g) || []).length;
  const c = (stripped.match(/\}/g) || []).length;
  console.log(file + ": braces " + o + "/" + c + (o === c ? " BALANCED" : "  <-- UNBALANCED"));
});

const styles = fs.readFileSync("styles.css", "utf8");
const editor = fs.readFileSync("admin-editor.css", "utf8");

const needs = [
  [".new-in-card__limited base kept", /\.new-in-card__limited \{/.test(styles)],
  [".new-in-card__limited--sold-out added", /\.new-in-card__limited--sold-out \{/.test(styles)],
  [".product-card__badge--stock added", /\.product-card__badge--stock \{/.test(styles)],
  ["dead .new-in-card__stock-label removed", !styles.includes("new-in-card__stock-label")],
  [".new-in-card sold-out treatment", /\.new-in-card\.lurei-is-sold-out \.new-in-card__media > img/.test(editor)],
  [".new-in-card sold-out CTA", /\.new-in-card\.lurei-is-sold-out \.new-in-card__cta/.test(editor)],
  ["empty shelf hides the bar", /\.new-in-card\.lurei-is-sold-out \.new-in-card__stock \{/.test(editor)],
  [".lurei-card-stock pill", /\.lurei-card-stock \{/.test(editor)],
  [".lurei-field__hint added", /\.lurei-field__hint \{/.test(editor)],
  ["product-card sold-out still intact", /\.product-card\.lurei-is-sold-out \.product-card__media > img/.test(editor)],
  ["object-fit cover on collections image", /\.product-card__media img \{[^}]*object-fit: cover/s.test(styles)],
  ["object-fit cover on new-in image", /\.new-in-card__media img \{[^}]*object-fit: cover/s.test(styles)],
];

let bad = 0;
needs.forEach(([label, cond]) => {
  if (!cond) bad++;
  console.log("  " + (cond ? "ok  " : "FAIL") + " " + label);
});

/* Every class the JS builds must exist in a stylesheet, or the badge silently
   renders unstyled. */
const built = new Set();
const add = (src, re) => {
  for (const m of src.matchAll(re)) built.add(m[1]);
};
add(fs.readFileSync("script.js", "utf8"), /className = "([a-z0-9_-]+)"/g);
add(fs.readFileSync("script.js", "utf8"), /className = "[a-z0-9_-]*?\s([a-z0-9_-]+)"/g);
add(fs.readFileSync("script.js", "utf8"), /classList\.add\("([a-z0-9_-]+)"\)/g);
built.delete(undefined);

const missing = [...built].filter(
  (c) => !styles.includes("." + c) && !editor.includes("." + c)
);
console.log("classes built by script.js: " + built.size + " | with no CSS rule: " + (missing.length ? missing.join(", ") : "none"));
process.exitCode = bad || missing.length ? 1 : 0;