-- oxy:deploy-phase=pre
CREATE TABLE "managed_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"source_reference" text NOT NULL,
	"read_capability_hash" text NOT NULL,
	"operation_id" text NOT NULL,
	"frozen" boolean DEFAULT true NOT NULL,
	"target_account_ids" text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_teams" ADD CONSTRAINT "managed_teams_id_conversations_id_fk" FOREIGN KEY ("id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_teams_capability_key" ON "managed_teams" USING btree ("read_capability_hash");