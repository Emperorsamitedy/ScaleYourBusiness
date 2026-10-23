CREATE TABLE "booking_client_erasures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"client_key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_client_erasures" ADD CONSTRAINT "booking_client_erasures_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_client_erasures_idx" ON "booking_client_erasures" USING btree ("account_id","client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_stock_finding_idx" ON "proposals" USING btree ("profile_id","originating_finding") WHERE "proposals"."originating_finding" LIKE 'stock:%';--> statement-breakpoint
-- Review 2026-10-23, #11: a bookings import row without the export's own
-- reference was keyed by sha256(day, time, CLIENT KEY, service, staff), so an
-- erased client's key lived on inside source_ref, and re-importing after an
-- erasure re-matched the row by it. lib/bookings/rows.ts now keys by
-- sha256(day, time, service, staff) only, numbered within the slot. Re-key the
-- stored rows the same way, so the next import of an old file updates them in
-- place instead of adding duplicates. Rows sharing a new slot key are numbered
-- 1..n (by their old number, then old key); a re-import rewrites every field of
-- each, so which old row takes which number doesn't change any count.
-- Two steps through a "~" prefix, so no row ever collides on the unique index.
WITH keyed AS (
  SELECT
    a.id,
    a.connection_id,
    a.source_ref,
    split_part(a.source_ref, ':', 1) AS platform,
    split_part(a.source_ref, ':', 4) AS old_n,
    left(encode(sha256(
      convert_to(to_char(a.day, 'YYYY-MM-DD'), 'UTF8') || '\x00'::bytea ||
      convert_to(coalesce(a.start_time, ''), 'UTF8') || '\x00'::bytea ||
      convert_to(coalesce(a.service, ''), 'UTF8') || '\x00'::bytea ||
      convert_to(coalesce(a.staff_ref, ''), 'UTF8')
    ), 'hex'), 32) AS content
  FROM "booking_appointments" a
  JOIN "connections" c ON c.id = a.connection_id
  WHERE c.provider = 'bookings_import' AND a.source_ref ~ '^[^:]+:k:[0-9a-f]{32}:[0-9]+$'
),
numbered AS (
  SELECT
    id,
    platform || ':k:' || content || ':' || row_number() OVER (
      PARTITION BY connection_id, platform, content
      ORDER BY old_n::int, source_ref
    ) AS new_ref
  FROM keyed
)
UPDATE "booking_appointments" a
SET source_ref = '~' || numbered.new_ref
FROM numbered
WHERE a.id = numbered.id;--> statement-breakpoint
UPDATE "booking_appointments" SET source_ref = substr(source_ref, 2) WHERE source_ref LIKE '~%';
