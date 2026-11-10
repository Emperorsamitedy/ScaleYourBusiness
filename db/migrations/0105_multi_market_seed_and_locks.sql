-- The multi-market spec Parts A and B: seeds and locks (migration 0104 made the tables).
--
-- 1. currencies: seeded from specs/currencies-v1.json (lib/core/currency-table.test.ts
--    holds the two equal). HUF rounds and displays in whole forints.
-- 2. price_book: the EUR base rows (the v1 spec §8.3, §7.5) enabled; Hungary's
--    HUF rows (§B.2, PPP 0.52, rounded to 500 Ft) seeded DISABLED — they go
--    live only once the per-tier quotas are confirmed (§B.4). The three
--    partner rows apply the same factor and need the owner's confirmation.
-- 3. usage_quotas: the owner-approved placeholders (2026-11-10), unconfirmed;
--    soft cap at 80 % of the hard cap.
-- 4. Locks, by trigger: a stored FX rate never changes (§A.3); a
--    subscription's price never changes after signup (§B.3); the price
--    book's changelog is append-only; a price_book row's amount, currency,
--    tier and country never change — a new price is a new row.

INSERT INTO currencies (code, minor_units, rounding_increment_minor, price_rounding_increment_minor, symbol, symbol_position, thousands_sep, decimal_sep, processor_amount_divisor_minor, processor_notes) VALUES
  ('AED', 2, 1, 1, 'AED', 'before', ',', '.', 1, NULL),
  ('AFN', 2, 1, 1, 'AFN', 'before', ',', '.', 1, NULL),
  ('ALL', 2, 1, 1, 'ALL', 'before', ',', '.', 1, NULL),
  ('AMD', 2, 1, 1, 'AMD', 'before', ',', '.', 1, NULL),
  ('ANG', 2, 1, 1, 'ANG', 'before', ',', '.', 1, NULL),
  ('AOA', 2, 1, 1, 'AOA', 'before', ',', '.', 1, NULL),
  ('ARS', 2, 1, 1, 'ARS', 'before', ',', '.', 1, NULL),
  ('AUD', 2, 1, 1, 'AUD', 'before', ',', '.', 1, NULL),
  ('AWG', 2, 1, 1, 'AWG', 'before', ',', '.', 1, NULL),
  ('AZN', 2, 1, 1, 'AZN', 'before', ',', '.', 1, NULL),
  ('BAM', 2, 1, 1, 'BAM', 'before', ',', '.', 1, NULL),
  ('BBD', 2, 1, 1, 'BBD', 'before', ',', '.', 1, NULL),
  ('BDT', 2, 1, 1, 'BDT', 'before', ',', '.', 1, NULL),
  ('BGN', 2, 1, 1, 'лв.', 'after', ' ', ',', 1, NULL),
  ('BHD', 3, 1, 1, 'BHD', 'before', ',', '.', 1, NULL),
  ('BIF', 0, 1, 1, 'BIF', 'before', ',', '.', 1, NULL),
  ('BMD', 2, 1, 1, 'BMD', 'before', ',', '.', 1, NULL),
  ('BND', 2, 1, 1, 'BND', 'before', ',', '.', 1, NULL),
  ('BOB', 2, 1, 1, 'BOB', 'before', ',', '.', 1, NULL),
  ('BRL', 2, 1, 1, 'BRL', 'before', ',', '.', 1, NULL),
  ('BSD', 2, 1, 1, 'BSD', 'before', ',', '.', 1, NULL),
  ('BTN', 2, 1, 1, 'BTN', 'before', ',', '.', 1, NULL),
  ('BWP', 2, 1, 1, 'BWP', 'before', ',', '.', 1, NULL),
  ('BYN', 2, 1, 1, 'BYN', 'before', ',', '.', 1, NULL),
  ('BZD', 2, 1, 1, 'BZD', 'before', ',', '.', 1, NULL),
  ('CAD', 2, 1, 1, 'CAD', 'before', ',', '.', 1, NULL),
  ('CDF', 2, 1, 1, 'CDF', 'before', ',', '.', 1, NULL),
  ('CHF', 2, 1, 1, 'CHF', 'before', '’', '.', 1, NULL),
  ('CLP', 0, 1, 1, 'CLP', 'before', ',', '.', 1, NULL),
  ('CNY', 2, 1, 1, '¥', 'before', ',', '.', 1, NULL),
  ('COP', 2, 1, 1, 'COP', 'before', ',', '.', 1, NULL),
  ('CRC', 2, 1, 1, 'CRC', 'before', ',', '.', 1, NULL),
  ('CUP', 2, 1, 1, 'CUP', 'before', ',', '.', 1, NULL),
  ('CVE', 2, 1, 1, 'CVE', 'before', ',', '.', 1, NULL),
  ('CZK', 2, 1, 1, 'Kč', 'after', ' ', ',', 1, NULL),
  ('DJF', 0, 1, 1, 'DJF', 'before', ',', '.', 1, NULL),
  ('DKK', 2, 1, 1, 'kr.', 'after', '.', ',', 1, NULL),
  ('DOP', 2, 1, 1, 'DOP', 'before', ',', '.', 1, NULL),
  ('DZD', 2, 1, 1, 'DZD', 'before', ',', '.', 1, NULL),
  ('EGP', 2, 1, 1, 'EGP', 'before', ',', '.', 1, NULL),
  ('ERN', 2, 1, 1, 'ERN', 'before', ',', '.', 1, NULL),
  ('ETB', 2, 1, 1, 'ETB', 'before', ',', '.', 1, NULL),
  ('EUR', 2, 1, 100, '€', 'before', ',', '.', 1, NULL),
  ('FJD', 2, 1, 1, 'FJD', 'before', ',', '.', 1, NULL),
  ('FKP', 2, 1, 1, 'FKP', 'before', ',', '.', 1, NULL),
  ('GBP', 2, 1, 1, '£', 'before', ',', '.', 1, NULL),
  ('GEL', 2, 1, 1, 'GEL', 'before', ',', '.', 1, NULL),
  ('GHS', 2, 1, 1, 'GHS', 'before', ',', '.', 1, NULL),
  ('GIP', 2, 1, 1, 'GIP', 'before', ',', '.', 1, NULL),
  ('GMD', 2, 1, 1, 'GMD', 'before', ',', '.', 1, NULL),
  ('GNF', 0, 1, 1, 'GNF', 'before', ',', '.', 1, NULL),
  ('GTQ', 2, 1, 1, 'GTQ', 'before', ',', '.', 1, NULL),
  ('GYD', 2, 1, 1, 'GYD', 'before', ',', '.', 1, NULL),
  ('HKD', 2, 1, 1, 'HKD', 'before', ',', '.', 1, NULL),
  ('HNL', 2, 1, 1, 'HNL', 'before', ',', '.', 1, NULL),
  ('HTG', 2, 1, 1, 'HTG', 'before', ',', '.', 1, NULL),
  ('HUF', 2, 100, 50000, 'Ft', 'after', ' ', ',', 100, 'ISO 4217 gives HUF two minor digits, but the fillér was withdrawn in 1999: amounts round and display in whole forints. Stripe requires HUF amounts divisible by 100 (whole forints) in several operations, asserted at the billing boundary. Prices round to the nearest 500 HUF.'),
  ('IDR', 2, 1, 1, 'IDR', 'before', ',', '.', 1, NULL),
  ('ILS', 2, 1, 1, 'ILS', 'before', ',', '.', 1, NULL),
  ('INR', 2, 1, 1, 'INR', 'before', ',', '.', 1, NULL),
  ('IQD', 3, 1, 1, 'IQD', 'before', ',', '.', 1, NULL),
  ('IRR', 2, 1, 1, 'IRR', 'before', ',', '.', 1, NULL),
  ('ISK', 0, 1, 1, 'kr', 'after', '.', ',', 1, NULL),
  ('JMD', 2, 1, 1, 'JMD', 'before', ',', '.', 1, NULL),
  ('JOD', 3, 1, 1, 'JOD', 'before', ',', '.', 1, NULL),
  ('JPY', 0, 1, 1, '¥', 'before', ',', '.', 1, NULL),
  ('KES', 2, 1, 1, 'KES', 'before', ',', '.', 1, NULL),
  ('KGS', 2, 1, 1, 'KGS', 'before', ',', '.', 1, NULL),
  ('KHR', 2, 1, 1, 'KHR', 'before', ',', '.', 1, NULL),
  ('KMF', 0, 1, 1, 'KMF', 'before', ',', '.', 1, NULL),
  ('KPW', 2, 1, 1, 'KPW', 'before', ',', '.', 1, NULL),
  ('KRW', 0, 1, 1, 'KRW', 'before', ',', '.', 1, NULL),
  ('KWD', 3, 1, 1, 'KWD', 'before', ',', '.', 1, NULL),
  ('KYD', 2, 1, 1, 'KYD', 'before', ',', '.', 1, NULL),
  ('KZT', 2, 1, 1, 'KZT', 'before', ',', '.', 1, NULL),
  ('LAK', 2, 1, 1, 'LAK', 'before', ',', '.', 1, NULL),
  ('LBP', 2, 1, 1, 'LBP', 'before', ',', '.', 1, NULL),
  ('LKR', 2, 1, 1, 'LKR', 'before', ',', '.', 1, NULL),
  ('LRD', 2, 1, 1, 'LRD', 'before', ',', '.', 1, NULL),
  ('LSL', 2, 1, 1, 'LSL', 'before', ',', '.', 1, NULL),
  ('LYD', 3, 1, 1, 'LYD', 'before', ',', '.', 1, NULL),
  ('MAD', 2, 1, 1, 'MAD', 'before', ',', '.', 1, NULL),
  ('MDL', 2, 1, 1, 'MDL', 'before', ',', '.', 1, NULL),
  ('MGA', 2, 1, 1, 'MGA', 'before', ',', '.', 1, NULL),
  ('MKD', 2, 1, 1, 'MKD', 'before', ',', '.', 1, NULL),
  ('MMK', 2, 1, 1, 'MMK', 'before', ',', '.', 1, NULL),
  ('MNT', 2, 1, 1, 'MNT', 'before', ',', '.', 1, NULL),
  ('MOP', 2, 1, 1, 'MOP', 'before', ',', '.', 1, NULL),
  ('MRU', 2, 1, 1, 'MRU', 'before', ',', '.', 1, NULL),
  ('MUR', 2, 1, 1, 'MUR', 'before', ',', '.', 1, NULL),
  ('MVR', 2, 1, 1, 'MVR', 'before', ',', '.', 1, NULL),
  ('MWK', 2, 1, 1, 'MWK', 'before', ',', '.', 1, NULL),
  ('MXN', 2, 1, 1, 'MXN', 'before', ',', '.', 1, NULL),
  ('MYR', 2, 1, 1, 'MYR', 'before', ',', '.', 1, NULL),
  ('MZN', 2, 1, 1, 'MZN', 'before', ',', '.', 1, NULL),
  ('NAD', 2, 1, 1, 'NAD', 'before', ',', '.', 1, NULL),
  ('NGN', 2, 1, 1, 'NGN', 'before', ',', '.', 1, NULL),
  ('NIO', 2, 1, 1, 'NIO', 'before', ',', '.', 1, NULL),
  ('NOK', 2, 1, 1, 'kr', 'after', ' ', ',', 1, NULL),
  ('NPR', 2, 1, 1, 'NPR', 'before', ',', '.', 1, NULL),
  ('NZD', 2, 1, 1, 'NZD', 'before', ',', '.', 1, NULL),
  ('OMR', 3, 1, 1, 'OMR', 'before', ',', '.', 1, NULL),
  ('PAB', 2, 1, 1, 'PAB', 'before', ',', '.', 1, NULL),
  ('PEN', 2, 1, 1, 'PEN', 'before', ',', '.', 1, NULL),
  ('PGK', 2, 1, 1, 'PGK', 'before', ',', '.', 1, NULL),
  ('PHP', 2, 1, 1, 'PHP', 'before', ',', '.', 1, NULL),
  ('PKR', 2, 1, 1, 'PKR', 'before', ',', '.', 1, NULL),
  ('PLN', 2, 1, 1, 'zł', 'after', ' ', ',', 1, NULL),
  ('PYG', 0, 1, 1, 'PYG', 'before', ',', '.', 1, NULL),
  ('QAR', 2, 1, 1, 'QAR', 'before', ',', '.', 1, NULL),
  ('RON', 2, 1, 1, 'lei', 'after', '.', ',', 1, NULL),
  ('RSD', 2, 1, 1, 'RSD', 'after', '.', ',', 1, NULL),
  ('RUB', 2, 1, 1, '₽', 'after', ' ', ',', 1, NULL),
  ('RWF', 0, 1, 1, 'RWF', 'before', ',', '.', 1, NULL),
  ('SAR', 2, 1, 1, 'SAR', 'before', ',', '.', 1, NULL),
  ('SBD', 2, 1, 1, 'SBD', 'before', ',', '.', 1, NULL),
  ('SCR', 2, 1, 1, 'SCR', 'before', ',', '.', 1, NULL),
  ('SDG', 2, 1, 1, 'SDG', 'before', ',', '.', 1, NULL),
  ('SEK', 2, 1, 1, 'kr', 'after', ' ', ',', 1, NULL),
  ('SGD', 2, 1, 1, 'SGD', 'before', ',', '.', 1, NULL),
  ('SHP', 2, 1, 1, 'SHP', 'before', ',', '.', 1, NULL),
  ('SLE', 2, 1, 1, 'SLE', 'before', ',', '.', 1, NULL),
  ('SOS', 2, 1, 1, 'SOS', 'before', ',', '.', 1, NULL),
  ('SRD', 2, 1, 1, 'SRD', 'before', ',', '.', 1, NULL),
  ('SSP', 2, 1, 1, 'SSP', 'before', ',', '.', 1, NULL),
  ('STN', 2, 1, 1, 'STN', 'before', ',', '.', 1, NULL),
  ('SVC', 2, 1, 1, 'SVC', 'before', ',', '.', 1, NULL),
  ('SYP', 2, 1, 1, 'SYP', 'before', ',', '.', 1, NULL),
  ('SZL', 2, 1, 1, 'SZL', 'before', ',', '.', 1, NULL),
  ('THB', 2, 1, 1, 'THB', 'before', ',', '.', 1, NULL),
  ('TJS', 2, 1, 1, 'TJS', 'before', ',', '.', 1, NULL),
  ('TMT', 2, 1, 1, 'TMT', 'before', ',', '.', 1, NULL),
  ('TND', 3, 1, 1, 'TND', 'before', ',', '.', 1, NULL),
  ('TOP', 2, 1, 1, 'TOP', 'before', ',', '.', 1, NULL),
  ('TRY', 2, 1, 1, '₺', 'before', '.', ',', 1, NULL),
  ('TTD', 2, 1, 1, 'TTD', 'before', ',', '.', 1, NULL),
  ('TWD', 2, 1, 1, 'TWD', 'before', ',', '.', 1, NULL),
  ('TZS', 2, 1, 1, 'TZS', 'before', ',', '.', 1, NULL),
  ('UAH', 2, 1, 1, '₴', 'after', ' ', ',', 1, NULL),
  ('UGX', 0, 1, 1, 'UGX', 'before', ',', '.', 1, NULL),
  ('USD', 2, 1, 1, '$', 'before', ',', '.', 1, NULL),
  ('UYU', 2, 1, 1, 'UYU', 'before', ',', '.', 1, NULL),
  ('UZS', 2, 1, 1, 'UZS', 'before', ',', '.', 1, NULL),
  ('VES', 2, 1, 1, 'VES', 'before', ',', '.', 1, NULL),
  ('VND', 0, 1, 1, 'VND', 'before', ',', '.', 1, NULL),
  ('VUV', 0, 1, 1, 'VUV', 'before', ',', '.', 1, NULL),
  ('WST', 2, 1, 1, 'WST', 'before', ',', '.', 1, NULL),
  ('XAF', 0, 1, 1, 'XAF', 'before', ',', '.', 1, NULL),
  ('XCD', 2, 1, 1, 'XCD', 'before', ',', '.', 1, NULL),
  ('XCG', 2, 1, 1, 'XCG', 'before', ',', '.', 1, NULL),
  ('XOF', 0, 1, 1, 'XOF', 'before', ',', '.', 1, NULL),
  ('XPF', 0, 1, 1, 'XPF', 'before', ',', '.', 1, NULL),
  ('YER', 2, 1, 1, 'YER', 'before', ',', '.', 1, NULL),
  ('ZAR', 2, 1, 1, 'ZAR', 'before', ',', '.', 1, NULL),
  ('ZMW', 2, 1, 1, 'ZMW', 'before', ',', '.', 1, NULL),
  ('ZWG', 2, 1, 1, 'ZWG', 'before', ',', '.', 1, NULL);
