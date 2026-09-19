-- oxy:deploy-phase=pre
--
-- Status updates (ADR 0002): one ciphertext, a key sealed per recipient
-- device, 24 hours.
--
--   statuses         the body the server cannot open, its digest, the blobs
--                    its envelope names, and the author instance's signature
--   status_keys      the per-status key HPKE-sealed to ONE device; deleting
--                    the row is what stops delivery
--   status_views     who saw it, one row per ACCOUNT, carrying the status's
--                    own deadline so a view never outlives the thing viewed
--   user_settings.privacy_status_view_receipts
--                    whether a view carries this account's name — its own
--                    switch, not a rider on read receipts
--
-- Every table here has a deadline and is registered in `EXPIRY_SWEEP_TARGETS`
-- with a leading index on the column the sweep reads.
--
-- `pre` because every statement is additive — three tables, a nullable-free
-- column with a default, and their indexes — and the OLD image keeps serving
-- with all of it in place.
CREATE TABLE "status_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"status_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"account_id" text NOT NULL,
	"sealed_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_views" (
	"id" text PRIMARY KEY NOT NULL,
	"status_id" text NOT NULL,
	"account_id" text NOT NULL,
	"published" text DEFAULT 'yes' NOT NULL,
	"viewed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "status_views_published_check" CHECK ("status_views"."published" in ('yes', 'no'))
);
--> statement-breakpoint
CREATE TABLE "statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"author_account_id" text NOT NULL,
	"author_instance_id" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"blob_ids" text[] DEFAULT '{}' NOT NULL,
	"signature" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "statuses_state_check" CHECK ("statuses"."state" in ('live', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "privacy_status_view_receipts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "status_keys" ADD CONSTRAINT "status_keys_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_views" ADD CONSTRAINT "status_views_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "status_keys_status_id_instance_id_key" ON "status_keys" USING btree ("status_id","instance_id");--> statement-breakpoint
CREATE INDEX "status_keys_instance_id_expires_at_idx" ON "status_keys" USING btree ("instance_id","expires_at");--> statement-breakpoint
CREATE INDEX "status_keys_expires_at_idx" ON "status_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "status_views_status_id_account_id_key" ON "status_views" USING btree ("status_id","account_id");--> statement-breakpoint
CREATE INDEX "status_views_expires_at_idx" ON "status_views" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_author_instance_idempotency_key" ON "statuses" USING btree ("author_instance_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "statuses_expires_at_idx" ON "statuses" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "statuses_author_account_id_created_at_idx" ON "statuses" USING btree ("author_account_id","created_at");