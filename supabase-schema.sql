-- =====================================================================
-- LUREÍ Dubai — order database for the admin dashboard
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New).
-- =====================================================================
--
-- WHY THIS FILE MATTERS
-- The admin dashboard will read this table from the browser using the
-- public "anon" key. That key is visible to anyone who views source, so
-- it is NOT a secret and cannot be treated as one. Security comes
-- entirely from Row Level Security below:
--
--   * Anyone may INSERT one new order (that is the storefront checkout).
--   * Only signed-in administrators may SELECT orders  -> customer names,
--     phone numbers, emails and addresses are private.
--   * Only signed-in administrators may UPDATE the delivery status.
--   * Only signed-in administrators may DELETE an order (the dashboard's
--     "Add to Monthly Report" and "Delete Order" row actions).
--
-- The DELETE is not always the end of the story: "Add to Monthly Report"
-- writes the order into completed_orders first, so the Monthly Report - and
-- every revenue, order-count and chart figure on the dashboard - keeps the
-- customer, items, price and delivery date after the live row is cleaned out.
-- "Delete Order" writes nothing: a test order removed that way leaves no trace
-- in the log or in any figure.
--
-- Do not disable RLS. With RLS off, the anon key could read every
-- customer's personal details out of the table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id           uuid        primary key default gen_random_uuid(),

  -- Human reference shown in the dashboard, e.g. LUREI-789811.
  order_id     text        not null unique,

  customer_name text       not null,
  phone         text,
  email         text,
  address       text,
  payment       text,

  -- 'card' or 'cod', stored raw so the dashboard can render a PAID/COD
  -- badge without re-deriving it from the human-readable label.
  payment_method text       check (payment_method in ('card', 'cod')),

  -- ISO yyyy-mm-dd chosen by the shopper, or the standard 2-3 business-day
  -- quote filled in by script.js when they left the field blank.
  requested_delivery_date date,

  -- Kept as jsonb so each line keeps its own title / quantity / price
  -- instead of being flattened into one string.
  items         jsonb       not null default '[]'::jsonb,

  -- Always numeric. The storefront stores the base AED value and also
  -- records which currency the shopper was viewing, so the dashboard
  -- never has to guess.
  total_aed     numeric(12,2) not null default 0,
  currency_at_order text    not null default 'AED',

  -- Only ever 'pending' or 'delivered'. Lowercase by convention; the
  -- dashboard compares case-insensitively either way.
  status        text        not null default 'pending'
                            check (status in ('pending', 'delivered')),

  -- Machine timestamp. The monthly-sales chart groups on this column,
  -- so it must stay an ISO-8601 value rather than a formatted string.
  created_at    timestamptz not null default now(),

  updated_at    timestamptz
);

-- The dashboard sorts newest first and filters on status.
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx     on public.orders (status);

-- ---------------------------------------------------------------------
-- 1b. Migration for databases created before the delivery-date columns
-- ---------------------------------------------------------------------
-- Safe to run repeatedly: each statement is a no-op once the column exists.
-- Run this if you already executed the original version of this file.
alter table public.orders add column if not exists payment_method text
  check (payment_method in ('card', 'cod'));
alter table public.orders add column if not exists requested_delivery_date date;

