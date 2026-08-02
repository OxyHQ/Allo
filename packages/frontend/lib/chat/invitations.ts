import { matrixRuntime, type MatrixRuntimeLike } from './matrixRuntime';

/**
 * Answering an invitation.
 *
 * The other end of `matrixConversations.ts`: creating a group invites the
 * people in it, and until each of them joins, what they have is a row in the
 * list with no timeline behind it. Allo's own backend has no equivalent — there
 * are no invitations there, a participant is simply in the conversation — so
 * unlike creating one, this has no `allo-api` half and no seam to choose
 * between two. A screen that needs it is a screen that already knows it is
 * looking at `Conversation.isInvitation`, which only the Matrix path sets.
 *
 * Neither call answers with anything. What changes is the room's membership,
 * and the app hears about that the same way it hears about everything else: the
 * room list is fed by sync, so the row stops being an invitation when the
 * homeserver says it has.
 */
export class MatrixInvitations {
  readonly #runtime: MatrixRuntimeLike;

  constructor(runtime: MatrixRuntimeLike) {
    this.#runtime = runtime;
  }

  readonly accept = async (roomId: string): Promise<void> => {
    await this.#runtime.client('Accepting an invitation').acceptInvitation(roomId);
  };

  /**
   * Refuses an invitation, which in Matrix is leaving the room it is to.
   *
   * The port has one call for both because the protocol has one operation for
   * both; what makes this a refusal rather than a departure is only that the
   * viewer had not joined. See {@link AlloChatClient.leaveRoom}.
   */
  readonly decline = async (roomId: string): Promise<void> => {
    await this.#runtime.client('Declining an invitation').leaveRoom(roomId);
  };
}

/** The app's one responder, bound to the app's runtime. */
export const matrixInvitations = new MatrixInvitations(matrixRuntime);
