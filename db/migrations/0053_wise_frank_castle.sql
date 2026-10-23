CREATE TYPE "public"."support_sender_auth" AS ENUM('verified', 'unverified', 'failed');--> statement-breakpoint
ALTER TABLE "support_email_messages" ADD COLUMN "sender_auth" "support_sender_auth";