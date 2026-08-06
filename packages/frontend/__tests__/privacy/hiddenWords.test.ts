import {
  addHiddenWord,
  HIDDEN_WORD_MAX_LENGTH,
  removeHiddenWord,
} from '@/lib/privacy/hiddenWords';

/**
 * EDITING A LIST OF WORDS.
 *
 * The whole list is written on every change, so what these functions return is
 * what gets stored. The interesting cases are the ones a renderer cannot be
 * asked about: whether `Spoilers` and `spoilers` are the same word, and what
 * happens to a list that already contains both.
 */

describe('addHiddenWord', () => {
  it('adds a word to the end, so the list does not rearrange itself', () => {
    expect(addHiddenWord(['one'], 'two')).toEqual({ ok: true, words: ['one', 'two'] });
  });

  it('does not change the list it was given', () => {
    const before = ['one'];
    addHiddenWord(before, 'two');
    expect(before).toEqual(['one']);
  });

  it('treats the space around a word as typing', () => {
    expect(addHiddenWord([], '  spoilers  ')).toEqual({ ok: true, words: ['spoilers'] });
  });

  it('refuses a word that is only space', () => {
    expect(addHiddenWord([], '   ')).toEqual({ ok: false, reason: 'empty' });
    expect(addHiddenWord([], '')).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses a pasted paragraph', () => {
    const long = 'a'.repeat(HIDDEN_WORD_MAX_LENGTH + 1);
    expect(addHiddenWord([], long)).toEqual({ ok: false, reason: 'too-long' });
  });

  it('accepts a word of exactly the maximum length', () => {
    const exact = 'a'.repeat(HIDDEN_WORD_MAX_LENGTH);
    expect(addHiddenWord([], exact)).toEqual({ ok: true, words: [exact] });
  });

  it('refuses a word already on the list, whatever case it was typed in', () => {
    // Somebody who hid `spoilers` did not mean to leave `Spoilers` showing, so
    // adding it again is a duplicate rather than a second entry.
    expect(addHiddenWord(['spoilers'], 'Spoilers')).toEqual({ ok: false, reason: 'duplicate' });
    expect(addHiddenWord(['Spoilers'], 'spoilers')).toEqual({ ok: false, reason: 'duplicate' });
    expect(addHiddenWord(['spoilers'], '  spoilers ')).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('keeps the word as it was typed', () => {
    // Compared case-insensitively, stored verbatim: the list is drawn back to
    // the person who wrote it.
    expect(addHiddenWord([], 'Spoilers')).toEqual({ ok: true, words: ['Spoilers'] });
  });
});

describe('removeHiddenWord', () => {
  it('takes the word off the list', () => {
    expect(removeHiddenWord(['one', 'two'], 'one')).toEqual(['two']);
  });

  it('does not change the list it was given', () => {
    const before = ['one', 'two'];
    removeHiddenWord(before, 'one');
    expect(before).toEqual(['one', 'two']);
  });

  it('removes the row the reader tapped whatever case it is stored in', () => {
    expect(removeHiddenWord(['Spoilers'], 'spoilers')).toEqual([]);
  });

  it('empties a list that an older build let duplicate', () => {
    // Both go, or the row comes back when the screen redraws and the reader
    // cannot get rid of it.
    expect(removeHiddenWord(['spoilers', 'Spoilers', 'other'], 'SPOILERS')).toEqual(['other']);
  });

  it('leaves a list that does not contain the word alone', () => {
    expect(removeHiddenWord(['one'], 'two')).toEqual(['one']);
  });
});
