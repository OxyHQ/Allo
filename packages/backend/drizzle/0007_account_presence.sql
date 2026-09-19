-- oxy:deploy-phase=pre
--
-- Presence, the durable half (ADR 0002). Whether an account is online right
-- now is a heartbeat with a seventy-five second life and lives in Redis; this
-- table holds only what has to survive everything restarting — when the
-- account was last connected — because "offline, last seen yesterday" and
-- "never seen" are different answers and a cold cache cannot tell them apart.
--
--   account_presence  one row per account, written at most once a minute and
--                     published truncated to the minute
--
-- `pre` because it is one new table and nothing reads it until the image that
-- creates it is serving.
CREATE TABLE "account_presence" (
	"account_id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
