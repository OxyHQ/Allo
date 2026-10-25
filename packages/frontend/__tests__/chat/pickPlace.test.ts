import * as Location from 'expo-location';

import { POSITION_TIMEOUT_MS, pickPlace } from '@/lib/chat/attachments';

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
}));

// The rest of the attachment module's native pickers, which this test never reaches.
jest.mock('expo-contacts', () => ({}));
jest.mock('expo-document-picker', () => ({}));
jest.mock('expo-image-manipulator', () => ({}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-video', () => ({}));

const location = Location as jest.Mocked<typeof Location>;

beforeEach(() => {
  jest.useFakeTimers();
  location.requestForegroundPermissionsAsync.mockResolvedValue({
    granted: true,
  } as Location.LocationPermissionResponse);
  location.reverseGeocodeAsync.mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());

describe('pickPlace', () => {
  it('says the position could not be read when no fix ever comes', async () => {
    // Location on, nothing to give: the platform call never settles.
    location.getCurrentPositionAsync.mockReturnValue(new Promise(() => {}));
    const picked = pickPlace();
    await jest.advanceTimersByTimeAsync(POSITION_TIMEOUT_MS);
    await expect(picked).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('sends the fix that arrives in time', async () => {
    location.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 41.39, longitude: 2.17 },
    } as Location.LocationObject);
    await expect(pickPlace()).resolves.toEqual({
      ok: true,
      place: { latitude: 41.39, longitude: 2.17 },
    });
  });

  it('is silent about a refusal', async () => {
    location.requestForegroundPermissionsAsync.mockResolvedValue({
      granted: false,
    } as Location.LocationPermissionResponse);
    await expect(pickPlace()).resolves.toEqual({ ok: false, reason: 'denied' });
  });
});
