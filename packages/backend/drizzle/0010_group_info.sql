-- oxy:deploy-phase=pre
--
-- Self-join by MLS external commit (docs/platform/crypto.md, external join):
--
--   conversation_group_info   the GroupInfo of a conversation's CURRENT epoch
--                             (external_pub plus ratchet tree), one row per
--                             conversation, replaced by every accepted
--                             mls_commit (CommitInfo.groupInfo) and
--                             re-publishable by a member holding an active leaf
--                             (PUT /v1/conversations/:id/group-info). A device
--                             that is a member with no active leaf joins from
--                             it with nobody else online.
--
-- `pre` because the only statement is a new table with its foreign key: the OLD
-- image can keep serving with it in place, and the NEW image's commit path
-- writes it from its first request.
CREATE TABLE "conversation_group_info" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"signer_instance_id" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_group_info_epoch_check" CHECK ("conversation_group_info"."epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_group_info" ADD CONSTRAINT "conversation_group_info_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;