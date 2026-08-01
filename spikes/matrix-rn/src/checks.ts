/**
 * Fase 0 — comprobaciones kill-switch de matrix-rust-sdk sobre Expo/RN.
 *
 * Dos fases, porque una parte no se puede automatizar desde el móvil:
 *
 *   Fase A (automática, sólo el móvil):  C1..C6 y C8.
 *   Fase B (asistida, móvil + navegador): C7.
 *
 * Entre las dos fases la sesión sigue viva: el cliente, la sala y el timeline
 * se conservan para que la Fase B escuche sobre la misma sala cifrada.
 */
import { File, Paths } from 'expo-file-system';
import {
  BackupDownloadStrategy,
  ClientBuilder,
  EncryptionState,
  LogLevel,
  MsgLikeKind_Tags,
  RoomPreset,
  RoomVisibility,
  SlidingSyncVersionBuilder,
  TimelineDiff_Tags,
  TimelineItemContent_Tags,
  UploadSource,
  initPlatform,
  messageEventContentFromMarkdown,
  sdkGitSha,
} from '@unomed/react-native-matrix-sdk';
import type {
  ClientLike,
  SyncServiceLike,
  TimelineDiff,
  TimelineItemLike,
  TimelineLike,
} from '@unomed/react-native-matrix-sdk';
import type { SpikeConfig } from './config';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** Qué se observó. Se muestra tal cual en pantalla y es seleccionable. */
  detail: string;
  durationMs: number;
}

export type LogFn = (line: string) => void;

/** Espera máxima a que un mensaje aparezca descifrado en el timeline. */
const TIMELINE_TIMEOUT_MS = 60_000;
/** Espera máxima a que el sync inicial reporte estado. */
const SYNC_TIMEOUT_MS = 90_000;
/**
 * Ventana del control negativo de C7. Aquí no esperamos un evento concreto:
 * dejamos correr el reloj entero para poder afirmar que algo NO pasó, así que
 * conviene que sea generosa pero no eterna.
 */
const NEGATIVE_WINDOW_MS = 45_000;
/** Espera máxima en Fase B: incluye el tiempo humano de ir al navegador. */
const PEER_TIMEOUT_MS = 600_000;
/** Cuántos eventos pedimos hacia atrás para que el dispositivo frío vea historial. */
const BACKFILL_EVENTS = 30;

class CheckFailure extends Error {}

/**
 * Los errores de uniffi llevan el detalle en `inner`, no en `message`. Un
 * `ClientError.Generic` se imprime como "ClientError.Generic" y se pierden
 * `msg` y `details` — que es exactamente lo que hace falta para diagnosticar.
 * Los de la API de Matrix traen además `code` (`M_LIMIT_EXCEEDED`,
 * `M_FORBIDDEN`...), que suele decir el problema por sí solo.
 */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'inner' in error) {
    const { inner, tag } = error as { inner?: unknown; tag?: unknown };
    if (typeof inner === 'object' && inner !== null) {
      const fields = inner as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof tag === 'string') {
        parts.push(tag);
      }
      for (const key of ['code', 'kind', 'msg', 'details'] as const) {
        const value = fields[key];
        if (value !== undefined && value !== null && String(value) !== '') {
          parts.push(`${key}=${String(value)}`);
        }
      }
      if (parts.length > 0) {
        return parts.join(' · ');
      }
    }
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extrae los `TimelineItem` que trae un diff. */
function itemsFromDiff(diff: TimelineDiff): TimelineItemLike[] {
  switch (diff.tag) {
    case TimelineDiff_Tags.Append:
    case TimelineDiff_Tags.Reset:
      return [...diff.inner.values];
    case TimelineDiff_Tags.PushBack:
    case TimelineDiff_Tags.PushFront:
    case TimelineDiff_Tags.Insert:
    case TimelineDiff_Tags.Set:
      return [diff.inner.value];
    default:
      return [];
  }
}

