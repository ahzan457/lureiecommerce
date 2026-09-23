/* ==========================================================================
   LUREÍ — Fine Jewellery & Accessories | Dubai, UAE
   Direct e-commerce: catalogue rendering + cart drawer + secure checkout
   --------------------------------------------------------------------------
   Architecture:
     Google Sheets        ->  Google Apps Script Web App (doGet, returns JSON)
     script.js            ->  fetch(APPS_SCRIPT_URL)  ->  render product cards

   Catalogue behaviour:
     • The local `products` catalogue renders instantly (mock-first).
     • Both "Top Sellers" and "Collections" sections render the same catalogue.
     • Add to Cart updates the navbar badge and opens the slide-out cart drawer.
     • Proceed to Checkout opens a payment & delivery modal (card / COD).
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. Configuration
   * ------------------------------------------------------------------ */
  const APPS_SCRIPT_URL = ""; // TODO: paste your deployed Google Apps Script Web App URL here

  const CONFIG = {
    APPS_SCRIPT_URL,
    REQUEST_TIMEOUT_MS: 8000,
    PAGE_SIZE: 4,
    CURRENCY_RATE: 26.08, // 1 AED = 26.08 INR
    CONTACT_EMAIL: "lureiaccessories@gmail.com",
    CONTACT_WHATSAPP: "971525303886",
    CONTACT_PHONE_DISPLAY: "+971 52 530 3886",
    SMS_WEBHOOK_URL: "https://api.brevo.com/v3/sms", // SMS alert API — sends to +971525303886 on inquiries/orders
  };

  /* Brevo v3 — welcome emails on newsletter signup (Transactional v3 API key) */
  const BREVO_CONFIG = {
    endpoint: "https://api.brevo.com/v3/smtp/email",
    
  };

  /* SMS alert to the boutique — Brevo v3 SMS (same API key as email). No-op when
     no endpoint is configured. Silently resolves on failure (best-effort alert). */
  const sendSmsAlert = (content) => {
    try {
      const endpoint = CONFIG.SMS_WEBHOOK_URL.trim();
      if (!endpoint) return Promise.resolve();
      return fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "api-key": BREVO_CONFIG.apiKey,
        },
        body: JSON.stringify({
          type: "transactional",
          unicodeEnabled: true,
          sender: "LUREI",
          recipient: `+${CONFIG.CONTACT_WHATSAPP}`,
          content,
          tag: "lurei-alert",
        }),
      }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };

  /* ------------------------------------------------------------------ *
   * 2. Fallback product catalogue (local asset mirror)
   * ------------------------------------------------------------------ *
   * Product images are mapped strictly to local folder paths under
   * `assets/products/` WITHOUT a file extension. script.js automatically
   * resolves the real extension by trying (.png, .jpg, .jpeg) in order,
   * so the shop works regardless of the saved file type.
   * ------------------------------------------------------------------ */
