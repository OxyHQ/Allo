/**
 * Configuración del spike.
 *
 * No hay valores por defecto para credenciales a propósito: el harness se
 * ejecuta contra un Synapse real y las credenciales se introducen en la
 * pantalla, no se commitean.
 */
export interface SpikeConfig {
  /** URL del homeserver, p.ej. `https://matrix.example.org`. */
  homeserverUrl: string;
  /** Localpart o MXID completo del usuario A (el que envía). */
  username: string;
  password: string;
  /**
   * Usuario B, opcional. Si se rellena, el harness ejecuta además la
   * comprobación de ida y vuelta entre dos dispositivos (C9), que es la única
   * que demuestra de verdad el reparto de claves de sala. Si se deja vacío,
   * C9 se marca como `skipped` en vez de fingir que pasó.
   */
  usernameB: string;
  passwordB: string;
  /**
   * `true` usa el store SQLite en disco (lo que hará la app real).
   * `false` usa el store en memoria, que aísla los fallos de FFI de los
   * fallos de sistema de ficheros.
   */
  usePersistentStore: boolean;
}

export const EMPTY_CONFIG: SpikeConfig = {
  homeserverUrl: '',
  username: '',
  password: '',
  usernameB: '',
  passwordB: '',
  usePersistentStore: true,
};

export function validateConfig(config: SpikeConfig): string | undefined {
  if (!config.homeserverUrl.trim()) {
    return 'Falta la URL del homeserver.';
  }
  if (!/^https?:\/\//.test(config.homeserverUrl.trim())) {
    return 'La URL del homeserver debe empezar por http:// o https://.';
  }
  if (!config.username.trim() || !config.password) {
    return 'Faltan las credenciales del usuario A.';
  }
  if (Boolean(config.usernameB.trim()) !== Boolean(config.passwordB)) {
    return 'El usuario B necesita usuario y contraseña, o ninguno de los dos.';
  }
  return undefined;
}