/**
 * Clasifica un item del timeline.
 *
 * Un evento que no se puede descifrar **no lleva texto**: su contenido es
 * `UnableToDecrypt { msg: EncryptedMessage }`. Por eso no se puede "buscar el
 * mensaje X sin descifrar": lo único que se puede afirmar es que hay eventos
 * ilegibles y que el texto que esperábamos no aparece.
 */
function classifyItem(item: TimelineItemLike): 'utd' | { body: string } | undefined {
  const event = item.asEvent();
  if (!event) {
    return undefined;
  }
  const content = event.content;
  if (content.tag !== TimelineItemContent_Tags.MsgLike) {
    return undefined;
  }
  const kind = content.inner.content.kind;
  if (kind.tag === MsgLikeKind_Tags.Message) {
    return { body: kind.inner.content.body };
  }
  if (kind.tag === MsgLikeKind_Tags.UnableToDecrypt) {
    return 'utd';
  }
  return undefined;
}

/**
 * Qué se llegó a ver en el timeline respecto a un texto concreto.
 *
 * - `decrypted`: apareció el texto, legible.
 * - `utd-only`: llegaron eventos cifrados que no se pudieron descifrar, y el
 *   texto no apareció. Es el resultado que esperamos en un control negativo.
 * - `absent`: no llegó ni una cosa ni la otra. No permite concluir nada.
 */
type Observation = 'decrypted' | 'utd-only' | 'absent';

/**
 * Observa el timeline durante `timeoutMs`. Corta en cuanto ve el texto
 * descifrado; si no, agota la ventana y reporta qué llegó a ver.
 */
async function observeBody(
  timeline: TimelineLike,
  body: string,
  timeoutMs: number,
  log: LogFn
): Promise<Observation> {
  let utdSeen = false;
  let resolveOnce: (value: Observation) => void = () => {};
  const outcome = new Promise<Observation>((resolve) => {
    resolveOnce = resolve;
  });

  const handle = await timeline.addListener({
    onUpdate: (diffs) => {
      for (const diff of diffs) {
        for (const item of itemsFromDiff(diff)) {
          const classified = classifyItem(item);
          if (classified === 'utd') {
            utdSeen = true;
          } else if (classified && classified.body === body) {
            resolveOnce('decrypted');
            return;
          }
        }
      }
    },
  });

  const timeout = setTimeout(() => resolveOnce(utdSeen ? 'utd-only' : 'absent'), timeoutMs);

  try {
    const observation = await outcome;
    log(`    · observación del timeline: ${observation}`);
    return observation;
  } finally {
    clearTimeout(timeout);
    handle.cancel();
  }
}

/** Espera a que `body` aparezca descifrado, o falla explicando qué se vio. */
async function requireDecrypted(
  timeline: TimelineLike,
  body: string,
  timeoutMs: number,
  log: LogFn
): Promise<void> {
  const observation = await observeBody(timeline, body, timeoutMs, log);
  if (observation === 'decrypted') {
    return;
  }
  if (observation === 'utd-only') {
    throw new CheckFailure(
      'Llegaron eventos al timeline pero el SDK no pudo descifrarlos ' +
        '(UnableToDecrypt). El transporte funciona; el descifrado no.'
    );
  }
  throw new CheckFailure(
    `No llegó nada al timeline en ${timeoutMs / 1000}s: ni el mensaje ni eventos cifrados.`
  );
}

interface LoginOptions {
  /**
   * Identificador de la corrida. El store se cuelga de él para que cada
   * ejecución empiece con un dispositivo limpio.
   *
   * Sin esto el store persiste entre corridas Y entre reinstalaciones —vive en
   * el directorio privado de la app, que sobrevive a una actualización—, así
   * que la segunda vez el store ya tiene sesión y `login()` falla. Un test que
   * depende de que no quede basura de la corrida anterior no sirve de test.
   */
  runId: string;
  /**
   * Subcarpeta del store. Dos etiquetas distintas son dos dispositivos
   * distintos, cada uno con sus propias claves.
   */
  storeLabel: string;
  /**
   * Un "dispositivo frío" simula un móvil recién estrenado: no arranca
   * cross-signing ni backups, y sólo baja claves del backup cuando recibe la
   * clave de recuperación.
   *
   * NO quitar `backupDownloadStrategy(OneShot)`: el valor por defecto del SDK
   * es `Manual`, que no descarga ninguna clave nunca. Con el defecto, C7
   * fallaría siempre después de `recover()` y parecería que el backup está
   * roto cuando lo que está mal es la configuración del cliente.
   *
   * `autoEnableCrossSigning(false)` mantiene el dispositivo sin verificar, que
   * es lo que cierra la vía del `m.secret.send` y hace que el control negativo
   * signifique algo.
   */
  coldDevice: boolean;
}

