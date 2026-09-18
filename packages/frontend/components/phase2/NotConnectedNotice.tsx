import React from 'react';
import { Admonition } from '@oxy.so/bloom/admonition';

/**
 * THE ONE SENTENCE EVERY PHASE 2 SCREEN OWES THE READER.
 *
 * Calls, stories and presence are drawn from a state layer that lives in this
 * tab (`lib/phase2/`). There is no transport behind any of them: nothing is
 * placed, nothing is posted and nothing is sent to anybody. A screen that looks
 * exactly like the working one and says nothing is a screen that promises a
 * person heard you, so each of them carries this — once, quietly, at the top,
 * in Bloom's `info` admonition rather than an alarm.
 *
 * It is deliberately not dismissible and not a toast: a toast is gone in four
 * seconds and this stays true for as long as the screen does.
 */
export function NotConnectedNotice({ children }: { children: string }) {
  return <Admonition type="info">{children}</Admonition>;
}
