import {
  conversationSecurity,
  ghostNamespacesFor,
  ghostNetworkFor,
  roomSummarySecurity,
  showsEncryptionPadlock,
} from '@/lib/chat/roomOrigin';
import type { AlloRoomPreview, AlloRoomSummary } from '@/lib/matrix/types';

/**
 * The rule from `docs/matrix/data-model.md` §5.3, which the design states out
 * loud *because this is where the mistake gets made*: the padlock is decided by
 * the encryption state, the network mark by the bridge, and mixing them is how a
 * padlock ends up on a room a bridge reads whole.
 *
 * The tests below are written to fail on that specific mistake rather than to
 * describe the implementation, which is why several of them assert about a room
 * that is BOTH encrypted and bridged. That combination is not hypothetical:
 * `bridges.md` §2.3 sets end-to-bridge encryption (`encryption.msc4190: true`) as
 * the Phase 1 rule for every bridge, so the Matrix room genuinely is encrypted
 * while a bridge holds the keys and reads every message in order to re-encrypt it
 * onto the remote network.
 */

const NAMESPACES = ghostNamespacesFor(['telegram', 'whatsapp']);

function preview(sender: string): AlloRoomPreview {
  return {
    sentAt: 1_700_000_000_000,
    sender,
    senderDisplayName: undefined,
    isOwn: false,
    content: { kind: 'text', body: 'hello', isEdited: false },
  };
}

function room(overrides: Partial<AlloRoomSummary> = {}): AlloRoomSummary {
  return {
    roomId: '!room:allo.you',
    displayName: 'Alice',
    avatarUrl: undefined,
    isDirect: true,
    membership: 'joined',
    encryption: 'encrypted',
    unreadCount: 0,
    latestMessage: undefined,
    ...overrides,
  };
}

describe('a bridged conversation never renders as encrypted', () => {
  it('refuses the padlock on a room that is encrypted AND bridged', () => {
    /**
     * The load-bearing case, and the one §5.3 gets wrong on its own.
     *
     * §5.3 nominates `latestEncryptionState() == NotEncrypted` as the PRIMARY
     * mark of a bridged room. Under §2.3's end-to-bridge encryption the room IS
     * encrypted, so that mark alone hands this room a padlock — a claim that only
     * the two humans can read it, made about a conversation a process in our own
     * cluster decrypts in full.
     */
    const security = conversationSecurity(
      'encrypted',
      ['@telegram_44556677:allo.you'],
      NAMESPACES,
    );

    expect(security).toEqual({ kind: 'bridged', networkId: 'telegram' });
    expect(showsEncryptionPadlock(security)).toBe(false);
  });

  it('refuses the padlock on an unencrypted bridged room too', () => {
    const security = conversationSecurity(
      'unencrypted',
      ['@whatsapp_34600111222:allo.you'],
      NAMESPACES,
    );

    expect(showsEncryptionPadlock(security)).toBe(false);
    expect(security).toEqual({ kind: 'bridged', networkId: 'whatsapp' });
  });

  it('still gives the padlock to an encrypted room with no bridge in it', () => {
    /**
     * The vacuity guard for both assertions above. Without it, an implementation
     * that never returned `end-to-end` at all would satisfy them perfectly and
     * the suite would be describing a padlock that does not exist.
     */
    const security = conversationSecurity('encrypted', ['@alice:allo.you'], NAMESPACES);

    expect(security).toEqual({ kind: 'end-to-end' });
    expect(showsEncryptionPadlock(security)).toBe(true);
  });

  it('says nothing about a room whose encryption state has not arrived', () => {
    /**
     * `unknown` genuinely means "this device does not know". An open padlock here
     * would report a fact nobody established, and it is the state every room is in
     * for the first moments after sync starts.
     */
    expect(conversationSecurity('unknown', [], NAMESPACES)).toEqual({ kind: 'none' });
    expect(showsEncryptionPadlock({ kind: 'none' })).toBe(false);
  });

  it('marks the room bridged when only one participant of several is a ghost', () => {
    /**
     * A bridged group has real people in it. Finding one ghost is enough and has
     * to be: a rule that required all participants to be ghosts would leave every
     * group conversation unmarked, which is exactly the population where the
     * padlock matters most.
     */
    const security = conversationSecurity(
      'encrypted',
      ['@alice:allo.you', '@bob:allo.you', '@telegram_99:allo.you'],
      NAMESPACES,
    );

    expect(security).toEqual({ kind: 'bridged', networkId: 'telegram' });
  });
});