const products = [
    { id: 1, name: "Aura Golden Stud", price: "AED 25.00", category: "under-30", type: "earrings", image: "assets/products/aura-golden-stud.jpg", desc: "Textured gold aura stud earrings." },
    { id: 2, name: "Cartier Inspired Bracelet", price: "AED 30.00", category: "under-30", type: "bracelets", image: "assets/products/cartier-inspired-bracelet.jpg", desc: "Luxury textured gold band bracelet." },
    { id: 3, name: "Crystal Ash Hoops", price: "AED 20.00", category: "under-30", type: "earrings", image: "assets/products/crystal-ash-hoops.jpg", desc: "Sparkling crystal ash luxury hoops." },
    { id: 4, name: "The Crystal Chain", price: "AED 30.00", category: "under-30", type: "necklace", image: "assets/products/crystal-chain.jpg", desc: "Minimal sparkling crystal accent silver chain." },
    { id: 5, name: "Crystal Cherry Hoops", price: "AED 20.00", category: "under-30", type: "earrings", image: "assets/products/crystal-cherry-hoops.jpg", desc: "Vibrant cherry red crystal drop hoop earrings." },
    { id: 6, name: "Golden Nova Mini Hoops", price: "AED 15.00", originalPrice: "AED 20.00", category: "under-30", type: "earrings", image: "assets/products/golden-nova-mini-hoops.jpg", desc: "Mini golden starburst huggie hoops." },
    { id: 7, name: "Golden Bamboo Drops", price: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/golden-bamboo-drops.jpg", desc: "Structured bamboo textured gold drop earrings." },
    { id: 8, name: "Lavender Bloom", price: "AED 24.00", category: "under-30", type: "ring", image: "assets/products/lavender-bloom.jpg", desc: "Lavender crystals in rose gold accents." },
    { id: 9, name: "Melted Metal Prism", price: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/melted-metal-prism.jpg", desc: "Melted metal prism in gold luxury finish." },
    { id: 10, name: "Pearl Petals Drops", price: "AED 45.00", category: "under-50", type: "earrings", image: "assets/products/pearl-petals-drops.jpg", desc: "Lustrous pearl petal cluster drop earrings." },
    { id: 11, name: "Petal Stud", price: "AED 20.00", category: "under-30", type: "earrings", image: "assets/products/petal-stud.jpg", desc: "Delicate flower petal stud earrings." },
    { id: 12, name: "Red Stone Hoops", price: "AED 20.00", category: "under-30", type: "earrings", image: "assets/products/red-stone-hoops.jpg", desc: "Ruby red stone retro hoop collection." },
    { id: 13, name: "Retro Red Hoops", price: "AED 45.00", category: "under-50", type: "earrings", image: "assets/products/retro-red-hoops.jpg", desc: "Ruby red accent vintage drop hoops." },
    { id: 14, name: "Sapphire Retro Hoops", price: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/sapphire-retro-hoops.jpg", desc: "Deep sapphire stone retro hoops." },
    { id: 15, name: "Screw Oval Bracelet", price: "AED 35.00", category: "under-50", type: "bracelets", image: "assets/products/screw-oval-bracelet.jpg", desc: "Minimalist luxury screw oval gold bangles." },
    { id: 16, name: "Seashell Toggle Chain", price: "AED 40.00", category: "under-50", type: "necklace", image: "assets/products/seashell-toggle-chain.jpg", desc: "Elegant gold toggle chain with seashell charm." },
    { id: 17, name: "Serene Heart Pendant", price: "AED 45.00", category: "under-50", type: "necklace", image: "assets/products/serene-heart-pendant.jpg", desc: "Toggle chain with dual chains and vintage heart." },
    { id: 18, name: "Silver Selen Bangles", price: "AED 35.00", category: "under-50", type: "bracelets", image: "assets/products/silver-selen-bangles.jpg", desc: "Sculptural wave silver selen bangle bracelet." },
    { id: 19, name: "Silver Loop Studs", price: "AED 25.00", category: "under-30", type: "earrings", image: "assets/products/silver-loop-studs.jpg", desc: "Minimalist luxury silver loop stud earrings." },
    { id: 20, name: "The Eternal Love", price: "AED 35.00", category: "under-50", type: "necklace", image: "assets/products/the-eternal-love.jpg", desc: "Vintage puffy heart pendant with a classic link." },
    { id: 21, name: "The Fourth Stone Pendant", price: "AED 30.00", category: "under-30", type: "necklace", image: "assets/products/the-fourth-stone-pendant.jpg", desc: "Minimalist single stone gold pendant chain." },
    { id: 22, name: "The Sapphire Heart Pendant", price: "AED 30.00", category: "under-30", type: "necklace", image: "assets/products/the-sapphire-heart-pendant.jpg", desc: "Deep sapphire stone heart gold pendant." },
    { id: 23, name: "Verdant Bloom", price: "AED 28.00", category: "under-30", type: "ring", image: "assets/products/verdant-bloom.jpg", desc: "Emerald green floral accent statement piece." },
    { id: 24, name: "Vintage Shine", price: "AED 32.00", category: "under-50", type: "watch", image: "assets/products/vintage-shine.jpg", desc: "Celestial gold coin pendant chain." },
    { id: 25, name: "Winter Bloom", price: "AED 28.00", category: "under-30", type: "rings", image: "assets/products/winter-bloom.jpg", desc: "Textured silver crystal statement ring." },
    { id: 26, name: "Zorei Zircon", price: "AED 25.00", category: "under-30", type: "rings", image: "assets/products/zorei-zircon.jpg", desc: "Solitaire olive zircon gemstone gold ring." },
    { id: 27, name: "Melted Metal Chain (in Gold)", price: "AED 130.00", category: "under-150", type: "necklace", image: "assets/products/melted-metal-chain-gold.jpg", desc: "Gold glided artistic statement collection chain." },
    { id: 28, name: "Melting Metal Chain (Silver)", price: "AED 130.00", category: "under-150", type: "necklace", image: "assets/products/melting-metal-chain-silver.jpg", desc: "Silver glided statement collection chain." },
    { id: 29, name: "Pearl Layered Pendant", price: "AED 90.00", originalPrice: "AED 130.00", category: "under-100", type: "necklace", image: "assets/products/pearl-layered-pendant.jpg", desc: "Classic elegant design with tear drop pearl layers." },
    { id: 30, name: "Golden Luna Mini Hoops", price: "AED 18.00", originalPrice: "AED 25.00", category: "under-30", type: "earrings", image: "assets/products/golden-luna-mini-hoops.jpg", desc: "Gold mini huggie hoops." },
    { id: 31, name: "Golden Hexa Mini Hoops", price: "AED 15.00", category: "under-30", type: "earrings", image: "assets/products/golden-hexa-mini-hoops.jpg", desc: "Hexagonal textured gold mini hoops." },
    { id: 32, name: "Golden Crystal Retro Hoops", price: "AED 20.00", originalPrice: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/golden-crystal-retro-hoops.jpg", desc: "Yellow sparkling crystal retro drop hoops." },
    { id: 33, name: "Wine Drop Hoops", price: "AED 18.00", originalPrice: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/wine-drop-hoops.jpg", desc: "Vibrant wine red drop hoop earrings." },
    { id: 34, name: "Rosè Mini Hoops", price: "AED 15.00", category: "under-30", type: "earrings", image: "assets/products/rose-mini-hoops.jpg", desc: "Asymmetrical rose mini huggie hoops." },
    { id: 35, name: "Luna Layered Ear Cuffs Set", price: "AED 25.00", category: "under-30", type: "earrings", image: "assets/products/luna-layered-ear-cuffs-set.jpg", desc: "Layered luxury gold ear cuff set." },
    { id: 36, name: "Honey Dew Hoops", price: "AED 18.00", originalPrice: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/honey-dew-hoops.jpg", desc: "Crystal honeydew teardrop hoop earrings." },
    { id: 37, name: "Half Hoop Drops", price: "AED 30.00", originalPrice: "AED 60.00", category: "under-30", type: "earrings", image: "assets/products/half-hoop-drops.jpg", desc: "Convertible half hoop drop earrings." },
    { id: 38, name: "Boho Chain Earring", price: "AED 35.00", category: "under-50", type: "earrings", image: "assets/products/boho-chain-earring.jpg", desc: "Free-spirited boho chain earrings in a refined silver finish." },
    { id: 39, name: "Chain Loop Earrings", price: "AED 30.00", category: "under-30", type: "earrings", image: "assets/products/chain-loop-earrings.jpg", desc: "Sculptural linked loop earrings with a sleek modern edge." },
    { id: 40, name: "Chunky Silver Hoops", price: "AED 32.00", category: "under-50", type: "earrings", image: "assets/products/chuncy-silver-hoops.jpg", desc: "Bold chunky silver hoops with a lustrous satin finish." },
    { id: 41, name: "Crystal Cherry Hoops", price: "AED 25.00", category: "under-30", type: "earrings", image: "assets/products/crystal-cherry-hoops.jpg", desc: "Cherry red crystal drop earrings with luminous glass accents." },
    { id: 42, name: "Dual Tone Oval Drops", price: "AED 40.00", category: "under-50", type: "earrings", image: "assets/products/dual-tone-oval-drops-earrings.jpg", desc: "Dual-tone oval drop earrings blending warm and cool metallics." },
    { id: 43, name: "Garnet Glare Asymmetrical Drops", price: "AED 55.00", category: "under-100", type: "earrings", image: "assets/products/garnet-glare-asymmetrical-drops.jpg", desc: "Asymmetrical garnet drops with a rich ruby glare finish." },
    { id: 44, name: "Garnet Glare Drops", price: "AED 55.00", category: "under-100", type: "earrings", image: "assets/products/garnet-glare-drops.jpg", desc: "Classic garnet glare drop earrings with deep crimson stones." },
    { id: 45, name: "Garnet Glare Hollow Drops", price: "AED 60.00", category: "under-100", type: "earrings", image: "assets/products/garnet-glare-hollow-drops.jpg", desc: "Hollow garnet drop earrings in a radiant crimson tone." },
    { id: 46, name: "Green Crescent Earrings", price: "AED 38.00", category: "under-50", type: "earrings", image: "assets/products/green-crescent-earrings.jpg", desc: "Emerald crescent earrings with a soft vintage glow." },
    { id: 47, name: "Luna Layered Ear Cuffs Set", price: "AED 35.00", category: "under-50", type: "earrings", image: "assets/products/luna-layered-ear-cuffs-set.jpg", desc: "Layered lunar ear cuff set in polished gold tones." },
    { id: 48, name: "Rainbow Crystal Drops", price: "AED 52.00", category: "under-100", type: "earrings", image: "assets/products/rainbow-crystal-drops.jpg", desc: "Iridescent rainbow crystal drop earrings with prismatic sparkle." },
    { id: 49, name: "Bianca Handcuff", price: "AED 45.00", category: "under-50", type: "bracelets", image: "assets/products/bianca-handcuff.jpg", desc: "Sculptural bianca handcuff bracelet in a statement silhouette." },
    { id: 50, name: "Cleopatra Handcuff", price: "AED 65.00", category: "under-100", type: "bracelets", image: "assets/products/cleopatra-handcuff.jpg", desc: "Regal cleopatra handcuff bracelet with bold engraved detailing." },
    { id: 51, name: "Kelly Gold Handcuff", price: "AED 48.00", category: "under-50", type: "bracelets", image: "assets/products/kelly-gold-handcuff.jpg", desc: "Opulent gold handcuff bracelet with a flawless mirror shine." },
    { id: 52, name: "Melted Gold Handcuff", price: "AED 65.00", category: "under-100", type: "bracelets", image: "assets/products/melted-gold-handcuff.jpg", desc: "Artistic melted gold handcuff bracelet in a fluid luxury form." },
];
  /* ------------------------------------------------------------------ *
   * 3. Small, dependency-free helpers
   * ------------------------------------------------------------------ */
  const $ = (selector, scope = document) => scope.querySelector(selector);

  const toNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };

  /** Format a number into UAE Dirhams, e.g. 15 -> "AED 15.00". */
  const formatAED = (amount) => {
    const value = toNumber(amount);
    return `AED ${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  /* ------------------------------------------------------------------ *
   * Currency switcher — AED (د.إ) ⇄ INR (₹)
   *   • Market rate: 1 AED = 26.08 INR (configurable in CONFIG)
   *   • Choice persists in localStorage; 'AED' is the store default.
   *   • All shopper-visible prices render through formatPrice().
   * ------------------------------------------------------------------ */
  const AED_TO_INR = toNumber(CONFIG.CURRENCY_RATE) > 0 ? toNumber(CONFIG.CURRENCY_RATE) : 26.08;
  const CURRENCY_STORAGE_KEY = "lurei_currency";

  const readSavedCurrency = () => {
    try {
      return localStorage.getItem(CURRENCY_STORAGE_KEY) === "INR" ? "INR" : "AED";
    } catch {
      return "AED";
    }
  };

  let activeCurrency = readSavedCurrency(); // "AED" | "INR"

  const saveCurrencyPreference = (code) => {
    try {
      localStorage.setItem(CURRENCY_STORAGE_KEY, code === "INR" ? "INR" : "AED");
    } catch {}
  };

  const currencyCode = () => activeCurrency; // "AED" | "INR"
  const currencySymbolLabel = () => (activeCurrency === "INR" ? "\u20B9 (INR)" : "AED (\u062F.\u0625)");

  /** AED amount → number to display in the active currency (INR: rounded paise-free). */
  const toDisplayNumber = (amountAED) => {
    const value = toNumber(amountAED) || 0;
    return activeCurrency === "INR" ? Math.round(value * AED_TO_INR) : value;
  };

  /** Single currency-aware price formatter used by every shopper-visible render. */
  const formatPrice = (amountAED) => {
    if (activeCurrency === "INR") {
      return `\u20B9 ${toDisplayNumber(amountAED).toLocaleString("en-IN")}`;
    }
    return formatAED(amountAED);
  };

  /** MutationObserver-less convenience: applies current currency to a card's price nodes. */
  const applyCurrencyToCard = (card) => {
    if (!card) return;
    card.querySelectorAll("[data-lurei-price]").forEach((el) => {
      const aed = Number(el.dataset.lureiPrice);
      el.textContent = activeCurrency === "INR"
        ? `\u20B9 ${Math.round(aed * AED_TO_INR).toLocaleString("en-IN")}`
        : formatAED(aed);
    });
  };

  /** Navbar currency toggle — syncs UI, persists choice, re-renders shopper prices. */
  const currencyToggleEls = Array.from(document.querySelectorAll(".currency-toggle"));

  const syncCurrencySelectors = () => {
    currencyToggleEls.forEach((select) => {
      select.value = activeCurrency === "INR" ? "INR" : "AED";
    });
  };

  const applyCurrencyAcross = () => {
    syncCurrencySelectors();
    renderPriceFilterOptions();
    renderTopSellers();
    refreshCollections();
    renderNewIn();
    renderCartItems();
  };

  const bindCurrencySwitcher = () => {
    currencyToggleEls.forEach((select) => {
      select.addEventListener("change", () => {
        const next = select.value === "INR" ? "INR" : "AED";
        if (next === activeCurrency) return;
        activeCurrency = next;
        saveCurrencyPreference(activeCurrency);
        applyCurrencyAcross();
      });
    });
  };

  /** Luxury toast — bottom-centre pill, auto-dismisses. */
  const showLureiToast = (message, type = "success") => {
    let toast = document.querySelector(".lurei-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "lurei-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.classList.toggle("lurei-toast--error", type === "error");
    toast.textContent = message;
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    clearTimeout(showLureiToast._timer);
    showLureiToast._timer = setTimeout(() => toast.classList.remove("is-visible"), 4200);
  };

  /** Two-letter initials of a title, for premium fallback placeholders. */
  const initialsOf = (title) =>
    String(title || "L")
      .split(/\s+/)
      .map((word) => word.charAt(0))
      .slice(0, 2)
      .join("")
      .toUpperCase();

  const CART_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12l1.5 13h-15L6 7z"></path><path d="M9 10V6a3 3 0 0 1 6 0v4"></path></svg>';

  const WISHLIST_ICON =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21l-8.5-8.5a5.6 5.6 0 1 1 8.5-7.5 5.6 5.6 0 1 1 8.5 7.5L12 21z"></path></svg>';

  /** Normalise unstructured sheet rows into consistent product objects. */
  const normalizeProducts = (payload) => {
    if (!Array.isArray(payload)) return [];
    return payload
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const image = row.image ?? row.img ?? row.image_url ?? row["Image URL"] ?? null;
        return {
          id: row.id ?? row.ID ?? row.product_id,
          title: row.title ?? row.name ?? row["Product Name"] ?? null,
          price: toNumber(row.price ?? row.Price ?? row["Price (AED)"]),
          category: row.category ?? row.filter ?? null,
          type: row.type ?? row.kind ?? null,
          image,
          fallbackImage: row.fallback_image ?? row.fallbackImage ?? null,
          description: row.description ?? row.Description ?? row.desc ?? null,
          badge: row.badge ?? row.tag ?? row.Badge ?? null,
        };
      })
      .filter((p) => p && p.title && p.price !== null && p.price > 0)
      .filter((p, i, arr) => arr.findIndex((x) => x.title === p.title) === i);
  };

  /* ------------------------------------------------------------------ *
   * 4. Product card rendering (Add to Cart)
   * ------------------------------------------------------------------ */
  const topGrid = $("#products-container");
  const collectionsGrid = $("#collections-container");
  const status = $("#trending-status");
  const loadMoreBtn = $("#load-more");

  const clearStatus = () => {
    if (status) {
      status.textContent = "";
      status.classList.remove("trending__status--error");
    }
  };

  /** Apex monogram shown when every file extension fails to load. */
  const buildPlaceholder = (className, product) => {
    const placeholder = document.createElement("div");
    placeholder.className = className;
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = initialsOf(product.title);
    return placeholder;
  };

  /* Local image resolution:
   * `assets/products/<slug>` has no extension in the dataset, so we probe
   * .jpg -> .png -> .jpeg (and upper-case variants) at runtime. The first
   * extension that loads is cached per base path so grids and the cart
   * never re-probe the same file.  Each error handler removes itself before
   * setting the next src, preventing listener stacking.
   */
  const IMAGE_EXTENSIONS = ["jpg", "png", "jpeg", "JPG", "PNG", "JPEG"];
  const resolvedImages = new Map(); // base path -> working URL ("" = dead)

  const wireImage = (img, product, onExhausted) => {
    const base = product && typeof product.image === "string" ? product.image : null;
    if (!base) {
      onExhausted();
      return;
    }

    const cached = resolvedImages.get(base);
    if (cached !== undefined) {
      if (cached) {
        img.src = cached;
        return;
      }
      onExhausted();
      return;
    }

    let attempt = 0;
    const onLoaded = () => {
      resolvedImages.set(base, img.src);
    };

    const onFailed = () => {
      img.removeEventListener("error", onFailed);
      attempt++;
      if (attempt >= IMAGE_EXTENSIONS.length) {
        resolvedImages.set(base, "");
        onExhausted();
        return;
      }
      img.src = `${base}.${IMAGE_EXTENSIONS[attempt]}`;
      img.addEventListener("error", onFailed);
    };

    img.addEventListener("load", onLoaded, { once: true });
    img.addEventListener("error", onFailed);
    img.src = `${base}.${IMAGE_EXTENSIONS[0]}`;
  };

  const buildCard = (product, index) => {
    const card = document.createElement("article");
    card.className = "product-card";
    card.style.animationDelay = `${Math.min(index % CONFIG.PAGE_SIZE, 3) * 80}ms`;

    const media = document.createElement("div");
    media.className = "product-card__media";

    if (product.image && typeof product.image === "string") {
      const img = document.createElement("img");
      img.alt = product.title;
      img.width = 500;
      img.height = 500;
      img.loading = "lazy";
      wireImage(img, product, () =>
        img.replaceWith(buildPlaceholder("product-card__placeholder", product))
      );
      media.appendChild(img);
    } else {
      media.appendChild(buildPlaceholder("product-card__placeholder", product));
    }

    const badge = product.badge ? String(product.badge).trim() : null;
    if (badge) {
      const label = document.createElement("span");
      label.className = "product-card__badge";
      label.textContent = badge;
      media.appendChild(label);
    }

    const was = toNumber(product.originalPrice);
    const now = toNumber(product.price);
    if (was !== null && now !== null && was > now) {
      const percent = Math.round(((was - now) / was) * 100);
      if (percent > 0 && !badge) {
        const label = document.createElement("span");
        label.className = "product-card__badge";
        label.textContent = `-${percent}%`;
        media.appendChild(label);
      }
    }

    const heart = document.createElement("button");
    heart.type = "button";
    heart.className = "wishlist-heart";
    heart.dataset.wishlistAdd = String(product.id);
    heart.dataset.wishlistTitle = product.title;
    heart.setAttribute("aria-label", `Add ${product.title} to wishlist`);
    heart.innerHTML = WISHLIST_ICON;
    if (hasWishlist(product.id)) heart.classList.add("is-wishlisted");
    media.appendChild(heart);

    const body = document.createElement("div");
    body.className = "product-card__body";

    const title = document.createElement("h3");
    title.className = "product-card__title";
    title.textContent = product.title;

    body.appendChild(title);

    if (product.description && typeof product.description === "string") {
      const description = document.createElement("p");
      description.className = "product-card__desc";
      description.textContent = product.description;
      body.appendChild(description);
    }

    const price = document.createElement("p");
    price.className = "product-card__price";
    if (was !== null && now !== null && was > now) {
      const wasPrice = document.createElement("span");
      wasPrice.className = "product-card__was";
      wasPrice.textContent = formatPrice(was);
      price.appendChild(wasPrice);
      const nowPrice = document.createElement("span");
      nowPrice.textContent = formatPrice(now);
      price.appendChild(nowPrice);
    } else {
      price.textContent = formatPrice(product.price);
    }
    body.appendChild(price);

    const cta = document.createElement("button");
    cta.className = "product-card__cta";
    cta.type = "button";
    cta.dataset.add = String(product.id);
    cta.innerHTML = `${CART_ICON}<span>Add to Cart</span>`;
    cta.setAttribute("aria-label", `Add ${product.title} to cart — ${formatPrice(product.price)}`);
    body.appendChild(cta);

    card.append(media, body);
    return card;
  };

  /* ------------------------------------------------------------------ *
   * 4b. New In — "Autumn Vault" curated arrivals
   * ------------------------------------------------------------------ */
  const NEW_IN_IDS = [1, 2, 4, 6, 20, 24];

  const NEW_IN_VAULT = {
    1: { original: "AED 40.00", stock: 5, left: 3 },
    2: { original: "AED 46.00", stock: 5, left: 2 },
    4: { original: "AED 44.00", stock: 6, left: 4 },
    6: { original: "AED 22.00", stock: 4, left: 1 },
    20: { original: "AED 52.00", stock: 6, left: 3 },
    24: { original: "AED 48.00", stock: 5, left: 4 },
  };

  const newInGridEl = $("#new-in-grid");

  const renderNewIn = () => {
    if (!newInGridEl) return;

    const fragment = document.createDocumentFragment();
    NEW_IN_IDS.forEach((id, index) => {
      const product = catalogue.find((p) => String(p.id) === String(id));
      if (!product) return;

      const vault = NEW_IN_VAULT[id] || { original: formatAED(product.price), stock: 4, left: 3 };
      const pct = Math.max(8, Math.round((vault.left / vault.stock) * 100));

      const card = document.createElement("article");
      card.className = "new-in-card";
      card.style.animationDelay = `${index * 90}ms`;

      const media = document.createElement("div");
      media.className = "new-in-card__media";

      if (product.image && typeof product.image === "string") {
        const img = document.createElement("img");
        img.alt = product.title;
        img.width = 500;
        img.height = 500;
        img.loading = "lazy";
        wireImage(img, product, () =>
          img.replaceWith(buildPlaceholder("new-in-card__placeholder", product))
        );
        media.appendChild(img);
      } else {
        media.appendChild(buildPlaceholder("new-in-card__placeholder", product));
      }

      const limited = document.createElement("span");
      limited.className = "new-in-card__limited";
      limited.textContent = `LIMITED VAULT \u2022 ${vault.left} LEFT`;

      const heart = document.createElement("button");
      heart.type = "button";
      heart.className = "wishlist-heart";
      heart.dataset.wishlistAdd = String(product.id);
      heart.dataset.wishlistTitle = product.title;
      heart.setAttribute("aria-label", `Add ${product.title} to wishlist`);
      heart.innerHTML = WISHLIST_ICON;
      if (hasWishlist(product.id)) heart.classList.add("is-wishlisted");

      media.append(limited, heart);

      const body = document.createElement("div");
      body.className = "new-in-card__body";

      const title = document.createElement("h3");
      title.className = "new-in-card__title";
      title.textContent = product.title;

      const desc = document.createElement("p");
      desc.className = "new-in-card__desc";
      desc.textContent = product.description || "A handcrafted piece from the Autumn Vault.";

      const price = document.createElement("p");
      price.className = "new-in-card__price";
      const wasPrice = document.createElement("span");
      wasPrice.className = "new-in-card__was";
      wasPrice.textContent = formatPrice(toNumber(vault.original) || product.price);
      const nowPrice = document.createElement("span");
      nowPrice.className = "new-in-card__now";
      nowPrice.textContent = formatPrice(product.price);
      price.append(wasPrice, nowPrice);

      const stock = document.createElement("div");
      stock.className = "new-in-card__stock";
      const stockTrack = document.createElement("div");
      stockTrack.className = "new-in-card__stock-track";
      const stockFill = document.createElement("div");
      stockFill.className = "new-in-card__stock-fill";
      stockFill.style.width = `${pct}%`;
      stockTrack.appendChild(stockFill);
      const stockLabel = document.createElement("p");
      stockLabel.className = "new-in-card__stock-label";
      stockLabel.textContent = `Only ${vault.left} piece${vault.left === 1 ? "" : "s"} remaining in Dubai stock`;
      stock.append(stockTrack, stockLabel);

      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "product-card__cta";
      cta.dataset.add = String(product.id);
      cta.setAttribute("aria-label", `Add ${product.title} to cart — ${formatPrice(product.price)}`);
      cta.innerHTML = `${CART_ICON}<span>Add to Cart</span>`;

      body.append(title, desc, price, stock, cta);
      card.append(media, body);
      fragment.appendChild(card);
    });

    newInGridEl.replaceChildren(fragment);
  };

  /* ------------------------------------------------------------------ *
   * 5. Catalogue state + dual-section rendering
   * ------------------------------------------------------------------ */
  let catalogue = [];
  let topVisible = 0;

  /* Homepage "Top Selling" horizontal carousel: 12 fixed products in
   * 3 batches of 4, auto-scrolling right every CAROUSEL_INTERVAL ms as a
   * continuous infinite loop (a cloned first batch creates the seam). */
  const TOP_SELLER_BATCHES = [
    [1, 5, 8, 11],
    [2, 4, 10, 16],
    [20, 27, 29, 32],
  ];
  const TOP_SELLER_IDS = TOP_SELLER_BATCHES.flat();
  const CAROUSEL_INTERVAL = 2000;

  const FILTERS = {
    all: () => catalogue,
    "under-150": () => catalogue.filter((p) => p.category === "under-150"),
    "under-100": () => catalogue.filter((p) => p.category === "under-100"),
    "under-50": () => catalogue.filter((p) => p.category === "under-50"),
    "under-30": () => catalogue.filter((p) => p.category === "under-30"),
    earrings: () => catalogue.filter((p) => p.type === "earrings" || p.type === "earring"),
    necklaces: () => catalogue.filter((p) => p.type === "necklace" || p.type === "necklaces"),
    rings: () => catalogue.filter((p) => p.type === "rings" || p.type === "ring"),
    bracelets: () => catalogue.filter((p) => p.type === "bracelets" || p.type === "bracelet" || p.type === "bangle" || p.type === "bangles"),
    watches: () => catalogue.filter((p) => p.type === "watch" || p.type === "watches"),
  };

  let activeFilter = "all";
  const filterTabs = document.querySelectorAll("[data-filter]");

  const renderInto = (container, products) => {
    if (!container) return;
    const fragment = document.createDocumentFragment();
    products.forEach((product, index) => {
      fragment.appendChild(buildCard(product, index));
    });
    container.replaceChildren(fragment);
  };

  let carouselTrack = null;
  let carouselIndex = 0;
  let carouselTimer = null;

  const topBatchProducts = (index) =>
    catalogue.filter((p) => TOP_SELLER_BATCHES[index].includes(Number(p.id)));

  const BATCH_STEP = 100 / TOP_SELLER_BATCHES.length;

  const carouselSlide = () => {
    if (!carouselTrack) return;
    /* Self-healing: if the timer was ever cleared, revive it so the loop
       can never freeze. */
    if (carouselTimer === null) {
      carouselTimer = window.setInterval(carouselSlide, CAROUSEL_INTERVAL);
    }
    carouselIndex++;
    if (carouselIndex > TOP_SELLER_BATCHES.length) {
      /* At the cloned first batch — snap back to the real one instantly. */
      carouselIndex = 0;
      carouselTrack.style.transition = "none";
      carouselTrack.style.transform = "translate3d(0, 0, 0)";
      void carouselTrack.offsetWidth; /* force reflow to commit the snap */
      carouselTrack.style.transition = "";
      return;
    }
    carouselTrack.style.transform = `translate3d(-${carouselIndex * BATCH_STEP}%, 0, 0)`;
  };

  const startTopRotation = () => {
    if (!topGrid || catalogue.length < TOP_SELLER_IDS.length) return;

    const track = document.createElement("div");
    track.className = "top-selling-track";
    TOP_SELLER_BATCHES.forEach((batchIds) => {
      const page = document.createElement("div");
      page.className = "top-selling-batch";
      catalogue
        .filter((p) => batchIds.includes(Number(p.id)))
        .forEach((product, i) => page.appendChild(buildCard(product, i)));
      track.appendChild(page);
    });
    /* Append a clone of the first batch so the loop is seamless. */
    track.appendChild(track.children[0].cloneNode(true));

    topGrid.replaceChildren(track);
    carouselTrack = track;
    carouselIndex = 0;

    /* The interval is created once and never paused, so auto-scroll always
       continues regardless of hover, focus, or tab activity. */
    if (carouselTimer !== null) window.clearInterval(carouselTimer);
    carouselTimer = window.setInterval(carouselSlide, CAROUSEL_INTERVAL);
  };

  const renderTopSellers = () => startTopRotation();

  const renderCollections = (list = catalogue) => {
    if (!collectionsGrid) return;
    const items = list && list.length ? list : [];
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "collections__empty";
      empty.textContent = "No products found";
      collectionsGrid.replaceChildren(empty);
      return;
    }
    renderInto(collectionsGrid, items);
  };

  /* Price buckets combined with the active category tab + live search.
     AED mode keeps clean 30/50 AED thresholds; INR mode matches converted
     item prices against clean 500/1,000 INR thresholds. */
  const PRICE_OPTIONS = {
    AED: [
      { value: "all", label: "All Prices" },
      { value: "under-30", label: "Under 30 AED" },
      { value: "30-50", label: "30 - 50 AED" },
      { value: "above-50", label: "Above 50 AED" },
    ],
    INR: [
      { value: "all", label: "All Prices" },
      { value: "under-30", label: "Under \u20B9500" },
      { value: "30-50", label: "\u20B9500 - \u20B91,000" },
      { value: "above-50", label: "Above \u20B91,000" },
    ],
  };

  const renderPriceFilterOptions = () => {
    const priceSelect = $("#price-filter");
    if (!priceSelect) return;
    const previous = priceSelect.value;
    const options = PRICE_OPTIONS[activeCurrency === "INR" ? "INR" : "AED"];
    priceSelect.innerHTML = options
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join("");
    priceSelect.value = options.some((o) => o.value === previous) ? previous : "all";
    priceRange = priceSelect.value;
  };

  const PRICE_RANGES = {
    all: () => (p) => true,
    "under-30": () => {
      const cap = activeCurrency === "INR" ? 500 : toDisplayNumber(30);
      return (p) => {
        const v = toDisplayNumber(p.price);
        return v > 0 && v <= cap;
      };
    },
    "30-50": () => {
      const lo = activeCurrency === "INR" ? 500 : toDisplayNumber(30);
      const hi = activeCurrency === "INR" ? 1000 : toDisplayNumber(50);
      return (p) => {
        const v = toDisplayNumber(p.price);
        return v > lo && v <= hi;
      };
    },
    "above-50": () => {
      const floor = activeCurrency === "INR" ? 1000 : toDisplayNumber(50);
      return (p) => toDisplayNumber(p.price) > floor;
    },
  };

  let searchQuery = "";
  let priceRange = "all";

  const refreshCollections = () => {
    const base = FILTERS[activeFilter]();
    const matchesPrice = PRICE_RANGES[priceRange]
      ? PRICE_RANGES[priceRange]()
      : PRICE_RANGES.all();
    const query = searchQuery.trim().toLowerCase();
    const items = base.filter((p) => {
      if (!matchesPrice(p)) return false;
      if (query && !String(p.title || "").toLowerCase().includes(query)) return false;
      return true;
    });
    renderCollections(items);
  };

  const applyFilter = (key) => {
    activeFilter = FILTERS[key] ? key : "all";
    filterTabs.forEach((tab) => {
      const isActive = tab.dataset.filter === activeFilter;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
    refreshCollections();
  };

  const bindFilters = () => {
    filterTabs.forEach((tab) => {
      tab.addEventListener("click", () => applyFilter(tab.dataset.filter));
    });
  };

  const bindCollectionTools = () => {
    const searchInput = $("#product-search");
    const priceSelect = $("#price-filter");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        refreshCollections();
      });
    }
    if (priceSelect) {
      priceSelect.addEventListener("change", () => {
        priceRange = priceSelect.value;
        refreshCollections();
      });
    }
  };

  const updateLoadMore = () => {
    if (!loadMoreBtn) return;
    const hasMore = topVisible < catalogue.length;
    loadMoreBtn.hidden = !hasMore;
  };

  const bindLoadMore = () => {
    if (!loadMoreBtn) return;
    loadMoreBtn.addEventListener("click", () => {
      if (topVisible >= catalogue.length) return;
      topVisible = Math.min(catalogue.length, topVisible + CONFIG.PAGE_SIZE);
      renderTopSellers();
      updateLoadMore();
    });
  };

  const seedCatalogue = (input) => {
    catalogue = [...input];
    topVisible = Math.min(CONFIG.PAGE_SIZE, catalogue.length);
    renderTopSellers();
    refreshCollections();
    renderNewIn();
    updateLoadMore();
    clearStatus();
  };

  /* ------------------------------------------------------------------ *
   * 6. Cart (state + drawer)
   * ------------------------------------------------------------------ */
  const CART_STORAGE_KEY = "lurei_cart";

  const readCart = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.id != null) : [];
    } catch {
      return [];
    }
  };

  let cart = readCart(); // [{ id, title, price, image, quantity }]

  const saveCart = () => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {}
  };

  const badge = $(".cart-badge");
  const drawer = $("#cart-drawer");
  const overlay = $("#cart-overlay");
  const cartItemsEl = $("#cart-items");
  const subtotalEl = $("#cart-subtotal");
  const checkoutBtn = $("#checkout-btn");

  const cartCount = () => cart.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const cartTotal = () => cart.reduce(
    (sum, item) => sum + (toNumber(item.price) || 0) * (Number(item.quantity) || 0),
    0
  );

  const updateBadge = () => {
    const count = cartCount();
    if (badge) {
      badge.textContent = String(count);
      badge.dataset.cartCount = String(count);
      badge.classList.remove("cart-badge--pulse");
      void badge.offsetWidth; // restart animation
      badge.classList.add("cart-badge--pulse");
    }
  };

  const renderCartItems = () => {
    if (!cartItemsEl || !subtotalEl || !checkoutBtn) return;
    subtotalEl.textContent = formatPrice(cartTotal());

    if (cart.length === 0) {
      checkoutBtn.disabled = true;
      drawer.classList.add("is-empty");
      cartItemsEl.replaceChildren(emptyState());
      return;
    }

    checkoutBtn.disabled = false;
    drawer.classList.remove("is-empty");

    const fragment = document.createDocumentFragment();
    cart.forEach((item) => {
      fragment.appendChild(buildCartItem(item));
    });
    cartItemsEl.replaceChildren(fragment);
  };

  const emptyState = () => {
    const wrap = document.createElement("div");
    wrap.className = "cart-empty";
    wrap.innerHTML =
      '<span class="cart-empty__icon" aria-hidden="true">&#10024;</span>' +
      '<p class="cart-empty__title">Your bag is empty</p>' +
      '<p class="cart-empty__text">Add a piece you love and it will appear here.</p>';
    return wrap;
  };

  const buildCartItem = (product) => {
    const item = document.createElement("div");
    item.className = "cart-item";
    item.dataset.id = product.id;

    const media = document.createElement("div");
    media.className = "cart-item__media";

    if (product.image && typeof product.image === "string") {
      const img = document.createElement("img");
      img.alt = product.title;
      img.width = 72;
      img.height = 72;
      img.loading = "lazy";
      wireImage(img, product, () =>
        img.replaceWith(buildPlaceholder("cart-item__placeholder", product))
      );
      media.appendChild(img);
    } else {
      media.appendChild(buildPlaceholder("cart-item__placeholder", product));
    }

    const info = document.createElement("div");
    info.className = "cart-item__info";

    const title = document.createElement("p");
    title.className = "cart-item__title";
    title.textContent = product.title;

    const price = document.createElement("p");
    price.className = "cart-item__price";
    price.textContent = `${formatPrice(product.price)} each`;

    info.append(title, price);

    const controls = document.createElement("div");
    controls.className = "cart-item__controls";

    const qtyRow = document.createElement("div");
    qtyRow.className = "cart-item__qty";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "qty-btn qty-btn--minus";
    minus.dataset.action = "minus";
    minus.setAttribute("aria-label", `Decrease quantity of ${product.title}`);
    minus.textContent = "\u2212";

    const count = document.createElement("span");
    count.className = "cart-item__count";
    count.textContent = String(product.quantity);

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "qty-btn qty-btn--plus";
    plus.dataset.action = "plus";
    plus.setAttribute("aria-label", `Increase quantity of ${product.title}`);
    plus.textContent = "+";

    qtyRow.append(minus, count, plus);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cart-item__remove";
    remove.dataset.action = "remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${product.title} from cart`);

    controls.append(qtyRow, remove);
    item.append(media, info, controls);
    return item;
  };

  const addToCart = (id) => {
    const product = catalogue.find((p) => String(p.id) === String(id));
    if (!product) return;

    const existing = cart.find((item) => String(item.id) === String(product.id));
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        id: product.id,
        title: product.title,
        price: product.price,
        image: product.image,
        quantity: 1,
      });
    }

    saveCart();
    updateBadge();
    renderCartItems();
    showLureiToast(`Added to bag \u2014 ${product.title}`);
  };

  const changeQty = (id, action) => {
    const item = cart.find((p) => String(p.id) === String(id));
    if (!item) return;

    if (action === "plus") item.quantity += 1;
    if (action === "minus") item.quantity = Math.max(1, item.quantity - 1);
    if (action === "remove") {
      cart = cart.filter((p) => String(p.id) !== String(id));
    }

    saveCart();
    updateBadge();
    renderCartItems();
  };

  const openDrawer = () => {
    renderCartItems();
    drawer.classList.add("is-open");
    overlay.classList.add("is-open");
    document.body.classList.add("lock-scroll");
  };

  const closeDrawer = () => {
    drawer.classList.remove("is-open");
    overlay.classList.remove("is-open");
    if (!modal.classList.contains("modal--open")) {
      document.body.classList.remove("lock-scroll");
    }
  };

  /* Delegated cart item controls — one listener on the parent container */
  if (cartItemsEl) {
    cartItemsEl.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("[data-action]");
      if (!actionBtn) return;
      const itemEl = actionBtn.closest("[data-id]");
      if (!itemEl) return;
      changeQty(itemEl.dataset.id, actionBtn.dataset.action);
    });
  }

  /* Restore persisted cart on load */
  updateBadge();
  renderCartItems();

  /* ------------------------------------------------------------------ *
   * 7. Checkout modal
   * ------------------------------------------------------------------ */
  const modal = $("#checkout-modal");
  const modalOverlay = $("#checkout-overlay");
  const modalClose = $("#checkout-close");
  const checkoutClose = modalClose;
  const checkoutForm = $("#checkout-form");
  const checkoutSuccess = $("#checkout-success");
  const summaryLabel = $("#checkout-items-label");
  const summaryTotal = $("#checkout-summary-total");
  const submitTotal = $("#checkout-submit-total");
  const payOptions = document.querySelectorAll('input[name="payment"]');

  const openCheckout = () => {
    if (cart.length === 0) return;
    closeDrawer();

    const count = cartCount();
    summaryLabel.textContent = `Items (${count})`;
    summaryTotal.textContent = formatPrice(cartTotal());
    const submitCurrencyEl = $("#checkout-submit-currency");
    if (submitCurrencyEl) {
      submitCurrencyEl.textContent = activeCurrency === "INR" ? "\u20B9" : "AED";
    }
    submitTotal.textContent = activeCurrency === "INR"
      ? toDisplayNumber(cartTotal()).toLocaleString("en-IN")
      : cartTotal().toFixed(2);

    modal.hidden = false;
    modalOverlay.classList.add("is-open");
    modal.classList.add("modal--open");
    document.body.classList.add("lock-scroll");

    const firstField = $("#cust-name");
    if (firstField) setTimeout(() => firstField.focus(), 120);
  };

  const closeCheckout = () => {
    modal.hidden = true;
    modalOverlay.classList.remove("is-open");
    modal.classList.remove("modal--open");
    renderCartItems();
    document.body.classList.remove("lock-scroll");
  };

  const resetCheckoutView = () => {
    checkoutForm.hidden = false;
    checkoutSuccess.hidden = true;
    checkoutForm.reset();
    payOptions.forEach((radio) => {
      radio.closest(".pay-option").classList.toggle("is-selected", radio.checked);
    });
  };

  const buildOrderReference = () => `LUREI-${Date.now().toString().slice(-6)}`;

  checkoutBtn.addEventListener("click", openCheckout);
  checkoutClose.addEventListener("click", () => {
    resetCheckoutView();
    closeCheckout();
  });

  modalOverlay.addEventListener("click", () => {
    resetCheckoutView();
    closeCheckout();
  });

  payOptions.forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll(".pay-option").forEach((option) => {
        option.classList.remove("is-selected");
      });
      radio.closest(".pay-option").classList.add("is-selected");
    });
  });

  /* High-end jsPDF invoice — luxury black & gold Order Invoice */
  const generateLureiInvoice = ({ orderId, name, phone, email, address, paymentLabel, items, totalPrice }) => {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      console.error("[Invoice] jsPDF library not loaded.");
      return;
    }
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const marginX = 48;
      const WHITE = [255, 255, 255];        // #FFFFFF — Crisp White
      const BLACK = [17, 17, 17];           // #111111 — Rich Black
      const CHARCOAL = [51, 51, 51];        // #333333 — body / customer details
      const GOLD = [212, 175, 55];          // #D4AF37 — Metallic Gold accents
      const GREY_ROW = [249, 249, 249];     // #F9F9F9 — alternating table rows
      const GRID = [229, 229, 229];         // #E5E5E5 — subtle table gridlines
      const FOOTER_GREY = [102, 102, 102];  // #666666 — footer message

      /* Crisp White canvas — pure, clean #FFFFFF background */
      doc.setFillColor(...WHITE);
      doc.rect(0, 0, pageW, pageH, "F");

      /* Deep rich black header band with a metallic gold 1pt underline */
      doc.setFillColor(...BLACK);
      doc.rect(0, 0, pageW, 96, "F");
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1);
      doc.line(0, 96, pageW, 96);

      doc.setTextColor(...WHITE);
      doc.setFont("times", "bold");
      doc.setFontSize(26);
      doc.text("LUREI DUBAI", marginX, 50);
      doc.setTextColor(...GOLD);
      doc.setFont("times", "normal");
      doc.setFontSize(9);
      doc.text("FINE JEWELLERY & ACCESSORIES", marginX, 68);
      doc.setTextColor(...WHITE);
      doc.setFont("times", "bold");
      doc.setFontSize(14);
      doc.text("OFFICIAL INVOICE", pageW - marginX, 52, { align: "right" });

      /* Order meta — rich black headings, charcoal body */
      let y = 138;
      doc.setFont("times", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...BLACK);
      doc.text(`Order Reference: #${orderId}`, marginX, y);
      doc.setFont("times", "normal");
      doc.setFontSize(10);
      doc.setTextColor(...CHARCOAL);
      y += 18;
      doc.text(`Date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, marginX, y);
      doc.text(`Payment Method: ${paymentLabel}`, marginX + 300, y);

      /* Customer details — two-tone serif fields (black labels, charcoal values) */
      const drawInvoiceField = (labelText, value, x, yPos) => {
        doc.setFont("times", "bold");
        doc.setTextColor(...BLACK);
        doc.text(`${labelText}:`, x, yPos);
        const labelWidth = doc.getTextWidth(`${labelText}: `);
        doc.setFont("times", "normal");
        doc.setTextColor(...CHARCOAL);
        doc.text(value, x + labelWidth, yPos);
      };

      y += 34;
      doc.setFont("times", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...BLACK);
      doc.text("CUSTOMER DETAILS", marginX, y);
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(0.75);
      doc.line(marginX, y + 4, marginX + 64, y + 4);
      doc.setFontSize(10);

      y += 20;
      drawInvoiceField("Name", name, marginX, y);
      drawInvoiceField("Phone", phone, marginX + 300, y);
      y += 16;
      drawInvoiceField("Email", email, marginX, y);
      y += 20;

      /* Delivery address — wrapping, black label + charcoal value */
      const addrLabel = "Delivery Address";
      doc.setFont("times", "bold");
      doc.setTextColor(...BLACK);
      doc.text(`${addrLabel}:`, marginX, y);
      const addrLabelWidth = doc.getTextWidth(`${addrLabel}: `);
      doc.setFont("times", "normal");
      doc.setTextColor(...CHARCOAL);
      const addressLines = doc.splitTextToSize(address, pageW - marginX * 2 - addrLabelWidth);
      addressLines.slice(0, 2).forEach((line, i) => {
        doc.text(line, marginX + addrLabelWidth, y + i * 14);
      });

      y += (addressLines.length > 1 ? 32 : 16) + 10;
      y = Math.max(y, 286);

      /* Order summary — black header row, white / soft-grey alternating rows,
         fine #E5E5E5 grid lines */
      const separators = [250, 300, 410];
      const colRight = { qty: 295, price: 405, total: 542 };
      const ROW_H = 22;

      const drawTableHeader = (yPos) => {
        doc.setFillColor(...BLACK);
        doc.rect(marginX, yPos, pageW - marginX * 2, 24, "F");
        doc.setTextColor(...WHITE);
        doc.setFont("times", "bold");
        doc.setFontSize(10);
        doc.text("PRODUCT", marginX + 10, yPos + 16);
        doc.text("QTY", colRight.qty, yPos + 16, { align: "right" });
        doc.text("PRICE", colRight.price, yPos + 16, { align: "right" });
        doc.text("TOTAL", colRight.total, yPos + 16, { align: "right" });
        doc.setDrawColor(...GRID);
        doc.setLineWidth(0.4);
        doc.line(marginX, yPos + 24, pageW - marginX, yPos + 24);
      };

      drawTableHeader(y);
      y += 24;

      let rowIndex = 0;
      items.forEach(({ title, price, quantity }) => {
        if (y + ROW_H > pageH - 90) {
          doc.addPage();
          y = 60;
          drawTableHeader(y);
          y += 24;
          rowIndex = 0;
        }

        const rowTop = y;
        doc.setFillColor(rowIndex % 2 === 0 ? WHITE : GREY_ROW);
        doc.rect(marginX, rowTop, pageW - marginX * 2, ROW_H, "F");

        const unitPrice = formatPrice(price).replace(/^(AED|\u20B9)\s*/, "");
        const lineTotal = formatPrice(price * quantity).replace(/^(AED|\u20B9)\s*/, "");

        doc.setFont("times", "normal");
        doc.setFontSize(9.5);
        doc.setTextColor(...CHARCOAL);
        doc.text(String(title).slice(0, 44), marginX + 10, rowTop + 16);
        doc.text(String(quantity), colRight.qty, rowTop + 16, { align: "right" });
        doc.text(unitPrice, colRight.price, rowTop + 16, { align: "right" });
        doc.text(lineTotal, colRight.total, rowTop + 16, { align: "right" });

        doc.setDrawColor(...GRID);
        doc.setLineWidth(0.4);
        separators.forEach((x) => doc.line(x, rowTop, x, rowTop + ROW_H));
        doc.line(marginX, rowTop + ROW_H, pageW - marginX, rowTop + ROW_H);

        y = rowTop + ROW_H;
        rowIndex++;
      });

      /* Total — solid gold accent divider, bold black figures */
      y += 26;
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1.2);
      doc.line(marginX, y, pageW - marginX, y);
      y += 24;
      doc.setFont("times", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...BLACK);
      doc.text("TOTAL", marginX, y);
      doc.text(formatPrice(totalPrice), pageW - marginX, y, { align: "right" });

      /* Footer — italic serif, soft charcoal grey */
      y += 44;
      doc.setFont("times", "italic");
      doc.setFontSize(10);
      doc.setTextColor(...FOOTER_GREY);
      doc.text("Thank you for choosing LUREÍ Dubai \u2014 your order is being prepared.", pageW / 2, y, { align: "center" });

      return doc;
    } catch (error) {
      console.error("[Invoice] generation failed:", error && error.message ? error.message : error);
      return null;
    }
  };

  checkoutForm.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!checkoutForm.checkValidity()) {
      checkoutForm.reportValidity();
      return;
    }

    const name = $("#cust-name").value.trim();
    const phone = $("#cust-phone").value.trim();
    const emailInput = $("#cust-email");
    const email = emailInput ? emailInput.value.trim() : "N/A";
    const address = $("#cust-address").value.trim();
    const payment = document.querySelector('input[name="payment"]:checked').value;
    const paymentLabel = payment === "card" ? "Online Payment" : "Cash on Delivery";

    const orderId = buildOrderReference();
    const items = [...cart];
    const totalPrice = cartTotal().toFixed(2);

    /* Success panel */
    const emailDd = $("#success-email");
    $("#checkout-order-ref").textContent = orderId;
    $("#success-name").textContent = name;
    $("#success-phone").textContent = phone;
    if (emailDd) emailDd.textContent = email;
    $("#success-address").textContent = address;
    $("#success-payment").textContent = paymentLabel;
    $("#success-total").textContent = formatPrice(totalPrice);

    /* Capture the current order globally so the modal's Download button can
       rebuild the jsPDF invoice reliably from memory — no stale closures
       or null doc references. */
    window.latestLureiOrder = {
      orderId,
      customerName: name,
      phone,
      email,
      address,
      payment: paymentLabel,
      items: [...cart],
      currency: currencyCode(),
      total: totalPrice,
    };

    /* Attach the explicit Download Official Invoice handler — a real,
       user-initiated gesture bypasses browser pop-up suppression. Fresh
       listeners only (cloneNode clears any stale bindings). */
    const modalDownloadBtn = document.getElementById("downloadPdfBtn");
    if (modalDownloadBtn) {
      modalDownloadBtn.replaceWith(modalDownloadBtn.cloneNode(true));
      const newDownloadBtn = document.getElementById("downloadPdfBtn");
      if (newDownloadBtn) {
        newDownloadBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();

          const order = window.latestLureiOrder;
          if (!order) return;

          try {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();

            const INK = [17, 17, 17];        // #111111 deep black
            const WHITE = [255, 255, 255];
            const GOLD = [212, 175, 55];     // #D4AF37 metallic gold
            const CHARCOAL = [34, 34, 34];   // #222222 crisp charcoal body text
            const ROW_BAR = [26, 26, 26];    // #1A1A1A dark charcoal table bar
            const DIVIDER = [232, 216, 184]; // #E8D8B8 thin gold row dividers
            const GREY = [51, 51, 51];       // thank-you note
            const SOFT = [102, 102, 102];    // #666666 customer care line
            const symbol = order.currency === "INR" ? "Rs." : "AED";

            /* 1 — Sleek modern luxury header */
            doc.setFillColor(...INK);
            doc.rect(0, 0, 210, 32, "F");
            doc.setFont("times", "bold");
            doc.setFontSize(20);
            doc.setTextColor(...WHITE);
            doc.text("L U R E Í  D U B A I", 16, 21);
            doc.setFontSize(8.5);
            doc.setTextColor(...GOLD);
            doc.text("FINE JEWELLERY & ACCESSORIES", 16, 28);
            doc.setFontSize(9.5);
            doc.setTextColor(...WHITE);
            doc.text("OFFICIAL INVOICE", 194, 21, { align: "right" });
            doc.setDrawColor(...GOLD);
            doc.setLineWidth(0.5);
            doc.line(0, 32, 210, 32);

            /* 2 — Clean two-column metadata grid */
            let y = 54;
            doc.setFont("times", "bold");
            doc.setFontSize(9);
            doc.setTextColor(...GOLD);
            doc.text("CUSTOMER DETAILS", 16, y);
            doc.text("ORDER INFORMATION", 194, y, { align: "right" });

            y += 8;
            doc.setFont("times", "normal");
            doc.setFontSize(10);
            doc.setTextColor(...CHARCOAL);
            doc.text(order.customerName, 16, y);
            doc.text(`Order Reference: ${order.orderId}`, 194, y, { align: "right" });
            y += 5.5;
            doc.text(order.phone, 16, y);
            doc.text(`Order Date: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, 194, y, { align: "right" });
            y += 5.5;
            doc.text(order.email, 16, y);
            doc.text(`Payment Method: ${order.payment}`, 194, y, { align: "right" });
            y += 6.5;
            const addrLines = doc.splitTextToSize(order.address, 92);
            addrLines.slice(0, 3).forEach((line, i) => {
              doc.text(line, 16, y + i * 5);
            });
            y += Math.min(addrLines.length, 3) * 5 + 6;

            /* 3 — Minimalist high-end product table */
            const tableX = 16;
            const tableW = 194;
            const rowH = 7.5;
            doc.setFillColor(...ROW_BAR);
            doc.rect(tableX, y, tableW - tableX, 8, "F");
            doc.setFont("times", "bold");
            doc.setFontSize(9);
            doc.setTextColor(...WHITE);
            doc.text("ITEM DESCRIPTION", tableX + 3, y + 5.5);
            doc.text("QTY", 130, y + 5.5, { align: "right" });
            doc.text("PRICE", 160, y + 5.5, { align: "right" });
            doc.text("TOTAL", tableW - 3, y + 5.5, { align: "right" });
            y += 8;

            doc.setFont("times", "normal");
            doc.setTextColor(...CHARCOAL);
            let calculatedSubtotal = 0;
            order.items.forEach((item) => {
              const qty = item.quantity || 1;
              const unitPrice = order.currency === "INR" ? Math.round(item.price * 26.08) : item.price;
              const itemTotal = unitPrice * qty;
              calculatedSubtotal += itemTotal;
              doc.text(String(item.title || "Jewellery Item").slice(0, 44), tableX + 3, y + 4.5);
              doc.text(String(qty), 130, y + 4.5, { align: "right" });
              doc.text(`${symbol} ${unitPrice}`, 160, y + 4.5, { align: "right" });
              doc.text(`${symbol} ${itemTotal}`, tableW - 3, y + 4.5, { align: "right" });
              doc.setDrawColor(...DIVIDER);
              doc.setLineWidth(0.2);
              doc.line(tableX, y + rowH, tableW, y + rowH);
              y += rowH;
            });

            /* 4 — Rich totals block (subtle gold-bordered container) */
            y += 4;
            const boxTop = y;
            const boxX = 108;
            doc.setDrawColor(...GOLD);
            doc.setLineWidth(0.4);
            doc.rect(boxX, boxTop, tableW - boxX, 30, "S");
            doc.setFont("times", "normal");
            doc.setFontSize(10);
            doc.setTextColor(...CHARCOAL);
            doc.text("Subtotal", boxX + 4, boxTop + 9);
            doc.text(`${symbol} ${calculatedSubtotal.toLocaleString()}`, tableW - 4, boxTop + 9, { align: "right" });
            doc.text("Shipping", boxX + 4, boxTop + 16);
            doc.text("Complimentary", tableW - 4, boxTop + 16, { align: "right" });
            doc.setFont("times", "bold");
            doc.setFontSize(12);
            doc.setTextColor(...INK);
            doc.text("Final Total", boxX + 4, boxTop + 25);
            doc.text(`${symbol} ${calculatedSubtotal.toLocaleString()}`, tableW - 4, boxTop + 25, { align: "right" });

            /* 5 — Balanced elegant footer */
            const footerY = 268;
            doc.setDrawColor(...GOLD);
            doc.setLineWidth(0.4);
            doc.line(16, footerY, 194, footerY);
            doc.setFont("times", "normal");
            doc.setFontSize(9.5);
            doc.setTextColor(...GREY);
            doc.text("Thank you for your order. We hope you love your piece.", 105, footerY + 8, { align: "center" });
            doc.setFontSize(8.5);
            doc.setTextColor(...SOFT);
            doc.text("Customer Care: +971 525303886 | LUREÍ Dubai", 105, footerY + 15, { align: "center" });

            doc.save(`LUREI_Invoice_${order.orderId}.pdf`);
          } catch (err) {
            console.error("jsPDF Execution Error:", err);
            alert("PDF generation in progress...");
          }
        });
      }
    }

    /* WhatsApp order message — clean plain text with zero asterisks,
       reliable \n newlines, and currency-aware items and total. */
    const currentCurrency = currencyCode();
    const formattedItems = items
      .map((item) => {
        const price = currentCurrency === "INR" ? Math.round(item.price * 26.08) : item.price;
        const currencySymbol = currentCurrency === "INR" ? "₹ " : "AED ";
        return `\u2022 ${item.title || "Item"} x${item.quantity || 1} \u2014 ${currencySymbol}${price}`;
      })
      .join("\n");

    const currencyLabel = currentCurrency === "INR" ? "₹ " : "AED ";
    const calculatedTotal = currentCurrency === "INR" ? Math.round(totalPrice * 26.08) : totalPrice;

    const waMessage =
