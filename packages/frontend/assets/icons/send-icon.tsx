import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export interface SendIconProps {
  color?: string;
  size?: number;
  style?: ViewStyle;
}

export const SendIcon = ({ 
  color = '#FFFFFF', 
  size = 20, 
  style 
}: SendIconProps) => {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={style}
    >
      <Path
        fill={color}
        d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"
      />
    </Svg>
  );
};



