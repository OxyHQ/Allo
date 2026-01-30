import React from 'react';
import { TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface HeaderIconButtonProps {
    onPress?: () => void;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    disabled?: boolean;
}

export const HeaderIconButton: React.FC<HeaderIconButtonProps> = ({
    onPress,
    children,
    style,
    disabled = false,
}) => {
    const theme = useTheme();

    return (
        <TouchableOpacity
            style={[
                styles.button,
                disabled && { opacity: 0.5 },
                style,
            ]}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.6}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
            {children}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    button: {
        padding: 8,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        // Removed border and background for cleaner look
        // Icons now match bottom bar style
    },
});

