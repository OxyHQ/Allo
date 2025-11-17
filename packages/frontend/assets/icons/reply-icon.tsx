import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const ReplyIcon = ({ color = colors.primaryColor, size = 24, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path 
        fill={color}
        d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"
      />
    </Svg>
  );
};


