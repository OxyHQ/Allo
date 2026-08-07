import {
  MatrixIdentityError,
  matrixServerNameOf,
  matrixUserIdFor,
  matrixUserIdsIn,
  oxyUserIdFrom,
  parseMatrixUserId,
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

describe('parseMatrixUserId', () => {
  it('splits on the first colon, so a port stays with the server', () => {
    // An IPv6 literal holds several colons and a localpart holds none, so the
    // first one is the only split that is right in both cases.
    expect(parseMatrixUserId('@alba:localhost:8448')).toEqual({
      localpart: 'alba',
      serverName: 'localhost:8448',
    });
    expect(parseMatrixUserId('@alba:[::1]:8448')).toEqual({
      localpart: 'alba',
      serverName: '[::1]:8448',
    });
  });

  it('reads a localpart the modern grammar would reject', () => {
    // Wider on the way in than on the way out. A bridge's puppet and any
    // account from before the modern rules have to be RECOGNISED as user ids,
    // because a string that is not recognised as one is left on screen verbatim.
    expect(parseMatrixUserId('@whatsapp_34600111222:allo.you')?.localpart).toBe(
      'whatsapp_34600111222',
    );
    expect(parseMatrixUserId('@Alice:matrix.org')?.localpart).toBe('Alice');
  });

  it.each([
    ['no sigil', 'alba:allo.you'],
    ['no colon', '@alba'],
    ['an empty localpart', '@:allo.you'],
    ['an empty server name', '@alba:'],
    ['a space in the localpart', '@al ba:allo.you'],
    ['nothing at all', ''],
  ])('refuses a string with %s', (_what, value) => {
    expect(parseMatrixUserId(value)).toBeUndefined();
  });

  it('refuses a user id past the 255-byte cap', () => {
    const tooLong = `@${'a'.repeat(250)}:allo.you`;
    expect(tooLong.length).toBeGreaterThan(255);
    expect(parseMatrixUserId(tooLong)).toBeUndefined();
  });
});

describe('oxyUserIdFrom', () => {
  it('is the exact inverse of matrixUserIdFor', () => {
    // The round trip is the whole claim `data-model.md` §6.2 makes: the mapping
    // is arithmetic in both directions, so neither side needs a table.
    expect(oxyUserIdFrom(matrixUserIdFor(OXY_ID, 'allo.you'), 'allo.you')).toBe(OXY_ID);
  });

  it('refuses a localpart that is not an Oxy id, rather than coercing one', () => {
    // The mirror of `matrixUserIdFor`'s refusal, and the same hazard read
    // backwards: pad, trim or lowercase a localpart into an Oxy id and the
    // lookup succeeds — against somebody else, whose name and face are then
    // drawn over a stranger's messages.
    expect(oxyUserIdFrom('@alba:allo.you', 'allo.you')).toBeUndefined();
    expect(oxyUserIdFrom(`@${OXY_ID}x:allo.you`, 'allo.you')).toBeUndefined();
    expect(oxyUserIdFrom(`@${OXY_ID.slice(0, 23)}:allo.you`, 'allo.you')).toBeUndefined();
    expect(oxyUserIdFrom('@507F1F77BCF86CD799439011:allo.you', 'allo.you')).toBeUndefined();
    expect(oxyUserIdFrom('@507f1f77bcf86cd79943901z:allo.you', 'allo.you')).toBeUndefined();
  });

  it("refuses a bridge's puppet, which is not an Oxy account at all", () => {
    expect(oxyUserIdFrom('@whatsapp_34600111222:allo.you', 'allo.you')).toBeUndefined();
    // Even one whose remote id happens to be shaped like an Oxy ObjectId: the
    // namespace prefix is part of the localpart, so it is not one.
    expect(oxyUserIdFrom(`@telegram_${OXY_ID}:allo.you`, 'allo.you')).toBeUndefined();
  });

  it('refuses a user on another homeserver, whose localpart means nothing here', () => {
    expect(oxyUserIdFrom(`@${OXY_ID}:matrix.org`, 'allo.you')).toBeUndefined();
  });

  it('refuses a user id past the 255-byte cap', () => {
    expect(oxyUserIdFrom(`@${'a'.repeat(250)}:allo.you`, 'allo.you')).toBeUndefined();
  });

  it('refuses something that is not a user id', () => {
    // `undefined` and not a throw, unlike the forward direction: this is asked
    // about every member of every room, and "not an Oxy account" is a routine,
    // correct answer with a rendering of its own.
    expect(oxyUserIdFrom('Familia', 'allo.you')).toBeUndefined();
    expect(oxyUserIdFrom('', 'allo.you')).toBeUndefined();
  });
});

describe('matrixUserIdsIn', () => {
  it('finds the one id a direct conversation is titled with', () => {
    expect(matrixUserIdsIn(`@${OXY_ID}:allo.you`)).toEqual([`@${OXY_ID}:allo.you`]);
  });

  it('finds every id in a title an SDK composed from the members', () => {
    // What both SDKs produce for a group with no `m.room.name` when nobody in it
    // has a Matrix display name, which on Allo's homeserver is everybody.
    expect(matrixUserIdsIn('@aaa:allo.you, @bbb:allo.you and 2 others')).toEqual([
      '@aaa:allo.you',
      '@bbb:allo.you',
    ]);
  });

  it('does not eat the punctuation after an id', () => {
    // The server half is matched as dot-separated labels, so a full stop at the
    // end of a sentence is not read as another one.
    expect(matrixUserIdsIn('ask @aaa:allo.you.')).toEqual(['@aaa:allo.you']);
    expect(matrixUserIdsIn('@aaa:allo.you, then')).toEqual(['@aaa:allo.you']);
  });

  it('reports each id once, however often it appears', () => {
    expect(matrixUserIdsIn('@aaa:allo.you and @aaa:allo.you')).toEqual(['@aaa:allo.you']);
  });

  it('re-checks what the scan found instead of trusting it', () => {
    // The scan is deliberately wider than the grammar, so its candidates go back
    // through `parseMatrixUserId`. Without that, a string past the 255-byte cap
    // comes out as an id — and a caller would then substitute a name for
    // something no homeserver could ever have issued.
    const tooLong = `@${'a'.repeat(250)}:allo.you`;
    expect(tooLong.length).toBeGreaterThan(255);
    expect(matrixUserIdsIn(`talking to ${tooLong}`)).toEqual([]);
  });

  it('finds nothing in a name somebody typed', () => {
    // A title with no user id in it must come back byte for byte, which is what
    // an empty list gives the caller.
    expect(matrixUserIdsIn('Familia')).toEqual([]);
    expect(matrixUserIdsIn('budget@work: 2026')).toEqual([]);
    expect(matrixUserIdsIn('')).toEqual([]);
  });
});
