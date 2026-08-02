import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { NetworkGlyph } from '@/components/bridges/NetworkGlyph';
import { showsEncryptionPadlock, type ConversationSecurity } from '@/lib/chat/roomOrigin';

/**
 * The only place in Allo that draws a padlock next to a conversation.
 *
 * ## Why it is one component
 *
 * `docs/matrix/data-model.md` §5.3 says the rule out loud *because this is where
 * the mistake gets made*: the padlock is decided by the encryption state, the
 * network mark by the bridge, and mixing them is how a padlock ends up on a room
 * a bridge reads whole. Keeping both marks in one component means there is one
 * `if` in the codebase that can draw a padlock, and it goes through
 * `showsEncryptionPadlock` — which under end-to-bridge encryption (`bridges.md`
 * §2.3) is emphatically not the same question as "is the room encrypted".
 *
 * ## Nothing is drawn for `none`
 *
 * Not an open padlock, not a struck-through one. `none` covers an unencrypted
 * room and a room whose encryption state has not synced yet, and an icon that
 * announced "not encrypted" for the second case would be reporting a fact nobody
 * established. Conversations from the Express API have no security value at all
 * and land here the same way.
 */

export interface ConversationSecurityMarkProps {
  readonly security: ConversationSecurity | undefined;
  readonly size: number;
  readonly color: string;
  /**
   * The network's name as the server spells it, when the caller has it.
   *
   * The conversation list does not: a room summary carries a network id and
   * nothing else, and fetching the catalogue to label a glyph would put a request
   * behind a scrolling list. {@link titleCase} covers that case and is right for
   * every id in the catalogue but `whatsapp`, where it produces "Whatsapp" in a
   * label a screen reader speaks aloud and nowhere else.
   */
  readonly networkDisplayName?: string;
}

/** `telegram` → `Telegram`. Only ever a fallback; see {@link ConversationSecurityMarkProps}. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function ConversationSecurityMark({
  security,
  size,
  color,
  networkDisplayName,
}: ConversationSecurityMarkProps) {
  const { t } = useTranslation();

  if (security === undefined) return null;

  if (security.kind === 'bridged') {
    const name = networkDisplayName ?? titleCase(security.networkId);
    return (
      <NetworkGlyph
        networkId={security.networkId}
        displayName={name}
        size={size}
        color={color}
        accessibilityLabel={t('bridges.mark.bridged', {
          network: name,
          defaultValue: '{{network}} · not end-to-end encrypted',
        })}
      />
    );
  }

  if (showsEncryptionPadlock(security)) {
    return (
      <Ionicons
        name="lock-closed"
        size={size}
        color={color}
        accessibilityLabel={t('bridges.mark.endToEnd', {
          defaultValue: 'End-to-end encrypted',
        })}
      />
    );
  }

  return null;
}
