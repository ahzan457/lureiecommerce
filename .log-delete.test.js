/* Throwaway harness: lifts the real deleteLoggedOrderForGood /
   handleLogDeleteClick source out of admin-dashboard.html and runs it against
   stubs, to check the revenue/order-count subtraction and the rollback path. */
const fs = require("fs");

const html = fs.readFileSync("admin-dashboard.html", "utf8");

const lift = (name) => {
  const start = html.indexOf("const " + name + " =");
  if (start === -1) throw new Error(name + " not found");
  let i = html.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") {
      depth--;
      if (depth === 0) return html.slice(start, j + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
};

const src =
  lift("deleteLoggedOrderForGood") + "\n" + lift("handleLogDeleteClick");

let store = {};
const toasts = [];
const rendered = [];

const sandbox = {
  archivedOrders: [],
  backendReady: false,
  backend: null,
  sortArchivedOrders: () => {
    sandbox.archivedOrders.sort(
      (a, b) =>
        (Date.parse(b.completedAt || b.createdAt) || 0) -
        (Date.parse(a.completedAt || a.createdAt) || 0)
    );
  },
  writeStoredArchive: () => {
    store["lurei_order_archive"] = JSON.stringify(sandbox.archivedOrders);
  },
  renderAll: () => rendered.push(sandbox.archivedOrders.length),
  showToast: (m) => toasts.push(m),
  formatAED: (n) => "AED " + (Number(n) || 0).toFixed(2),
  escapeHTML: (v) => String(v),
  window: { confirm: () => true },
};

/* `with` keeps the lifted code bound to the sandbox object, so its writes to
   archivedOrders land where the assertions read them. */
const { deleteLoggedOrderForGood, handleLogDeleteClick } = new Function(
  "sandbox",
  "with (sandbox) {\n" + src + "\nreturn { deleteLoggedOrderForGood, handleLogDeleteClick };\n}"
)(sandbox);

const entry = (orderId, totalAED, completedAt) => ({
  orderId,
  totalAED,
  completedAt,
  customerName: "Test",
  phone: "+971500000000",
  email: "t@example.com",
  items: [{ title: "Scarf", quantity: 1 }],
});

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log("  FAIL " + name);
  }
};

const revenueOf = (list) => list.reduce((s, o) => s + (Number(o.totalAED) || 0), 0);

const reset = (list) => {
  sandbox.archivedOrders = list.slice();
  toasts.length = 0;
  rendered.length = 0;
  sandbox.backendReady = false;
  sandbox.backend = null;
  sandbox.confirmAnswer = true;
  sandbox.window = { confirm: () => sandbox.confirmAnswer };
};

const fakeButton = (orderId) => {
  const b = {
    dataset: { logDeleteId: orderId },
    disabled: false,
    closest: () => b,
  };
  return {
    btn: b,
    event: {
      target: {
        closest(sel) {
          if (sel !== "[data-log-delete-id]") return null;
          return b;
        },
      },
    },
  };
};

