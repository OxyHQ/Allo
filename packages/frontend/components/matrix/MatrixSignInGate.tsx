import React, { useMemo, useRef } from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import { useMatrixRuntime, signInToMatrix } from '@/hooks/useMatrixRuntime';
import { useTheme } from '@/hooks/useTheme';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { shouldAutoSignIn } from '@/lib/chat/matrixAutoSignIn';
import { matrixSignInAttempt } from '@/lib/chat/matrixSignInAttempt';

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
  //
  // It answers a narrower question than `matrixSignInAttempt` below — "did THIS
  // component start one", not "has this run started one" — and the two are not
  // interchangeable. On web the run outlives the page, so a browser that comes
  // back from the authorization server with nothing usable finds the marker set;
  // reading that as "starting right now" would draw a spinner over a screen that
  // owes the person a button.
  const startedHere = useRef(false);

  // Read during render rather than from an Effect, because this is a decision
  // about the state just computed — not a synchronisation with anything
  // outside. `signInToMatrix` publishes its progress through the runtime, which
  // re-renders this component on its own.
  if (
    CHAT_BACKEND === 'matrix' &&
    shouldAutoSignIn({
      phase: runtime.phase,
      hasOxySession: user?.id !== undefined,
      alreadyAttempted: matrixSignInAttempt.started(),
    })
  ) {
    // Recorded before the sign-in starts, so that a second render — StrictMode's,
    // or another gate mounting — sees the attempt rather than starting a second
    // one.
    matrixSignInAttempt.record();
    startedHere.current = true;
    signInToMatrix();
  }

  // Starting it does not move the phase within this render, so without this the
  // pass that begins the sign-in still draws the screen offering to begin it —
  // the exact screen the automatic start exists to remove, shown for as long as
  // the runtime takes to react. The phase leaves `signed-out` on its own, to
  // `authorizing` or `leaving` when the browser opens or `failed` when it cannot,
  // and all three are handled below.
  const startingItself = startedHere.current && runtime.phase === 'signed-out';

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

  // ANOTHER WINDOW OF ALLO IS IN THE WAY, AND ONLY THE READER CAN MOVE IT.
  //
  // Before this screen existed the app drew "Connecting…" and kept drawing it:
  // the launch has to empty the chat data on this device before it opens it, a
  // second window holding that data open makes the deletion wait, and the wait
  // had nowhere to appear. What it looked like from the outside was an app that
  // had stopped, with the reason in a console line nobody was reading.
  //
  // A spinner is still right here, because this really is still working and it
  // really does finish by itself — closing the other window completes the
  // deletion and the phase moves on with nothing else asked of anybody. What
  // was missing was the sentence next to it.
  if (runtime.phase === 'blocked') {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
        <ThemedText style={styles.title}>{t('Allo is open in another tab')}</ThemedText>
        <ThemedText style={styles.detail}>
          {t('Close the other Allo tab and this one will carry on by itself.')}
        </ThemedText>
      </View>
    );
  }

  // The same request, after the app has stopped waiting for it.
  //
  // No spinner: nothing is running any more, and a spinner over a stopped launch
  // is the lie this whole screen was written to stop telling. The button is the
  // way out, and it is honest — pressing it starts the launch again, which tries
  // the deletion again, which works the moment the other window is gone.
  //
  // What is deliberately NOT here is a way to continue anyway. The data that
  // could not be deleted is the last account's synced state and keys.
  if (runtime.phase === 'blocked-timed-out') {
    return (
      <View style={styles.container}>
        <ThemedText style={styles.title}>{t('Allo is still open in another tab')}</ThemedText>
        <ThemedText style={styles.detail}>
          {t('Close every other Allo tab or window, then try again.')}
        </ThemedText>
        <TouchableOpacity
          accessibilityRole="button"
          style={styles.button}
          onPress={signInToMatrix}
        >
          <ThemedText style={styles.buttonLabel}>{t('Try again')}</ThemedText>
        </TouchableOpacity>
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

  // Web, and the two ends of the redirect. `leaving` is drawn for the moment
  // between asking the browser to navigate and the browser doing it, and then it
  // goes with the page; `finishing` is the page that comes back, exchanging the
  // code for a session. Neither is `authorizing`: nothing here is waiting on a
  // browser, and a screen telling somebody to go and finish something they have
  // already finished is worse than no screen at all.
  if (runtime.phase === 'leaving') {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
        <ThemedText style={styles.title}>{t('Taking you to sign in…')}</ThemedText>
      </View>
    );
  }

  if (runtime.phase === 'finishing') {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={styles.spinner} color={theme.colors.primary} />
        <ThemedText style={styles.title}>{t('Finishing your sign-in…')}</ThemedText>
      </View>
    );
  }

  // WHAT IS MISSING HERE IS THE CHAT, NOT THE PERSON.
  //
  // Whoever reads this is signed in: the Oxy session is live, their avatar is
  // drawn in the sidebar, and everything the app knows about them it already
  // knows. The one thing absent is a Matrix access token. "Allo could not sign
  // you in" said the opposite, and next to their own face it read as a second
  // account they were being asked to keep — which is not what this is. The
  // Matrix identity is derived from the Oxy one; there is only ever one account.
  //
  // The detail names the hop rather than hiding it. The browser genuinely leaves
  // Allo for Oxy and comes back, so copy promising something instant would be a
  // lie one redirect later.
  const failed = runtime.phase === 'failed';
  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>
        {failed ? t('Allo could not connect your chat') : t('Connect your chat')}
      </ThemedText>
      <ThemedText style={styles.detail}>
        {failed
          ? (runtime.error ?? t('Something went wrong. Try again.'))
          : t('Allo will take you to Oxy for a moment and bring you straight back.')}
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
