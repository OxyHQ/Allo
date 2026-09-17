/**
 * Jest stand-in for AsyncStorage.
 *
 * The real module reaches for a native module that does not exist outside a
 * running app, and throws at *import* time — so a test that never touches
 * storage still fails if anything in its import graph does. Anything under
 * test that reaches `utils/storage.ts` needs this to be importable.
 *
 * The package ships its own mock, which is the one to use rather than a
 * hand-written map: it implements the whole surface, including `multiGet`,
 * `multiSet` and the callback forms, so a module that uses one of those does not
 * fail in a way that has nothing to do with what it is being tested for.
 *
 * A manual mock for a node module needs no `jest.mock()` call — Jest applies it
 * automatically.
 */
import asyncStorageMock from '@react-native-async-storage/async-storage/jest/async-storage-mock';

export default asyncStorageMock;
