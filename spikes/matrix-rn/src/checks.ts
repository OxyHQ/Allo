/**
 * Fase 0 — comprobaciones kill-switch de matrix-rust-sdk sobre Expo/RN.
 *
 * El spike corre en dos fases, porque una parte no se puede automatizar desde
 * el móvil: hay que abrir Element Web en un navegador y mirar qué pasa.
 *
 *   Fase A (automática, sólo el móvil):  C1..C6 y C8.
 *   Fase B (asistida, móvil + navegador): C7.
 *
 * Entre las dos fases la sesión sigue viva: el cliente, la sala y el timeline
 * se conservan para que la Fase B escuche sobre la misma sala cifrada.
 */
import { File, Paths } from 'expo-file-system';
import {
  ClientBuilder,
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
/** Espera máxima en Fase B: incluye el tiempo humano de ir al navegador. */
const PEER_TIMEOUT_MS = 600_000;

class CheckFailure extends Error {}

function describeError(error: unknown): string {
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
 * Cuerpo del mensaje si el item es un mensaje descifrado, `'<UTD>'` si el SDK
 * no pudo descifrarlo, `undefined` para cualquier otra cosa.
 *
 * Distinguir descifrado de UnableToDecrypt es el punto de la comprobación: un
 * evento que llega pero no descifra significa que el E2EE está roto, no que
 * el transporte falló.
 */
function messageBodyOf(item: TimelineItemLike): string | undefined {
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
    return kind.inner.content.body;
  }
  if (kind.tag === MsgLikeKind_Tags.UnableToDecrypt) {
    return '<UTD>';
  }
  return undefined;
}

/** Espera a que `body` aparezca descifrado en el timeline. */
async function waitForDecryptedBody(
  timeline: TimelineLike,
  body: string,
  timeoutMs: number,
  log: LogFn
): Promise<void> {
  let resolveOnce: (value: Error | undefined) => void = () => {};
  const outcome = new Promise<Error | undefined>((resolve) => {
    resolveOnce = resolve;
  });

  const handle = await timeline.addListener({
    onUpdate: (diffs) => {
      for (const diff of diffs) {
        for (const item of itemsFromDiff(diff)) {
          const seen = messageBodyOf(item);
          if (seen === body) {
            resolveOnce(undefined);
            return;
          }
          if (seen === '<UTD>') {
            resolveOnce(
              new Error(
                'Llegó un evento al timeline pero el SDK no pudo descifrarlo ' +
                  '(UnableToDecrypt). El transporte funciona; el reparto de claves no.'
              )
            );
            return;
          }
        }
      }
    },
  });

  const timeout = setTimeout(() => {
    resolveOnce(
      new Error(`No apareció descifrado en el timeline en ${timeoutMs / 1000}s.`)
    );
  }, timeoutMs);

  try {
    const failure = await outcome;
    if (failure) {
      throw new CheckFailure(failure.message);
    }
    log('    · observado descifrado en el timeline');
  } finally {
    clearTimeout(timeout);
    handle.cancel();
  }
}

/** Construye y autentica el cliente del móvil. */
async function loginClient(config: SpikeConfig, log: LogFn) {
  let builder = new ClientBuilder()
    .homeserverUrl(config.homeserverUrl.trim())
    .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.DiscoverNative)
    .autoEnableCrossSigning(true)
    .autoEnableBackups(true);

  if (config.usePersistentStore) {
    const dataDir = new File(Paths.document, 'matrix/data').parentDirectory;
    const cacheDir = new File(Paths.cache, 'matrix/cache').parentDirectory;
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
    'Allo Matrix Spike',
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

/**
 * Sesión viva entre la Fase A y la Fase B.
 *
 * `recoveryKey`, `roomId` y `sentBodies` son exactamente lo que el operador
 * necesita llevarse al navegador para cerrar C6 y C7.
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
  /** Texto exacto a enviar desde Element Web para cerrar C7. */
  pingToken: string;
  /** Fase B: espera el mensaje enviado desde Element Web. */
  waitForPeerMessage(log: LogFn): Promise<CheckResult>;
  /** Cierra el sync. */
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
    client = await loginClient(config, log);
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
    // La sala tarda un instante en aparecer en el room list tras crearse.
    await delay(2_000);
    const room = client.getRoom(roomId);
    if (!room) {
      throw new CheckFailure(`La sala ${roomId} no apareció en el room list.`);
    }
    if (!(await room.isEncrypted())) {
      throw new CheckFailure(
        `La sala ${roomId} se creó pero el SDK no la considera cifrada.`
      );
    }
    timeline = await room.timeline();
    return peer
      ? `Sala cifrada ${roomId}, con ${peer} invitado`
      : `Sala cifrada ${roomId}`;
  });

  await check(
    'C5',
    'Ida y vuelta de un mensaje E2EE en el propio timeline',
    async () => {
      if (!timeline) throw new CheckFailure('No hay timeline.');
      const observed = waitForDecryptedBody(
        timeline,
        historyBody,
        TIMELINE_TIMEOUT_MS,
        log
      );
      await timeline.send(messageEventContentFromMarkdown(historyBody));
      await observed;
      sentBodies.push(historyBody);
      return 'Mensaje cifrado, enviado y releído descifrado';
    }
  );

  // C8 va antes que C6 a propósito: la recuperación tiene que respaldar las
  // claves de un historial que ya existe, si no C6 no demuestra nada.
  await check(
    'C8',
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

  await check(
    'C6',
    'Cross-signing y key backup: se genera clave de recuperación',
    async () => {
      if (!client) throw new CheckFailure('No hay cliente.');
      const encryption = client.encryption();

      log('    · habilitando recuperación y esperando a que suban las claves');
      recoveryKey = await encryption.enableRecovery(true, undefined, {
        onUpdate: (progress) =>
          log(`    · progreso de recuperación: ${String(progress)}`),
      });
      if (!recoveryKey) {
        throw new CheckFailure(
          'enableRecovery() no devolvió clave de recuperación.'
        );
      }

      // Sin backup en el servidor, un dispositivo nuevo no puede recuperar el
      // historial por mucha clave que tenga. Comprobarlo es la mitad de C6.
      const existsOnServer = await encryption.backupExistsOnServer();
      if (!existsOnServer) {
        throw new CheckFailure(
          'La recuperación dice estar habilitada pero el servidor no tiene backup.'
        );
      }

      const verification = encryption.verificationState();
      const recovery = encryption.recoveryState();
      const backup = encryption.backupState();
      return (
        'Clave de recuperación generada y backup presente en el servidor. ' +
        `verificationState=${String(verification)} ` +
        `recoveryState=${String(recovery)} backupState=${String(backup)}`
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
      const id = 'C7';
      const title = 'Ida y vuelta E2EE con un segundo dispositivo (Element Web)';
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
        await waitForDecryptedBody(timeline, pingToken, PEER_TIMEOUT_MS, peerLog);
        const durationMs = Date.now() - startedAt;
        const detail =
          'El mensaje enviado desde Element Web llegó al móvil y se descifró. ' +
          'El reparto de claves de sala entre dispositivos funciona.';
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
      if (!sync) return;
      try {
        await sync.stop();
      } catch (error) {
        disposeLog(`  ⚠️  no se pudo parar el sync: ${describeError(error)}`);
      }
    },
  };
}
