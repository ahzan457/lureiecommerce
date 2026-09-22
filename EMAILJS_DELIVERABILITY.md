# Primary-Inbox Delivery — GoDaddy DNS + EmailJS Template Guide

Welcome emails (sent via `service_0kq9ear` / `template_hovo7r8`) land in
Spam when the sending domain has no email authentication published in DNS.
Gmail and Outlook place far more trust in sends that pass **SPF**, **DKIM**
and **DMARC**. This guide authenticates `lurei.com` end-to-end.

---

## Step 1 — Script.js (already done)

The newsletter dispatch layer in `script.js` is already compliant:

- SDK initialized once in each page `<head>` with the public key
  `kcYFaC9mvXkFLANF_`.
- Single `#newsletter-form` submit listener that calls `event.preventDefault()`.
- Name and Email are `.trim()`-ed before use; invalid emails are rejected.
- Exact payload:

  ```js
  const templateParams = {
    user_name: nameInputValue.trim() || "Valued Customer",
    user_email: emailInputValue.trim(),
    reply_to: "support@lurei.com"
  };
  ```

- Sent with `emailjs.send("service_0kq9ear", "template_hovo7r8", templateParams)`.
- Success → gold toast "Welcome to LUREÍ Circle! Check your inbox." + form reset.
- Error → clean `console.error` (no UI crash) + fallback toast.

No spam-triggering parameters (no `to_name`/`to_email` echoes, no marketing
headers) are sent.

---

## Step 2 — GoDaddy DNS authentication (~10 mins, apply once)

