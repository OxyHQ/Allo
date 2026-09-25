import { useEffect } from 'react';
import { Linking } from 'react-native';
import { useRouter, type Href } from 'expo-router';

import { hrefFromUrl, rememberPendingHref, takePendingHref } from './pendingHref';

/**
 * The launch URL is a destination once per process. Without this, signing out
 * and back in would replay the link the app was opened with an hour ago.
 */
let initialUrlRead = false;

/** Test seam: forget that the launch URL was read. */
export function resetInitialUrlForTests(): void {
  initialUrlRead = false;
}

/**
 * KEEP A DEEP LINK THROUGH SIGN-IN.
 *
 * While signed out, every URL that opens the app — the one it was launched with
 * and any that arrive while it runs — is remembered, because the root stack is
 * about to redirect it to the welcome screen. When the session appears (a
 * sign-in, or a stored session that finished restoring after the first render),
 * the remembered href replaces the chat list the redirect would otherwise show.
 *
 * `Linking.getInitialURL()` is the launch URL on native, and on web it is the
 * address react-native-web captured when the bundle loaded — before the router
 * redirected anything — so both platforms read the link as it was opened.
 */
export function usePendingHref(signedIn: boolean): void {
  const router = useRouter();

  // Subscribed only while signed out: the cleanup runs the moment a session
  // appears, so neither a late launch URL nor a later link is recorded then.
  useEffect(() => {
    if (signedIn) return undefined;
    let active = true;

    if (!initialUrlRead) {
      initialUrlRead = true;
      Linking.getInitialURL()
        .then((url) => {
          if (active) rememberPendingHref(hrefFromUrl(url));
        })
        .catch(() => undefined);
    }

    const subscription = Linking.addEventListener('url', ({ url }) => {
      rememberPendingHref(hrefFromUrl(url));
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    const href = takePendingHref();
    // The href is a path parsed out of the URL the app was opened with, so it can
    // only name a screen of this app; one that does not exist gets the 404.
    if (href) router.replace(href as Href);
  }, [signedIn, router]);
}
