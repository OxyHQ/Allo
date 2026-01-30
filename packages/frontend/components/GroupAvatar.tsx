import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import Avatar from './Avatar';
import { ConversationParticipant } from '@/app/(chat)/index';
import { useTheme } from '@/hooks/useTheme';

interface GroupAvatarProps {
  participants: ConversationParticipant[];
  size?: number;
  maxAvatars?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Each layout entry positions an avatar inside the circle.
 * x, y = top-left origin as a fraction of container size (0–1).
 * s    = avatar diameter as a fraction of container size.
 */
type AvatarSlot = { x: number; y: number; s: number };

const LAYOUTS: Record<number, AvatarSlot[]> = {
  2: [
    { x: 0.04, y: 0.06, s: 0.58 },
    { x: 0.38, y: 0.40, s: 0.54 },
  ],
  3: [
    { x: 0.27, y: 0.01, s: 0.48 },
    { x: 0.01, y: 0.40, s: 0.44 },
    { x: 0.46, y: 0.46, s: 0.46 },
  ],
  4: [
    { x: 0.26, y: 0.01, s: 0.42 },
    { x: 0.01, y: 0.32, s: 0.38 },
    { x: 0.50, y: 0.24, s: 0.40 },
    { x: 0.28, y: 0.56, s: 0.38 },
  ],
  5: [
    { x: 0.22, y: 0.00, s: 0.38 },
    { x: 0.56, y: 0.12, s: 0.34 },
    { x: 0.00, y: 0.28, s: 0.36 },
    { x: 0.38, y: 0.46, s: 0.36 },
    { x: 0.06, y: 0.60, s: 0.32 },
  ],
  6: [
    { x: 0.18, y: 0.00, s: 0.36 },
    { x: 0.54, y: 0.04, s: 0.32 },
    { x: 0.00, y: 0.26, s: 0.34 },
    { x: 0.38, y: 0.30, s: 0.32 },
    { x: 0.62, y: 0.48, s: 0.30 },
    { x: 0.14, y: 0.58, s: 0.34 },
  ],
};

/**
 * GroupAvatar
 *
 * Packs participant avatars inside a single circle at different sizes,
 * like floating bubbles within the container. The overall shape stays
 * the same size as a regular single Avatar.
 */
export const GroupAvatar: React.FC<GroupAvatarProps> = ({
  participants,
  size = 48,
  maxAvatars = 6,
  style,
}) => {
  const theme = useTheme();

  const getInitial = (p: ConversationParticipant): string =>
    p.name?.first?.charAt(0).toUpperCase() || '?';

  // Empty group fallback
  if (!participants || participants.length === 0) {
    return (
      <View
        style={[
          styles.container,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.colors.backgroundSecondary,
          },
          style,
        ]}
      >
        <Avatar size={size * 0.6} label="?" />
      </View>
    );
  }

  // Single participant — just show a normal avatar
  if (participants.length === 1) {
    return (
      <Avatar
        size={size}
        source={participants[0].avatar ? { uri: participants[0].avatar } : undefined}
        label={getInitial(participants[0])}
        style={style}
      />
    );
  }

  const visible = participants.slice(0, maxAvatars);
  const layoutKey = Math.min(visible.length, 6) as 2 | 3 | 4 | 5 | 6;
  const layout = LAYOUTS[layoutKey];

  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.backgroundSecondary,
        },
        style,
      ]}
    >
      {layout.map((slot, index) => {
        const participant = visible[index];
        if (!participant) return null;
        const avatarSize = Math.round(slot.s * size);
        return (
          <View
            key={participant.id}
            style={{
              position: 'absolute',
              left: Math.round(slot.x * size),
              top: Math.round(slot.y * size),
            }}
          >
            <Avatar
              size={avatarSize}
              source={participant.avatar ? { uri: participant.avatar } : undefined}
              label={getInitial(participant)}
            />
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
});