--> statement-breakpoint
INSERT INTO price_book (tier, country, currency, list_amount_minor, ppp_index, effective_from, enabled) VALUES
  ('watch', '*', 'EUR', 4900, '1.00', '2026-11-10', true),
  ('act', '*', 'EUR', 14900, '1.00', '2026-11-10', true),
  ('autonomous', '*', 'EUR', 29900, '1.00', '2026-11-10', true),
  ('extra_business', '*', 'EUR', 2900, '1.00', '2026-11-10', true),
  ('full_diagnosis', '*', 'EUR', 4900, '1.00', '2026-11-10', true),
  ('partner_starter', '*', 'EUR', 3900, '1.00', '2026-11-10', true),
  ('partner_practice', '*', 'EUR', 2900, '1.00', '2026-11-10', true),
  ('partner_network', '*', 'EUR', 2200, '1.00', '2026-11-10', true),
  ('watch', 'HU', 'HUF', 1150000, '0.52', '2026-11-10', false),
  ('act', 'HU', 'HUF', 3500000, '0.52', '2026-11-10', false),
  ('autonomous', 'HU', 'HUF', 6900000, '0.52', '2026-11-10', false),
  ('extra_business', 'HU', 'HUF', 700000, '0.52', '2026-11-10', false),
  ('full_diagnosis', 'HU', 'HUF', 1150000, '0.52', '2026-11-10', false),
  ('partner_starter', 'HU', 'HUF', 900000, '0.52', '2026-11-10', false),
  ('partner_practice', 'HU', 'HUF', 700000, '0.52', '2026-11-10', false),
  ('partner_network', 'HU', 'HUF', 500000, '0.52', '2026-11-10', false);
