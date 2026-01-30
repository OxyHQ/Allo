import React, { useState, useMemo } from 'react';
import {
    StyleSheet,
    View,
    Text,
    FlatList,
    TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Ionicons } from '@expo/vector-icons';
import { EmptyState } from '@/components/shared/EmptyState';

const IconComponent = Ionicons as any;

// Mock data - replace with actual data from your store/API
interface Call {
    id: string;
    name: string;
    phone?: string;
    timestamp: Date;
    type: 'missed' | 'outgoing' | 'incoming';
    duration?: number; // in seconds
    avatar?: string;
}

const MOCK_CALLS: Call[] = [
    {
        id: '1',
        name: 'John Doe',
        phone: '+1 234 567 8900',
        timestamp: new Date(Date.now() - 3600000),
        type: 'missed',
        duration: 0,
    },
    {
        id: '2',
        name: 'Jane Smith',
        phone: '+1 234 567 8901',
        timestamp: new Date(Date.now() - 7200000),
        type: 'outgoing',
        duration: 180,
    },
    {
        id: '3',
        name: 'Alice Johnson',
        phone: '+1 234 567 8902',
        timestamp: new Date(Date.now() - 86400000),
        type: 'incoming',
        duration: 245,
    },
];

export default function CallsScreen() {
    const theme = useTheme();
    const [calls] = useState<Call[]>(MOCK_CALLS);

    const styles = useMemo(() => StyleSheet.create({
        container: {
            flex: 1,
            backgroundColor: theme.colors.background,
        },
        header: {
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.background,
        },
        headerTitle: {
            fontSize: 24,
            fontWeight: 'bold',
            color: theme.colors.text,
        },
        list: {
            flex: 1,
        },
        callItem: {
            flexDirection: 'row',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: theme.colors.border,
            backgroundColor: theme.colors.background,
            alignItems: 'center',
        },
        callIcon: {
            marginRight: 12,
            width: 40,
            height: 40,
            borderRadius: 20,
            justifyContent: 'center',
            alignItems: 'center',
        },
        callIconMissed: {
            backgroundColor: `${theme.colors.error || '#FF3B30'}20`,
        },
        callIconOutgoing: {
            backgroundColor: `${theme.colors.primary}20`,
        },
        callIconIncoming: {
            backgroundColor: `${theme.colors.success || '#4CAF50'}20`,
        },
        callContent: {
            flex: 1,
            marginLeft: 12,
        },
        callHeader: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
        },
        callName: {
            fontSize: 16,
            fontWeight: '600',
            color: theme.colors.text,
        },
        callTimestamp: {
            fontSize: 12,
            color: theme.colors.textSecondary,
        },
        callDetails: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        callPhone: {
            fontSize: 14,
            color: theme.colors.textSecondary,
        },
        callDuration: {
            fontSize: 14,
            color: theme.colors.textSecondary,
        },
    }), [theme]);

    const formatTimestamp = (date: Date) => {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (minutes < 1) return 'Just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return date.toLocaleDateString();
    };

    const formatDuration = (seconds: number) => {
        if (seconds === 0) return '';
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const getCallIcon = (type: Call['type']) => {
        switch (type) {
            case 'missed':
                return <IconComponent name="call" size={20} color={theme.colors.error || '#FF3B30'} />;
            case 'outgoing':
                return <IconComponent name="call-outline" size={20} color={theme.colors.primary} />;
            case 'incoming':
                return <IconComponent name="call" size={20} color={theme.colors.success || '#4CAF50'} />;
            default:
                return <IconComponent name="call-outline" size={20} color={theme.colors.text} />;
        }
    };

    const renderCallItem = ({ item }: { item: Call }) => {
        const iconStyle = 
            item.type === 'missed' ? styles.callIconMissed :
            item.type === 'outgoing' ? styles.callIconOutgoing :
            styles.callIconIncoming;

        return (
            <TouchableOpacity
                style={styles.callItem}
                activeOpacity={0.7}
            >
                <View style={[styles.callIcon, iconStyle]}>
                    {getCallIcon(item.type)}
                </View>
                <View style={styles.callContent}>
                    <View style={styles.callHeader}>
                        <ThemedText style={styles.callName}>
                            {item.name}
                        </ThemedText>
                        <ThemedText style={styles.callTimestamp}>
                            {formatTimestamp(item.timestamp)}
                        </ThemedText>
                    </View>
                    <View style={styles.callDetails}>
                        {item.phone && (
                            <ThemedText style={styles.callPhone}>
                                {item.phone}
                            </ThemedText>
                        )}
                        {item.duration !== undefined && item.duration > 0 && (
                            <>
                                <Text style={{ color: theme.colors.textSecondary }}>•</Text>
                                <ThemedText style={styles.callDuration}>
                                    {formatDuration(item.duration)}
                                </ThemedText>
                            </>
                        )}
                    </View>
                </View>
            </TouchableOpacity>
        );
    };

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <ThemedView style={styles.container}>
                <View style={styles.header}>
                    <ThemedText style={styles.headerTitle}>Calls</ThemedText>
                </View>

                {calls.length > 0 ? (
                    <FlatList
                        style={styles.list}
                        data={calls}
                        renderItem={renderCallItem}
                        keyExtractor={(item) => item.id}
                        contentContainerStyle={{ flexGrow: 1 }}
                    />
                ) : (
                    <EmptyState
                        lottieSource={require('@/assets/lottie/welcome.json')}
                        title="No calls yet"
                        subtitle="Your call history will appear here!"
                    />
                )}
            </ThemedView>
        </SafeAreaView>
    );
}

