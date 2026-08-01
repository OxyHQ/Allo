import {
  MatrixListDiffError,
  applyListUpdate,
  type SdkListUpdate,
} from '@/lib/matrix/native/listDiff';

/**
 * The binding never hands over a list, only a stream of diffs against one Rust
 * keeps. Every message a user sees arrives through this function, and every index
 * in every later diff assumes it applied the earlier ones exactly: an off-by-one
 * here does not lose a message, it silently reorders a conversation.
 *
 * These cases are written against plain strings rather than SDK objects on
 * purpose — the reconciliation is the part with the logic in it, and it has none
 * of the SDK in it.
 */

function apply(list: string[], ...updates: SdkListUpdate<string>[]): string[] {
  for (const update of updates) {
    applyListUpdate(list, update);
  }
  return list;
}

describe('applyListUpdate', () => {
  describe('adding', () => {
    it('appends onto what is already there', () => {
      expect(apply(['a', 'b'], { tag: 'Append', inner: { values: ['c', 'd'] } })).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
    });

    it('appending nothing leaves the list alone', () => {
      expect(apply(['a'], { tag: 'Append', inner: { values: [] } })).toEqual(['a']);
    });

    it('pushes to the front and to the back at the right ends', () => {
      expect(
        apply(
          ['b'],
          { tag: 'PushFront', inner: { value: 'a' } },
          { tag: 'PushBack', inner: { value: 'c' } },
        ),
      ).toEqual(['a', 'b', 'c']);
    });

    it('inserts in the middle without dropping the item that was there', () => {
      expect(apply(['a', 'c'], { tag: 'Insert', inner: { index: 1, value: 'b' } })).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('inserts at the end when the index is one past the last item', () => {
      // The boundary that separates Insert from Set: appending is a legal insert.
      expect(apply(['a'], { tag: 'Insert', inner: { index: 1, value: 'b' } })).toEqual([
        'a',
        'b',
      ]);
    });

    it('refuses an insert beyond the end rather than leaving a hole', () => {
      expect(() =>
        apply(['a'], { tag: 'Insert', inner: { index: 2, value: 'b' } }),
      ).toThrow(MatrixListDiffError);
    });
  });

  describe('replacing', () => {
    it('replaces in place without changing the length', () => {
      expect(
        apply(['a', 'b', 'c'], { tag: 'Set', inner: { index: 1, value: 'B' } }),
      ).toEqual(['a', 'B', 'c']);
    });

    it('refuses a set one past the end, which would be an append', () => {
      // Set and Insert differ by exactly this index, and confusing them grows the
      // list by one every time — which is how a timeline ends up with duplicates.
      expect(() => apply(['a'], { tag: 'Set', inner: { index: 1, value: 'b' } })).toThrow(
        MatrixListDiffError,
      );
    });
  });

  describe('removing', () => {
    it('pops from the right end', () => {
      expect(apply(['a', 'b', 'c'], { tag: 'PopFront' })).toEqual(['b', 'c']);
      expect(apply(['a', 'b', 'c'], { tag: 'PopBack' })).toEqual(['a', 'b']);
    });

    it('refuses to pop an empty list', () => {
      expect(() => apply([], { tag: 'PopFront' })).toThrow(MatrixListDiffError);
      expect(() => apply([], { tag: 'PopBack' })).toThrow(MatrixListDiffError);
    });

    it('removes exactly the item at the index', () => {
      expect(apply(['a', 'b', 'c'], { tag: 'Remove', inner: { index: 1 } })).toEqual([
        'a',
        'c',
      ]);
    });

    it('refuses to remove an index that is not there', () => {
      expect(() => apply(['a'], { tag: 'Remove', inner: { index: 1 } })).toThrow(
        MatrixListDiffError,
      );
      expect(() => apply(['a'], { tag: 'Remove', inner: { index: -1 } })).toThrow(
        MatrixListDiffError,
      );
    });

    it('empties the list on Clear', () => {
      expect(apply(['a', 'b'], { tag: 'Clear' })).toEqual([]);
    });
  });

  describe('truncating', () => {
    it('cuts the tail off', () => {
      expect(apply(['a', 'b', 'c'], { tag: 'Truncate', inner: { length: 2 } })).toEqual([
        'a',
        'b',
      ]);
    });

    it('truncating to zero empties the list', () => {
      expect(apply(['a', 'b'], { tag: 'Truncate', inner: { length: 0 } })).toEqual([]);
    });

    it('leaves the list alone when asked to truncate to more than it holds', () => {
      // Assigning `length` unconditionally would *grow* the array here, padding it
      // with holes that read as `undefined` rows further down the pipeline.
      const list = apply(['a', 'b'], { tag: 'Truncate', inner: { length: 5 } });
      expect(list).toEqual(['a', 'b']);
      expect(list).toHaveLength(2);
    });

    it('refuses a negative length', () => {
      expect(() => apply(['a'], { tag: 'Truncate', inner: { length: -1 } })).toThrow(
        MatrixListDiffError,
      );
    });
  });

  describe('resetting', () => {
    it('replaces the whole list, it does not add to it', () => {
      expect(
        apply(['a', 'b'], { tag: 'Reset', inner: { values: ['x', 'y'] } }),
      ).toEqual(['x', 'y']);
    });

    it('resets an empty list', () => {
      expect(apply([], { tag: 'Reset', inner: { values: ['x'] } })).toEqual(['x']);
    });

    it('resetting to nothing empties the list', () => {
      expect(apply(['a'], { tag: 'Reset', inner: { values: [] } })).toEqual([]);
    });
  });

  it('applies a batch in order, each update seeing the previous one', () => {
    // A real batch: a room arrives, moves to the top, then its summary changes.
    expect(
      apply(
        ['first', 'second'],
        { tag: 'PushBack', inner: { value: 'third' } },
        { tag: 'Remove', inner: { index: 2 } },
        { tag: 'Insert', inner: { index: 0, value: 'third' } },
        { tag: 'Set', inner: { index: 0, value: 'third (updated)' } },
      ),
    ).toEqual(['third (updated)', 'first', 'second']);
  });

  it('mutates the array it was given rather than returning a copy', () => {
    // The caller keeps this array as its mirror of Rust's list across batches.
    const list = ['a'];
    applyListUpdate(list, { tag: 'PushBack', inner: { value: 'b' } });
    expect(list).toEqual(['a', 'b']);
  });
});