/** Construye y autentica un cliente. */
async function loginClient(config: SpikeConfig, options: LoginOptions, log: LogFn) {
  let builder = new ClientBuilder()
    .homeserverUrl(config.homeserverUrl.trim())
    .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.DiscoverNative)
    .autoEnableCrossSigning(!options.coldDevice)
    .autoEnableBackups(!options.coldDevice);

  if (options.coldDevice) {
    builder = builder.backupDownloadStrategy(BackupDownloadStrategy.OneShot);
  }

  if (config.usePersistentStore) {
    const scope = `${options.runId}/${options.storeLabel}`;
    const dataDir = new File(Paths.document, `${scope}/data`).parentDirectory;
    const cacheDir = new File(Paths.cache, `${scope}/cache`).parentDirectory;
    dataDir.create({ intermediates: true, idempotent: true });
    cacheDir.create({ intermediates: true, idempotent: true });
    // El SDK Rust espera rutas de sistema de ficheros, no URIs `file://`.
    const dataPath = dataDir.uri.replace(/^file:\/\//, '');
    const cachePath = cacheDir.uri.replace(/^file:\/\//, '');
    log(`    · store SQLite en ${dataPath}`);
    builder = builder.sessionPaths(dataPath, cachePath);
  } else {
    log('    · store en memoria');
    builder = builder.inMemoryStore();
  }

  const client = await builder.build();
  await client.login(
    config.username.trim(),
    config.password,
    `Allo Matrix Spike (${options.storeLabel})`,
    undefined
  );
  return client;
}

/** Arranca el sync y espera a que reporte un estado. */
async function startSync(client: ClientLike, log: LogFn) {
  const syncService = await client.syncService().finish();
  let resolveOnce: (value: string | undefined) => void = () => {};
  const settled = new Promise<string | undefined>((resolve) => {
    resolveOnce = resolve;
  });

  const stateHandle = syncService.state({
    onUpdate: (state) => {
      log(`    · estado del sync: ${String(state)}`);
      resolveOnce(String(state));
    },
  });

  const timeout = setTimeout(() => resolveOnce(undefined), SYNC_TIMEOUT_MS);
  await syncService.start();

  try {
    const state = await settled;
    if (state === undefined) {
      throw new CheckFailure(
        `El sync no reportó ningún estado en ${SYNC_TIMEOUT_MS / 1000}s. ` +
          'El homeserver debe soportar Simplified Sliding Sync (MSC4186).'
      );
    }
  } finally {
    clearTimeout(timeout);
    stateHandle.cancel();
  }

  return syncService;
}

/** La sala tarda un poco en aparecer en el room list tras el primer sync. */
async function waitForRoom(client: ClientLike, roomId: string, log: LogFn) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const room = client.getRoom(roomId);
    if (room) {
      return room;
    }
    log(`    · esperando a que ${roomId} aparezca en el room list…`);
    await delay(2_000);
  }
  throw new CheckFailure(`La sala ${roomId} no apareció en el room list.`);
}

/**
 * Sesión viva entre la Fase A y la Fase B.
 */
export interface SpikeSession {
  results: CheckResult[];
  failed: boolean;
  /** Clave de recuperación generada en C6. */
  recoveryKey?: string;
  /** Sala cifrada creada por el spike. */
  roomId?: string;
  /** Mensajes que la Fase A dejó en la sala, para buscarlos en Element Web. */
  sentBodies: string[];
  /** Texto exacto a enviar desde Element Web para cerrar C8. */
  pingToken: string;
  /** Fase B: espera el mensaje enviado desde Element Web. */
  waitForPeerMessage(log: LogFn): Promise<CheckResult>;
  /** Cierra los syncs. */
  dispose(log: LogFn): Promise<void>;
}

