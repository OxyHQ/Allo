import React, { useMemo } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Avatar from '@/components/Avatar';
import type { AvatarShapeKey } from '@/components/avatar/avatarShapes';

interface MessageAvatarProps {
  name?: string;
  avatarUri?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  shape?: AvatarShapeKey;
}

const getInitials = (name?: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(' ').filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
  return initials || '?';
};

export const MessageAvatar: React.FC<MessageAvatarProps> = ({
  name,
  avatarUri,
  size = 32,
  style,
  shape,
}) => {
  const initials = useMemo(() => getInitials(name), [name]);

  return (
    <Avatar
      source={avatarUri ? { uri: avatarUri } : undefined}
      label={initials}
      size={size}
      style={style}
      shape={shape}
    />
  );
};

