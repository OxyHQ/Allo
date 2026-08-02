import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

/**
 * The status a message shows when it is not going to arrive.
 *
 * Deliberately not another tick and not another clock. The clock says "still on
 * its way", which is the one thing a failed send is not, and a reader who has to
 * tell two nearly identical marks apart at eleven pixels will not.
 *
 * Drawn on the same 16x15 canvas as the tick and the clock so the three line up
 * inside a bubble's metadata row.
 */
export const MsgFailedIcon = ({
  color = colors.primaryColor,
  size = 26,
  style,
}: {
  color?: string;
  size?: number;
  style?: ViewStyle;
}) => {
  return (
    <Svg viewBox="0 0 16 15" width={size} height={size} style={{ ...style }}>
      <Path
        fill={color}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8,1.7c-3.2,0-5.8,2.6-5.8,5.8S4.8,13.3,8,13.3s5.8-2.6,5.8-5.8S11.2,1.7,8,1.7z M8,2.9 c2.5,0,4.6,2.1,4.6,4.6S10.5,12.1,8,12.1S3.4,10,3.4,7.5S5.5,2.9,8,2.9z M8,4.2c-0.3,0-0.6,0.3-0.6,0.6v3.1c0,0.3,0.3,0.6,0.6,0.6 s0.6-0.3,0.6-0.6V4.8C8.6,4.5,8.3,4.2,8,4.2z M8,9.5c-0.4,0-0.7,0.3-0.7,0.7s0.3,0.7,0.7,0.7s0.7-0.3,0.7-0.7S8.4,9.5,8,9.5z"
      />
    </Svg>
  );
};
