-- oxy:deploy-phase=pre
--
-- Additive only: the FIVE Mongoose `maxlength` bounds that were actually in
-- force, as CHECKs. Mongoose runs a `maxlength` validator on `.create()`/
-- `.save()` and not on an update without `runValidators: true`, which appears
-- nowhere in this service — so of the sixteen bounds the three bridge models
-- declared, only the three written by `BridgeLinkSession.create` and the two
-- written by `BridgeProxyLease.create` ever refused anything. The other eleven
-- are documented on their columns in `db/schema/bridges.ts` with the reason
-- they get no constraint.
--
-- `pre` because no image can violate them: the serving image does not write
-- these tables at all — the bridge routes reach Postgres for the first time in
-- the change these constraints ship with — and `bridge*` is empty in
-- `allo-production` (0 rows across all three collections).
ALTER TABLE "bridge_link_sessions" ADD CONSTRAINT "bridge_link_sessions_flow_id_length_check" CHECK (length(flow_id) <= 200);--> statement-breakpoint
ALTER TABLE "bridge_link_sessions" ADD CONSTRAINT "bridge_link_sessions_remote_login_process_id_length_check" CHECK (length(remote_login_process_id) <= 200);--> statement-breakpoint
ALTER TABLE "bridge_link_sessions" ADD CONSTRAINT "bridge_link_sessions_current_step_id_length_check" CHECK (length(current_step_id) <= 200);--> statement-breakpoint
ALTER TABLE "bridge_proxy_leases" ADD CONSTRAINT "bridge_proxy_leases_provider_length_check" CHECK (length(provider) <= 100);--> statement-breakpoint
ALTER TABLE "bridge_proxy_leases" ADD CONSTRAINT "bridge_proxy_leases_session_seed_length_check" CHECK (length(session_seed) <= 100);