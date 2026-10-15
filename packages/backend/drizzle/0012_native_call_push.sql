-- oxy:deploy-phase=pre
ALTER TABLE "call_participants" ADD COLUMN "ring_push_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_participants" ADD COLUMN "ring_push_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_participants" ADD COLUMN "ring_push_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_instances" ADD COLUMN "call_push_provider" text;--> statement-breakpoint
ALTER TABLE "client_instances" ADD COLUMN "call_push_token" text;--> statement-breakpoint
ALTER TABLE "client_instances" ADD CONSTRAINT "client_instances_call_push_provider_check" CHECK ("client_instances"."call_push_provider" in ('fcm', 'apns'));--> statement-breakpoint
ALTER TABLE "client_instances" ADD CONSTRAINT "client_instances_call_push_pair_check" CHECK (("client_instances"."call_push_provider" is null) = ("client_instances"."call_push_token" is null));