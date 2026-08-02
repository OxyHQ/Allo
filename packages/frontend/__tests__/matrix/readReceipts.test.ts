import { markReadByOthers, type AlloReadRow } from '@/lib/matrix/readReceipts';

/**
 * Turning "whose receipt names this event" into "has anybody seen this message".
 *
 * The whole reason this function exists is that the two are not the same
 * question. A Matrix receipt is a high-water mark: it names the newest event a
 * user has read and covers everything before it, so in any conversation somebody
 * has actually read, exactly one event carries a receipt and every earlier one
 * carries none. Answering per row is answering the wrong question.
 */

const ALICE = '@alice:allo.you';
const BEA = '@bea:allo.you';
const CARLA = '@carla:allo.you';

function row(sender: string, readers: readonly string[] = []): AlloReadRow {
  return { sender, readers };
}

describe('markReadByOthers', () => {
  it('marks every row before the one the receipt names', () => {
    // The case the whole function exists for. Bea's receipt sits on the last
    // message, and it says she has read the two before it as well.
    const flags = markReadByOthers([
      row(ALICE),
      row(ALICE),
      row(ALICE, [BEA]),
    ]);

    expect(flags).toEqual([true, true, true]);
  });

  it('leaves the rows after the receipt unread', () => {
    const flags = markReadByOthers([
      row(ALICE, [BEA]),
      row(ALICE),
      row(ALICE),
    ]);

    expect(flags).toEqual([true, false, false]);
  });

  it('does not count a sender reading their own message', () => {
    // Clients send a receipt for the message they have just sent. Counting it
    // would put the read mark on every outgoing message the moment it came back
    // down sync, which is a mark that means nothing at all.
    expect(markReadByOthers([row(ALICE, [ALICE])])).toEqual([false]);
  });

  it('counts a reader who is not the sender even when the sender is there too', () => {
    expect(markReadByOthers([row(ALICE, [ALICE, BEA])])).toEqual([true]);
  });

  it('answers each row against its own sender', () => {
    // A group conversation, where consecutive rows have different senders and
    // the same receipt means different things to each of them.
    const flags = markReadByOthers([
      row(BEA),
      row(ALICE),
      row(BEA, [BEA]),
    ]);

    // Bea's own two messages are not read by anybody but Bea; Alice's is.
    expect(flags).toEqual([false, true, false]);
  });

  it('keeps counting receipts met further along', () => {
    const flags = markReadByOthers([
      row(ALICE),
      row(ALICE, [BEA]),
      row(ALICE, [CARLA]),
    ]);

    expect(flags).toEqual([true, true, true]);
  });

  it('reports nothing read when nobody has a receipt', () => {
    expect(markReadByOthers([row(ALICE), row(ALICE)])).toEqual([false, false]);
  });

  it('answers an empty timeline with an empty list', () => {
    expect(markReadByOthers([])).toEqual([]);
  });
});
