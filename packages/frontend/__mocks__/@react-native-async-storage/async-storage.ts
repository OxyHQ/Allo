/**
 * Jest stand-in for AsyncStorage.
 *
 * The real module reaches for a native module that does not exist outside a
 * running app, and throws at *import* time — so a test that never touches
 * storage still fails if anything in its import graph does. That is how this
 * became necessary: `lib/chat/pushRegistration.ts` reads the notification
 * preference, `matrixRuntime.ts` owns the registrar, and four suites that care
 * about neither import the runtime.
 *
 * The package ships its own mock, which is the one to use rather than a
 * hand-written map: it implements the whole surface, including `multiGet`,
 * `multiSet` and the callback forms, so a module that uses one of those does not
 * fail in a way that has nothing to do with what it is being tested for.
 *
 * A manual mock for a node module needs no `jest.mock()` call — Jest applies it
 * automatically — which is the same arrangement as
 * `__mocks__/@unomed/react-native-matrix-sdk.ts`.
 */
import asyncStorageMock from '@react-native-async-storage/async-storage/jest/async-storage-mock';

export default asyncStorageMock;
