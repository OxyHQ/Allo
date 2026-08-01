import { MatrixPortError } from '@/lib/matrix/errors';

/**
 * Reconciling the Rust SDK's list diffs into a plain array.
 *
 * The binding does not hand over lists; it hands over a stream of diffs against a
 * list that Rust maintains. Both streams Allo consumes — `TimelineDiff` for a
 * conversation and `RoomListEntriesUpdate` for the room list — are the same eleven
 * operations over different payloads, so they are reconciled by one function.
 *
 * {@link SdkListUpdate} is not a copy of either SDK union: it is the shape they
 * share, and it is checked against both at the call sites. If a future version of
 * the binding changes one of them, passing it here stops compiling — which is the
 * point of writing it this way rather than reaching for a cast.
 */
export type SdkListUpdate<T> =
  | { readonly tag: 'Append'; readonly inner: { readonly values: readonly T[] } }
  | { readonly tag: 'Clear' }
  | { readonly tag: 'PushFront'; readonly inner: { readonly value: T } }
  | { readonly tag: 'PushBack'; readonly inner: { readonly value: T } }
  | { readonly tag: 'PopFront' }
  | { readonly tag: 'PopBack' }
  | { readonly tag: 'Insert'; readonly inner: { readonly index: number; readonly value: T } }
  | { readonly tag: 'Set'; readonly inner: { readonly index: number; readonly value: T } }
  | { readonly tag: 'Remove'; readonly inner: { readonly index: number } }
  | { readonly tag: 'Truncate'; readonly inner: { readonly length: number } }
  | { readonly tag: 'Reset'; readonly inner: { readonly values: readonly T[] } };

/**
 * An update that cannot be applied to the list it was meant for.
 *
 * This means the local copy and the list Rust maintains have diverged. There is
 * no way to carry on correctly from here: every later index refers to a list that
 * no longer exists, so the messages the user sees would be in the wrong order
 * rather than merely stale.
 */
export class MatrixListDiffError extends MatrixPortError {
  constructor(operation: string, detail: string) {
    super(`Cannot apply list update "${operation}": ${detail}`);
  }
}

/**
 * Applies one update to `list`, in place.
 *
 * In place because this array is the private mirror of the SDK's list and a batch
 * of updates arrives on every sync: rebuilding it per operation would copy the
 * whole conversation for each event. The array the UI sees is built separately,
 * once per batch.
 */
export function applyListUpdate<T>(list: T[], update: SdkListUpdate<T>): void {
  switch (update.tag) {
    case 'Append':
      list.push(...update.inner.values);
      return;

    case 'Clear':
      list.length = 0;
      return;

    case 'PushFront':
      list.unshift(update.inner.value);
      return;

    case 'PushBack':
      list.push(update.inner.value);
      return;

    case 'PopFront':
      requireNotEmpty(list, 'PopFront');
      list.shift();
      return;

    case 'PopBack':
      requireNotEmpty(list, 'PopBack');
      list.pop();
      return;

    case 'Insert': {
      const { index, value } = update.inner;
      // An insert may land one past the end: that is an append.
      requireIndexInRange(index, list.length, 'Insert');
      list.splice(index, 0, value);
      return;
    }

    case 'Set': {
      const { index, value } = update.inner;
      requireIndexInRange(index, list.length - 1, 'Set');
      list[index] = value;
      return;
    }

    case 'Remove': {
      const { index } = update.inner;
      requireIndexInRange(index, list.length - 1, 'Remove');
      list.splice(index, 1);
      return;
    }

    case 'Truncate': {
      const { length } = update.inner;
      if (length < 0) {
        throw new MatrixListDiffError('Truncate', `negative length ${length}`);
      }
      // Assigning `length` unconditionally would *grow* the array with holes when
      // the SDK asks to truncate to more than it currently holds.
      if (length < list.length) {
        list.length = length;
      }
      return;
    }

    case 'Reset':
      list.length = 0;
      list.push(...update.inner.values);
      return;
  }
}

function requireNotEmpty(list: readonly unknown[], operation: string): void {
  if (list.length === 0) {
    throw new MatrixListDiffError(operation, 'the list is empty');
  }
}

function requireIndexInRange(index: number, maximum: number, operation: string): void {
  if (!Number.isInteger(index) || index < 0 || index > maximum) {
    throw new MatrixListDiffError(
      operation,
      `index ${index} is outside 0..${maximum}`,
    );
  }
}
