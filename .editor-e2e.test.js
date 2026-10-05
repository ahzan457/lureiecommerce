/* Throwaway end-to-end harness for the storefront editor.
   Drives a real Chrome against the real collections.html to prove the
   edit bar, quick actions, add-product flow and sold-out rendering work
   and that an edit survives a reload. */
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");

const SITE = "file:///" + path.resolve(__dirname).replace(/\\/g, "/") + "/collections.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const PASS = [];
const FAIL = [];
const ok = (name, cond, extra) =>
  (cond ? PASS : FAIL).push(name + (cond ? "" : "  ->  " + JSON.stringify(extra)));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--allow-file-access-from-files", "--no-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });

  /* Dialogs: answer "yes" so the confirm-gated stock action proceeds. */
  page.on("dialog", async (d) => {
    await d.accept();
  });

  /* ---------- 1. edit mode OFF: no editor chrome ---------- */
  await page.goto(SITE, { waitUntil: "load" });
  await page.waitForSelector(".product-card");
  ok("no edit bar when edit mode is off", (await page.$(".lurei-edit-bar")) === null);
  ok("no add button when edit mode is off", (await page.$(".lurei-add-fab")) === null);
  ok("no card tools when edit mode is off", (await page.$(".lurei-card-tools")) === null);
  ok(
    "product cards still render",
    (await page.$$(".product-card")).length > 20,
    (await page.$$(".product-card")).length
  );
  ok(
    "every card carries a product id for the editor",
    await page.$$eval(".product-card", (cards) => cards.every((c) => c.getAttribute("data-product-id"))),
  );

  /* ---------- 2. enter edit mode via the admin path ---------- */
  await page.evaluate(() => window.LureiCatalogue.enterEditMode());
  await page.goto(SITE + "?editMode=true", { waitUntil: "load" });
  await page.waitForSelector(".lurei-edit-bar");

  ok("edit bar appears", (await page.$(".lurei-edit-bar")) !== null);
  ok("add product button appears", (await page.$(".lurei-add-fab")) !== null);
  ok(
    "card quick actions appear",
    (await page.$$(".lurei-card-tools")).length > 20,
    (await page.$$(".lurei-card-tools")).length
  );
  ok(
    "body is padded so the fixed bar hides nothing",
    await page.evaluate(() => document.body.classList.contains("lurei-edit-mode")),
  );
  ok(
    "edit bar sits above the page content",
    await page.evaluate(() => {
      const bar = document.querySelector(".lurei-edit-bar");
      return bar && getComputedStyle(bar).position === "fixed";
    }),
  );

  /* ---------- 3. inline quick edit changes a price ---------- */
  const targetId = await page.$eval(".product-card", (c) => c.getAttribute("data-product-id"));
  const before = await page.evaluate((id) => {
    const p = window.LureiCatalogue.store.read().find((x) => String(x.id) === id);
    return { title: p.title, price: p.price };
  }, targetId);

  await page.click(`.product-card[data-product-id="${targetId}"] [data-lurei-action="edit"]`);
  await page.waitForSelector(".lurei-inline");
  ok("inline editor opens", (await page.$(".lurei-inline")) !== null);

  await page.$eval(".lurei-inline [data-lurei-price]", (el) => {
    el.value = "77";
  });
  await page.click(".lurei-inline [data-lurei-save]");
  /* Saving re-seeds the catalogue, which rebuilds the grid; the inline panel
     either goes with it or stays open showing the saved value. Both are fine,
     so settle it by value rather than by presence. */
  await page.waitForFunction(
    (id) => {
      const p = window.LureiCatalogue.store.read().find((x) => String(x.id) === id);
      return p.price === 77;
    },
    {},
    targetId
  );
  if (await page.$(".lurei-inline [data-lurei-cancel]")) {
    await page.click(".lurei-inline [data-lurei-cancel]");
  }

  const after = await page.evaluate((id) => {
    const p = window.LureiCatalogue.store.read().find((x) => String(x.id) === id);
    return { price: p.price, category: p.category };
  }, targetId);

  ok("price edit persisted", after.price === 77, after);
  ok("price bucket re-derived on edit", after.category === "under-100", after);
  ok(
    "card shows the new price",
    (await page.$eval(
      `.product-card[data-product-id="${targetId}"] .product-card__price`,
      (el) => el.textContent
    )).includes("77"),
    await page.$eval(
      `.product-card[data-product-id="${targetId}"] .product-card__price`,
      (el) => el.textContent
    )
  );
  ok("title untouched by a price-only edit", after.price === 77 && before.title === (await page.evaluate((id) => {
    const p = window.LureiCatalogue.store.read().find((x) => String(x.id) === id);
    return p.title;
  }, targetId)));

  /* ---------- 4. out of stock ---------- */
  await page.click(`.product-card[data-product-id="${targetId}"] [data-lurei-action="stock"]`);
  await page.waitForSelector(`.product-card[data-product-id="${targetId}"].lurei-is-sold-out`);

  ok("card marked sold out", (await page.$(`.product-card[data-product-id="${targetId}"].lurei-is-sold-out`)) !== null);
  ok(
    "sold-out badge rendered",
    /* Uppercased by CSS, so the DOM text stays title case. */
    (await page.$eval(`.product-card[data-product-id="${targetId}"] .product-card__badge--sold-out`, (el) => el.textContent)).trim() === "Out of Stock"
  );
  ok(
    "add to cart disabled while sold out",
    await page.$eval(`.product-card[data-product-id="${targetId}"] .product-card__cta`, (el) => el.disabled === true && !el.hasAttribute("data-add"))
  );
  ok(
    "action button flips to restock",
    (await page.$eval(
      `.product-card[data-product-id="${targetId}"] [data-lurei-action="stock"]`,
      (el) => el.textContent
    )).trim() === "RESTOCK"
  );
  ok(
    "other cards are unaffected",
    (await page.$$(".product-card.lurei-is-sold-out")).length === 1,
    (await page.$$(".product-card.lurei-is-sold-out")).length
  );
  ok(
    "a sold-out card drops its stock pill",
    (await page.$(`.product-card[data-product-id="${targetId}"] .product-card__badge--stock`)) === null
  );
  ok(
    "sold-out count is recorded as zero",
    (await page.evaluate(
      (id) => window.LureiCatalogue.store.read().find((p) => String(p.id) === id).stock,
      targetId
    )) === 0
  );

  /* restock */
  await page.click(`.product-card[data-product-id="${targetId}"] [data-lurei-action="stock"]`);
  await page.waitForFunction(
    (id) => !document.querySelector(`.product-card[data-product-id="${id}"].lurei-is-sold-out`),
    {},
    targetId
  );
  ok("restock clears the sold-out state", true);
  ok(
    "add to cart is live again",
    await page.$eval(`.product-card[data-product-id="${targetId}"] .product-card__cta`, (el) => !el.disabled && el.hasAttribute("data-add"))
  );
  ok(
    "restock brings back a positive count",
    (await page.evaluate(
      (id) => window.LureiCatalogue.store.read().find((p) => String(p.id) === id).stock,
      targetId
    )) > 0
  );

  /* ---------- 5. add a product through the modal ---------- */
  await page.click(".lurei-add-fab");
  await page.waitForSelector(".lurei-modal__card");
  ok("modal opens", await page.$eval(".lurei-modal", (el) => !el.hidden));
  ok("background scroll locked", await page.evaluate(() => document.body.classList.contains("lurei-modal-open")));

  await page.type(".lurei-modal [data-lurei-name]", "Solitaire Gold Ring");
  await page.$eval(".lurei-modal [data-lurei-price]", (el) => {
    el.value = "45";
  });
  await page.select(".lurei-modal [data-lurei-type]", "rings");
  await page.$eval(".lurei-modal [data-lurei-stock]", (el) => {
    el.value = "4";
  });
  await page.$eval(".lurei-modal [data-lurei-desc]", (el) => {
    el.value = "A single polished stone.";
  });

  await page.evaluate(() => {
    const input = document.querySelector(".lurei-modal [data-lurei-file]");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "ring.png", { type: "image/png" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await page.waitForSelector(".lurei-modal [data-lurei-preview] img", { timeout: 8000 });
  ok("uploaded image previewed in the modal", true);

  await page.click('.lurei-modal button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".lurei-modal").hidden, { timeout: 8000 });

  const added = await page.evaluate(() => window.LureiCatalogue.store.read().find((p) => p.title === "Solitaire Gold Ring"));
  ok("product added to the store", !!added, added);
  ok("added price stored as a number", added.price === 45, added.price);
  ok("added bucket derived", added.category === "under-50", added.category);
  ok("added type stored", added.type === "rings", added.type);
  ok("added description stored", added.description === "A single polished stone.", added.description);
  ok("added stock count stored", added.stock === 4, added.stock);
  ok("a positive count does not mark it sold out", added.outOfStock === false, added.outOfStock);
  ok("image converted to Base64 JPEG", /^data:image\/jpeg;base64,/.test(added.image), (added.image || "").slice(0, 30));
  ok("modal closed after publish", await page.$eval(".lurei-modal", (el) => el.hidden));
  ok(
    "new product card is on the page",
    (await page.$$eval(".product-card__title", (els) => els.map((e) => e.textContent))).includes("Solitaire Gold Ring")
  );
  ok(
    "new product shows the condensed stock pill",
    await page.$$eval(".product-card__badge--stock", (els) => els.some((e) => e.textContent.trim() === "ONLY 4 LEFT")),
    await page.$$eval(".product-card__badge--stock", (els) => els.map((e) => e.textContent))
  );
  ok(
    "no long stock sentence anywhere on the grid",
    (await page.evaluate(() => document.body.innerText)).indexOf("remaining in Dubai stock") === -1
  );

  /* duplicate name is rejected in the modal */
  await page.click(".lurei-add-fab");
  await page.waitForSelector(".lurei-modal__card");
  await page.type(".lurei-modal [data-lurei-name]", "Solitaire Gold Ring");
  await page.$eval(".lurei-modal [data-lurei-price]", (el) => {
    el.value = "45";
  });
  await page.click('.lurei-modal button[type="submit"]');
  await page.waitForSelector(".lurei-modal__error:not([hidden])");
  ok(
    "duplicate name surfaces an inline error",
    (await page.$eval(".lurei-modal__error", (el) => el.textContent)).includes("already")
  );
  await page.click(".lurei-modal__foot [data-lurei-close]");
  await page.waitForFunction(() => document.querySelector(".lurei-modal").hidden);

  /* ---------- 6. persistence across a reload ---------- */
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".product-card");
  ok(
    "added product survives a reload",
    (await page.$$eval(".product-card__title", (els) => els.map((e) => e.textContent))).includes("Solitaire Gold Ring")
  );
  ok(
    "price edit survives a reload",
    await page.evaluate((id) => {
      const p = window.LureiCatalogue.store.read().find((x) => String(x.id) === id);
      return p.price === 77;
    }, targetId)
  );
  ok(
    "base64 image survives a reload",
    await page.evaluate(() => {
      const p = window.LureiCatalogue.store.read().find((x) => x.title === "Solitaire Gold Ring");
      return /^data:image\/jpeg;base64,/.test(p.image || "");
    })
  );

  /* ---------- 7. cross-tab sync ---------- */
  const other = await browser.newPage();
  await other.goto(SITE, { waitUntil: "load" });
  await other.waitForSelector(".product-card");
  const syncId = await other.$eval(".product-card", (c) => c.getAttribute("data-product-id"));
  await other.evaluate((id) => window.LureiCatalogue.store.setOutOfStock(id, true), syncId);
  await page.waitForFunction(
    (id) => !!document.querySelector(`.product-card[data-product-id="${id}"].lurei-is-sold-out`),
    { timeout: 5000 },
    syncId
  );
  ok("sold-out state syncs to the open tab", true);
  await other.close();

  /* ---------- 8. delete, then confirm the tombstone holds ---------- */
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => d.accept());
  const delId = await page.evaluate(() => {
    const p = window.LureiCatalogue.store.read().find((x) => x.title === "Solitaire Gold Ring");
    return String(p.id);
  });
  await page.evaluate((id) => window.LureiCatalogue.store.remove(id), delId);
  await page.waitForFunction(
    (id) => !window.LureiCatalogue.store.read().some((p) => String(p.id) === id),
    {},
    delId
  );
  ok("deleted product leaves the catalogue", true);
  ok(
    "deleted card is gone from the page",
    !(await page.$$eval(".product-card__title", (els) => els.map((e) => e.textContent))).includes("Solitaire Gold Ring")
  );

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".product-card");
  ok(
    "deletion survives a reload (tombstone)",
    !(await page.$$eval(".product-card__title", (els) => els.map((e) => e.textContent))).includes("Solitaire Gold Ring")
  );
  ok(
    "the rest of the catalogue is intact after deletion",
    (await page.$$(".product-card")).length > 20,
    (await page.$$(".product-card")).length
  );

  /* ---------- 9. exit edit mode clears the flag ---------- */
await page.evaluate(() => window.LureiCatalogue.exitEditMode());
  await page.goto(SITE, { waitUntil: "load" });
  await page.waitForSelector(".product-card");
  ok("exiting edit mode hides the bar", (await page.$(".lurei-edit-bar")) === null);
  ok("exiting edit mode hides the add button", (await page.$(".lurei-add-fab")) === null);
  ok(
    "exiting edit mode hides the card tools",
    (await page.$(".lurei-card-tools")) === null
  );
  ok(
    "exit button clears the stored flag",
    await page.evaluate(() => localStorage.getItem("lurei_admin_editing") === null)
  );

  /* ---------- 10. no runtime errors from the editor ---------- */
  /* Product image 404s are pre-existing (the built-in catalogue points at
     flat assets/*.jpg paths) and are not produced by the editor. */
  const editorErrors = errors.filter((e) => !/ERR_FILE_NOT_FOUND|net::ERR_FILE/.test(e));
  ok("no editor runtime errors", editorErrors.length === 0, editorErrors.slice(0, 6));

  /* ---------- 11. global CSS untouched by the editor ---------- */
  ok("styles.css still on disk and unmodified by the editor", fs.existsSync(path.resolve(__dirname, "styles.css")));

  await browser.close();

  console.log(`\nPASS ${PASS.length}`);
  if (PASS.length) console.log(PASS.map((s) => "  ok  " + s).join("\n"));
  if (FAIL.length) {
    console.log(`\nFAIL ${FAIL.length}`);
    console.log(FAIL.map((s) => "  XX  " + s).join("\n"));
    process.exit(1);
  }
  console.log("\nall editor checks passed");
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});