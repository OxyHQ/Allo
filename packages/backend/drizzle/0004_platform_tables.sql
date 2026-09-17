-- oxy:deploy-phase=pre
--
-- The messaging platform's tables (issue #139, the clean break): client
-- instances, key packages, conversations with their members and leaves, the
-- event log, the per-instance delivery stream and blobs. Design in
-- `docs/platform/api-v1.md`; column decisions in `src/db/schema/*.ts`.
--
-- THE ONE NON-ADDITIVE STATEMENT IN A `pre` MIGRATION, and why it is here:
-- the new `conversations` table takes the name of the retired one, so it cannot
-- be created while the old one exists, and `messages` and
-- `conversation_participants` hang off it by foreign key. The first line drops
-- those three (and, through CASCADE, the constraint triggers and the foreign
-- keys `message_reads`, `message_deliveries` and `message_reactions` held on
-- `messages`). This is safe at the `pre` side of THIS rollout for two reasons
-- that are both true today and are not general rules: the image currently
-- serving has already lost every route that touched these tables (they were
-- deleted in d2410ef, the groundwork commit of the same release), and the
-- issue explicitly allows a development-data reset — nothing in production
-- holds real conversations. A future migration must not copy this shape.
--
-- Everything after the first line is `drizzle-kit`'s own output for the diff
-- from 0003 (minus those three tables) to the schema in `src/db/schema/`. The
-- remaining retired tables, the retired `user_settings` column and the trigger
-- functions are dropped in 0005 (`post`), once no image can plan against them.
DROP TABLE IF EXISTS "messages", "conversation_participants", "conversations" CASCADE;
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"uploader_instance_id" text NOT NULL,
	"uploader_account_id" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "blobs_size_check" CHECK ("blobs"."size" >= 0)
);

--> statement-breakpoint
CREATE TABLE "blob_bytes" (
	"blob_id" text PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL
);

--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"app_id" text NOT NULL,
	"dm_key" text,
	"mls_group_id" text NOT NULL,
	"current_epoch" bigint DEFAULT 0 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_by_account_id" text NOT NULL,
	"created_by_instance_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversations_dm_key_key" UNIQUE("dm_key"),
	CONSTRAINT "conversations_mls_group_id_key" UNIQUE("mls_group_id"),
	CONSTRAINT "conversations_kind_check" CHECK ("conversations"."kind" in ('dm', 'group')),
	CONSTRAINT "conversations_dm_key_check" CHECK ("conversations"."kind" <> 'dm' or "conversations"."dm_key" is not null),
	CONSTRAINT "conversations_current_epoch_check" CHECK ("conversations"."current_epoch" >= 0),
	CONSTRAINT "conversations_last_seq_check" CHECK ("conversations"."last_seq" >= 0)
);

--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"added_by_account_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_members_role_check" CHECK ("conversation_members"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "conversation_members_state_check" CHECK ("conversation_members"."state" in ('joined', 'left', 'removed'))
);

--> statement-breakpoint
CREATE TABLE "conversation_leaves" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"account_id" text NOT NULL,
	"state" text NOT NULL,
	"added_epoch" bigint NOT NULL,
	"removed_epoch" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_leaves_state_check" CHECK ("conversation_leaves"."state" in ('pending_welcome', 'active', 'removed')),
	CONSTRAINT "conversation_leaves_added_epoch_check" CHECK ("conversation_leaves"."added_epoch" >= 0)
);

--> statement-breakpoint
CREATE TABLE "instance_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"notified_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "instance_deliveries_status_check" CHECK ("instance_deliveries"."status" in ('pending', 'notified', 'acked', 'dead')),
	CONSTRAINT "instance_deliveries_attempts_check" CHECK ("instance_deliveries"."attempts" >= 0)
);

--> statement-breakpoint
CREATE TABLE "conversation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"epoch" bigint NOT NULL,
	"sender_account_id" text NOT NULL,
	"sender_instance_id" text,
	"idempotency_key" text,
	"payload" "bytea" NOT NULL,
	"blob_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_events_kind_check" CHECK ("conversation_events"."kind" in ('mls_commit', 'mls_proposal', 'mls_welcome', 'app_message', 'control')),
	CONSTRAINT "conversation_events_seq_check" CHECK ("conversation_events"."seq" >= 1),
	CONSTRAINT "conversation_events_epoch_check" CHECK ("conversation_events"."epoch" >= 0)
);

