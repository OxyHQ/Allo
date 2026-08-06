import React, { useMemo, useRef } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import { useMatrixRuntime, signInToMatrix } from '@/hooks/useMatrixRuntime';
import { useTheme } from '@/hooks/useTheme';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { shouldAutoSignIn } from '@/lib/chat/matrixAutoSignIn';

/**
 * Stands between the chat UI and a Matrix client that is not ready yet.
 *
 * Allo's homeserver hands out sessions through Matrix Authentication Service with
 * Oxy upstream, so there is no Matrix password and signing in means handing
 * control to a browser and getting it back. That takes a screen of its own, and
 * this is the smallest one that tells the truth about each state it can be in.
 *
 * With the chat backend set to `allo-api` this renders its children and nothing
 * else — the component is not in the way of the app as it was.
 */
export function MatrixSignInGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const runtime = useMatrixRuntime();
  const { user } = useOxy();
  // A ref, not state: starting the sign-in must not itself cause a render, and
  // nothing on screen depends on whether it has been tried.
  const attempted = useRef(false);

  // Read during render rather than from an Effect, because this is a decision
  // about the state just computed — not a synchronisation with anything
  // outside. `signInToMatrix` publishes its progress through the runtime, which
  // re-renders this component on its own.
  if (
    CHAT_BACKEND === 'matrix' &&
    shouldAutoSignIn({
      phase: runtime.phase,
      hasOxySession: user?.id !== undefined,
      alreadyAttempted: attempted.current,
    })
  ) {
    attempted.current = true;
    signInToMatrix();
  }

  // Starting it does not move the phase within this render, so without this the
  // pass that begins the sign-in still draws the screen offering to begin it —
  // the exact screen the automatic start exists to remove, shown for as long as
  // the runtime takes to react. The phase leaves `signed-out` on its own, to
  // `authorizing` when the browser opens or `failed` when it cannot, and both
  // are handled below.
  const startingItself = attempted.current && runtime.phase === 'signed-out';

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          backgroundColor: theme.colors.background,
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
        button: {
          marginTop: 24,
          paddingHorizontal: 24,
          paddingVertical: 12,
          borderRadius: 24,
          backgroundColor: theme.colors.primary,
        },
        buttonLabel: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.background,
        },
        spinner: {
          marginBottom: 16,
        },
      }),
    [theme.colors],
  );

  if (CHAT_BACKEND !== 'matrix' || runtime.phase === 'ready') {
    return <>{children}</>;
  }

  if (runtime.phase === 'idle' || runtime.phase === 'starting' || startingItself) {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
        <ThemedText style={styles.title}>{t('Connecting…')}</ThemedText>
      </View>
    );
  }

  if (runtime.phase === 'authorizing') {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
        <ThemedText style={styles.title}>{t('Finish signing in')}</ThemedText>
        <ThemedText style={styles.detail}>
          {t('Allo is waiting for the sign-in page in your browser.')}
        </ThemedText>
      </View>
    );
  }

  const failed = runtime.phase === 'failed';
  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>
        {failed ? t('Allo could not sign you in') : t('Connect your chat')}
      </ThemedText>
      <ThemedText style={styles.detail}>
        {failed
          ? (runtime.error ?? t('Something went wrong. Try again.'))
          : t('One more step and your conversations are here.')}
      </ThemedText>
      <TouchableOpacity
        accessibilityRole="button"
        style={styles.button}
        onPress={signInToMatrix}
      >
        <ThemedText style={styles.buttonLabel}>
          {failed ? t('Try again') : t('Continue')}
        </ThemedText>
      </TouchableOpacity>
    </View>
  );
}
