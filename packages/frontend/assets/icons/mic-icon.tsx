import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export interface MicIconProps {
  color?: string;
  size?: number;
  style?: ViewStyle;
}

export const MicIcon = ({ 
  color = '#FFFFFF', 
  size = 20, 
  style 
}: MicIconProps) => {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={style}
    >
      <Path
        fill={color}
        d="M12 14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2s-2 .9-2 2v7c0 1.1.9 2 2 2zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"
      />
    </Svg>
  );
};


