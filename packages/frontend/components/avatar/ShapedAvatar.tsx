import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Defs, ClipPath, Path, ForeignObject } from 'react-native-svg';
import { AVATAR_SHAPES, AvatarShapeKey, DEFAULT_SHAPE } from './avatarShapes';

interface ShapedAvatarProps {
  shape?: AvatarShapeKey;
  size: number;
  children: React.ReactNode;
}

/**
 * Wraps children inside an SVG clip path matching the chosen avatar shape.
 * For the default circle shape, skips SVG entirely and uses borderRadius.
 */
const ShapedAvatar: React.FC<ShapedAvatarProps> = ({ shape, size, children }) => {
  const shapeKey = shape ?? DEFAULT_SHAPE;

  // Fast path: circle uses borderRadius (no SVG overhead)
  if (shapeKey === 'circle' || !AVATAR_SHAPES[shapeKey]) {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }}>
        {children}
      </View>
    );
  }

  const pathData = AVATAR_SHAPES[shapeKey];
  const clipId = `avatar-clip-${shapeKey}`;

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <ClipPath id={clipId}>
            <Path d={pathData} />
          </ClipPath>
        </Defs>
        <ForeignObject
          x={0}
          y={0}
          width={100}
          height={100}
          clipPath={`url(#${clipId})`}
        >
          <View style={{ width: '100%', height: '100%' }}>
            {children}
          </View>
        </ForeignObject>
      </Svg>
    </View>
  );
};

export default React.memo(ShapedAvatar);
