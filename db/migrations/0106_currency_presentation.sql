ALTER TABLE "currencies" ADD COLUMN "presentation" text DEFAULT 'reader' NOT NULL;--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_presentation" CHECK ("currencies"."presentation" in ('home', 'reader'));--> statement-breakpoint
UPDATE currencies SET presentation = 'home' WHERE code IN ('BGN', 'CHF', 'CZK', 'DKK', 'HUF', 'ISK', 'NOK', 'PLN', 'RON', 'RSD', 'RUB', 'SEK', 'TRY', 'UAH');
