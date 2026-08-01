/**
 * Fase 0 — comprobaciones kill-switch de matrix-rust-sdk sobre Expo/RN.
 *
 * El orden importa: cada comprobación asume que la anterior pasó. La primera
 * que falle detiene la cadena, porque seguir ejecutando contra un cliente roto
 * sólo produce ruido.
 *
 * Las tres que deciden si el plan sigue vivo son C1 (arranque del módulo
 * nativo en RN 0.86), C5 (ida y vuelta E2EE) y C6/C7 (adjuntos cifrados en
 * dispositivo físico, que es el bug abierto #55 del wrapper).
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
  /** Qué se observó. Se muestra tal cual en la pantalla y se copia al portapapeles. */
  detail: string;
  durationMs: number;
}

export type LogFn = (line: string) => void;

/** Milisegundos que esperamos a que un mensaje aparezca descifrado en el timeline. */
const TIMELINE_TIMEOUT_MS = 60_000;
/** Milisegundos que esperamos a que el sync inicial se estabilice. */
const SYNC_TIMEOUT_MS = 90_000;

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

/**
 * Extrae los `TimelineItem` que trae un diff. El SDK modela el diff como una
 * unión etiquetada, así que hay que cubrir cada variante que aporta items.
 */
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
 * Devuelve el cuerpo del mensaje si el item es un mensaje descifrado, o el
 * marcador `'<UTD>'` si el SDK no pudo descifrarlo. `undefined` para cualquier
 * otra cosa (eventos de estado, miembros, etc.).
 *
 * Distinguir descifrado de UTD es justamente el punto de la comprobación: un
 * item que llega pero no descifra significa que el E2EE está roto, no que el
 * transporte falló.
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

/**
 * Espera a que `body` aparezca descifrado en el timeline. Resuelve con el
 * motivo del fallo si vence el plazo o si el mensaje llega sin descifrar.
 */
async function waitForDecryptedBody(
  timeline: TimelineLike,
  body: string,
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
                'Llegó un evento al timeline pero el SDK no pudo descifrarlo (UnableToDecrypt). ' +
                  'El transporte funciona; el reparto de claves no.'
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
      new Error(
        `El mensaje no apareció descifrado en el timeline en ${TIMELINE_TIMEOUT_MS / 1000}s.`
      )
    );
  }, TIMELINE_TIMEOUT_MS);

  try {
    const failure = await outcome;
    if (failure) {
      throw new CheckFailure(failure.message);
    }
    log('    · mensaje observado descifrado en el timeline');
  } finally {
    clearTimeout(timeout);
    handle.cancel();
  }
}

/** Construye y autentica un cliente. Se usa para el usuario A y para el B. */
async function loginClient(
  config: SpikeConfig,
  username: string,
  password: string,
  storeLabel: string,
  log: LogFn
) {
  let builder = new ClientBuilder()
    .homeserverUrl(config.homeserverUrl.trim())
    .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.DiscoverNative)
    .autoEnableCrossSigning(true)
    .autoEnableBackups(true);

  if (config.usePersistentStore) {
    const dataDir = new File(Paths.document, `${storeLabel}/data`).parentDirectory;
    const cacheDir = new File(Paths.cache, `${storeLabel}/cache`).parentDirectory;
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
  await client.login(username.trim(), password, 'Allo Matrix Spike', undefined);
  return client;
}

/**
 * Arranca el sync y espera a que el servicio reporte un estado estable.
 * Devuelve el `SyncService` para poder pararlo en el cleanup.
 */
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
          'Comprueba que el homeserver soporta Simplified Sliding Sync (Synapse >= 1.114).'
      );
    }
  } finally {
    clearTimeout(timeout);
    stateHandle.cancel();
  }

  return syncService;
}

export interface SpikeRun {
  results: CheckResult[];
  /** `true` si alguna comprobación falló; el team lead sólo necesita esto. */
  failed: boolean;
}

