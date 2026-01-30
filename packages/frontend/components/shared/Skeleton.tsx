import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';

/**
 * Reusable skeleton bone element with pulse animation
 */
export function SkeletonBone({
  width,
  height,
  borderRadius = 4,
  style,
}: {
  width: number | string;
  height: number;
  borderRadius?: number;
  style?: any;
}) {
  const theme = useTheme();
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const bone = theme.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  return (
    <Animated.View
      style={[
        { width: width as any, height, borderRadius, backgroundColor: bone },
        animStyle,
        style,
      ]}
    />
  );
}

/**
 * Skeleton row mimicking a conversation list item (avatar + name + message)
 */
export function ConversationSkeletonRow({ index = 0 }: { index?: number }) {
  const theme = useTheme();
  const nameWidths = [140, 110, 160, 120, 130, 100, 150, 115, 145, 125];
  const msgWidths = [200, 170, 220, 180, 150, 210, 190, 160, 230, 175];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 64,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
      }}
    >
      <SkeletonBone width={44} height={44} borderRadius={22} style={{ marginRight: 12 }} />
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <SkeletonBone width={nameWidths[index % nameWidths.length]} height={14} />
          <SkeletonBone width={40} height={10} borderRadius={3} />
        </View>
        <SkeletonBone width={msgWidths[index % msgWidths.length]} height={12} />
      </View>
    </View>
  );
}

/**
 * Skeleton for a user list item (avatar + name + subtitle)
 */
export function UserSkeletonRow({ index = 0 }: { index?: number }) {
  const theme = useTheme();
  const nameWidths = [120, 100, 140, 110, 130];
  const handleWidths = [80, 70, 90, 75, 85];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
      }}
    >
      <SkeletonBone width={48} height={48} borderRadius={24} />
      <View style={{ flex: 1, marginLeft: 12, justifyContent: 'center' }}>
        <SkeletonBone width={nameWidths[index % nameWidths.length]} height={14} style={{ marginBottom: 6 }} />
        <SkeletonBone width={handleWidths[index % handleWidths.length]} height={12} />
      </View>
    </View>
  );
}

/**
 * Skeleton for a chat message bubble
 */
export function MessageSkeletonRow({ index = 0 }: { index?: number }) {
  const isSent = index % 3 !== 0;
  const widths = [180, 140, 220, 160, 200, 120, 190];

  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: isSent ? 'flex-end' : 'flex-start',
        paddingHorizontal: 12,
        marginVertical: 3,
      }}
    >
      <SkeletonBone
        width={widths[index % widths.length]}
        height={36}
        borderRadius={18}
      />
    </View>
  );
}

/**
 * Skeleton for a settings row (icon + label + chevron)
 */
export function SettingsSkeletonRow({ index = 0 }: { index?: number }) {
  const labelWidths = [140, 160, 120, 150, 130, 170, 110];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 16,
      }}
    >
      <SkeletonBone width={20} height={20} borderRadius={4} style={{ marginRight: 12 }} />
      <SkeletonBone width={labelWidths[index % labelWidths.length]} height={14} style={{ flex: 1 }} />
      <SkeletonBone width={16} height={16} borderRadius={3} />
    </View>
  );
}

/**
 * Skeleton for a draft list item
 */
export function DraftSkeletonRow({ index = 0 }: { index?: number }) {
  const theme = useTheme();
  const previewWidths = [200, 170, 220, 180, 190];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flex: 1, marginRight: 12 }}>
        <SkeletonBone width={70} height={10} borderRadius={3} style={{ marginBottom: 6 }} />
        <SkeletonBone width={previewWidths[index % previewWidths.length]} height={14} />
      </View>
      <SkeletonBone width={18} height={18} borderRadius={4} />
    </View>
  );
}

/**
 * Skeleton for a GIF grid (3-column)
 */
export function GifGridSkeleton({ count = 9 }: { count?: number }) {
  const rows = Math.ceil(count / 3);

  return (
    <View style={{ flex: 1 }}>
      {Array.from({ length: rows }, (_, rowIdx) => (
        <View key={rowIdx} style={{ flexDirection: 'row', width: '100%' }}>
          {Array.from({ length: 3 }, (_, colIdx) => (
            <View key={colIdx} style={{ flex: 1, aspectRatio: 1, borderWidth: 1, borderColor: 'transparent' }}>
              <SkeletonBone width={200} height={200} borderRadius={0} style={{ flex: 1, width: '100%', height: '100%' }} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * Full-screen skeleton for conversation list
 */
export function ConversationListSkeleton({ count = 10 }: { count?: number }) {
  return (
    <View style={{ flex: 1 }}>
      {Array.from({ length: count }, (_, i) => (
        <ConversationSkeletonRow key={i} index={i} />
      ))}
    </View>
  );
}

/**
 * Skeleton for user search results
 */
export function UserListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View style={{ flex: 1 }}>
      {Array.from({ length: count }, (_, i) => (
        <UserSkeletonRow key={i} index={i} />
      ))}
    </View>
  );
}

/**
 * Skeleton for chat messages
 */
export function MessageListSkeleton({ count = 8 }: { count?: number }) {
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end', paddingVertical: 12 }}>
      {Array.from({ length: count }, (_, i) => (
        <MessageSkeletonRow key={i} index={i} />
      ))}
    </View>
  );
}

/**
 * Skeleton for settings list
 */
export function SettingsListSkeleton({ count = 7 }: { count?: number }) {
  const theme = useTheme();

  return (
    <View style={{ marginHorizontal: 16, marginTop: 20, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.border, overflow: 'hidden', backgroundColor: theme.colors.card }}>
      {Array.from({ length: count }, (_, i) => (
        <React.Fragment key={i}>
          <SettingsSkeletonRow index={i} />
          {i < count - 1 && (
            <View style={{ height: 1, marginHorizontal: 16, backgroundColor: theme.colors.border }} />
          )}
        </React.Fragment>
      ))}
    </View>
  );
}

/**
 * Skeleton for drafts list
 */
export function DraftsListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <View style={{ flex: 1 }}>
      {Array.from({ length: count }, (_, i) => (
        <DraftSkeletonRow key={i} index={i} />
      ))}
    </View>
  );
}
