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
   * MXID de una segunda cuenta, opcional. Si se rellena, la sala cifrada la
   * invita y C7 mide el reparto de claves entre **usuarios distintos**.
   *
   * Si se deja vacío, C7 se hace con una segunda sesión de la misma cuenta en
   * Element Web: sigue midiendo el reparto entre dispositivos y ahorra
   * registrar otra cuenta en matrix.org (que pide email y captcha).
   *
   * `passwordB` no lo usa la app — quien inicia sesión con esa cuenta es el
   * navegador. Está aquí sólo para que el operador lo tenga a mano.
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

export const DEFAULT_CONFIG: SpikeConfig = {
  // matrix.org anuncia `org.matrix.simplified_msc3575 = true`, así que sirve
  // sin desplegar nada. El homeserver propio es Fase 1.
  homeserverUrl: 'https://matrix.org',
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
  if (!config.username.trim()) {
    return 'Falta el usuario.';
  }
  if (!config.password) {
    return 'Falta la contraseña.';
  }
  return undefined;
}
