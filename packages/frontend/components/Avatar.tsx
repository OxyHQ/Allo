import React from 'react';
import {
  View,
  Image,
  Animated,
  StyleSheet,
  ImageSourcePropType,
  Text,
  StyleProp,
  ViewStyle,
  ImageStyle,
  TouchableOpacity,
} from 'react-native';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { colors } from '../styles/colors';
import DefaultAvatar from '@/assets/images/default-avatar.jpg';
import { useTheme } from '@/hooks/useTheme';
import ShapedAvatar from './avatar/ShapedAvatar';
import type { AvatarShapeKey } from './avatar/avatarShapes';

const AnimatedImage = Animated.createAnimatedComponent(Image);

interface AvatarProps {
  source?: ImageSourcePropType | string | undefined | null;
  size?: number;
  verified?: boolean;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  label?: string;
  onPress?: () => void;
  useAnimated?: boolean;
  shape?: AvatarShapeKey;
}

const Avatar: React.FC<AvatarProps> = ({
  source,
  size = 40,
  verified = false,
  style,
  imageStyle,
  label,
  onPress,
  useAnimated = false,
  shape,
}) => {
  const theme = useTheme();
  const [errored, setErrored] = React.useState(false);

  const imageSource = source && !errored
    ? (typeof source === 'string' ? { uri: source } : source)
    : DefaultAvatar;

  const Container: any = onPress ? TouchableOpacity : View;

  const inner = source && !errored ? (
    useAnimated ? (
      <AnimatedImage
        source={imageSource}
        onError={() => setErrored(true)}
        resizeMode="cover"
        style={[StyleSheet.absoluteFillObject, imageStyle]}
        defaultSource={DefaultAvatar}
      />
    ) : (
      <Image
        source={imageSource}
        onError={() => setErrored(true)}
        resizeMode="cover"
        style={[StyleSheet.absoluteFillObject, imageStyle]}
        defaultSource={DefaultAvatar}
      />
    )
  ) : (
    <View style={[styles.fallback, { width: size, height: size, backgroundColor: theme.colors.backgroundSecondary }]}>
      {label ? (
        <Text style={[styles.fallbackText, { fontSize: Math.round(size * 0.4), color: theme.colors.text }]}>
          {label}
        </Text>
      ) : null}
    </View>
  );

  const content = (
    <View style={[{ width: size, height: size }, style]}>
      <ShapedAvatar shape={shape} size={size}>
        {inner}
      </ShapedAvatar>

      {verified && (
        <View style={[styles.verifiedBadge, { width: size * 0.36, height: size * 0.36 }]}>
          <VerifiedIcon size={Math.round(size * 0.36)} color={colors.primaryColor} />
        </View>
      )}
    </View>
  );

  return <Container onPress={onPress}>{content}</Container>;
};

const styles = StyleSheet.create({
  verifiedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    fontWeight: '700',
  },
});

export default React.memo(Avatar);
