import AsyncStorage from '@react-native-async-storage/async-storage';

/** A JSON value kept under `key`, or `null` when there is none or it cannot be read. */
export async function getData<T>(key: string): Promise<T | null> {
  try {
    const item = await AsyncStorage.getItem(key);
    return item ? JSON.parse(item) : null;
  } catch (error) {
    console.warn(`[Storage] Failed to get item: ${key}`, error);
    return null;
  }
}
