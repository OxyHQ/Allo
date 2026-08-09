-- oxy:deploy-phase=pre
-- Genesis. Purely additive: 19 CREATE TABLEs, their indexes, and the two
-- constraint triggers at the end of this file. Nothing here narrows or drops,
-- so it is safe to apply before the image that uses it is running.
CREATE TABLE "bridge_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"network" text NOT NULL,
	"remote_login_id" text NOT NULL,
	"remote_name" text,
	"remote_profile_name" text,
	"remote_profile_username" text,
	"remote_profile_phone" text,
	"remote_profile_avatar_url" text,
	"slot_id" text,
	"state" text DEFAULT 'linking' NOT NULL,
	"raw_state_event" text,
	"raw_state_error" text,
	"raw_state_message" text,
	"raw_state_reason" text,
	"raw_state_ttl" integer,
	"raw_state_at" timestamp with time zone,
	"space_room_id" text,
	"linked_at" timestamp with time zone NOT NULL,
	"last_state_at" timestamp with time zone NOT NULL,
	"last_connected_at" timestamp with time zone,
	"last_notified_state" text,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bridge_accounts_network_check" CHECK ("bridge_accounts"."network" in ('telegram', 'slack', 'discord', 'whatsapp', 'instagram', 'messenger')),
	CONSTRAINT "bridge_accounts_state_check" CHECK ("bridge_accounts"."state" in ('linking', 'connecting', 'connected', 'degraded', 'action_required', 'failed')),
	CONSTRAINT "bridge_accounts_last_notified_state_check" CHECK ("bridge_accounts"."last_notified_state" in ('linking', 'connecting', 'connected', 'degraded', 'action_required', 'failed')),
	CONSTRAINT "bridge_accounts_raw_state_ttl_check" CHECK ("bridge_accounts"."raw_state_ttl" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bridge_link_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"network" text NOT NULL,
	"flow_id" text NOT NULL,
	"slot_id" text,
	"remote_login_process_id" text NOT NULL,
	"current_step_id" text,
	"current_step_type" text,
	"expires_at" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"result_account_id" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bridge_link_sessions_link_id_key" UNIQUE("link_id"),
	CONSTRAINT "bridge_link_sessions_network_check" CHECK ("bridge_link_sessions"."network" in ('telegram', 'slack', 'discord', 'whatsapp', 'instagram', 'messenger')),
	CONSTRAINT "bridge_link_sessions_current_step_type_check" CHECK ("bridge_link_sessions"."current_step_type" in ('user_input', 'cookies', 'client_http', 'display_and_wait', 'webauthn', 'complete')),
	CONSTRAINT "bridge_link_sessions_outcome_check" CHECK ("bridge_link_sessions"."outcome" in ('pending', 'completed', 'cancelled', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "bridge_proxy_lease_rotations" (
	"id" text PRIMARY KEY NOT NULL,
	"lease_id" text NOT NULL,
	"rotated_at" timestamp with time zone NOT NULL,
	"from_seed" text NOT NULL,
	"to_seed" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bridge_proxy_lease_rotations_reason_check" CHECK ("bridge_proxy_lease_rotations"."reason" in ('provider_retired', 'ban_quarantine', 'operator_forced'))
);
--> statement-breakpoint
CREATE TABLE "bridge_proxy_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"network" text NOT NULL,
	"provider" text NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text,
	"session_seed" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"last_exit_ip" text,
	"last_exit_country" text,
	"last_verified_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bridge_proxy_leases_network_check" CHECK ("bridge_proxy_leases"."network" in ('telegram', 'slack', 'discord', 'whatsapp', 'instagram', 'messenger')),
	CONSTRAINT "bridge_proxy_leases_state_check" CHECK ("bridge_proxy_leases"."state" in ('active', 'quarantined', 'released')),
	CONSTRAINT "bridge_proxy_leases_country_code_check" CHECK ("bridge_proxy_leases"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "conversation_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversation_participants_role_check" CHECK ("conversation_participants"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"description" text,
	"avatar" text,
	"theme" text,
	"created_by" text NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_text" text,
	"last_message_sender_id" text,
	"last_message_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "conversations_type_check" CHECK ("conversations"."type" in ('direct', 'group'))
);
--> statement-breakpoint
CREATE TABLE "device_pre_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" integer NOT NULL,
	"identity_key_public" text NOT NULL,
	"signed_pre_key_id" integer NOT NULL,
	"signed_pre_key_public" text NOT NULL,
	"signed_pre_key_signature" text NOT NULL,
	"registration_id" integer NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"sender_device_id" integer NOT NULL,
	"ciphertext" text,
	"encrypted_media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"message_type" text DEFAULT 'text' NOT NULL,
	"text" text,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" text,
	"font_size" integer,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "messages_message_type_check" CHECK ("messages"."message_type" in ('text', 'media', 'system')),
	CONSTRAINT "messages_content_present_check" CHECK ("messages"."ciphertext" is not null
        or jsonb_array_length("messages"."encrypted_media") > 0
        or "messages"."text" is not null
        or jsonb_array_length("messages"."media") > 0),
	CONSTRAINT "messages_media_is_array_check" CHECK (jsonb_typeof("messages"."encrypted_media") = 'array' and jsonb_typeof("messages"."media") = 'array'),
	CONSTRAINT "messages_font_size_range_check" CHECK ("messages"."font_size" between 10 and 72),
	CONSTRAINT "messages_sender_device_id_check" CHECK ("messages"."sender_device_id" >= 1)
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text,
	"case_id" text,
	"payload" jsonb,
	"state" text DEFAULT 'claimed' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_events_state_check" CHECK ("moderation_events"."state" in ('claimed', 'queued', 'ignored'))
);
--> statement-breakpoint
CREATE TABLE "moderation_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload_report_id" text,
	"payload_event_id" text,
	"payload_case_id" text,
	"payload_decision" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_outbox_kind_check" CHECK ("moderation_outbox"."kind" in ('report.submit', 'decision.apply')),
	CONSTRAINT "moderation_outbox_status_check" CHECK ("moderation_outbox"."status" in ('pending', 'processing', 'processed', 'dead_letter')),
	CONSTRAINT "moderation_outbox_attempts_check" CHECK ("moderation_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_type" text NOT NULL,
	"reported_id" text NOT NULL,
	"reporter" text NOT NULL,
	"categories" text[] NOT NULL,
	"details" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"local_status" text DEFAULT 'received' NOT NULL,
	"local_status_reason" text,
	"crowd_source_report_id" text,
	"crowd_source_case_id" text,
	"crowd_source_merged" boolean,
	"submitted_at" timestamp with time zone,
	"decision_id" text,
	"decision_revision" integer,
	"decision_outcome" text,
	"decision_status" text,
	"decided_at" timestamp with time zone,
	"enforced_action" text,
	"enforced_at" timestamp with time zone,
	"content_snapshot_hash" text,
	"last_delivery_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reports_reported_type_check" CHECK ("reports"."reported_type" in ('user', 'message', 'conversation')),
	CONSTRAINT "reports_status_check" CHECK ("reports"."status" in ('pending', 'reviewed', 'resolved', 'dismissed')),
	CONSTRAINT "reports_local_status_check" CHECK ("reports"."local_status" in ('received', 'queued', 'submitted', 'delivery_failed', 'closed')),
	CONSTRAINT "reports_enforced_action_check" CHECK ("reports"."enforced_action" in ('none', 'restrict', 'restore', 'manual_review')),
	CONSTRAINT "reports_categories_within_check" CHECK ("reports"."categories" <@ array['spam', 'hate_speech', 'harassment', 'misinformation', 'explicit_content', 'other']::text[]),
	CONSTRAINT "reports_categories_non_empty_check" CHECK (coalesce(array_length("reports"."categories", 1), 0) >= 1),
	CONSTRAINT "reports_decision_revision_check" CHECK ("reports"."decision_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"blocked_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restricts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"restricted_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_behaviors" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_behaviors_oxy_user_id_key" UNIQUE("oxy_user_id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"appearance_theme_mode" text DEFAULT 'system' NOT NULL,
	"appearance_primary_color" text,
	"profile_header_image" text,
	"privacy_profile_visibility" text DEFAULT 'public' NOT NULL,
	"privacy_show_contact_info" boolean DEFAULT true NOT NULL,
	"privacy_allow_tags" boolean DEFAULT true NOT NULL,
	"privacy_allow_allos" boolean DEFAULT true NOT NULL,
	"privacy_show_online_status" boolean DEFAULT true NOT NULL,
	"privacy_hide_like_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_share_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_reply_counts" boolean DEFAULT false NOT NULL,
	"privacy_hide_save_counts" boolean DEFAULT false NOT NULL,
	"privacy_hidden_words" text[] DEFAULT '{}' NOT NULL,
	"privacy_restricted_users" text[] DEFAULT '{}' NOT NULL,
	"profile_cover_photo_enabled" boolean DEFAULT true NOT NULL,
	"profile_minimalist_mode" boolean DEFAULT false NOT NULL,
	"profile_display_name" text,
	"profile_cover_image" text,
	"security_cloud_sync_enabled" boolean DEFAULT false NOT NULL,
	"security_encryption_enabled" boolean DEFAULT true NOT NULL,
	"security_peer_to_peer_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_settings_oxy_user_id_key" UNIQUE("oxy_user_id"),
	CONSTRAINT "user_settings_appearance_theme_mode_check" CHECK ("user_settings"."appearance_theme_mode" in ('light', 'dark', 'system')),
	CONSTRAINT "user_settings_privacy_profile_visibility_check" CHECK ("user_settings"."privacy_profile_visibility" in ('public', 'private', 'followers_only'))
);
--> statement-breakpoint
ALTER TABLE "bridge_link_sessions" ADD CONSTRAINT "bridge_link_sessions_result_account_id_bridge_accounts_id_fk" FOREIGN KEY ("result_account_id") REFERENCES "public"."bridge_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_proxy_lease_rotations" ADD CONSTRAINT "bridge_proxy_lease_rotations_lease_id_bridge_proxy_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."bridge_proxy_leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pre_keys" ADD CONSTRAINT "device_pre_keys_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_accounts_oxy_user_id_network_remote_login_id_key" ON "bridge_accounts" USING btree ("oxy_user_id","network","remote_login_id");--> statement-breakpoint
CREATE INDEX "bridge_accounts_oxy_user_id_idx" ON "bridge_accounts" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "bridge_accounts_state_last_state_at_idx" ON "bridge_accounts" USING btree ("state","last_state_at");--> statement-breakpoint
CREATE INDEX "bridge_accounts_network_remote_login_id_idx" ON "bridge_accounts" USING btree ("network","remote_login_id");--> statement-breakpoint
CREATE INDEX "bridge_accounts_slot_id_idx" ON "bridge_accounts" USING btree ("slot_id") WHERE "bridge_accounts"."slot_id" is not null;--> statement-breakpoint
CREATE INDEX "bridge_link_sessions_oxy_user_id_network_outcome_idx" ON "bridge_link_sessions" USING btree ("oxy_user_id","network","outcome");--> statement-breakpoint
CREATE INDEX "bridge_link_sessions_expires_at_idx" ON "bridge_link_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "bridge_proxy_lease_rotations_lease_id_rotated_at_idx" ON "bridge_proxy_lease_rotations" USING btree ("lease_id","rotated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_proxy_leases_oxy_user_id_network_key" ON "bridge_proxy_leases" USING btree ("oxy_user_id","network");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_participants_conversation_id_user_id_key" ON "conversation_participants" USING btree ("conversation_id","user_id");--> statement-breakpoint
CREATE INDEX "conversation_participants_user_id_idx" ON "conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_created_by_last_message_at_idx" ON "conversations" USING btree ("created_by","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_type_last_message_at_idx" ON "conversations" USING btree ("type","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_pre_keys_device_id_key_id_key" ON "device_pre_keys" USING btree ("device_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_id_device_id_key" ON "devices" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_deliveries_message_id_user_id_key" ON "message_deliveries" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_message_id_user_id_emoji_key" ON "message_reactions" USING btree ("message_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX "message_reactions_message_id_idx" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reads_message_id_user_id_key" ON "message_reads" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_sender_id_created_at_idx" ON "messages" USING btree ("sender_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_deleted_at_created_at_idx" ON "messages" USING btree ("conversation_id","deleted_at","created_at");--> statement-breakpoint
CREATE INDEX "moderation_events_case_id_idx" ON "moderation_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "moderation_events_state_received_at_idx" ON "moderation_events" USING btree ("state","received_at");--> statement-breakpoint
CREATE INDEX "moderation_events_expires_at_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_status_available_at_created_at_idx" ON "moderation_outbox" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_status_lease_until_created_at_idx" ON "moderation_outbox" USING btree ("status","lease_until","created_at");--> statement-breakpoint
CREATE INDEX "moderation_outbox_expires_at_idx" ON "moderation_outbox" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_reported_id_reported_type_key" ON "reports" USING btree ("reporter","reported_id","reported_type");--> statement-breakpoint
CREATE INDEX "reports_local_status_created_at_idx" ON "reports" USING btree ("local_status","created_at");--> statement-breakpoint
CREATE INDEX "reports_crowd_source_case_id_idx" ON "reports" USING btree ("crowd_source_case_id");--> statement-breakpoint
CREATE INDEX "reports_reported_id_idx" ON "reports" USING btree ("reported_id");--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_user_id_blocked_id_key" ON "blocks" USING btree ("user_id","blocked_id");--> statement-breakpoint
CREATE INDEX "blocks_blocked_id_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "restricts_user_id_restricted_id_key" ON "restricts" USING btree ("user_id","restricted_id");--> statement-breakpoint
CREATE INDEX "restricts_restricted_id_idx" ON "restricts" USING btree ("restricted_id");--> statement-breakpoint
-- `Conversation.pre('save')` and the `participants` array validator, expressed
-- in the database.
--
-- Both claims are CROSS-ROW once participants are their own table, so neither is
-- a CHECK. They are DEFERRABLE INITIALLY DEFERRED constraint triggers instead,
-- which is what makes the ordinary write legal: a transaction inserts the
-- conversation, then its participants, and the count is judged at COMMIT rather
-- than after the first statement. An immediate trigger would reject every
-- conversation ever created.
--
-- This closes a race the Mongoose hook never did. `pre('save')` ran in the
-- application against the document in memory, so two concurrent writes could
-- each remove a different participant from a two-person direct conversation and
-- both pass. Here the count is taken under the transaction's own visibility at
-- commit time, and one of the two is refused.
--
-- Deletion is deliberately silent: `ON DELETE CASCADE` removes a conversation's
-- participants, which fires this trigger with the conversation already gone, and
-- a check that raised then would make deleting a conversation impossible.
CREATE FUNCTION allo_check_conversation_participants(target_conversation_id text)
RETURNS void AS $$
DECLARE
  target_type text;
  participant_count integer;
BEGIN
  SELECT c.type INTO target_type FROM conversations c WHERE c.id = target_conversation_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO participant_count
  FROM conversation_participants p
  WHERE p.conversation_id = target_conversation_id;

  IF participant_count < 2 THEN
    RAISE EXCEPTION
      'conversation % has % participant(s); a conversation must have at least 2',
      target_conversation_id, participant_count
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'conversations_participant_count_check';
  END IF;

  IF target_type = 'direct' AND participant_count <> 2 THEN
    RAISE EXCEPTION
      'direct conversation % has % participants; a direct conversation must have exactly 2',
      target_conversation_id, participant_count
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'conversations_participant_count_check';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION allo_conversations_participant_count_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM allo_check_conversation_participants(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION allo_conversation_participants_count_trigger()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM allo_check_conversation_participants(OLD.conversation_id);
  ELSE
    PERFORM allo_check_conversation_participants(NEW.conversation_id);
    IF TG_OP = 'UPDATE' AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
      PERFORM allo_check_conversation_participants(OLD.conversation_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER conversations_participant_count_check
AFTER INSERT OR UPDATE ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION allo_conversations_participant_count_trigger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER conversation_participants_count_check
AFTER INSERT OR UPDATE OR DELETE ON conversation_participants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION allo_conversation_participants_count_trigger();
