CREATE TABLE "vocabularies" (
	"key" text PRIMARY KEY NOT NULL,
	"bank_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vocabulary_entries" (
	"vocab_key" text NOT NULL,
	"code" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vocabulary_entries" ADD CONSTRAINT "vocabulary_entries_vocab_key_vocabularies_key_fk" FOREIGN KEY ("vocab_key") REFERENCES "public"."vocabularies"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vocabulary_entries_pk" ON "vocabulary_entries" USING btree ("vocab_key","code");