--> statement-breakpoint
CREATE TABLE "client_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"app_id" text NOT NULL,
	"platform" text NOT NULL,
	"display_name" text NOT NULL,
	"signing_public_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"enrollment_challenge" text,
	"approved_by_instance_id" text,
	"approval_signature" text,
	"enrolled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"push_provider" text,
	"push_token" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "client_instances_platform_check" CHECK ("client_instances"."platform" in ('ios', 'android', 'web', 'desktop', 'node')),
	CONSTRAINT "client_instances_status_check" CHECK ("client_instances"."status" in ('pending', 'active', 'revoked')),
	CONSTRAINT "client_instances_push_provider_check" CHECK ("client_instances"."push_provider" in ('fcm', 'apns')),
	CONSTRAINT "client_instances_push_pair_check" CHECK (("client_instances"."push_provider" is null) = ("client_instances"."push_token" is null))
);

--> statement-breakpoint
CREATE TABLE "key_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"ciphersuite" integer NOT NULL,
	"ref" text NOT NULL,
	"data" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_instance_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "key_packages_ref_key" UNIQUE("ref"),
	CONSTRAINT "key_packages_ciphersuite_check" CHECK ("key_packages"."ciphersuite" between 1 and 65535)
);

--> statement-breakpoint
ALTER TABLE "blob_bytes" ADD CONSTRAINT "blob_bytes_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_leaves" ADD CONSTRAINT "conversation_leaves_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_leaves" ADD CONSTRAINT "conversation_leaves_instance_id_client_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."client_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instance_deliveries" ADD CONSTRAINT "instance_deliveries_event_id_conversation_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."conversation_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "instance_deliveries" ADD CONSTRAINT "instance_deliveries_instance_id_client_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."client_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "key_packages" ADD CONSTRAINT "key_packages_instance_id_client_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."client_instances"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "blobs_expires_at_idx" ON "blobs" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "blobs_uploader_instance_id_idx" ON "blobs" USING btree ("uploader_instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_conversation_id_account_id_key" ON "conversation_members" USING btree ("conversation_id","account_id");
--> statement-breakpoint
CREATE INDEX "conversation_members_account_id_state_idx" ON "conversation_members" USING btree ("account_id","state");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_leaves_conversation_id_instance_id_key" ON "conversation_leaves" USING btree ("conversation_id","instance_id");
--> statement-breakpoint
CREATE INDEX "conversation_leaves_instance_id_state_idx" ON "conversation_leaves" USING btree ("instance_id","state");
--> statement-breakpoint
CREATE UNIQUE INDEX "instance_deliveries_event_id_instance_id_key" ON "instance_deliveries" USING btree ("event_id","instance_id");
--> statement-breakpoint
CREATE INDEX "instance_deliveries_instance_id_id_idx" ON "instance_deliveries" USING btree ("instance_id","id");
--> statement-breakpoint
CREATE INDEX "instance_deliveries_status_available_at_id_idx" ON "instance_deliveries" USING btree ("status","available_at","id");
--> statement-breakpoint
CREATE INDEX "instance_deliveries_status_lease_until_id_idx" ON "instance_deliveries" USING btree ("status","lease_until","id");
--> statement-breakpoint
CREATE INDEX "instance_deliveries_expires_at_idx" ON "instance_deliveries" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_events_conversation_id_seq_key" ON "conversation_events" USING btree ("conversation_id","seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_events_sender_instance_id_idempotency_key_key" ON "conversation_events" USING btree ("sender_instance_id","idempotency_key") WHERE idempotency_key is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "client_instances_account_id_signing_public_key_key" ON "client_instances" USING btree ("account_id","signing_public_key");
--> statement-breakpoint
CREATE INDEX "client_instances_account_id_status_idx" ON "client_instances" USING btree ("account_id","status");
--> statement-breakpoint
CREATE INDEX "key_packages_instance_id_consumed_at_idx" ON "key_packages" USING btree ("instance_id","consumed_at");
