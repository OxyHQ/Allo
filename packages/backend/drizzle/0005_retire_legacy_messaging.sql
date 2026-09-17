-- oxy:deploy-phase=post
--
-- Retires what the clean break (issue #139) replaced and 0004 could not yet
-- drop: the per-message tables that hung off `messages`, the Signal-era device
-- and pre-key tables, the four bridge tables, the `security_cloud_sync_enabled`
-- column of `user_settings`, and the three plpgsql functions behind the two
-- constraint triggers that 0000 created by hand (the triggers themselves went
-- with their tables in 0004; the functions did not, because a function is not
-- dropped by a table's CASCADE and drizzle-kit never knew they existed).
--
-- `post` because every statement is a DROP: it lands only once the new image
-- has rolled, so no serving process can still plan against what disappears.
-- 0004's header explains why three of the retired tables went at `pre` instead.
DROP TABLE "message_reads" CASCADE;
--> statement-breakpoint
DROP TABLE "message_deliveries" CASCADE;
--> statement-breakpoint
DROP TABLE "message_reactions" CASCADE;
--> statement-breakpoint
DROP TABLE "devices" CASCADE;
--> statement-breakpoint
DROP TABLE "device_pre_keys" CASCADE;
--> statement-breakpoint
DROP TABLE "bridge_accounts" CASCADE;
--> statement-breakpoint
DROP TABLE "bridge_link_sessions" CASCADE;
--> statement-breakpoint
DROP TABLE "bridge_proxy_leases" CASCADE;
--> statement-breakpoint
DROP TABLE "bridge_proxy_lease_rotations" CASCADE;
--> statement-breakpoint
ALTER TABLE "user_settings" DROP COLUMN "security_cloud_sync_enabled";
--> statement-breakpoint
DROP FUNCTION IF EXISTS allo_conversations_participant_count_trigger();
--> statement-breakpoint
DROP FUNCTION IF EXISTS allo_conversation_participants_count_trigger();
--> statement-breakpoint
DROP FUNCTION IF EXISTS allo_check_conversation_participants(text);
