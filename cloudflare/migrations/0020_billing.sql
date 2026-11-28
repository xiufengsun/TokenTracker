CREATE TABLE tokentracker_cloud_policy (
  environment TEXT PRIMARY KEY CHECK(environment IN ('live','sandbox')),
  phase TEXT NOT NULL CHECK(phase IN ('active','preview')),
  launch_at TEXT,
  hosting_mode TEXT NOT NULL CHECK(hosting_mode='hosted'),
  CHECK(phase='preview' OR launch_at IS NOT NULL)
) STRICT;

CREATE TABLE tokentracker_cloud_catalog (
  sku TEXT PRIMARY KEY, currency TEXT NOT NULL CHECK(currency IN ('USD','CNY')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  term_months INTEGER NOT NULL CHECK(term_months IN (1,12)),
  billing_mode TEXT NOT NULL CHECK(billing_mode IN ('fixed','recurring')),
  active INTEGER NOT NULL CHECK(active IN (0,1))
) STRICT;

CREATE TABLE tokentracker_cloud_accounts (
  user_id TEXT NOT NULL, environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy,
  trial_started_at TEXT, trial_ends_at TEXT,
  PRIMARY KEY(user_id,environment),
  CHECK((trial_started_at IS NULL AND trial_ends_at IS NULL)
    OR (trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL AND julianday(trial_ends_at)>julianday(trial_started_at)))
) STRICT;

CREATE TABLE tokentracker_cloud_orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy,
  request_id TEXT NOT NULL, provider TEXT NOT NULL, sku TEXT NOT NULL REFERENCES tokentracker_cloud_catalog,
  currency TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), term_months INTEGER NOT NULL CHECK(term_months IN (1,12)),
  status TEXT NOT NULL CHECK(status IN ('pending','ready','paid','closed')), provider_order_id TEXT, provider_price_id TEXT,
  checkout_url TEXT, checkout_attempts INTEGER NOT NULL DEFAULT 0, checkout_claimed_at TEXT, last_reconciled_at TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, provider_checkout_id TEXT, waffo_order_id TEXT,
  billing_mode TEXT NOT NULL CHECK(billing_mode IN ('fixed','recurring')), retry_order_id TEXT,
  retry_payment_conflict_at TEXT, provider_checkout_expires_at TEXT, cancel_requested_at TEXT,
  checkout_started INTEGER NOT NULL DEFAULT 0, checkout_tracking_uncertain INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id,environment,request_id), UNIQUE(provider,environment,provider_order_id)
) STRICT;
CREATE INDEX tt_billing_orders_owned ON tokentracker_cloud_orders(user_id,environment,created_at DESC);

CREATE TABLE tokentracker_cloud_payments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES tokentracker_cloud_orders,
  user_id TEXT NOT NULL, provider TEXT NOT NULL, environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy,
  transaction_id TEXT NOT NULL, subscription_id TEXT, currency TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK(refunded_cents BETWEEN 0 AND amount_cents),
  revoked_at TEXT, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, paid_at TEXT NOT NULL, waffo_order_id TEXT,
  CHECK(julianday(ends_at)>julianday(starts_at)), UNIQUE(environment,provider,transaction_id)
) STRICT;
CREATE INDEX tt_billing_payments_owned ON tokentracker_cloud_payments(user_id,environment,ends_at);

CREATE TABLE tokentracker_cloud_subscriptions (
  provider TEXT NOT NULL, environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy,
  provider_subscription_id TEXT NOT NULL, user_id TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES tokentracker_cloud_orders,
  status TEXT NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
  last_event_at TEXT NOT NULL, next_billed_at TEXT,
  PRIMARY KEY(provider,environment,provider_subscription_id)
) STRICT;
CREATE INDEX tt_billing_subscriptions_owned ON tokentracker_cloud_subscriptions(user_id,environment);

CREATE TABLE tokentracker_cloud_gift_batches (
  id TEXT PRIMARY KEY, environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy,
  duration_days INTEGER NOT NULL CHECK(duration_days>0), redeem_before TEXT NOT NULL,
  label TEXT NOT NULL, created_at TEXT NOT NULL, disabled_at TEXT
) STRICT;
CREATE TABLE tokentracker_cloud_gift_codes (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES tokentracker_cloud_gift_batches,
  environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy,
  code_hash TEXT NOT NULL, suffix TEXT NOT NULL, UNIQUE(environment,code_hash)
) STRICT;
CREATE TABLE tokentracker_cloud_gift_grants (
  id TEXT PRIMARY KEY, code_id TEXT NOT NULL UNIQUE REFERENCES tokentracker_cloud_gift_codes, user_id TEXT NOT NULL,
  environment TEXT NOT NULL REFERENCES tokentracker_cloud_policy, request_id TEXT NOT NULL, duration_days INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, revoked_at TEXT,
  UNIQUE(user_id,environment,request_id)
) STRICT;
CREATE INDEX tt_billing_gifts_owned ON tokentracker_cloud_gift_grants(user_id,environment,ends_at);
CREATE TABLE tokentracker_cloud_checkout_operations (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES tokentracker_cloud_orders,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1))
) STRICT;
CREATE INDEX tt_checkout_operations_order ON tokentracker_cloud_checkout_operations(order_id);
CREATE UNIQUE INDEX tt_retry_successor ON tokentracker_cloud_orders(retry_order_id);
CREATE TABLE tokentracker_cloud_gift_attempts (
  user_id TEXT NOT NULL,environment TEXT NOT NULL,window_started_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL CHECK(failed_attempts BETWEEN 0 AND 10),PRIMARY KEY(user_id,environment)
) STRICT;
