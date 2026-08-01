import { useCallback, useState, useSyncExternalStore } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
    getLines,
    getServerLines,
    installGlobal,
    run,
    step1LoadWasm,
    step2Login,
    step3RoundTrip,
    step4aBootstrapRecovery,
    step4bRecoverOnSecondDevice,
    step5MultiTab,
    step5ProbeLockPrimitives,
    subscribe,
    type SpikeConfig,
} from '../spike';

// Runs at module scope on purpose: the global driving surface must exist before
// anything renders, and Effects would run twice under StrictMode.
installGlobal();

const DEFAULT_CONFIG: SpikeConfig = {
    homeserver: 'http://localhost:8008',
    user: '',
    password: '',
    passphrase: '',
};

export default function App() {
    // The third argument is required because this app is exported with
    // `output: "static"`, i.e. it is server-rendered in Node at export time.
    const lines = useSyncExternalStore(subscribe, getLines, getServerLines);
    const [config, setConfig] = useState<SpikeConfig>(DEFAULT_CONFIG);
    const [busy, setBusy] = useState(false);

    const runStep = useCallback(async (name: string, fn: () => Promise<unknown> | unknown) => {
        setBusy(true);
        try {
            await run(name, fn);
        } finally {
            setBusy(false);
        }
    }, []);

    const steps: { label: string; action: () => Promise<void> }[] = [
        { label: '1 · load wasm', action: () => runStep('step1 wasm', step1LoadWasm) },
        { label: '2 · login + crypto', action: () => runStep('step2 login', () => step2Login(config)) },
        { label: '3 · encrypted round trip', action: () => runStep('step3 round trip', step3RoundTrip) },
        { label: '4a · 4S from passphrase', action: () => runStep('step4a recovery', step4aBootstrapRecovery) },
        { label: '4b · recover on device B', action: () => runStep('step4b recover', step4bRecoverOnSecondDevice) },
        { label: '5 · multi-tab client', action: () => runStep('step5 multi-tab', () => step5MultiTab(config)) },
        { label: '5 · probe lock APIs', action: () => runStep('step5 probe', step5ProbeLockPrimitives) },
    ];

    return (
        <View style={styles.root}>
            <Text style={styles.title}>matrix-js-sdk + crypto wasm under Expo web</Text>

            <View style={styles.form}>
                {(['homeserver', 'user', 'password', 'passphrase'] as const).map((field) => (
                    <TextInput
                        key={field}
                        style={styles.input}
                        placeholder={field}
                        placeholderTextColor="#888"
                        value={config[field]}
                        autoCapitalize="none"
                        autoCorrect={false}
                        secureTextEntry={field === 'password'}
                        onChangeText={(value) => setConfig((prev) => ({ ...prev, [field]: value }))}
                        // nativeID lets the browser-driven part of the spike fill
                        // these fields without depending on layout coordinates.
                        nativeID={`spike-${field}`}
                    />
                ))}
            </View>

            <View style={styles.buttons}>
                {steps.map((step) => (
                    <Pressable
                        key={step.label}
                        style={[styles.button, busy && styles.buttonBusy]}
                        disabled={busy}
                        onPress={step.action}
                    >
                        <Text style={styles.buttonText}>{step.label}</Text>
                    </Pressable>
                ))}
            </View>

            <ScrollView style={styles.log} nativeID="spike-log">
                {lines.map((line, index) => (
                    <Text key={`${index}-${line.slice(0, 12)}`} style={styles.logLine} selectable>
                        {line}
                    </Text>
                ))}
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, padding: 16, backgroundColor: '#12131a', gap: 12 },
    title: { color: '#fff', fontSize: 18, fontWeight: '600' },
    form: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    input: {
        backgroundColor: '#1e2029',
        color: '#fff',
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 6,
        minWidth: 180,
    },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    button: { backgroundColor: '#3d5afe', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
    buttonBusy: { opacity: 0.5 },
    buttonText: { color: '#fff', fontWeight: '600' },
    log: { flex: 1, backgroundColor: '#0b0c11', borderRadius: 6, padding: 10 },
    logLine: { color: '#c8d1e0', fontFamily: 'monospace', fontSize: 12 },
});
