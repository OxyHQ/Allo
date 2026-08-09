-- oxy:deploy-phase=pre
--
-- Additive only: three CHECK constraints for the Mongoose `maxlength` bounds
-- `reports` carried (`details` 500, `localStatusReason` 300,
-- `lastDeliveryError` 2000).
--
-- `pre` because no image can violate them. `db/moderation/reportRepository.ts`
-- truncates to exactly these three lengths at every write, and the image
-- currently serving does not write this table at all — the moderation routes
-- reach Postgres for the first time in the change these constraints ship with.
ALTER TABLE "reports" ADD CONSTRAINT "reports_details_length_check" CHECK (length(details) <= 500);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_local_status_reason_length_check" CHECK (length(local_status_reason) <= 300);--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_last_delivery_error_length_check" CHECK (length(last_delivery_error) <= 2000);