export async function runPhaseA(
  config: SpikeConfig,
  log: LogFn
): Promise<SpikeSession> {
  const results: CheckResult[] = [];
  let stopped = false;

  let client: ClientLike | undefined;
  let sync: SyncServiceLike | undefined;
  let coldSync: SyncServiceLike | undefined;
  let timeline: TimelineLike | undefined;
  let recoveryKey: string | undefined;
  let roomId: string | undefined;

  const runId = Date.now().toString(36);
  const pingToken = `PING-${runId}`;
  const historyBody = `historial-cifrado-${runId}`;
  const sentBodies: string[] = [];

  async function check(
    id: string,
    title: string,
    body: () => Promise<string>
  ): Promise<void> {
    if (stopped) {
      results.push({
        id,
        title,
        status: 'skipped',
        detail: 'No ejecutada: una comprobación anterior falló.',
        durationMs: 0,
      });
      return;
    }
    log(`▶ ${id} — ${title}`);
    const startedAt = Date.now();
    try {
      const detail = await body();
      const durationMs = Date.now() - startedAt;
      results.push({ id, title, status: 'pass', detail, durationMs });
      log(`  ✅ ${detail} (${durationMs} ms)`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const detail = describeError(error);
      results.push({ id, title, status: 'fail', detail, durationMs });
      log(`  ❌ ${detail} (${durationMs} ms)`);
      stopped = true;
    }
  }

  await check('C1', 'El módulo nativo arranca y Rust responde', async () => {
    // Si el crash de JNI del issue #47 sigue vivo en RN 0.86, la app se cae al
    // cargar el módulo y nunca llegamos aquí.
    initPlatform(
      {
        logLevel: LogLevel.Debug,
        traceLogPacks: [],
        extraTargets: [],
        writeToStdoutOrSystem: true,
        writeToFiles: undefined,
      },
      false
    );
    const sha = sdkGitSha();
    if (!sha) {
      throw new CheckFailure('sdkGitSha() devolvió una cadena vacía.');
    }
    return `JSI → Rust vivo. matrix-rust-sdk @ ${sha}`;
  });

  await check('C2', 'Login contra el homeserver', async () => {
    client = await loginClient(config, { runId, storeLabel: 'device-a', coldDevice: false }, log);
    const session = client.session();
    return `Sesión como ${session.userId}, deviceId ${session.deviceId}`;
  });

  await check('C3', 'Sliding sync arranca (MSC4186)', async () => {
    if (!client) throw new CheckFailure('No hay cliente.');
    sync = await startSync(client, log);
    return 'SyncService reportó estado; sliding sync nativo, sin proxy';
  });

  await check('C4', 'Crear sala cifrada', async () => {
    if (!client) throw new CheckFailure('No hay cliente.');
    const peer = config.usernameB.trim();
    roomId = await client.createRoom({
      name: `Allo spike ${runId}`,
      isEncrypted: true,
      isDirect: false,
      visibility: new RoomVisibility.Private(),
      preset: RoomPreset.PrivateChat,
      invite: peer ? [peer] : undefined,
    });
    const room = await waitForRoom(client, roomId, log);

    // NO usar `isEncrypted()` aquí. `EncryptionState` tiene tres valores, y el
    // tercero es `Unknown` — según el propio SDK, "the `/sync` did not provide
    // all data needed to decide". Recién creada la sala ese es el caso normal:
    // el evento `m.room.encryption` todavía no ha llegado por sliding sync.
    // `isEncrypted()` colapsa `Unknown` en `false`, así que no distingue "la
    // sala no está cifrada" de "aún no lo sé" y produce un falso negativo que
    // se lee como que el cifrado de Matrix no funciona.
    //
    // `latestEncryptionState()` consulta al servidor cuando el estado local es
    // desconocido, que es exactamente lo que hace falta aquí.
    const encryptionState = await room.latestEncryptionState();
    if (encryptionState === EncryptionState.NotEncrypted) {
      throw new CheckFailure(
        `La sala ${roomId} se creó SIN cifrado pese a pedirlo con ` +
          '`isEncrypted: true`. Esto sí es un fallo real.'
      );
    }
    if (encryptionState !== EncryptionState.Encrypted) {
      throw new CheckFailure(
        `INCONCLUSA: el estado de cifrado de ${roomId} sigue siendo desconocido ` +
          'después de consultar al servidor. No es que la sala esté sin cifrar: ' +
          'es que no se ha podido determinar. Suele ser sync lento; repite.'
      );
    }

    timeline = await room.timeline();
    return peer
      ? `Sala cifrada ${roomId}, con ${peer} invitado`
      : `Sala cifrada ${roomId}`;
  });

  await check(
    'C5',
    'Ida y vuelta de un mensaje E2EE en el propio dispositivo',
    async () => {
      if (!timeline) throw new CheckFailure('No hay timeline.');
      const observed = requireDecrypted(timeline, historyBody, TIMELINE_TIMEOUT_MS, log);
      await timeline.send(messageEventContentFromMarkdown(historyBody));
      await observed;
      sentBodies.push(historyBody);
      return 'Mensaje cifrado, enviado y releído descifrado';
    }
  );

  await check(
    'C6',
    'Adjuntos cifrados (UploadSource.Data y UploadSource.File)',
    async () => {
      if (!timeline) throw new CheckFailure('No hay timeline.');

      const dataBytes = new Uint8Array(1024);
      for (let i = 0; i < dataBytes.length; i += 1) {
        dataBytes[i] = i % 256;
      }
      log('    · enviando adjunto desde bytes en memoria');
      const dataHandle = timeline.sendFile(
        {
          source: new UploadSource.Data({
            bytes: dataBytes.buffer,
            filename: `${runId}-data.bin`,
          }),
          caption: 'spike attachment (data)',
        },
        { mimetype: 'application/octet-stream', size: BigInt(dataBytes.length) }
      );
      await dataHandle.join();

      const fileBytes = new Uint8Array(1024);
      for (let i = 0; i < fileBytes.length; i += 1) {
        fileBytes[i] = (i * 7) % 256;
      }
      const file = new File(Paths.cache, `${runId}-file.bin`);
      file.create({ overwrite: true });
      file.write(fileBytes);
      const path = file.uri.replace(/^file:\/\//, '');
      log(`    · enviando adjunto desde ${path}`);
      const fileHandle = timeline.sendFile(
        {
          source: new UploadSource.File({ filename: path }),
          caption: 'spike attachment (file)',
        },
        { mimetype: 'application/octet-stream', size: BigInt(fileBytes.length) }
      );
      await fileHandle.join();

      return 'Los dos adjuntos de 1 KiB subieron a la sala cifrada';
    }
  );

  // C7 es la propiedad que sostiene el nivel de "chats normales": cambiar de
  // móvil y recuperar el historial con la clave de recuperación, sin que el
  // dispositivo viejo intervenga.
  //
  // El control negativo (paso 3) es lo que impide que la comprobación sea
  // vacua: si el dispositivo frío ya descifra ANTES de recuperar, las claves
  // llegaron por otra vía y la corrida no demuestra que el backup sirva.
  await check(
    'C7',
    'Key backup: un dispositivo nuevo descifra historial anterior con la clave de recuperación',
    async () => {
      if (!client) throw new CheckFailure('No hay cliente.');
      if (!roomId) throw new CheckFailure('No hay sala.');

      const encryption = client.encryption();
      log('    · habilitando recuperación y esperando a que suban las claves');
      // El `true` espera a que el backup termine de subir. Sin él estaríamos
      // midiendo una carrera en vez de una propiedad.
      recoveryKey = await encryption.enableRecovery(true, undefined, {
        onUpdate: (progress) => log(`    · progreso: ${String(progress)}`),
      });
      if (!recoveryKey) {
        throw new CheckFailure('enableRecovery() no devolvió clave de recuperación.');
      }
      if (!(await encryption.backupExistsOnServer())) {
        throw new CheckFailure(
          'La recuperación dice estar habilitada pero el servidor no tiene backup.'
        );
      }

      log('    · segundo login del mismo usuario como dispositivo frío');
      const coldClient = await loginClient(
        config,
        { runId, storeLabel: 'device-cold', coldDevice: true },
        log
      );
      const coldSession = coldClient.session();
      if (coldSession.deviceId === client.session().deviceId) {
        throw new CheckFailure(
          'El segundo login reutilizó el mismo deviceId; no es un dispositivo nuevo.'
        );
      }
      coldSync = await startSync(coldClient, log);

      const coldRoom = await waitForRoom(coldClient, roomId, log);
      const coldTimeline = await coldRoom.timeline();
      await coldTimeline.paginateBackwards(BACKFILL_EVENTS);

      log('    · control negativo: el dispositivo frío NO debería poder leer todavía');
      const before = await observeBody(
        coldTimeline,
        historyBody,
        NEGATIVE_WINDOW_MS,
        log
      );
      if (before === 'decrypted') {
        throw new CheckFailure(
          'INCONCLUSA: el dispositivo frío descifró el historial ANTES de recuperar. ' +
            'Las claves llegaron por otra vía (reenvío o secretos compartidos), así que ' +
            'esta corrida no demuestra que el key backup funcione.'
        );
      }
      if (before === 'absent') {
        throw new CheckFailure(
          'INCONCLUSA: al dispositivo frío no le llegó ningún evento de la sala, ' +
            'ni siquiera cifrado. Sin ese punto de partida el control negativo no ' +
            'significa nada. Puede ser sync lento o poca paginación.'
        );
      }

      log('    · recuperando con la clave y esperando a que baje el backup');
      await coldClient.encryption().recover(recoveryKey);

      await requireDecrypted(coldTimeline, historyBody, TIMELINE_TIMEOUT_MS, log);

      const coldRecoveryState = coldClient.encryption().recoveryState();
      return (
        'El dispositivo frío no podía leer el historial, y tras recuperar con la ' +
        `clave sí lo descifra. recoveryState=${String(coldRecoveryState)}, ` +
        `deviceId nuevo ${coldSession.deviceId}`
      );
    }
  );

  const failed = results.some((result) => result.status === 'fail');

  return {
    results,
    failed,
    recoveryKey,
    roomId,
    sentBodies,
    pingToken,

    async waitForPeerMessage(peerLog: LogFn): Promise<CheckResult> {
      const id = 'C8';
      const title = 'Ida y vuelta E2EE con un segundo dispositivo vivo (Element Web)';
      const startedAt = Date.now();

      if (!timeline) {
        return {
          id,
          title,
          status: 'skipped',
          detail: 'No ejecutada: la Fase A no llegó a crear la sala.',
          durationMs: 0,
        };
      }

      peerLog(`▶ ${id} — ${title}`);
      peerLog(`  Esperando "${pingToken}" desde Element Web…`);
      try {
        await requireDecrypted(timeline, pingToken, PEER_TIMEOUT_MS, peerLog);
        const durationMs = Date.now() - startedAt;
        const detail =
          'El mensaje escrito en Element Web llegó al móvil y se descifró. ' +
          'El reparto de claves entre dispositivos vivos funciona.';
        peerLog(`  ✅ ${detail} (${durationMs} ms)`);
        return { id, title, status: 'pass', detail, durationMs };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const detail = describeError(error);
        peerLog(`  ❌ ${detail} (${durationMs} ms)`);
        return { id, title, status: 'fail', detail, durationMs };
      }
    },

    async dispose(disposeLog: LogFn): Promise<void> {
      for (const [label, service] of [
        ['principal', sync],
        ['frío', coldSync],
      ] as const) {
        if (!service) continue;
        try {
          await service.stop();
        } catch (error) {
          disposeLog(`  ⚠️  no se pudo parar el sync ${label}: ${describeError(error)}`);
        }
      }
    },
  };
}
