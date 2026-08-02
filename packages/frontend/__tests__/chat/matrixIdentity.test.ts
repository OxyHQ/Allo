import {
  MatrixIdentityError,
  matrixServerNameOf,
  matrixUserIdFor,
} from '@/lib/chat/matrixIdentity';

/**
 * Naming an Oxy account on the homeserver.
 *
 * The screens know people by their Oxy id and a homeserver knows nobody by that
 * name, so every invitation goes through this. `docs/matrix/data-model.md` §6.2
 * requires the derivation to be deterministic precisely so that it can be
 * arithmetic instead of a table — and the part that has to be got right is what
 * it does with an id that does not fit, because the tempting repair is how two
 * people end up sharing one MXID.
 */

const OXY_ID = '507f1f77bcf86cd799439011';

describe('matrixServerNameOf', () => {
  it('reads the homeserver out of the viewer’s own user id', () => {
    // From the session rather than from configuration: a homeserver URL is not
    // a server name, and a variable holding the name is one more thing that can
    // disagree with the account the app is signed into.
    expect(matrixServerNameOf(`@${OXY_ID}:allo.you`)).toBe('allo.you');
  });

  it('keeps a port, which is part of the name', () => {
    expect(matrixServerNameOf('@someone:localhost:8448')).toBe('localhost:8448');
  });

  it('refuses something that is not a user id', () => {
    expect(() => matrixServerNameOf('allo.you')).toThrow(MatrixIdentityError);
    expect(() => matrixServerNameOf('@nobody')).toThrow(MatrixIdentityError);
    expect(() => matrixServerNameOf('')).toThrow(MatrixIdentityError);
  });

  it('refuses a user id that names no homeserver', () => {
    expect(() => matrixServerNameOf('@someone:')).toThrow(MatrixIdentityError);
  });
});

describe('matrixUserIdFor', () => {
  it('builds the user id of an Oxy account on this homeserver', () => {
    expect(matrixUserIdFor(OXY_ID, 'allo.you')).toBe(`@${OXY_ID}:allo.you`);
  });

  it('accepts an id with surrounding space, which is not a different id', () => {
    expect(matrixUserIdFor(`  ${OXY_ID}  `, 'allo.you')).toBe(`@${OXY_ID}:allo.you`);
  });

  it.each([
    ['uppercase', '507F1F77BCF86CD799439011'],
    ['a space inside', '507f1f77 bcf86cd7'],
    ['an at sign', '@507f1f77bcf86cd799439011'],
    ['a colon', '507f1f77:bcf86cd7'],
    ['an accent', 'josé'],
  ])('refuses an Oxy id with %s rather than repairing it', (_what, oxyUserId) => {
    // The repair — lowercase it and drop what is left — is how two distinct
    // people are squeezed into one localpart. On this side that is an
    // invitation sent to the wrong person; on the backend's side of the same
    // arithmetic it is an account takeover. Failing one attempt loudly is the
    // only outcome that is neither.
    expect(() => matrixUserIdFor(oxyUserId, 'allo.you')).toThrow(MatrixIdentityError);
  });

  it('refuses an empty id, which names nobody', () => {
    expect(() => matrixUserIdFor('   ', 'allo.you')).toThrow(MatrixIdentityError);
  });

  it('refuses a user id no homeserver would accept', () => {
    // 255 bytes, sigil and server name included. Everything that gets this far
    // is ASCII — the localpart by its grammar, the server name by Matrix's —
    // so the character count is the byte count.
    expect(() => matrixUserIdFor('a'.repeat(256), 'allo.you')).toThrow(MatrixIdentityError);
  });
});