export async function runSpike(config: SpikeConfig, log: LogFn): Promise<SpikeRun> {
  const results: CheckResult[] = [];
  let stopped = false;

  // Recursos a liberar pase lo que pase.
  let clientA: ClientLike | undefined;
  let clientB: ClientLike | undefined;
  let syncA: SyncServiceLike | undefined;
  let syncB: SyncServiceLike | undefined;

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

  function skip(id: string, title: string, reason: string): void {
    results.push({ id, title, status: 'skipped', detail: reason, durationMs: 0 });
    log(`▶ ${id} — ${title}`);
    log(`  ⏭️  ${reason}`);
  }

  // El identificador único del mensaje evita falsos positivos si el harness se
  // ejecuta varias veces contra la misma cuenta.
  const runId = `spike-${Date.now()}`;
  const messageBody = `hola desde ${runId}`;
  let roomId = '';
  let timelineA: TimelineLike | undefined;

  try {
    await check('C1', 'El módulo nativo arranca y Rust responde', async () => {
      // Si el crash de JNI del issue #47 sigue vivo en RN 0.86, la app se cae
      // al importar el módulo y nunca llegamos aquí.
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

    await check('C2', 'Login contra Synapse (usuario A)', async () => {
      clientA = await loginClient(config, config.username, config.password, 'userA', log);
      const session = clientA.session();
      return `Sesión abierta como ${session.userId}, deviceId ${session.deviceId}`;
    });

    await check('C3', 'Sliding sync arranca', async () => {
      if (!clientA) throw new CheckFailure('No hay cliente A.');
      syncA = await startSync(clientA, log);
      return 'SyncService reportó estado; sliding sync nativo operativo';
    });

    await check('C4', 'Crear sala cifrada', async () => {
      if (!clientA) throw new CheckFailure('No hay cliente A.');
      roomId = await clientA.createRoom({
        name: `Allo spike ${runId}`,
        isEncrypted: true,
        isDirect: false,
        visibility: new RoomVisibility.Private(),
        preset: RoomPreset.PrivateChat,
        invite: config.usernameB.trim() ? [config.usernameB.trim()] : undefined,
      });
      // La sala tarda un instante en aparecer en el room list tras crearse.
      await delay(2_000);
      const room = clientA.getRoom(roomId);
      if (!room) {
        throw new CheckFailure(`La sala ${roomId} no apareció en el room list.`);
      }
      const encrypted = await room.isEncrypted();
      if (!encrypted) {
        throw new CheckFailure(
          `La sala ${roomId} se creó pero el SDK no la considera cifrada.`
        );
      }
      timelineA = await room.timeline();
      return `Sala cifrada ${roomId}`;
    });

    await check('C5', 'Ida y vuelta de un mensaje E2EE', async () => {
      if (!timelineA) throw new CheckFailure('No hay timeline.');
      const observed = waitForDecryptedBody(timelineA, messageBody, log);
      await timelineA.send(messageEventContentFromMarkdown(messageBody));
      await observed;
      return 'Mensaje cifrado, enviado y releído descifrado';
    });

    // C6 y C7 son el issue #55: fallan en iPhone físico y funcionan en
    // simulador. Se ejecutan las dos variantes de origen porque el reporte
    // dice que ambas fallan igual, y conviene confirmarlo o desmentirlo.
    await check('C6', 'Adjunto cifrado desde bytes en memoria (UploadSource.Data)', async () => {
      if (!timelineA) throw new CheckFailure('No hay timeline.');
      const bytes = new Uint8Array(1024);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = i % 256;
      }
      const handle = timelineA.sendFile(
        {
          source: new UploadSource.Data({
            bytes: bytes.buffer,
            filename: `${runId}-data.bin`,
          }),
          caption: 'spike attachment (data)',
        },
        { mimetype: 'application/octet-stream', size: BigInt(bytes.length) }
      );
      await handle.join();
      return 'Adjunto de 1 KiB subido a la sala cifrada desde memoria';
    });

    await check('C7', 'Adjunto cifrado desde fichero en disco (UploadSource.File)', async () => {
      if (!timelineA) throw new CheckFailure('No hay timeline.');
      const bytes = new Uint8Array(1024);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = (i * 7) % 256;
      }
      const file = new File(Paths.cache, `${runId}-file.bin`);
      file.create({ overwrite: true });
      file.write(bytes);
      const path = file.uri.replace(/^file:\/\//, '');
      log(`    · fichero de prueba en ${path}`);
      const handle = timelineA.sendFile(
        {
          source: new UploadSource.File({ filename: path }),
          caption: 'spike attachment (file)',
        },
        { mimetype: 'application/octet-stream', size: BigInt(bytes.length) }
      );
      await handle.join();
      return 'Adjunto de 1 KiB subido a la sala cifrada desde disco';
    });

    await check('C8', 'Cross-signing, verificación y key backup', async () => {
      if (!clientA) throw new CheckFailure('No hay cliente A.');
      const encryption = clientA.encryption();
      const verification = encryption.verificationState();
      const recovery = encryption.recoveryState();
      const backup = encryption.backupState();
      const isLast = await encryption.isLastDevice();
      return (
        `verificationState=${String(verification)} recoveryState=${String(recovery)} ` +
        `backupState=${String(backup)} isLastDevice=${isLast}`
      );
    });

    if (!config.usernameB.trim()) {
      skip(
        'C9',
        'Ida y vuelta E2EE entre dos dispositivos',
        'No ejecutada: no se configuró usuario B. Es la única comprobación que ' +
          'demuestra el reparto de claves de sala entre dispositivos distintos.'
      );
    } else {
      await check('C9', 'Ida y vuelta E2EE entre dos dispositivos', async () => {
        clientB = await loginClient(
          config,
          config.usernameB,
          config.passwordB,
          'userB',
          log
        );
        syncB = await startSync(clientB, log);
        const roomB = clientB.getRoom(roomId);
        if (!roomB) {
          throw new CheckFailure(
            `El usuario B no ve la sala ${roomId}. ¿Se envió y aceptó la invitación?`
          );
        }
        await roomB.join();
        const timelineB = await roomB.timeline();
        const secondBody = `respuesta desde ${runId}`;
        const observedOnA = timelineA
          ? waitForDecryptedBody(timelineA, secondBody, log)
          : Promise.resolve();
        await timelineB.send(messageEventContentFromMarkdown(secondBody));
        await observedOnA;
        return 'B se unió a la sala cifrada y A descifró su mensaje';
      });
    }
  } finally {
    // El cleanup nunca debe enmascarar el resultado del spike.
    for (const [label, sync] of [
      ['A', syncA],
      ['B', syncB],
    ] as const) {
      if (!sync) continue;
      try {
        await sync.stop();
      } catch (error) {
        log(`  ⚠️  no se pudo parar el sync de ${label}: ${describeError(error)}`);
      }
    }
  }

  const failed = results.some((result) => result.status === 'fail');
  return { results, failed };
}