### 2.1 Open DNS management
Log in at GoDaddy → **My Products** → next to your domain → **Manage** →
**DNS** (also reachable via *Manage DNS* under the domain's settings).

### 2.2 Record 1 — SPF (Sender Policy Framework)
| Field  | Value                          |
|--------|--------------------------------|
| Type   | TXT                            |
| Name   | `@`                            |
| Value  | `v=spf1 include:emailjs.com ~all` |
| TTL    | 1 Hour                         |

> **IMPORTANT — single-record rule.** A domain may only publish **one**
> SPF record. If GoDaddy already shows an SPF record (e.g.
> `v=spf1 include:secureserver.net ~all`), delete it and use the merged
> value instead:
>
> `v=spf1 include:secureserver.net include:emailjs.com ~all`
>
> Two `v=spf1` records cause SPF to **fail** (→ guaranteed Spam).

### 2.3 Record 2 — DKIM (signed with your domain)
1. Open the **EmailJS Dashboard → Account → Domains → Add New Domain**.
2. Enter `lurei.com`; EmailJS generates one or more records (usually a
   CNAME like `emailjs._domainkey**.**lurei.com` and/or a DKIM TXT with a
   long `v=DKIM1; k=rsa; p=…` value).
3. Add **every** generated record into GoDaddy DNS **exactly as shown**
   (the key selector matters — never re-type or shorten the `p=` value).
4. Return to EmailJS and click **Verify** once the record is live.

### 2.4 Record 3 — DMARC policy
| Field  | Value                                          |
|--------|------------------------------------------------|
| Type   | TXT                                            |
| Name   | `_dmarc`                                       |
| Value  | `v=DMARC1; p=none; rua=mailto:dmarc-reports@lurei.com` |
| TTL    | 1 Hour                                         |

`p=none` is the safe monitoring policy — it only *reports* without
rejecting mail. Upgrade to `p=quarantine` later once SPF+DKIM pass
consistently.

### 2.5 Verify and wait
- After saving, check propagation:
  - Web: `https://dns.google` → "Look up `TXT @ lurei.com`", `TXT _dmarc.lurei.com`, and the DKIM selector.
  - Or run `nslookup -type=txt lurei.com` / `dig txt lurei.com`.
- Record changes can take **up to 48 hours** (usually 5–60 minutes).

### 2.6 Sender alignment (critical for DKIM)
DKIM only authenticates the *reply-domain* if the EmailJS **sender email**
uses your verified domain. In EmailJS → Email Services → `service_0kq9ear`
settings, set the **Sender (From) email** to an address on a domain you
verified (e.g. `newsletter@lurei.com`). Sending from `@emailjs.dev`
notification addresses will not produce DKIM alignment and spam filters
stay suspicious.

### 2.7 First-email guidance (Gmail Primary-Inbox priming)
Gmail bases *Primary tab* placement partly on recipient behavior. In the
welcome template, tell subscribers to open the email once — that single
"opened, not spam" signal trains Gmail to deliver future LUREÍ mail to
Primary. (See the template copy in Step 3.)

---

## Step 3 — EmailJS template sanitization

Rules for the template at `template_hovo7r8`:

1. **No tracking parameters** (`?utm_*`, `email=`, `ref=`) on any link.
2. **No URL shorteners** (bit.ly, tinyurl …) — always full `https://lurei.com/…`.
3. **Inline CSS only** — no `<style>` block, no external fonts, no remote
   images (a white-HSV Gmail placeholder never resolves).
4. **HTML + Plain text both filled** — Gmail auto-uses the higher-spam
   threshold when a template lacks a text alternative.
5. **Reply-To** is driven by the `reply_to` template param
   (`support@lurei.com`); leave the template's Reply-To field set to
   `{{reply_to}}`.

### Paste-ready HTML (gold/black brand accents, #d4af37)

```html
<div style="background:#faf7f0; padding:40px 16px; font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:560px; background:#ffffff; border:1px solid #e6dfd0; border-radius:12px; overflow:hidden;">
        <tr>
          <td style="background:#0b0b0b; padding:26px 32px; text-align:center;">
            <span style="font-family:Georgia,serif; font-size:26px; letter-spacing:4px; color:#d4af37; font-weight:bold;">LUREÍ</span>
            <span style="display:block; margin-top:4px; font-family:Arial,sans-serif; font-size:11px; letter-spacing:3px; color:#e9dfc8; text-transform:uppercase;">Dubai &middot; Fine Jewellery</span>
          </td>
        </tr>
        <tr>
          <td style="padding:34px 32px;">
            <h1 style="margin:0 0 14px; font-family:Georgia,serif; font-size:22px; color:#111111; font-weight:normal;">Welcome to LUREÍ Circle, {{user_name}}!</h1>
            <p style="margin:0 0 16px; font-size:15px; line-height:1.7; color:#444444;">You are officially on the list. Enjoy early access to new collections, private previews and members-only offers across the UAE.</p>
            <p style="margin:0 0 22px; font-size:15px; line-height:1.7; color:#444444;"><span style="color:#b8860b; font-weight:bold;">Tip:</span> open this email once &mdash; doing so tells Gmail to keep future LUREÍ mail in your Primary Inbox.</p>
            <a href="https://lurei.com/collections.html" style="display:inline-block; background:#d4af37; color:#0b0b0b; padding:13px 30px; border-radius:999px; font-size:13px; font-weight:bold; letter-spacing:1.5px; text-decoration:none; text-transform:uppercase;">Explore the Collection</a>
          </td>
        </tr>
        <tr>
          <td style="background:#faf7f0; padding:18px 32px; text-align:center; font-size:11px; color:#999286;">
            You are receiving this because you subscribed on lurei.com &middot; Luscious Jewellery LLC &middot; Dubai, UAE<br>
            <a href="#" style="color:#b8860b; text-decoration:none;">Unsubscribe</a>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</div>
```

### Plain-text tab (same content)

```
Welcome to LUREÍ Circle, {{user_name}}!

You are officially on the list. Enjoy early access to new collections,
private previews and members-only offers across the UAE.

Tip: open this email once — doing so tells Gmail to keep future LUREÍ
mail in your Primary Inbox.

Explore the collection: https://lurei.com/collections.html

Luscious Jewellery LLC · Dubai, UAE
```

---

## Delivery checklist
- [ ] SPF TXT record live at `@` (single record, includes `emailjs.com`)
- [ ] DKIM records from EmailJS Dashboard added + **verified** on-site
- [ ] DMARC `_dmarc` TXT live
- [ ] EmailJS service sender set to `newsletter@lurei.com`
- [ ] Template HTML + plain text updated, test send opened (Primary Inbox)
- [ ] `reply_to` bound to `{{reply_to}}` so `support@lurei.com` applies