CREATE TABLE tokentracker_cloud_waffo_attempts (
  order_id TEXT NOT NULL REFERENCES tokentracker_cloud_orders, environment TEXT NOT NULL,
  waffo_order_id TEXT NOT NULL, provider_price_id TEXT NOT NULL, billing_mode TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(environment,waffo_order_id), UNIQUE(order_id,environment,waffo_order_id)
) STRICT;
CREATE TABLE tokentracker_cloud_waffo_periods (
  order_id TEXT NOT NULL, environment TEXT NOT NULL, waffo_order_id TEXT NOT NULL,
  period_number INTEGER NOT NULL CHECK(period_number>0), starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  CHECK(julianday(ends_at)>julianday(starts_at)),
  PRIMARY KEY(order_id,waffo_order_id,period_number),
  FOREIGN KEY(order_id,environment,waffo_order_id) REFERENCES tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id)
) STRICT;
CREATE TABLE tokentracker_cloud_waffo_authorizations (
  environment TEXT NOT NULL, transaction_id TEXT NOT NULL, order_id TEXT NOT NULL,
  waffo_order_id TEXT NOT NULL, normalized_event TEXT NOT NULL CHECK(json_valid(normalized_event)),
  verified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(environment,transaction_id),
  FOREIGN KEY(order_id,environment,waffo_order_id) REFERENCES tokentracker_cloud_waffo_attempts(order_id,environment,waffo_order_id)
) STRICT;
CREATE TABLE tokentracker_cloud_events (
  provider TEXT NOT NULL, environment TEXT NOT NULL, event_id TEXT NOT NULL,
  kind TEXT NOT NULL, action_id TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES tokentracker_cloud_orders,
  occurred_at TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  normalized_event TEXT NOT NULL CHECK(json_valid(normalized_event)), status TEXT NOT NULL,
  PRIMARY KEY(provider,environment,event_id)
) STRICT;
CREATE UNIQUE INDEX tt_billing_applied_action ON tokentracker_cloud_events(provider,environment,kind,action_id)
  WHERE status='applied' AND kind IN ('payment','refund');

-- Contending Workers use this per-owner revision in the same D1 batch as their journal writes.
CREATE TABLE billing_ledger_revision(
  user_id TEXT NOT NULL, environment TEXT NOT NULL, revision INTEGER NOT NULL CONSTRAINT billing_revision_match CHECK(revision>0),
  PRIMARY KEY(user_id,environment)
) STRICT;
