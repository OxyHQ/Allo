import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';

import { Header } from '@/components/layout/Header';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { matrixInvitations } from '@/lib/chat/invitations';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * What an invitation looks like before it is a conversation.
 *
 * A room the viewer has been invited to is in the list — the port's definition
 * of a conversation is everything the viewer has not left — and it is not one
 * yet: there is no readable timeline in it until the invitation is accepted.
 * Drawing it as an ordinary conversation is what makes a family group look
 * broken to the family: an empty thread, a composer that sends into a room they
 * are not in, and no way to join.
 *
 * Nothing here navigates on success. Accepting changes the room's membership on
 * the homeserver, sync reports it, the room list stops calling it an invitation
 * and the route draws the conversation instead — one source of truth, arriving
 * the way every other fact about a room does.
 */
export function MatrixInvitationCard({
  roomId,
  name,
}: {
  readonly roomId: string;
  /** What the list calls this room. A room id while sync has nothing better. */
  readonly name: string;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const [answer, setAnswer] = useState<'accepting' | 'declining' | undefined>(undefined);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          backgroundColor: theme.colors.background,
        },
        container: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        },
        title: {
          fontSize: 17,
          fontWeight: '600',
          color: theme.colors.text,
          textAlign: 'center',
        },
        detail: {
          fontSize: 15,
          lineHeight: 22,
          color: theme.colors.textSecondary,
          textAlign: 'center',
          marginTop: 8,
          maxWidth: 320,
        },
        actions: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginTop: 24,
        },
        button: {
          paddingHorizontal: 24,
          paddingVertical: 12,
          borderRadius: 24,
          minWidth: 120,
          alignItems: 'center',
          backgroundColor: theme.colors.primary,
        },
        declineButton: {
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        buttonLabel: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.background,
        },
        declineLabel: {
          color: theme.colors.text,
        },
        busy: {
          opacity: 0.5,
        },
      }),
    [theme.colors],
  );

  const accept = useCallback(async () => {
    if (answer !== undefined) {
      return;
    }
    setAnswer('accepting');
    try {
      await matrixInvitations.accept(roomId);
    } catch (error: unknown) {
      logger.error('[chat] an invitation could not be accepted', error);
      toast.error(getErrorMessage(error) || t('Allo could not join this conversation'));
      setAnswer(undefined);
    }
    // Left busy on success on purpose: the room's membership has changed and
    // this component is about to be replaced by the conversation itself, as
    // soon as sync says so. Clearing it would offer the buttons again in the
    // gap.
  }, [answer, roomId, t]);

  const decline = useCallback(async () => {
    if (answer !== undefined) {
      return;
    }
    setAnswer('declining');
    try {
      await matrixInvitations.decline(roomId);
      // Declining removes the room from the list, so this route now names
      // nothing. The conversation list is the only honest place to be.
      router.replace('/');
    } catch (error: unknown) {
      logger.error('[chat] an invitation could not be declined', error);
      toast.error(getErrorMessage(error) || t('Allo could not decline this invitation'));
      setAnswer(undefined);
    }
  }, [answer, roomId, router, t]);

  const busy = answer !== undefined;
  return (
    <View style={styles.screen}>
      {/* An invitation is not a conversation, so there is no conversation
          header to draw here — and without one there is no way back on a
          platform with no gesture for it. */}
      <Header options={{ title: name, showBackButton: true }} />
      <View style={styles.container}>
        <ThemedText style={styles.title}>{name}</ThemedText>
        <ThemedText style={styles.detail}>
          {t('You have been invited to this conversation. Join it to read what is sent from now on.')}
        </ThemedText>
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={[styles.button, styles.declineButton, busy && styles.busy]}
            disabled={busy}
            onPress={() => {
              void decline();
            }}
          >
            {answer === 'declining' ? (
              <ActivityIndicator color={theme.colors.text} />
            ) : (
              <ThemedText style={[styles.buttonLabel, styles.declineLabel]}>
                {t('Decline')}
              </ThemedText>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={[styles.button, busy && styles.busy]}
            disabled={busy}
            onPress={() => {
              void accept();
            }}
          >
            {answer === 'accepting' ? (
              <ActivityIndicator color={theme.colors.background} />
            ) : (
              <ThemedText style={styles.buttonLabel}>{t('Join')}</ThemedText>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