-- ---------------------------------------------------------------------
-- 1c. Completed orders log (the dashboard's Monthly Report)
-- ---------------------------------------------------------------------
-- "Add to Monthly Report" does not erase a sale, it files it. The order's
-- details are copied here on the way out of public.orders, and this table is
-- the single source of revenue for the Monthly Report, the Overview tiles and
-- every analytics chart.
--
-- order_id is unique so filing the same order twice updates the existing log
-- entry instead of creating a second one - the button can be pressed twice and
-- the log must still balance against the dashboard.
create table if not exists public.completed_orders (
  id           uuid        primary key default gen_random_uuid(),

  -- Same reference the live orders table used.
  order_id     text        not null unique,

  customer_name text       not null,
  phone         text,
  email         text,
  address       text,
  payment       text,
  payment_method text       check (payment_method in ('card', 'cod')),
  requested_delivery_date date,
  items         jsonb       not null default '[]'::jsonb,
  total_aed     numeric(12,2) not null default 0,
  currency_at_order text    not null default 'AED',

  -- Kept for continuity with the live table; a completed order is always
  -- 'delivered', so this column exists purely so the log can be exported or
  -- moved back into orders without losing the original status handling.
  status        text        not null default 'delivered'
                            check (status in ('pending', 'delivered')),

  -- When the shopper placed the order. Displayed as a sub-line in the log,
  -- because the month a sale was completed in can differ from the month it
  -- was placed in.
  order_date    timestamptz not null default now(),

  -- When the admin completed it. This is the column the Monthly Report groups
  -- its month buckets on, in Gulf Standard Time.
  completed_at  timestamptz not null default now(),

  updated_at    timestamptz
);

-- The log is read newest-first and filtered by completion month.
create index if not exists completed_orders_completed_at_idx on public.completed_orders (completed_at desc);

-- ---------------------------------------------------------------------
-- 2. Row Level Security
-- ---------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.completed_orders enable row level security;

-- Drop and recreate so this file is safe to run more than once.
drop policy if exists "checkout can create orders"   on public.orders;
drop policy if exists "admins can read orders"       on public.orders;
drop policy if exists "admins can update orders"     on public.orders;
drop policy if exists "admins can delete orders"     on public.orders;
drop policy if exists "admins can read completed orders"   on public.completed_orders;
drop policy if exists "admins can create completed orders" on public.completed_orders;
drop policy if exists "admins can update completed orders" on public.completed_orders;
drop policy if exists "admins can delete completed orders" on public.completed_orders;

-- ---------------------------------------------------------------------
-- 3. Policies
-- ---------------------------------------------------------------------

-- Storefront checkout: may place an order, but may NOT pre-set the
-- delivery status to "delivered" and may not backdate the order.
create policy "checkout can create orders"
  on public.orders
  for insert
  to anon, authenticated
  with check (
    status = 'pending'
    and created_at >= now() - interval '5 minutes'
  );

-- Reading orders exposes customer PII, so this is admin-only.
create policy "admins can read orders"
  on public.orders
  for select
  to authenticated
  using (true);

-- Admins may edit two things from the dashboard: the delivery status and
-- the target delivery date. Postgres RLS filters ROWS, not columns, so
-- this policy cannot itself restrict which columns change; the dashboard
-- only ever sends those two in its PATCH body. To hard-limit the columns,
-- revoke UPDATE on the table and grant it per column instead:
--
--   revoke update on public.orders from authenticated;
--   grant update (status, requested_delivery_date) on public.orders to authenticated;
--
-- which would also require dropping this policy, since a policy alone
-- cannot deny a column that has been granted.
create policy "admins can update orders"
  on public.orders
  for update
  to authenticated
  using (true)
  with check (true);

-- Completed orders: admin-only on every verb.
--
-- There is deliberately NO insert policy for anon here, unlike public.orders.
-- That table is the storefront checkout and has to be writable by shoppers;
-- the completed log is not - only an authenticated admin archives a sale, so
-- nobody else can fabricate revenue history in the Monthly Report.
create policy "admins can read completed orders"
  on public.completed_orders
  for select
  to authenticated
  using (true);

create policy "admins can create completed orders"
  on public.completed_orders
  for insert
  to authenticated
  with check (true);

-- Required, not optional: the dashboard files with an upsert
-- (POST ...?on_conflict=order_id with Prefer: resolution=merge-duplicates),
-- which PostgREST turns into INSERT ... ON CONFLICT DO UPDATE. That branch
-- needs UPDATE privilege *and* an UPDATE policy - without this policy the
-- second filing of the same order (the button pressed again, or the same
-- order filed from another device) is rejected by RLS and the server log keeps
-- the older row instead. It still cannot touch orders: UPDATE here only ever
-- rewrites a log entry that a signed-in admin already filed.
create policy "admins can update completed orders"
  on public.completed_orders
  for update
  to authenticated
  using (true)
  with check (true);

-- Lets the dashboard undo a filing when the live row could not actually be
-- removed, so the log and the dashboard cannot disagree about one sale.
create policy "admins can delete completed orders"
  on public.completed_orders
  for delete
  to authenticated
  using (true);

-- Permanent removal, admin-only. The dashboard deletes a live order outright
-- when the admin presses "Delete Order" (nothing is written to
-- completed_orders first, so the sale leaves no trace) and as the second half
-- of "Add to Monthly Report" (after the details have been filed).
--
-- `to authenticated` is the whole security story here: DELETE needs an admin's
-- signed-in JWT, so the anon key that ships with the storefront still cannot
-- touch a single row. Revenue, order counts and every chart on the dashboard
-- are recomputed from the log on each render, so a filed sale simply moves
-- from the board to the Monthly Report instead of disappearing.
--
-- Drop this one policy to keep orders on the live dashboard forever:
--   drop policy if exists "admins can delete orders" on public.orders;
create policy "admins can delete orders"
  on public.orders
  for delete
  to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- 4. Keep updated_at honest
-- ---------------------------------------------------------------------
create or replace function public.touch_orders_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at
  before update on public.orders
  for each row execute function public.touch_orders_updated_at();

drop trigger if exists completed_orders_touch_updated_at on public.completed_orders;
create trigger completed_orders_touch_updated_at
  before update on public.completed_orders
  for each row execute function public.touch_orders_updated_at();

-- =====================================================================
-- 5. Create the administrator account
-- =====================================================================
-- Supabase Auth does not let raw SQL create a usable login, so do this
-- in the Dashboard UI instead:
--
--   Authentication > Users > "Add user" > "Create new user"
--     Email    : your admin email
--     Password : a strong password
--     ☑ Auto Confirm User
--
-- Only accounts created here can read the orders table.
-- The old hardcoded password inside admin-login.html is no longer used
-- and can be deleted.
-- =====================================================================