`Hello LUREÍ Dubai Team,

I would like to place a new order:

Order Reference: ${orderId}
Customer Name: ${name}
Phone: ${phone}
Email: ${email}
Delivery Address: ${address}
Payment Choice: ${paymentLabel}

Selected Products:
${formattedItems}

Total Amount: ${currencyLabel}${calculatedTotal}

Note: I confirm my order and will download my Official PDF Invoice. Please confirm delivery timeline.

Thank you!`;

    const encodedWaUrl = `https://wa.me/971525303886?text=${encodeURIComponent(waMessage)}`;

    /* WhatsApp routing — opened safely (noopener) after a 500ms delay so the
       Order Placed panel renders first and the user-initiated PDF download
       is not affected by pop-up suppression. */
    setTimeout(() => {
      if (encodedWaUrl) {
        window.open(encodedWaUrl, "_blank", "noopener,noreferrer");
      }
    }, 500);

    /* Order alert email to lureiaccessories@gmail.com (FormSubmit) */
    fetch(`https://formsubmit.co/ajax/${CONFIG.CONTACT_EMAIL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone,
        address,
        payment: paymentLabel,
        orderId,
        message: waMessage,
        _subject: `New LUREÍ order ${orderId} from ${name}`,
        _template: "table",
        _captcha: "false",
      }),
    }).catch(() => {});

    /* Order SMS alert to the boutique (Brevo v3 SMS) */
    sendSmsAlert(
      `New LUREÍ order ${orderId}\n` +
        `Customer: ${name}\n` +
        `Phone: ${phone}\n` +
        `Total: AED ${totalPrice}\n` +
        `Payment: ${paymentLabel}`
    );

    checkoutForm.hidden = true;
    checkoutSuccess.hidden = false;

    cart = [];
    saveCart();
    updateBadge();
    renderCartItems();
  });

  $("#checkout-done").addEventListener("click", () => {
    resetCheckoutView();
    closeCheckout();
  });

  /* ------------------------------------------------------------------ *
   * 7c. Wishlist (localStorage + slide-out drawer)
   * ------------------------------------------------------------------ */
  const WISHLIST_STORAGE_KEY = "lurei_wishlist";

  const readWishlist = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(WISHLIST_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  let wishlist = readWishlist();

  const saveWishlist = () => {
    try {
      localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(wishlist));
    } catch {}
  };

  const hasWishlist = (id) => wishlist.some((p) => String(p.id) === String(id));

  const toggleWishlist = (id, productDetails) => {
    const index = wishlist.findIndex((p) => String(p.id) === String(id));
    if (index !== -1) {
      wishlist.splice(index, 1);
    } else if (productDetails) {
      wishlist.push(productDetails);
    }
    saveWishlist();
    syncWishlistHearts();
    renderWishlist();
    updateWishlistBadge();
  };

  const wishlistBadge = $(".wishlist-badge");

  const updateWishlistBadge = () => {
    if (!wishlistBadge) return;
    const count = wishlist.length;
    wishlistBadge.textContent = String(count);
    wishlistBadge.dataset.wishlistCount = String(count);
    wishlistBadge.classList.toggle("is-hidden", count === 0);
  };

  const syncWishlistHearts = () => {
    document.querySelectorAll(".wishlist-heart").forEach((heart) => {
      const active = hasWishlist(heart.dataset.wishlistAdd);
      heart.classList.toggle("is-wishlisted", active);
      const productName = heart.dataset.wishlistTitle || "item";
      heart.setAttribute("aria-label", `${active ? "Remove" : "Add"} ${productName} ${active ? "from" : "to"} wishlist`);
    });
  };

  const wishlistDrawerEl = $("#wishlistDrawer");
  const wishlistOverlayEl = $("#wishlist-overlay");
  const wishlistItemsEl = $("#wishlist-items");
  const wishlistCloseEl = $("#wishlist-close");

  const openWishlist = () => {
    renderWishlist();
    if (wishlistDrawerEl) wishlistDrawerEl.classList.add("is-open");
    if (wishlistOverlayEl) wishlistOverlayEl.classList.add("is-open");
    document.body.classList.add("lock-scroll");
  };

  const closeWishlist = () => {
    if (wishlistDrawerEl) wishlistDrawerEl.classList.remove("is-open");
    if (wishlistOverlayEl) wishlistOverlayEl.classList.remove("is-open");
    if (!overlay.classList.contains("is-open") && !modal.classList.contains("modal--open")) {
      document.body.classList.remove("lock-scroll");
    }
  };

  const buildWishlistEmpty = () => {
    const wrap = document.createElement("div");
    wrap.className = "wishlist-empty";
    wrap.innerHTML =
      '<span class="wishlist-empty__icon" aria-hidden="true">&#9825;</span>' +
      '<p class="wishlist-empty__title">Your Wishlist is Empty</p>' +
      '<p class="wishlist-empty__text">Tap the heart on any piece to save it here.</p>';
    return wrap;
  };

  const buildWishlistItem = (product) => {
    const item = document.createElement("div");
    item.className = "wishlist-item";
    item.dataset.id = product.id;

    const media = document.createElement("div");
    media.className = "wishlist-item__media";

    if (product.image && typeof product.image === "string") {
      const img = document.createElement("img");
      img.alt = product.title;
      img.width = 72;
      img.height = 72;
      img.loading = "lazy";
      wireImage(img, product, () =>
        img.replaceWith(buildPlaceholder("wishlist-item__placeholder", product))
      );
      media.appendChild(img);
    } else {
      media.appendChild(buildPlaceholder("wishlist-item__placeholder", product));
    }

    const info = document.createElement("div");
    info.className = "wishlist-item__info";

    const title = document.createElement("p");
    title.className = "wishlist-item__title";
    title.textContent = product.title;

    const price = document.createElement("p");
    price.className = "wishlist-item__price";
    price.textContent = formatPrice(product.price);

    info.append(title, price);

    const actions = document.createElement("div");
    actions.className = "wishlist-item__actions";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "wishlist-item__remove";
    remove.dataset.wishlistRemove = String(product.id);
    remove.setAttribute("aria-label", `Remove ${product.title} from wishlist`);
    remove.textContent = "Remove";

    const bag = document.createElement("button");
    bag.type = "button";
    bag.className = "wishlist-item__bag";
    bag.dataset.wishlistToBag = String(product.id);
    bag.innerHTML = `${CART_ICON}<span>Add to Bag</span>`;
    bag.setAttribute("aria-label", `Add ${product.title} to bag`);

    actions.append(remove, bag);
    item.append(media, info, actions);
    return item;
  };

  const renderWishlist = () => {
    if (!wishlistItemsEl) return;
    if (wishlistDrawerEl) wishlistDrawerEl.classList.toggle("is-empty", wishlist.length === 0);
    if (wishlist.length === 0) {
      wishlistItemsEl.replaceChildren(buildWishlistEmpty());
      return;
    }
    const fragment = document.createDocumentFragment();
    wishlist.forEach((product) => fragment.appendChild(buildWishlistItem(product)));
    wishlistItemsEl.replaceChildren(fragment);
  };

  /* ------------------------------------------------------------------ *
   * 8. Global event wiring (delegation + keyboard)
   * ------------------------------------------------------------------ */
  document.addEventListener("click", (event) => {
    const openWishBtn = event.target.closest("#wishlist-open");
    if (openWishBtn) {
      openWishlist();
      return;
    }

    const heartBtn = event.target.closest("[data-wishlist-add]");
    if (heartBtn) {
      const wishId = heartBtn.dataset.wishlistAdd;
      const product = catalogue.find((p) => String(p.id) === String(wishId));
      toggleWishlist(wishId, product || { id: wishId });
      return;
    }

    const wishRemoveBtn = event.target.closest("[data-wishlist-remove]");
    if (wishRemoveBtn) {
      toggleWishlist(wishRemoveBtn.dataset.wishlistRemove, null);
      return;
    }

    const toBagBtn = event.target.closest("[data-wishlist-to-bag]");
    if (toBagBtn) {
      closeWishlist();
      addToCart(toBagBtn.dataset.wishlistToBag);
      return;
    }

    const addBtn = event.target.closest("[data-add]");
    if (addBtn) {
      addToCart(addBtn.dataset.add);
      return;
    }

    const cartIcon = event.target.closest(".cart-btn");
    if (cartIcon) {
      openDrawer();
      return;
    }

    if (event.target === overlay) closeDrawer();
    if (event.target.closest("#cart-close")) closeDrawer();
    if (event.target === wishlistOverlayEl) closeWishlist();
    if (event.target.closest("#wishlist-close")) closeWishlist();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (!modal.hidden) {
      resetCheckoutView();
      closeCheckout();
      return;
    }

    if (drawer.classList.contains("is-open")) closeDrawer();
    if (wishlistDrawerEl && wishlistDrawerEl.classList.contains("is-open")) closeWishlist();
  });

  /* ------------------------------------------------------------------ *
   * 8b. Service modals — Contact & Customer Care (footer links)
   * ------------------------------------------------------------------ */
  const SERVICE_MODAL_HTML = `
    <div class="modal-overlay" id="contact-overlay" aria-hidden="true"></div>
    <div class="modal" id="contact-modal" role="dialog" aria-modal="true" aria-labelledby="contact-title" hidden>
      <div class="modal__card">
        <header class="modal__head">
          <h2 class="modal__title" id="contact-title">Contact Us</h2>
          <button class="modal__close" type="button" data-close-service="contact" aria-label="Close contact">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </header>
        <p class="checkout-success__note">Customer Care &mdash; lureiaccessories@gmail.com &bull; WhatsApp &amp; SMS &mdash; +971 52 530 3886. We reply within 24 hours.</p>
        <form class="checkout-form" id="contact-modal-form" data-lurei-contact onsubmit="return false;">
          <div class="field">
            <label class="field__label" for="contact-name">YOUR NAME</label>
            <input class="field__input" id="contact-name" name="name" type="text" placeholder="Your full name" autocomplete="name" required />
          </div>
          <div class="field">
            <label class="field__label" for="contact-email">EMAIL ADDRESS</label>
            <input class="field__input" id="contact-email" name="email" type="email" placeholder="you@email.com" autocomplete="email" required />
          </div>
          <div class="field">
            <label class="field__label" for="contact-phone">PHONE NUMBER</label>
            <input class="field__input" id="contact-phone" name="phone" type="tel" placeholder="+971 50 123 4567" autocomplete="tel" required />
          </div>
          <div class="field">
            <label class="field__label" for="contact-message">MESSAGE</label>
            <textarea class="field__input" id="contact-message" name="message" rows="4" placeholder="How can we help you?" required></textarea>
          </div>
          <button class="btn btn--checkout btn--checkout-block" type="submit">SEND MESSAGE</button>
        </form>
      </div>
    </div>

    <div class="modal-overlay" id="stores-overlay" aria-hidden="true"></div>
    <div class="modal" id="stores-modal" role="dialog" aria-modal="true" aria-labelledby="stores-title" hidden>
      <div class="modal__card">
        <header class="modal__head">
          <h2 class="modal__title" id="stores-title">Connect With Us</h2>
          <button class="modal__close" type="button" data-close-service="stores" aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
          </button>
        </header>
        <p class="checkout-success__note">LURE&Iacute; Dubai is an exclusive online jewellery store. We are always here to help you pick the perfect piece, answer questions, or track your order.</p>
        <div class="checkout-summary">
          <div class="checkout-summary__row"><span><strong>WhatsApp Support</strong></span><span>24/7 Digital Assistant</span></div>
          <p style="margin:0.4rem 0 0.8rem;font-size:0.8rem;color:var(--color-muted);">Instant help for order status, styling suggestions, and delivery queries.</p>
          <a class="btn btn--gold" style="width:100%;" href="https://wa.me/971525303886" target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a>
        </div>
        <div class="checkout-summary">
          <div class="checkout-summary__row"><span><strong>Official Instagram</strong></span><span>Daily Styling Notes &amp; DMs</span></div>
          <p style="margin:0.4rem 0 0.8rem;font-size:0.8rem;color:var(--color-muted);">Follow us for new designs, video previews, and direct messages.</p>
          <a class="btn btn--gold" style="width:100%;" href="https://www.instagram.com/lurei.ae/" target="_blank" rel="noopener noreferrer">Visit Instagram (@lurei.ae)</a>
        </div>
      </div>
    </div>
  `;

  const buildServiceModals = () => {
    if (!document.getElementById("contact-modal")) {
      document.body.insertAdjacentHTML("beforeend", SERVICE_MODAL_HTML);
    }
  };

  const openServiceModal = (name) => {
    const overlayEl = document.getElementById(`${name}-overlay`);
    const modalEl = document.getElementById(`${name}-modal`);
    if (!overlayEl || !modalEl) return;
    closeServiceModals();
    if (drawer.classList.contains("is-open")) closeDrawer();
    if (wishlistDrawerEl && wishlistDrawerEl.classList.contains("is-open")) closeWishlist();
    overlayEl.classList.add("is-open");
    modalEl.hidden = false;
    modalEl.classList.add("modal--open");
    document.body.style.overflow = "hidden";
  };

  const closeServiceModals = () => {
    ["contact", "stores"].forEach((name) => {
      const overlayEl = document.getElementById(`${name}-overlay`);
      const modalEl = document.getElementById(`${name}-modal`);
      if (modalEl) modalEl.hidden = true;
      if (overlayEl) overlayEl.classList.remove("is-open");
    });
    document.body.style.overflow = "";
  };

  /* Sleek brand toast — injected locally, no shared styles touched */
  const showAppToast = (message) => {
    let toast = $("#app-toast");
    if (!toast) {
      const style = document.createElement("style");
      style.textContent =
        "#app-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:999;" +
        "background:#1A1815;color:#FAF8F5;font-family:'Plus Jakarta Sans',sans-serif;font-size:0.82rem;font-weight:500;" +
        "letter-spacing:0.02em;line-height:1.5;padding:0.85rem 1.4rem;border-radius:999px;" +
        "border:1px solid rgba(197,160,89,0.55);box-shadow:0 18px 40px -18px rgba(26,26,26,0.65);" +
        "opacity:0;pointer-events:none;transition:opacity 0.35s ease, transform 0.35s ease;max-width:min(92vw, 540px);text-align:center}" +
        "#app-toast.is-visible{opacity:1;transform:translateX(-50%) translateY(0)}";
      document.head.appendChild(style);
      toast = document.createElement("div");
      toast.id = "app-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove("is-visible"), 5200);
  };

  /* Multi-channel inquiry — WhatsApp redirect + Email (FormSubmit) + SMS webhook */
  const handleLureiContactSubmit = (event) => {
    event.preventDefault();
    event.stopPropagation();

    const form = event.target;

    if (form.checkValidity && !form.checkValidity()) {
      if (form.reportValidity) form.reportValidity();
      return;
    }

    const field = (name) => {
      const el = form.querySelector(`[name="${name}"]`);
      return el ? String(el.value || "").trim() : "";
    };
    const name = field("name");
    const email = field("email");
    const phone = field("phone");
    const message = field("message") || "No message provided.";

    /* Trigger 1 — WhatsApp redirect with pre-filled inquiry template */
    const messageTemplate =
      `Hello LUREÍ Dubai Team,\n\n` +
      `My name is ${name}.\n\n` +
      `Inquiry:\n${message}\n\n` +
      `Kindly reach back to me using my details below:\n` +
      `• Email: ${email}\n` +
      `• Phone: ${phone}\n\n` +
      `Thank you!`;

    const waUrl = `https://wa.me/971525303886?text=${encodeURIComponent(messageTemplate)}`;
    window.open(waUrl, "_blank", "noopener,noreferrer");

    /* Trigger 2 — Email alert to lureiaccessories@gmail.com (FormSubmit AJAX) */
    fetch(`https://formsubmit.co/ajax/${CONFIG.CONTACT_EMAIL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone,
        message,
        _subject: `New LUREÍ Dubai customer inquiry from ${name}`,
        _template: "table",
        _body: messageTemplate,
        _captcha: "false",
      }),
    }).catch(() => {});

    /* Trigger 3 — SMS alert to the boutique (Brevo v3 SMS) */
    sendSmsAlert(
      `LUREÍ customer inquiry from ${name}: ${message} — reach back at ${phone}`
    );

    showAppToast(
      "Message sent. We reply within 24 hours."
    );

    form.reset();

    if (form.closest(".modal")) setTimeout(closeServiceModals, 600);
  };

  const bindServiceModals = () => {
    buildServiceModals();

    document.addEventListener("submit", (event) => {
      if (event.target.matches("form[data-lurei-contact]")) {
        handleLureiContactSubmit(event);
      }
    });

    document.addEventListener("click", (event) => {
      const opener = event.target.closest("[data-open-service]");
      if (opener) {
        event.preventDefault();
        openServiceModal(opener.dataset.openService);
        return;
      }
      const closer = event.target.closest("[data-close-service]");
      if (closer) {
        event.preventDefault();
        closeServiceModals();
        return;
      }
      const serviceModalEl = event.target.closest("[id$='-modal']");
      if (serviceModalEl && event.target === serviceModalEl) closeServiceModals();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeServiceModals();
    });
  };

  /* In-page anchors — smooth scroll with shared CSS fallback */
  const bindSmoothAnchors = () => {
    document.addEventListener("click", (event) => {
      const anchor = event.target.closest('a[href^="#"]');
      if (!anchor) return;
      const hrefAttr = anchor.getAttribute("href");
      if (hrefAttr === "#" || anchor.hasAttribute("data-open-service")) return;
      const anchorTarget = document.getElementById(hrefAttr.slice(1));
      if (!anchorTarget) return;
      event.preventDefault();
      anchorTarget.scrollIntoView({ behavior: "smooth", block: "start" });
      if (history.replaceState) history.replaceState(null, "", hrefAttr);
    });
  };

  /* ------------------------------------------------------------------ *
   * 9. Data loading (Google Sheets via Apps Script; mock-first)
   * ------------------------------------------------------------------ */
  const fetchFromSheets = async () => {
    const endpoint = CONFIG.APPS_SCRIPT_URL.trim();

    if (!endpoint) {
      throw new Error("APPS_SCRIPT_URL not configured — using fallback catalogue.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Google Apps Script responded with HTTP ${response.status}`);
      }

      const payload = await response.json();
      const products = normalizeProducts(
        Array.isArray(payload) ? payload : payload.products ?? payload.data ?? []
      );

      if (!products.length) {
        throw new Error("Sheets API returned no usable products.");
      }

      return products;
    } finally {
      clearTimeout(timer);
    }
  };

  /* ------------------------------------------------------------------ *
   * 10. Boot
   * ------------------------------------------------------------------ */
  (async () => {
    bindFilters();
    bindCollectionTools();
    bindLoadMore();
    bindCurrencySwitcher();
    syncCurrencySelectors();
    renderPriceFilterOptions();

    const activeParams = new URLSearchParams(window.location.search);
    const selectedCat = activeParams.get("category");
    if (selectedCat && Object.prototype.hasOwnProperty.call(FILTERS, selectedCat)) {
      activeFilter = selectedCat;
    }

    seedCatalogue(normalizeProducts(products));
    applyFilter(activeFilter);
    renderCartItems();
    resetCheckoutView();

    try {
      const live = await fetchFromSheets();
      if (live && live.length) {
        seedCatalogue(live);
        console.info("LUREÍ products loaded from Google Sheets.");
      }
    } catch (error) {
      console.info("LUREÍ kept fallback catalogue:", error.message);
    }
  })();

  document.addEventListener("DOMContentLoaded", () => {
    /* Footer year */
    const yearEl = $("[data-year]");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    /* Header search — redirect to collections with fluid auto-focus */
    const searchBtn = $('.icon-btn[aria-label="Search"]');
    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        if ($("#product-search")) {
          const searchInput = $("#product-search");
          searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => searchInput.focus(), 450);
        } else {
          window.location.href = "collections.html?focusSearch=true";
        }
      });
    }

    /* Auto-focus: collections.html?focusSearch=true -> smooth scroll + focus */
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("focusSearch") === "true") {
      const searchInput =
        document.getElementById("product-search") ||
        document.getElementById("search-input") ||
        document.querySelector(".collection-search__input") ||
        document.querySelector(".search-input");
      if (searchInput) {
        searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => searchInput.focus(), 400);
      }
    }

    /* Wishlist — restore heart states, badge, and drawer on load */
    syncWishlistHearts();
    updateWishlistBadge();
    renderWishlist();

    /* Hero image fallback (local model.jpg may not exist yet) */
    const heroImg = $("#hero-model");
    if (heroImg) {
      heroImg.addEventListener(
        "error",
        () => {
          if (!heroImg.dataset.fallbackApplied && heroImg.dataset.fallbackSrc) {
            heroImg.dataset.fallbackApplied = "1";
            heroImg.src = heroImg.dataset.fallbackSrc;
          }
        },
        { once: false }
      );
    }

    /* Mobile navigation */
    const toggle = $(".nav-toggle");
    const nav = $(".nav");
    if (toggle && nav) {
      toggle.addEventListener("click", () => {
        const open = nav.classList.toggle("nav--open");
        toggle.setAttribute("aria-expanded", String(open));
      });
    }

    /* Footer service modals (Contact / Stores) + in-page smooth anchors */
    bindServiceModals();
    bindSmoothAnchors();

    /* Newsletter form — Brevo v3 welcome email. Single validated listener,
       trimmed & sanitized payload, loading state, toast feedback. */
    const form = $("#newsletter-form");
    const newsletterNote = $("#newsletter-note");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();

        const nameInput = form.querySelector("#newsletter-name");
        const emailInput = form.querySelector("#newsletter-email");
        const nameValue = nameInput ? nameInput.value.trim() : "";
        const emailValue = emailInput ? emailInput.value.trim() : "";

        const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailValue);
        if (!emailValid) {
          showLureiToast("Please enter a valid email address.", "error");
          if (emailInput) emailInput.focus();
          return;
        }

        const submitBtn = form.querySelector("#newsletter-submit");
        const originalButtonHTML = submitBtn ? submitBtn.innerHTML : "";
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.setAttribute("aria-busy", "true");
          submitBtn.innerHTML = "SUBSCRIBING...";
        }

        const displayName = nameValue || "Valued Customer";
        const htmlContent =
          "<div style='font-family:Arial,sans-serif;padding:30px;max-width:600px;margin:0 auto;border:1px solid #eeeeee;'>" +
          "<h1 style='color:#d4af37;text-align:center;'>L U R E &Iacute;</h1>" +
          "<p style='text-align:center;color:#777;'>DUBAI &bull; FINE JEWELRY</p>" +
          "<hr style='border:0;border-top:1px solid #eee;margin:20px 0;'>" +
          "<p>Welcome to LURE&Iacute; Circle, <strong>" + displayName + "</strong>!</p>" +
          "<p>Thank you for subscribing to our exclusive styling updates.</p>" +
          "<p style='color:#999;margin-top:30px;'>Best regards,<br><strong>LURE&Iacute; Team</strong></p></div>";

        const payload = {
          sender: { name: "LUREÍ Dubai", email: "lureiaccessories.s925@gmail.com" },
          to: [{ email: emailValue, name: displayName }],
          subject: "Welcome to LUREÍ Circle!",
          htmlContent: htmlContent,
        };

        fetch(BREVO_CONFIG.endpoint, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "api-key": BREVO_CONFIG.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        })
          .then((response) => {
            if (!response.ok) {
              return response.json().catch(() => null).then((err) => {
                throw new Error((err && err.message) || "Brevo responded with status " + response.status);
              });
            }
            showLureiToast("Welcome to LUREÍ Circle! Check your inbox.");
            if (newsletterNote) newsletterNote.hidden = false;
            form.reset();
          })
          .catch((error) => {
            console.error("[Brevo] email send failed:", error && error.message ? error.message : error);
            showLureiToast("Something went wrong. Please try again.", "error");
          })
          .finally(() => {
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.removeAttribute("aria-busy");
              submitBtn.innerHTML = originalButtonHTML;
            }
          });
      });
    }

    /* ------------------------------------------------------------------ *
     * 10b. Account auth — Google One-Tap + Auth Modal + profile badge
     * ------------------------------------------------------------------ */
    const GOOGLE_CLIENT_ID = ""; // TODO: paste your Google Cloud OAuth Client ID here
    const AUTH_STORAGE_KEY = "lurei_user";

    const authModal = document.getElementById("auth-modal");
    const authClose = document.getElementById("auth-close");
    const authGuest = document.getElementById("auth-guest");
    const navProfileBtn = document.getElementById("nav-profile");
    const authTabs = Array.from(document.querySelectorAll(".auth-tab"));
    const signInForm = document.getElementById("auth-signin-form");
    const createForm = document.getElementById("auth-create-form");
    const signInEmail = document.getElementById("loginEmail") || document.getElementById("auth-signin-email");
    const signInPw = document.getElementById("loginPassword") || document.getElementById("passwordInput") || document.getElementById("auth-signin-password");
    const createName = document.getElementById("auth-create-name");
    const createEmail = document.getElementById("auth-create-email");
    const createPw = document.getElementById("auth-create-password");

    /* Force-clear login fields — global, used on load and back-arrow exit */
    window.clearLoginInputs = () => {
      const emailField = document.getElementById("loginEmail");
      const passwordField = document.getElementById("loginPassword");
      if (emailField) emailField.value = "";
      if (passwordField) passwordField.value = "";
    };

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", window.clearLoginInputs);
    } else {
      window.clearLoginInputs();
    }

    const readStoredUser = () => {
      try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null"); }
      catch { return null; }
    };
    let currentUser = readStoredUser();

    const firstNameOf = (n) => String(n || "Guest").trim().split(/\s+/)[0] || "Friend";
    const initialsOf = (n) => String(n || "?").trim().split(/\s+/).map((w) => w.charAt(0)).slice(0, 2).join("").toUpperCase();
    const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    /* JWT decode helper for Google credential tokens */
    const decodeJwt = (token) => {
      try {
        const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const json = decodeURIComponent(Array.prototype.map.call(atob(b64), (c) =>
          "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)
        ).join(""));
        return JSON.parse(json);
      } catch { return {}; }
    };

    /* Modal open / close */
    const openAuthModal = (panel = "signin") => {
      if (!authModal) return;
      authTabs.forEach((tab) => {
        const p = document.getElementById("auth-panel-" + tab.dataset.authPanel);
        const active = tab.dataset.authPanel === panel;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        if (p) { p.hidden = !active; p.classList.toggle("is-active", active); }
      });
      authModal.hidden = false;
      authModal.style.display = "";
      authModal.removeAttribute("aria-hidden");
      requestAnimationFrame(() => authModal.classList.add("is-open"));
      document.body.style.overflow = "hidden";
    };

    const closeAuthModal = () => {
      if (!authModal) return;
      resetAuthModal();
      authModal.classList.remove("is-open");
      authModal.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
      setTimeout(() => { authModal.hidden = true; }, 280);
    };

    /* Profile badge + dropdown */
    const patchProfile = () => {
      if (!navProfileBtn) return;
      const old = navProfileBtn.querySelector(".nav-profile__badge");
      if (old) old.remove();
      const oldMenu = navProfileBtn.querySelector(".nav-profile__menu");
      if (oldMenu) oldMenu.remove();

      if (currentUser) {
        const badge = document.createElement("span");
        badge.className = "nav-profile__badge";
        badge.textContent = initialsOf(currentUser.name);
        badge.title = "Hi, " + currentUser.name;
        badge.setAttribute("aria-hidden", "true");
        navProfileBtn.appendChild(badge);
        navProfileBtn.setAttribute("aria-label", "Hi, " + firstNameOf(currentUser.name) + " — account menu");
      } else {
        navProfileBtn.setAttribute("aria-label", "Your account");
      }
    };

    /* Successful auth handler (Google or email) */
    const handleAuthenticated = (user) => {
      currentUser = { name: user.name, email: user.email, photo: user.photo || "" };
      try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(currentUser)); } catch {}
      patchProfile();
      closeAuthModal();
      showLureiToast("Welcome to LUREÍ, " + firstNameOf(currentUser.name) + "!");
    };

    /* Sign-out */
    const handleSignOut = () => {
      currentUser = null;
      try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch {}
      patchProfile();
      const m = navProfileBtn ? navProfileBtn.querySelector(".nav-profile__menu") : null;
      if (m) m.remove();
      showLureiToast("You have been signed out.");
    };

    /* Email sign-in (mock — wire to real backend) */
    const signInWithEmail = (email) => {
      const label = (email.split("@")[0] || "Guest").replace(/[._-]+/g, " ");
      handleAuthenticated({ name: label.charAt(0).toUpperCase() + label.slice(1), email: email });
    };

    /* Create-account (mock) */
    const createAccount = (name, email) => {
      handleAuthenticated({ name: name || "Guest", email: email });
    };

    /* Tab switching */
    authTabs.forEach((tab) => {
      tab.addEventListener("click", () => openAuthModal(tab.dataset.authPanel));
    });

    /* Close handlers */
    if (authClose) authClose.addEventListener("click", () => { resetAuthModal(); closeAuthModal(); });
    if (authGuest) authGuest.addEventListener("click", () => { resetAuthModal(); closeAuthModal(); });
    /* Outside overlay click close is disabled. */
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAuthModal(); });

    /* Back arrow exit button (#modalBackBtn) — clears fields and closes the auth modal */
    const modalBackBtn = document.getElementById("modalBackBtn");
    if (modalBackBtn) modalBackBtn.addEventListener("click", () => {
      window.clearLoginInputs();
      if (authModal) authModal.style.display = "none";
      closeAuthModal();
    });

    /* Show/Hide password eye toggle (#togglePasswordBtn / #eyeSvg / #passwordInput) */
    const togglePasswordBtn = document.getElementById("togglePasswordBtn");
    const eyeSvg = document.getElementById("eyeSvg");
    if (togglePasswordBtn && eyeSvg) {
      togglePasswordBtn.addEventListener("click", () => {
        if (!signInPw) return;
        const show = signInPw.type === "password";
        signInPw.type = show ? "text" : "password";
        eyeSvg.style.color = show ? "#C5A059" : "#888275";
        togglePasswordBtn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      });
    }

    /* Reset auth form inputs whenever the modal exits or closes */
    const resetAuthModal = () => {
      if (signInEmail) signInEmail.value = "";
      if (signInPw) {
        signInPw.value = "";
        signInPw.type = "password";
      }
      if (signInForm) signInForm.reset();
      if (createForm) createForm.reset();
      if (togglePasswordBtn) togglePasswordBtn.setAttribute("aria-label", "Show password");
      if (eyeSvg) eyeSvg.style.color = "#888275";
    };

    /* Sign-in form */
    if (signInForm) {
      signInForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const email = signInEmail ? signInEmail.value.trim() : "";
        const pw = signInPw ? signInPw.value : "";
        if (!email) return showLureiToast("Please enter your email.");
        if (!pw) return showLureiToast("Please enter your password.");
        signInWithEmail(email);
      });
    }

    /* Create-account form */
    if (createForm) {
      createForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const name = createName ? createName.value.trim() : "";
        const email = createEmail ? createEmail.value.trim() : "";
        const pw = createPw ? createPw.value : "";
        if (!name) return showLureiToast("Please enter your full name.");
        if (!email) return showLureiToast("Please enter your email.");
        if (!pw || pw.length < 6) return showLureiToast("Password must be at least 6 characters.");
        createAccount(name, email);
      });
    }

    /* Profile icon click — open modal or toggle dropdown */
    if (navProfileBtn) {
      navProfileBtn.addEventListener("click", (e) => {
        /* Ignore clicks on the dropdown itself */
        if (e.target.closest && e.target.closest(".nav-profile__menu")) return;

        if (currentUser) {
          const existing = navProfileBtn.querySelector(".nav-profile__menu");
          if (existing) { existing.remove(); return; }

          const menu = document.createElement("div");
          menu.className = "nav-profile__menu";
          menu.innerHTML =
            '<p class="nav-profile__menu-name">' + escapeHtml(currentUser.name) + "</p>" +
            '<p class="nav-profile__menu-email">' + escapeHtml(currentUser.email) + "</p>" +
            '<button type="button" class="nav-profile__signout" id="nav-signout">Sign Out</button>';
          navProfileBtn.appendChild(menu);

          const so = menu.querySelector("#nav-signout");
          if (so) so.addEventListener("click", (ev) => { ev.stopPropagation(); handleSignOut(); });

          const closeDropdown = (ev) => {
            if (!navProfileBtn.contains(ev.target)) { menu.remove(); document.removeEventListener("click", closeDropdown); }
          };
          setTimeout(() => document.addEventListener("click", closeDropdown), 0);
        } else {
          openAuthModal("signin");
        }
      });
    }

    /* Google Identity Services — delayed init (SDK loads async) */
    const initGoogleAuth = () => {
      if (!GOOGLE_CLIENT_ID) return;
      let tries = 0;
      const attempt = () => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            auto_select: false,
            cancel_on_tap_outside: true,
            callback: (resp) => {
              if (!resp || !resp.credential) return;
              const p = decodeJwt(resp.credential);
              handleAuthenticated({
                name: p.name || p.given_name || "Guest",
                email: p.email || "",
                photo: p.picture || "",
              });
            },
          });

          const wrap = document.getElementById("g_id_signin_wrap");
          if (wrap) {
            window.google.accounts.id.renderButton(wrap, {
              type: "standard",
              theme: "filled_black",
              size: "large",
              shape: "pill",
              text: "continue_with",
              logo_alignment: "left",
              width: wrap.offsetWidth || 300,
            });
          }

          /* Auto-prompt One-Tap once per session if not logged in */
          if (!currentUser && !sessionStorage.getItem("lurei_onetap_seen")) {
            window.google.accounts.id.prompt((moment) => {
              sessionStorage.setItem("lurei_onetap_seen", "1");
              if (moment && (moment.isNotDisplayed() || moment.isSkippedMoment() || moment.isDismissedMoment())) {
                sessionStorage.setItem("lurei_onetap_seen", "1");
              }
            });
          }
        } else if (tries < 40) {
          tries++;
          setTimeout(attempt, 250);
        }
      };
      attempt();
    };

    /* Restore profile badge on load + init Google GIS */
    patchProfile();
    initGoogleAuth();

    /* ------------------------------------------------------------------ *
     * 10c. Login / Signup page — runs only on login.html (.login-page)
     * ------------------------------------------------------------------ */
    if (document.querySelector(".login-page")) {
      const loginTabs = Array.from(document.querySelectorAll(".login-tab"));
      const loginSigninForm = document.getElementById("login-signin-form");
      const loginCreateForm = document.getElementById("login-create-form");
      const loginSigninSubmit = document.getElementById("login-signin-submit");
      const loginCreateSubmit = document.getElementById("login-create-submit");
      const loginFootText = document.getElementById("login-foot-text");
      const loginForgot = document.getElementById("login-forgot");
      const rememberMe = document.getElementById("login-remember");
      const getValue = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : "";
      };

      /* Top-left back arrow exit button — leave login and return to the shop */
      const modalBackBtn = document.getElementById("modalBackBtn");
      if (modalBackBtn) {
        modalBackBtn.addEventListener("click", () => {
          window.location.href = "index.html";
        });
      }

      /* Outside-click close is disabled: login.html has no modal overlay, so
         the card is never dismissed by backdrop clicks. */

      /* Smooth toggle between Sign In / Create Account panels */
      const loginIndicator = document.querySelector(".login-toggle__indicator");
      loginTabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          loginTabs.forEach((t) => {
            const panel = document.getElementById("login-panel-" + t.dataset.loginPanel);
            const active = t === tab;
            t.classList.toggle("is-active", active);
            t.setAttribute("aria-selected", String(active));
            if (panel) {
              panel.hidden = !active;
              panel.classList.toggle("is-active", active);
            }
          });
          if (loginIndicator) {
            loginIndicator.style.transform = tab.dataset.loginPanel === "create" ? "translateX(100%)" : "translateX(0)";
          }
          const isCreate = tab.dataset.loginPanel === "create";
          if (loginSigninSubmit) loginSigninSubmit.textContent = isCreate ? "Join the Circle" : "Enter the Circle";
          if (loginCreateSubmit) loginCreateSubmit.textContent = isCreate ? "Join the Circle" : "Enter the Circle";
          if (loginFootText) {
            loginFootText.textContent = isCreate
              ? "By joining, you accept our privacy policy. Welcome to the Circle."
              : "Already a member? Sign in to unlock private previews.";
          }
        });
      });

      /* Password eye toggles — swap input type and eye/slash icon state */
      document.querySelectorAll(".login-eye").forEach((eye) => {
        eye.addEventListener("click", () => {
          const input = document.getElementById(eye.dataset.eyeFor);
          if (!input) return;
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
          eye.classList.toggle("is-visible", show);
          const eyeIcon = eye.querySelector(".login-eye__icon.is-eye");
          const slashIcon = eye.querySelector(".login-eye__icon.is-eye-slash");
          if (eyeIcon) eyeIcon.classList.toggle("is-active", !show);
          if (slashIcon) slashIcon.classList.toggle("is-active", show);
        });
      });

      /* Forced Show/Hide password toggle — inline eye icon (#togglePassword / #eyeIcon) */
      const togglePassword = document.getElementById("togglePassword");
      const eyeIconEl = document.getElementById("eyeIcon");
      if (togglePassword && eyeIconEl) {
        togglePassword.addEventListener("click", () => {
          const input = document.getElementById("password");
          if (!input) return;
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          eyeIconEl.style.color = show ? "#C5A059" : "#888275";
          togglePassword.setAttribute("aria-label", show ? "Hide password" : "Show password");
        });
      }

      /* Prefill remembered email */
      try {
        const savedEmail = localStorage.getItem("lurei_remember_email");
        if (savedEmail) {
          const emailInput = document.getElementById("login-email");
          if (emailInput) emailInput.value = savedEmail;
          if (rememberMe) rememberMe.checked = true;
        }
      } catch {}

      /* Sign In submit */
      if (loginSigninForm) {
        loginSigninForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const email = getValue("login-email");
          const password = getValue("password");
          if (!email) return showLureiToast("Please enter your email address.", "error");
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showLureiToast("Please enter a valid email address.", "error");
          if (!password) return showLureiToast("Please enter your password.", "error");

          try {
            if (rememberMe && rememberMe.checked) {
              localStorage.setItem("lurei_remember_email", email);
            } else {
              localStorage.removeItem("lurei_remember_email");
            }
            localStorage.setItem("lurei_user", JSON.stringify({ name: "Circle Member", email: email, photo: "" }));
          } catch {}

          showLureiToast("Welcome back to LUREÍ!");
          setTimeout(() => { window.location.href = "index.html"; }, 1200);
        });
      }

      /* Create Account submit */
      if (loginCreateForm) {
        loginCreateForm.addEventListener("submit", (event) => {
          event.preventDefault();
          const name = getValue("create-name");
          const email = getValue("create-email");
          const password = getValue("create-password");
          if (!name) return showLureiToast("Please enter your full name.", "error");
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showLureiToast("Please enter a valid email address.", "error");
          if (!password || password.length < 6) return showLureiToast("Password must be at least 6 characters.", "error");

          try {
            localStorage.setItem("lurei_user", JSON.stringify({ name: name, email: email, photo: "" }));
          } catch {}

          showLureiToast("Welcome to LUREÍ Circle!");
          setTimeout(() => { window.location.href = "index.html"; }, 1200);
        });
      }

      /* Forgot Password (mock reset link) */
      if (loginForgot) {
        loginForgot.addEventListener("click", (event) => {
          event.preventDefault();
          showLureiToast("Password reset link sent to your email.");
        });
      }
    }
  });

  /* ------------------------------------------------------------------ *
   * 11. Hero slideshow (2s crossfade loop)
   * ------------------------------------------------------------------ */
  const heroSlides = Array.from(document.querySelectorAll(".hero-slide"));
  if (heroSlides.length) {
    let heroSlideIndex = 0;
    heroSlides[0].classList.add("active");
    setInterval(() => {
      heroSlides[heroSlideIndex].classList.remove("active");
      heroSlideIndex = (heroSlideIndex + 1) % heroSlides.length;
      heroSlides[heroSlideIndex].classList.add("active");
    }, 2000);
  }

  /* ------------------------------------------------------------------ *
   * 12. FAQ accordion (expand / collapse)
   * ------------------------------------------------------------------ */
  Array.from(document.querySelectorAll(".lurei-faq-item")).forEach((item) => {
    const q = item.querySelector(".lurei-faq-item__q");
    const answer = item.querySelector(".lurei-faq-item__a");
    if (!q || !answer) return;

    q.addEventListener("click", () => {
      const isOpen = item.classList.toggle("is-open");
      q.setAttribute("aria-expanded", String(isOpen));
      answer.style.maxHeight = isOpen ? answer.scrollHeight + "px" : "0px";
    });
  });

  /* ------------------------------------------------------------------ *
   * 13. Perks scroll-pop animation (infinite loop while in view)
   * ------------------------------------------------------------------ */
  const perksSection = document.querySelector(".lurei-brand-perks-section");
  const perkCards = document.querySelectorAll(".perk-card");
  const hidePerkCards = () =>
    perkCards.forEach((card) => card.classList.remove("in-view"));

  let perkLoop = null;
  let perkTimers = [];

  const clearPerkTimers = () => {
    perkTimers.forEach((timer) => clearTimeout(timer));
    perkTimers = [];
  };

  const stopPerkLoop = () => {
    if (perkLoop) {
      clearInterval(perkLoop);
      perkLoop = null;
    }
    clearPerkTimers();
  };

  const runPerkLoop = () => {
    clearPerkTimers();
    hidePerkCards();

    const schedule = (index, delay) =>
      perkTimers.push(
        setTimeout(() => {
          if (perkCards[index]) perkCards[index].classList.add("in-view");
        }, delay)
      );

    schedule(0, 100);
    schedule(1, 1000);
    schedule(2, 1900);
    schedule(3, 2800);
    perkTimers.push(
      setTimeout(() => {
        hidePerkCards();
      }, 5500)
    );
  };

  if (perksSection && perkCards.length) {
    if ("IntersectionObserver" in window) {
      const perksObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              stopPerkLoop();
              runPerkLoop();
              perkLoop = setInterval(runPerkLoop, 6500);
            } else {
              stopPerkLoop();
              hidePerkCards();
            }
          });
        },
        { threshold: 0.2 }
      );
      perksObserver.observe(perksSection);
    } else {
      perkCards.forEach((card) => card.classList.add("in-view"));
    }
  }

  /* ------------------------------------------------------------------ *
   * 14. Newsletter stagger entrance (footer)
   * ------------------------------------------------------------------ */
  const newsletterCol = document.querySelector(".footer__col--newsletter");
  const newsletterEls = document.querySelectorAll(
    ".footer-newsletter-title, .footer-newsletter-sub, .footer-newsletter-input-wrap"
  );
  if (newsletterCol && newsletterEls.length) {
    if ("IntersectionObserver" in window) {
      const newsletterObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              newsletterEls.forEach((el) => el.classList.add("in-view"));
              newsletterObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 }
      );
      newsletterObserver.observe(newsletterCol);
    } else {
      newsletterEls.forEach((el) => el.classList.add("in-view"));
    }
  }

  /* ------------------------------------------------------------------ *
   * 14c. Gift Cards page — interactive card selection, live preview
   * ------------------------------------------------------------------ */
  const gcCards = Array.from(document.querySelectorAll(".gc-card"));
  const gcPreviewCard = document.querySelector("#gc-preview-card");
  const gcAmountEl = document.querySelector("#gc-amount");
  const gcRecipientEl = document.querySelector("#gc-recipient");
  const gcMessageEl = document.querySelector("#gc-message");
  const gcNameInput = document.querySelector("#gc-name");
  const gcNoteInput = document.querySelector("#gc-note");
  const gcCustomField = document.querySelector("#gc-custom-amount-field");
  const gcCustomInput = document.querySelector("#gc-custom-amount");
  const gcBtnAmount = document.querySelector("#gc-btn-amount");
  const gcForm = document.querySelector("#gc-form");
  const gcSuccess = document.querySelector("#gc-success");
  const gcDateWrap = document.querySelector("#gc-date-wrap");
  const gcDeliveryRadios = Array.from(
    document.querySelectorAll('input[name="gc-delivery"]')
  );

  if (gcCards.length && gcPreviewCard) {
    let gcAmount = 50;
    let gcCustom = false;

    const gcAmountDisplay = () =>
      gcCustom ? (toNumber(gcCustomInput.value) || 0) : gcAmount;

    const gcRefreshPreview = () => {
      const value = gcAmountDisplay();
      gcAmountEl.textContent = gcCustom && value === 0 ? "Custom Amount" : `AED ${value}`;
      if (gcRecipientEl) {
        gcRecipientEl.textContent =
          gcNameInput && gcNameInput.value.trim()
            ? gcNameInput.value.trim()
            : "Your Recipient";
      }
      if (gcMessageEl) {
        gcMessageEl.textContent =
          gcNoteInput && gcNoteInput.value.trim()
            ? gcNoteInput.value.trim()
            : "A spark of elegance, just for you.";
      }
      if (gcBtnAmount) {
        gcBtnAmount.textContent = String(value || 0);
      }
    };

    const gcSelectCard = (card) => {
      gcCards.forEach((c) => {
        const active = c === card;
        c.classList.toggle("is-selected", active);
        c.setAttribute("aria-checked", String(active));
      });

      const isCustom = card.dataset.gcAmount === "custom";
      gcCustom = isCustom;
      if (!isCustom) {
        gcAmount = toNumber(card.dataset.gcAmount) || gcAmount;
        if (gcCustomField) gcCustomField.hidden = true;
      } else {
        if (gcCustomField) {
          gcCustomField.hidden = false;
          gcCustomInput.focus();
        }
      }

      const modifier = Array.from(card.classList).find((cls) => /^gc-card--/.test(cls));
      const theme = modifier ? modifier.replace("gc-card--", "is-") : "";
      gcPreviewCard.classList.remove("is-silver", "is-sapphire", "is-rosegold", "is-onyx");
      if (theme && theme !== "is-champagne") gcPreviewCard.classList.add(theme);

      gcRefreshPreview();
    };

    gcCards.forEach((card) => {
      card.addEventListener("click", () => gcSelectCard(card));
    });

    if (gcCustomInput) {
      gcCustomInput.addEventListener("input", gcRefreshPreview);
    }

    if (gcNameInput) {
      gcNameInput.addEventListener("input", gcRefreshPreview);
    }

    if (gcNoteInput) {
      gcNoteInput.addEventListener("input", gcRefreshPreview);
    }

    if (gcDeliveryRadios.length && gcDateWrap) {
      gcDeliveryRadios.forEach((radio) => {
        radio.addEventListener("change", () => {
          gcDateWrap.hidden = radio.value !== "schedule";
        });
      });
    }

    if (gcForm) {
      gcForm.addEventListener("submit", (event) => {
        event.preventDefault();
        if (gcSuccess) {
          gcForm.hidden = true;
          gcSuccess.hidden = false;
          gcSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }

    gcRefreshPreview();
  }
})();
