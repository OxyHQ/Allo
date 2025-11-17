import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import Avatar from './Avatar';
import { ConversationParticipant } from '@/app/(chat)/index';

interface GroupAvatarProps {
  participants: ConversationParticipant[];
  size?: number;
  maxAvatars?: number; // Maximum number of avatars to display (default: 2)
  style?: StyleProp<ViewStyle>;
}

/**
 * Component for displaying multiple avatars in a stacked layout for group conversations
 */
export const GroupAvatar: React.FC<GroupAvatarProps> = ({
  participants,
  size = 48,
  maxAvatars = 2,
  style,
}) => {
  if (!participants || participants.length === 0) {
    return (
      <View style={[styles.container, { width: size, height: size }, style]}>
        <Avatar size={size} label="?" />
      </View>
    );
  }

  // Helper to get initial from participant
  const getInitial = (participant: ConversationParticipant): string => {
    return participant.name?.first?.charAt(0).toUpperCase() || '?';
  };

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

  // For groups, show up to maxAvatars stacked
  const avatarsToShow = participants.slice(0, maxAvatars);
  const avatarSize = size * 0.65; // Each avatar is 65% of total size
  const offset = size * 0.35; // Offset for stacking

  return (
    <View style={[styles.container, { width: size, height: size }, style]}>
      {avatarsToShow.map((participant, index) => {
        const isLast = index === avatarsToShow.length - 1;
        const positionStyle = {
          position: 'absolute' as const,
          left: index * offset,
          top: index * offset,
        };

        return (
          <View key={participant.id} style={positionStyle}>
            <Avatar
              size={avatarSize}
              source={participant.avatar ? { uri: participant.avatar } : undefined}
              label={getInitial(participant)}
            />
          </View>
        );
      })}
      {/* Show indicator if there are more participants */}
      {participants.length > maxAvatars && (
        <View
          style={[
            {
              position: 'absolute' as const,
              width: avatarSize,
              height: avatarSize,
              left: (avatarsToShow.length - 1) * offset,
              top: (avatarsToShow.length - 1) * offset,
            },
          ]}
        >
          <Avatar
            size={avatarSize}
            label={`+${participants.length - maxAvatars}`}
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

