import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, StatusBar } from 'react-native';
import {
    Appbar,
    List,
    RadioButton,
    Text,
    useTheme as usePaperTheme,
    Divider,
    Switch,
    Portal,
    Dialog,
    Button
} from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useTheme, ThemeMode } from '@/contexts/themeContext';
import * as Icons from 'phosphor-react-native';
import { colors } from '@/constants/theme';
import packageInfo from '../../package.json';

export default function Settings() {
    const router = useRouter();
    const { themeMode, setThemeMode, isDarkMode } = useTheme();
    const paperTheme = usePaperTheme();
    const [themeDialogVisible, setThemeDialogVisible] = useState(false);

    const handleThemeChange = (mode: ThemeMode) => {
        setThemeMode(mode);
        setThemeDialogVisible(false);
    };

    const getThemeDescription = (mode: ThemeMode) => {
        switch (mode) {
            case 'system':
                return 'Use system setting';
            case 'light':
                return 'Light mode';
            case 'dark':
                return 'Dark mode';
            default:
                return 'Use system setting';
        }
    };

    const getThemeIcon = (mode: ThemeMode) => {
        switch (mode) {
            case 'system':
                return 'device-mobile';
            case 'light':
                return 'sun';
            case 'dark':
                return 'moon';
            default:
                return 'device-mobile';
        }
    };

    return (
        <View style={[styles.container, { backgroundColor: paperTheme.colors.background }]}>
            <StatusBar
                barStyle={isDarkMode ? 'light-content' : 'dark-content'}
                backgroundColor={paperTheme.colors.surface}
            />

            <Appbar.Header style={{ backgroundColor: colors.alloGreen }}>
                <Appbar.BackAction iconColor={colors.white} onPress={() => router.back()} />
                <Appbar.Content
                    title="Settings"
                    titleStyle={[styles.headerTitle, { color: colors.white }]}
                />
            </Appbar.Header>

            <ScrollView style={styles.scrollContainer}>
                {/* Theme Section */}
                <View style={styles.section}>
                    <Text variant="titleMedium" style={[styles.sectionTitle, { color: paperTheme.colors.primary }]}>
                        Appearance
                    </Text>

                    <List.Item
                        title="Theme"
                        description={getThemeDescription(themeMode)}
                        left={() => (
                            <List.Icon
                                icon={getThemeIcon(themeMode)}
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Icons.CaretRight
                                size={20}
                                color={paperTheme.colors.onSurfaceVariant}
                            />
                        )}
                        onPress={() => setThemeDialogVisible(true)}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />
                </View>

                <Divider style={styles.divider} />

                {/* Notifications Section */}
                <View style={styles.section}>
                    <Text variant="titleMedium" style={[styles.sectionTitle, { color: paperTheme.colors.primary }]}>
                        Notifications
                    </Text>

                    <List.Item
                        title="Push Notifications"
                        description="Receive notifications for new messages"
                        left={() => (
                            <List.Icon
                                icon="bell"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Switch
                                value={true}
                                onValueChange={() => { }}
                                thumbColor={paperTheme.colors.primary}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />

                    <List.Item
                        title="Message Previews"
                        description="Show message content in notifications"
                        left={() => (
                            <List.Icon
                                icon="eye"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Switch
                                value={true}
                                onValueChange={() => { }}
                                thumbColor={paperTheme.colors.primary}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />
                </View>

                <Divider style={styles.divider} />

                {/* Privacy Section */}
                <View style={styles.section}>
                    <Text variant="titleMedium" style={[styles.sectionTitle, { color: paperTheme.colors.primary }]}>
                        Privacy
                    </Text>

                    <List.Item
                        title="Read Receipts"
                        description="Send read receipts to other users"
                        left={() => (
                            <List.Icon
                                icon="check-all"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Switch
                                value={true}
                                onValueChange={() => { }}
                                thumbColor={paperTheme.colors.primary}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />

                    <List.Item
                        title="Last Seen"
                        description="Share your last seen status"
                        left={() => (
                            <List.Icon
                                icon="clock"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Switch
                                value={true}
                                onValueChange={() => { }}
                                thumbColor={paperTheme.colors.primary}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />
                </View>

                <Divider style={styles.divider} />

                {/* About Section */}
                <View style={styles.section}>
                    <Text variant="titleMedium" style={[styles.sectionTitle, { color: paperTheme.colors.primary }]}>
                        About
                    </Text>

                    <List.Item
                        title="Version"
                        description={packageInfo.version}
                        left={() => (
                            <List.Icon
                                icon="information"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />

                    <List.Item
                        title="Privacy Policy"
                        description="Read our privacy policy"
                        left={() => (
                            <List.Icon
                                icon="shield-check"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Icons.CaretRight
                                size={20}
                                color={paperTheme.colors.onSurfaceVariant}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />

                    <List.Item
                        title="Terms of Service"
                        description="Read our terms of service"
                        left={() => (
                            <List.Icon
                                icon="file-document"
                                color={paperTheme.colors.onSurface}
                            />
                        )}
                        right={() => (
                            <Icons.CaretRight
                                size={20}
                                color={paperTheme.colors.onSurfaceVariant}
                            />
                        )}
                        style={[styles.listItem, { backgroundColor: paperTheme.colors.surface }]}
                    />
                </View>
            </ScrollView>

            {/* Theme Selection Dialog */}
            <Portal>
                <Dialog
                    visible={themeDialogVisible}
                    onDismiss={() => setThemeDialogVisible(false)}
                    style={{ backgroundColor: paperTheme.colors.surface }}
                >
                    <Dialog.Title style={{ color: paperTheme.colors.onSurface }}>
                        Choose Theme
                    </Dialog.Title>
                    <Dialog.Content>
                        <RadioButton.Group
                            onValueChange={(value) => handleThemeChange(value as ThemeMode)}
                            value={themeMode}
                        >
                            <View style={styles.radioOption}>
                                <View style={styles.radioContent}>
                                    <Icons.DeviceMobile size={24} color={paperTheme.colors.onSurface} />
                                    <View style={styles.radioText}>
                                        <Text variant="bodyLarge" style={{ color: paperTheme.colors.onSurface }}>
                                            System
                                        </Text>
                                        <Text variant="bodySmall" style={{ color: paperTheme.colors.onSurfaceVariant }}>
                                            Use system setting
                                        </Text>
                                    </View>
                                </View>
                                <RadioButton value="system" color={paperTheme.colors.primary} />
                            </View>

                            <View style={styles.radioOption}>
                                <View style={styles.radioContent}>
                                    <Icons.Sun size={24} color={paperTheme.colors.onSurface} />
                                    <View style={styles.radioText}>
                                        <Text variant="bodyLarge" style={{ color: paperTheme.colors.onSurface }}>
                                            Light
                                        </Text>
                                        <Text variant="bodySmall" style={{ color: paperTheme.colors.onSurfaceVariant }}>
                                            Light mode
                                        </Text>
                                    </View>
                                </View>
                                <RadioButton value="light" color={paperTheme.colors.primary} />
                            </View>

                            <View style={styles.radioOption}>
                                <View style={styles.radioContent}>
                                    <Icons.Moon size={24} color={paperTheme.colors.onSurface} />
                                    <View style={styles.radioText}>
                                        <Text variant="bodyLarge" style={{ color: paperTheme.colors.onSurface }}>
                                            Dark
                                        </Text>
                                        <Text variant="bodySmall" style={{ color: paperTheme.colors.onSurfaceVariant }}>
                                            Dark mode
                                        </Text>
                                    </View>
                                </View>
                                <RadioButton value="dark" color={paperTheme.colors.primary} />
                            </View>
                        </RadioButton.Group>
                    </Dialog.Content>
                    <Dialog.Actions>
                        <Button
                            onPress={() => setThemeDialogVisible(false)}
                            textColor={paperTheme.colors.primary}
                        >
                            Cancel
                        </Button>
                    </Dialog.Actions>
                </Dialog>
            </Portal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: '600',
    },
    scrollContainer: {
        flex: 1,
    },
    section: {
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    sectionTitle: {
        marginBottom: 12,
        fontWeight: '600',
    },
    listItem: {
        marginBottom: 4,
        borderRadius: 12,
    },
    divider: {
        marginHorizontal: 16,
    },
    radioOption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
    },
    radioContent: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    radioText: {
        marginLeft: 16,
        flex: 1,
    },
}); 