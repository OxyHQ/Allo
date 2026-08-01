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
import { EMPTY_CONFIG, validateConfig, type SpikeConfig } from './src/config';
import { runSpike, type CheckResult } from './src/checks';

type Phase = 'idle' | 'running' | 'done';

const STATUS_COLOR: Record<CheckResult['status'], string> = {
  pass: '#137333',
  fail: '#c5221f',
  skipped: '#8a8a8a',
};

export default function App() {
  const [config, setConfig] = useState<SpikeConfig>(EMPTY_CONFIG);
  const [phase, setPhase] = useState<Phase>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [configError, setConfigError] = useState<string | undefined>(undefined);

  const set = <K extends keyof SpikeConfig>(key: K, value: SpikeConfig[K]) =>
    setConfig((previous) => ({ ...previous, [key]: value }));

  const onRun = async () => {
    const error = validateConfig(config);
    setConfigError(error);
    if (error) {
      return;
    }

    setPhase('running');
    setLines([]);
    setResults([]);

    const collected: string[] = [];
    const log = (line: string) => {
      collected.push(line);
      setLines([...collected]);
    };

    try {
      const run = await runSpike(config, log);
      setResults(run.results);
      log(run.failed ? '— Spike FALLIDO —' : '— Spike COMPLETO, sin fallos —');
    } catch (error) {
      // runSpike ya captura por comprobación; esto sólo cubre un fallo del
      // propio runner, que también hay que ver en pantalla.
      log(`💥 El runner se cayó: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPhase('done');
    }
  };

  const busy = phase === 'running';

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Allo · spike matrix-rust-sdk</Text>
        <Text style={styles.subtitle}>
          Fase 0. Ejecutar en dispositivo físico, no en simulador: el bug de adjuntos
          que estamos comprobando sólo se reproduce en hardware real.
        </Text>

        <Field
          label="Homeserver"
          value={config.homeserverUrl}
          onChange={(value) => set('homeserverUrl', value)}
          placeholder="https://matrix.example.org"
          disabled={busy}
          autoCapitalize="none"
        />
        <Field
          label="Usuario A"
          value={config.username}
          onChange={(value) => set('username', value)}
          placeholder="alice"
          disabled={busy}
          autoCapitalize="none"
        />
        <Field
          label="Contraseña A"
          value={config.password}
          onChange={(value) => set('password', value)}
          disabled={busy}
          secure
        />
        <Field
          label="Usuario B (opcional, habilita C9)"
          value={config.usernameB}
          onChange={(value) => set('usernameB', value)}
          placeholder="@bob:example.org"
          disabled={busy}
          autoCapitalize="none"
        />
        <Field
          label="Contraseña B"
          value={config.passwordB}
          onChange={(value) => set('passwordB', value)}
          disabled={busy}
          secure
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
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={onRun}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text style={styles.buttonText}>Ejecutar spike</Text>
          )}
        </Pressable>

        {results.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Resultado</Text>
            {results.map((result) => (
              <View key={result.id} style={styles.result}>
                <Text style={[styles.resultTitle, { color: STATUS_COLOR[result.status] }]}>
                  {result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⏭️'}{' '}
                  {result.id} — {result.title}
                </Text>
                <Text style={styles.resultDetail}>{result.detail}</Text>
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
  autoCapitalize?: 'none' | 'sentences';
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  secure,
  autoCapitalize,
}: FieldProps) {
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
        autoCapitalize={autoCapitalize ?? 'none'}
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
