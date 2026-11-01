CREATE TABLE "bank_overlays" (
	"bank_version" text NOT NULL,
	"locale" text NOT NULL,
	"words" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	CONSTRAINT "bank_overlays_locale_known" CHECK ("bank_overlays"."locale" in ('es-ES', 'de-DE', 'fr-FR', 'hu-HU', 'ru-RU', 'zh-Hans'))
);
--> statement-breakpoint
ALTER TABLE "bank_overlays" ADD CONSTRAINT "bank_overlays_bank_version_bank_versions_version_fk" FOREIGN KEY ("bank_version") REFERENCES "public"."bank_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_overlays_pk" ON "bank_overlays" USING btree ("bank_version","locale");