describe('recognising an appservice ghost', () => {
  it('matches on the localpart and ignores the server name', () => {
    expect(ghostNetworkFor('@telegram_123:allo.you', NAMESPACES)).toBe('telegram');
    expect(ghostNetworkFor('@telegram_123:example.org', NAMESPACES)).toBe('telegram');
  });

  it('does not mistake a person whose name merely starts with a network', () => {
    /**
     * The separator is part of the prefix for this reason. `@telegramfan` is a
     * user; treating them as a ghost would strip the padlock from a genuinely
     * end-to-end conversation, which is the failure that runs the wrong way.
     */
    expect(ghostNetworkFor('@telegramfan:allo.you', NAMESPACES)).toBeUndefined();
    expect(ghostNetworkFor('@telegram:allo.you', NAMESPACES)).toBeUndefined();
  });

  it('ignores anything that is not a Matrix user id', () => {
    expect(ghostNetworkFor('telegram_123:allo.you', NAMESPACES)).toBeUndefined();
    expect(ghostNetworkFor('', NAMESPACES)).toBeUndefined();
  });

  it('recognises a network this build has never heard of, once the server enables it', () => {
    /**
     * §9.2: the app carries no list of networks. The namespaces are built from
     * what the server said, so a deployment turning Slack on is covered without an
     * app release — and a namespace list that had been hardcoded would leave those
     * rooms looking end-to-end.
     */
    const namespaces = ghostNamespacesFor(['slack']);

    expect(ghostNetworkFor('@slack_U123:allo.you', namespaces)).toBe('slack');
    expect(
      conversationSecurity('encrypted', ['@slack_U123:allo.you'], namespaces),
    ).toEqual({ kind: 'bridged', networkId: 'slack' });
  });

  it('finds no ghost when no network is enabled', () => {
    expect(ghostNetworkFor('@telegram_123:allo.you', [])).toBeUndefined();
    expect(conversationSecurity('encrypted', ['@telegram_123:allo.you'], [])).toEqual({
      kind: 'end-to-end',
    });
  });
});

describe('deciding from a room-list summary', () => {
  it('reads the one Matrix id a summary carries', () => {
    expect(
      roomSummarySecurity(
        room({ latestMessage: preview('@telegram_777:allo.you') }),
        NAMESPACES,
      ),
    ).toEqual({ kind: 'bridged', networkId: 'telegram' });
  });

  it('falls back to the encryption state when there is no message yet', () => {
    expect(roomSummarySecurity(room({ latestMessage: undefined }), NAMESPACES)).toEqual({
      kind: 'end-to-end',
    });
  });

  it('degrades towards saying less, never towards claiming more', () => {
    /**
     * The documented limitation, pinned so it cannot be forgotten: a summary
     * carries only the sender of its latest message, so a bridged conversation
     * whose last message is the user's own has no ghost to find.
     *
     * The point of the assertion is the direction of the error. Partial
     * information turns `bridged` into `end-to-end` here — which is the hole
     * `roomOrigin.ts` names in its header and which the `m.bridge` state event
     * would close. It must never turn `end-to-end` into a confident claim about
     * a room nobody looked at.
     */
    const ownMessage = roomSummarySecurity(
      room({ encryption: 'unencrypted', latestMessage: preview('@me:allo.you') }),
      NAMESPACES,
    );

    expect(ownMessage).toEqual({ kind: 'none' });
    expect(showsEncryptionPadlock(ownMessage)).toBe(false);
  });
});
