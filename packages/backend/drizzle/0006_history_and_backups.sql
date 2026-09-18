-- oxy:deploy-phase=pre
--
-- Phase 3 of the platform (issue #139 §9, §16, §17): history transfer between
-- instances of one account and encrypted account backups.
--
--   client_instances.transfer_public_key  the X25519 key a donor seals an
--                                         archive key to; NULL on Phase 2 rows
--                                         until `PUT /v1/instances/me/transfer-key`
--   history_offers                        a signed archive manifest plus the key
--                                         sealed to ONE recipient; 7-day deadline
--   account_backups                       one archive per account, key derived
--                                         from a recovery phrase the server
--                                         never sees
--   conversation_events (blob_ids) GIN    "is this blob named by any event?" as
--                                         an index probe, for chunk release
--
-- `pre` because every statement is additive — a nullable column, two tables,
-- an index — and the OLD image can keep serving with all of it in place.
CREATE TABLE "history_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"donor_instance_id" text NOT NULL,
	"recipient_instance_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"sealed_key" text NOT NULL,
	"manifest_signature" text NOT NULL,
	"chunk_blob_ids" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "history_offers_status_check" CHECK ("history_offers"."status" in ('pending', 'consumed', 'expired')),
	CONSTRAINT "history_offers_chunk_blob_ids_check" CHECK (coalesce(array_length("history_offers"."chunk_blob_ids", 1), 0) >= 1)
);

--> statement-breakpoint
CREATE TABLE "account_backups" (
	"account_id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"key_check" text NOT NULL,
	"manifest_signature" text NOT NULL,
	"chunk_blob_ids" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "account_backups_chunk_blob_ids_check" CHECK (coalesce(array_length("account_backups"."chunk_blob_ids", 1), 0) >= 1)
);

--> statement-breakpoint
ALTER TABLE "client_instances" ADD COLUMN "transfer_public_key" text;
--> statement-breakpoint
ALTER TABLE "history_offers" ADD CONSTRAINT "history_offers_donor_instance_id_client_instances_id_fk" FOREIGN KEY ("donor_instance_id") REFERENCES "public"."client_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "history_offers" ADD CONSTRAINT "history_offers_recipient_instance_id_client_instances_id_fk" FOREIGN KEY ("recipient_instance_id") REFERENCES "public"."client_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_backups" ADD CONSTRAINT "account_backups_instance_id_client_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."client_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "history_offers_recipient_instance_id_status_idx" ON "history_offers" USING btree ("recipient_instance_id","status");
--> statement-breakpoint
CREATE INDEX "history_offers_donor_recipient_status_idx" ON "history_offers" USING btree ("donor_instance_id","recipient_instance_id","status");
--> statement-breakpoint
CREATE INDEX "history_offers_expires_at_idx" ON "history_offers" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "conversation_events_blob_ids_gin_idx" ON "conversation_events" USING gin ("blob_ids");