--> statement-breakpoint
INSERT INTO usage_quotas (tier, metric, monthly_soft, monthly_hard, confirmed) VALUES
  ('watch', 'llm_tokens', 240000, 300000, false),
  ('watch', 'video_renders', 0, 0, false),
  ('watch', 'connector_calls', 2400, 3000, false),
  ('act', 'llm_tokens', 1200000, 1500000, false),
  ('act', 'video_renders', 8, 10, false),
  ('act', 'connector_calls', 12000, 15000, false),
  ('autonomous', 'llm_tokens', 3200000, 4000000, false),
  ('autonomous', 'video_renders', 32, 40, false),
  ('autonomous', 'connector_calls', 32000, 40000, false);
--> statement-breakpoint
CREATE FUNCTION multi_market_refuse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: % is not permitted (%)', TG_TABLE_NAME, TG_OP, TG_ARGV[0]
    USING ERRCODE = 'raise_exception';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fx_rates_no_update
  BEFORE UPDATE ON fx_rates
  FOR EACH ROW EXECUTE FUNCTION multi_market_refuse('a stored rate is never rewritten: conversions reproduce from it');
--> statement-breakpoint
CREATE TRIGGER price_book_changes_append_only
  BEFORE UPDATE OR DELETE ON price_book_changes
  FOR EACH ROW EXECUTE FUNCTION multi_market_refuse('the price changelog is append-only');
--> statement-breakpoint
CREATE FUNCTION subscriptions_price_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_amount_minor IS DISTINCT FROM OLD.price_amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.price_book_id IS DISTINCT FROM OLD.price_book_id
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'a subscription''s price is locked at signup for its lifetime'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscriptions_price_locked
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_price_locked();
--> statement-breakpoint
CREATE FUNCTION price_book_identity_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.list_amount_minor IS DISTINCT FROM OLD.list_amount_minor
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.country IS DISTINCT FROM OLD.country
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'a price book row''s price never changes: close it (effective_to) and add a new row'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER price_book_identity_fixed
  BEFORE UPDATE ON price_book
  FOR EACH ROW EXECUTE FUNCTION price_book_identity_fixed();
