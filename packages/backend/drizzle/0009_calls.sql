-- oxy:deploy-phase=pre
--
-- Calls (ADR 0002): the state machine the server runs, and nothing about the
-- media. Offers, candidates and keys are encrypted messages in the
-- conversation and are not here.
--
--   calls               one per attempt: who rang, in which conversation,
--                       whether the media must be relayed, and how it ended
--   call_participants   one per RUNG DEVICE, because the ring is forked to
--                       every phone and exactly one of them wins
--   user_settings.privacy_relay_calls
--                       "hide my IP address in calls". Either side asking is
--                       enough to relay a call, which is why the server reads
--                       both sides
--
-- `calls.expires_at` is a day out and is pulled to NOW when a call ends: these
-- rows are operational, and what a person sees afterwards is an encrypted
-- `call_log` message in their conversation.
--
-- `pre` because every statement is additive, and the old image keeps serving
-- with all of it in place.
CREATE TABLE "call_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"call_id" text NOT NULL,
	"account_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"state" text DEFAULT 'ringing' NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "call_participants_state_check" CHECK ("call_participants"."state" in ('ringing', 'joined', 'left', 'declined', 'missed'))
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"initiator_account_id" text NOT NULL,
	"initiator_instance_id" text NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'ringing' NOT NULL,
	"relayed" boolean DEFAULT false NOT NULL,
	"group" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"ring_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calls_mode_check" CHECK ("calls"."mode" in ('voice', 'video')),
	CONSTRAINT "calls_state_check" CHECK ("calls"."state" in ('ringing', 'active', 'ended')),
	CONSTRAINT "calls_end_reason_check" CHECK ("calls"."end_reason" in ('hangup', 'declined', 'missed', 'busy', 'cancelled', 'failed', 'answered_elsewhere', 'declined_elsewhere'))
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "privacy_relay_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_participants_call_id_instance_id_key" ON "call_participants" USING btree ("call_id","instance_id");--> statement-breakpoint
CREATE INDEX "call_participants_instance_id_state_idx" ON "call_participants" USING btree ("instance_id","state");--> statement-breakpoint
CREATE INDEX "call_participants_expires_at_idx" ON "call_participants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_initiator_instance_idempotency_key" ON "calls" USING btree ("initiator_instance_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "calls_state_ring_expires_at_idx" ON "calls" USING btree ("state","ring_expires_at");--> statement-breakpoint
CREATE INDEX "calls_conversation_id_started_at_idx" ON "calls" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_expires_at_idx" ON "calls" USING btree ("expires_at");