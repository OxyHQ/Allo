import React, { useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { AVATAR_SHAPES, AVATAR_SHAPE_META, AvatarShapeKey } from './avatarShapes';
import { useTheme } from '@/hooks/useTheme';

interface AvatarShapePickerProps {
  selected: AvatarShapeKey;
  onSelect: (shape: AvatarShapeKey) => void;
}

const COLUMNS = 5;
const CELL_SIZE = 56;
const ICON_SIZE = 36;
const GAP = 10;

const ShapeCell: React.FC<{
  shapeKey: AvatarShapeKey;
  isSelected: boolean;
  onPress: () => void;
  fillColor: string;
  selectedBorderColor: string;
  cellBg: string;
}> = React.memo(({ shapeKey, isSelected, onPress, fillColor, selectedBorderColor, cellBg }) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.7}
    style={[
      styles.cell,
      {
        backgroundColor: cellBg,
        borderColor: isSelected ? selectedBorderColor : 'transparent',
        borderWidth: 2,
      },
    ]}
  >
    <Svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 100 100">
      <Path d={AVATAR_SHAPES[shapeKey]} fill={isSelected ? selectedBorderColor : fillColor} />
    </Svg>
  </TouchableOpacity>
));

const AvatarShapePicker: React.FC<AvatarShapePickerProps> = ({ selected, onSelect }) => {
  const theme = useTheme();

  const handlePress = useCallback(
    (key: AvatarShapeKey) => {
      onSelect(key);
    },
    [onSelect],
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.grid}>
      {AVATAR_SHAPE_META.map(({ key }) => (
        <ShapeCell
          key={key}
          shapeKey={key}
          isSelected={selected === key}
          onPress={() => handlePress(key)}
          fillColor={theme.colors.textSecondary}
          selectedBorderColor={theme.colors.primary}
          cellBg={theme.colors.backgroundSecondary}
        />
      ))}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: {
    maxHeight: (CELL_SIZE + GAP) * 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default React.memo(AvatarShapePicker);
