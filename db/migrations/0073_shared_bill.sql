DROP INDEX "payments_checkout_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_profile_idx" ON "payments" USING btree ("checkout_session_id","profile_id");--> statement-breakpoint
CREATE INDEX "payments_checkout_idx" ON "payments" USING btree ("checkout_session_id");