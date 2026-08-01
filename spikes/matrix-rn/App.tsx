import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { DEFAULT_CONFIG, validateConfig, type SpikeConfig } from './src/config';
import { runPhaseA, type CheckResult, type SpikeSession } from './src/checks';

type Phase = 'idle' | 'runningA' | 'readyForB' | 'waitingB' | 'done';

const STATUS_COLOR: Record<CheckResult['status'], string> = {
  pass: '#137333',
  fail: '#c5221f',
  skipped: '#8a8a8a',
};

export default function App() {
  const [config, setConfig] = useState<SpikeConfig>(DEFAULT_CONFIG);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [session, setSession] = useState<SpikeSession | undefined>(undefined);
  const [configError, setConfigError] = useState<string | undefined>(undefined);

  const set = <K extends keyof SpikeConfig>(key: K, value: SpikeConfig[K]) =>
    setConfig((previous) => ({ ...previous, [key]: value }));

  // El log se acumula fuera del estado de React para que cada línea no
  // dispare un render con un array a medio construir.
  const appendLine = (collected: string[], line: string) => {
    collected.push(line);
    setLines([...collected]);
  };

  const onRunPhaseA = async () => {
    const error = validateConfig(config);
    setConfigError(error);
    if (error) {
      return;
    }

    setPhase('runningA');
    setLines([]);
    setResults([]);
    setSession(undefined);

    const collected: string[] = [];
    const log = (line: string) => appendLine(collected, line);

    try {
      const created = await runPhaseA(config, log);
      setSession(created);
      setResults(created.results);
      if (created.failed) {
        log('— Fase A FALLIDA. No sigas a la Fase B: arregla esto primero. —');
        setPhase('done');
      } else {
        log('— Fase A completa. Sigue las instrucciones de abajo. —');
        setPhase('readyForB');
      }
    } catch (error) {
      log(
        `💥 El runner se cayó: ${error instanceof Error ? error.message : String(error)}`
      );
      setPhase('done');
    }
  };

  const onWaitForPeer = async () => {
    if (!session) return;
    setPhase('waitingB');

    const collected = [...lines];
    const log = (line: string) => appendLine(collected, line);

    const result = await session.waitForPeerMessage(log);
    setResults((previous) => [...previous, result]);
    await session.dispose(log);
    log('— Spike terminado. Copia todo este log. —');
    setPhase('done');
  };

  const busy = phase === 'runningA' || phase === 'waitingB';

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Allo · spike matrix-rust-sdk</Text>
        <Text style={styles.subtitle}>
          Fase 0. Rellena los datos, pulsa Fase A, y luego sigue las instrucciones
          que aparecerán para terminar en el navegador.
        </Text>

        <Field
          label="Homeserver"
          value={config.homeserverUrl}
          onChange={(value) => set('homeserverUrl', value)}
          disabled={busy}
        />
        <Field
          label="Usuario"
          value={config.username}
          onChange={(value) => set('username', value)}
          placeholder="alice"
          disabled={busy}
        />
        <Field
          label="Contraseña"
          value={config.password}
          onChange={(value) => set('password', value)}
          disabled={busy}
          secure
        />
        <Field
          label="MXID de la segunda cuenta (opcional)"
          value={config.usernameB}
          onChange={(value) => set('usernameB', value)}
          placeholder="@bob:matrix.org"
          disabled={busy}
        />

        <View style={styles.switchRow}>
          <Text style={styles.label}>Store SQLite en disco</Text>
          <Switch
            value={config.usePersistentStore}
            onValueChange={(value) => set('usePersistentStore', value)}
            disabled={busy}
          />
        </View>

        {configError ? <Text style={styles.error}>{configError}</Text> : null}

        <Pressable
          style={[styles.button, (busy || phase !== 'idle') && styles.buttonDisabled]}
          onPress={onRunPhaseA}
          disabled={busy || phase !== 'idle'}
        >
          {phase === 'runningA' ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.buttonText}>Fase A · ejecutar en el móvil</Text>
          )}
        </Pressable>

        {session && !session.failed ? (
          <View style={styles.handoff}>
            <Text style={styles.sectionTitle}>Fase B · ahora en el navegador</Text>

            <Text style={styles.handoffLabel}>Clave de recuperación</Text>
            <Text style={styles.mono} selectable>
              {session.recoveryKey ?? '(no generada)'}
            </Text>

            <Text style={styles.handoffLabel}>Sala</Text>
            <Text style={styles.mono} selectable>
              {session.roomId ?? '(sin sala)'}
            </Text>

            <Text style={styles.handoffLabel}>Mensaje que debe verse descifrado</Text>
            <Text style={styles.mono} selectable>
              {session.sentBodies.join('\n') || '(ninguno)'}
            </Text>

            <Text style={styles.handoffLabel}>Escribe esto EXACTO en Element Web</Text>
            <Text style={styles.mono} selectable>
              {session.pingToken}
            </Text>

            <Text style={styles.steps}>
              1. Abre app.element.io en el ordenador e inicia sesión.{'\n'}
              2. Cuando pida verificar, elige verificar con clave de recuperación y
              pega la clave de arriba.{'\n'}
              3. Entra en la sala y comprueba que el mensaje de arriba se lee. Si
              sale «no se puede descifrar», C6 ha fallado.{'\n'}
              4. Envía el texto PING de arriba en esa sala.{'\n'}
              5. Vuelve aquí y pulsa el botón.
            </Text>

            <Pressable
              style={[styles.button, phase !== 'readyForB' && styles.buttonDisabled]}
              onPress={onWaitForPeer}
              disabled={phase !== 'readyForB'}
            >
              {phase === 'waitingB' ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>Fase B · esperar el PING</Text>
              )}
            </Pressable>
          </View>
        ) : null}

        {results.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Resultado</Text>
            {results.map((result) => (
              <View key={result.id} style={styles.result}>
                <Text
                  style={[styles.resultTitle, { color: STATUS_COLOR[result.status] }]}
                >
                  {result.status === 'pass'
                    ? '✅'
                    : result.status === 'fail'
                      ? '❌'
                      : '⏭️'}{' '}
                  {result.id} — {result.title}
                </Text>
                <Text style={styles.resultDetail} selectable>
                  {result.detail}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {lines.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Log</Text>
            <Text style={styles.log} selectable>
              {lines.join('\n')}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  secure?: boolean;
}

function Field({ label, value, onChange, placeholder, disabled, secure }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        editable={!disabled}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 20, paddingTop: 64, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 13, color: '#5f6368', marginBottom: 8 },
  field: { gap: 4 },
  label: { fontSize: 13, fontWeight: '600', color: '#3c4043' },
  input: {
    borderWidth: 1,
    borderColor: '#dadce0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { backgroundColor: '#8ab4f8' },
  buttonText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
  error: { color: '#c5221f', fontSize: 13 },
  section: { marginTop: 20, gap: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  handoff: {
    marginTop: 20,
    gap: 6,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#fef7e0',
    borderWidth: 1,
    borderColor: '#f9ab00',
  },
  handoffLabel: { fontSize: 12, fontWeight: '700', color: '#3c4043', marginTop: 6 },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#202124',
    backgroundColor: '#ffffff',
    padding: 8,
    borderRadius: 6,
  },
  steps: { fontSize: 13, color: '#3c4043', marginTop: 10, lineHeight: 19 },
  result: { gap: 2 },
  resultTitle: { fontSize: 14, fontWeight: '600' },
  resultDetail: { fontSize: 13, color: '#3c4043' },
  log: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#202124',
    backgroundColor: '#f1f3f4',
    padding: 12,
    borderRadius: 8,
  },
});
