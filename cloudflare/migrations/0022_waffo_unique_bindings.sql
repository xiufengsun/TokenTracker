CREATE UNIQUE INDEX tt_waffo_checkout_binding ON tokentracker_cloud_orders(environment,provider_checkout_id) WHERE provider='waffo';
CREATE UNIQUE INDEX tt_waffo_order_binding ON tokentracker_cloud_orders(environment,waffo_order_id) WHERE provider='waffo';
CREATE UNIQUE INDEX tt_waffo_period_binding ON tokentracker_cloud_waffo_periods(environment,waffo_order_id,period_number);