(async () => {
  console.log("PASS 1  deleting the only entry");

  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z")]);
  ok("revenue starts at 100", revenueOf(sandbox.archivedOrders) === 100);
  ok("count starts at 1", sandbox.archivedOrders.length === 1);

  ok("resolves true", (await deleteLoggedOrderForGood("LUR-1")) === true);
  ok("count drops to 0", sandbox.archivedOrders.length === 0);
  ok("revenue drops to 0", revenueOf(sandbox.archivedOrders) === 0);
  ok("renderAll called once", rendered.length === 1 && rendered[0] === 0);
  ok("localStorage rewritten empty", JSON.parse(store["lurei_order_archive"]).length === 0);
  ok("delete fn itself stays quiet", toasts.length === 0);

  console.log("PASS 2  deleting one of several, revenue subtracts exactly that amount");

  reset([
    entry("LUR-1", 100, "2026-10-05T10:00:00Z"),
    entry("LUR-2", 250.5, "2026-09-01T10:00:00Z"),
    entry("LUR-3", 49.5, "2026-08-01T10:00:00Z"),
  ]);
  ok("revenue starts at 400", revenueOf(sandbox.archivedOrders) === 400);

  ok("resolves true", (await deleteLoggedOrderForGood("LUR-2")) === true);
  ok("count is 2", sandbox.archivedOrders.length === 2);
  ok("revenue is 149.5", revenueOf(sandbox.archivedOrders) === 149.5);
  ok("LUR-2 gone", !sandbox.archivedOrders.some((o) => o.orderId === "LUR-2"));
  ok("siblings untouched", ["LUR-1", "LUR-3"].every((id) => sandbox.archivedOrders.some((o) => o.orderId === id)));

  console.log("PASS 3  unknown id is a no-op");

  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z")]);
  ok("resolves false", (await deleteLoggedOrderForGood("NOPE")) === false);
  ok("nothing removed", sandbox.archivedOrders.length === 1);
  ok("no re-render", rendered.length === 0);
  ok("toast explains", /no longer in the log/.test(toasts[0]));

  console.log("PASS 4  a refused database delete puts the sale back");

  let refused = false;
  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z"), entry("LUR-2", 250.5, "2026-09-01T10:00:00Z")]);
  sandbox.backendReady = true;
  sandbox.backend = {
    deleteCompletedOrder: () => (refused ? Promise.reject(new Error("403")) : Promise.resolve()),
  };
  refused = true;

  ok("resolves false on refusal", (await deleteLoggedOrderForGood("LUR-1")) === false);
  ok("entry restored", sandbox.archivedOrders.some((o) => o.orderId === "LUR-1"));
  ok("revenue back to 350.5", revenueOf(sandbox.archivedOrders) === 350.5);
  ok("sorted newest first again", sandbox.archivedOrders[0].orderId === "LUR-1");
  ok("localStorage matches", JSON.parse(store["lurei_order_archive"]).length === 2);
  ok("re-rendered once more", rendered.length === 2);
  ok("toast says revenue kept", /still counted as revenue/.test(toasts[toasts.length - 1]));

  console.log("PASS 5  a successful database delete is not rolled back");

  refused = false;
  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z")]);
  sandbox.backendReady = true;
  sandbox.backend = {
    deleteCompletedOrder: () => Promise.resolve(),
  };
  ok("resolves true", (await deleteLoggedOrderForGood("LUR-1")) === true);
  ok("stays deleted", sandbox.archivedOrders.length === 0);

  console.log("PASS 6  a backend with no delete verb changes nothing");

  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z")]);
  sandbox.backendReady = true;
  sandbox.backend = {};
  ok("resolves false", (await deleteLoggedOrderForGood("LUR-1")) === false);
  ok("entry kept", sandbox.archivedOrders.length === 1);
  ok("toast explains the build", /cannot delete confirmed orders/.test(toasts[0]));

  console.log("PASS 7  the click handler confirms, names the amount, then deletes");

  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z")]);

  let asked = "";
  sandbox.window = {
    confirm: (message) => {
      asked = message;
      return sandbox.confirmAnswer;
    },
  };

  sandbox.confirmAnswer = false;
  let h = fakeButton("LUR-1");
  handleLogDeleteClick(h.event);
  ok("confirm names the order id", /LUR-1/.test(asked));
  ok("confirm names the amount", /AED 100\.00/.test(asked));
  ok("confirm warns it is permanent", /permanent/i.test(asked));
  ok("cancelling keeps the entry", sandbox.archivedOrders.length === 1);
  ok("cancelling leaves the button enabled", h.btn.disabled === false);

  sandbox.confirmAnswer = true;
  h = fakeButton("LUR-1");
  handleLogDeleteClick(h.event);
  ok("button disabled while deleting", h.btn.disabled === true);
  await new Promise((r) => setTimeout(r, 0));
  ok("entry deleted after confirming", sandbox.archivedOrders.length === 0);
  ok("toast names the amount", /AED 100\.00/.test(toasts[toasts.length - 1]));

  console.log("PASS 8  the handler ignores clicks on anything else");

  reset([entry("LUR-1", 100, "2026-10-02T10:00:00Z")]);
  handleLogDeleteClick({
    target: {
      closest: () => null,
    },
  });
  ok("nothing happened", sandbox.archivedOrders.length === 1 && toasts.length === 0);

  console.log("\npassed: " + pass + " / " + (pass + fail));
  if (fail) {
    console.log("FAILED: " + fail);
    process.exit(1);
  }
  console.log("all completed-log delete checks passed");
})();