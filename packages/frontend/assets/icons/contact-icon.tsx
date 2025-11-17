import React from 'react';
import Svg, { Path, Circle } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export interface ContactIconProps {
  color?: string;
  size?: number;
  style?: ViewStyle;
}

export const ContactIcon = ({ 
  color = colors.primaryColor, 
  size = 26, 
  style 
}: ContactIconProps) => {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={style}
    >
      <Path
        fill={color}
        d="M20 0H4c-1.1 0-2 .9-2 2v20l4-4h14c1.1 0 2-.9 2-2V2c0-1.1-.9-2-2-2zm-7 12.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-1.5c0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5.67-1.5 1.5-1.5 1.5.67 1.5 1.5zM16 9H8V7h8v2z"
      />
    </Svg>
  );
};

