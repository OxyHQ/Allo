import React, { useState, useRef, useCallback } from "react";
import {
    View,
    TextInput,
    StyleSheet,
    TextInputProps,
    Platform,
    findNodeHandle,
} from "react-native";
import { useTheme } from "@/hooks/useTheme";
import alloPicker, { alloUser } from "./alloPicker";

export interface alloData {
    userId: string;
    username: string;
    displayName: string;
}

interface alloTextInputProps extends Omit<TextInputProps, "onChangeText" | "value"> {
    value: string;
    onChangeText: (text: string) => void;
    onallosChange?: (allos: alloData[]) => void;
    placeholder?: string;
    maxLength?: number;
    multiline?: boolean;
    style?: any;
}

const alloTextInput: React.FC<alloTextInputProps> = ({
    value,
    onChangeText,
    onallosChange,
    placeholder,
    maxLength,
    multiline = true,
    style,
    ...textInputProps
}) => {
    const theme = useTheme();
    const [showalloPicker, setShowalloPicker] = useState(false);
    const [alloQuery, setalloQuery] = useState("");
    const [cursorPosition, setCursorPosition] = useState(0);
    const [allos, setallos] = useState<alloData[]>([]);
    const textInputRef = useRef<TextInput>(null);

    // Parse allos from text with [allo:userId] format
    const parseallos = useCallback((text: string): alloData[] => {
        const alloRegex = /\[allo:([^\]]+)\]/g;
        const foundallos: alloData[] = [];
        let match;

        while ((match = alloRegex.exec(text)) !== null) {
            const userId = match[1];
            // Find the allo in our local state to get username/displayName
            const existingallo = allos.find(m => m.userId === userId);
            if (existingallo) {
                foundallos.push(existingallo);
            }
        }

        return foundallos;
    }, [allos]);

    // Convert display text with @username to storage format with [allo:userId]
    const convertToStorageFormat = useCallback((displayText: string, currentallos: alloData[]): string => {
        let result = displayText;
        // Replace @username with [allo:userId]
        currentallos.forEach(allo => {
            const displayallo = `@${allo.username}`;
            const storageallo = `[allo:${allo.userId}]`;
            result = result.replace(displayallo, storageallo);
        });
        return result;
    }, []);

    // Convert storage format [allo:userId] to display format @username
    const convertToDisplayFormat = useCallback((storageText: string, currentallos: alloData[]): string => {
        let result = storageText;
        currentallos.forEach(allo => {
            const storageallo = `[allo:${allo.userId}]`;
            const displayallo = `@${allo.username}`;
            result = result.replace(new RegExp(storageallo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), displayallo);
        });
        return result;
    }, []);

    // Handle text change
    const handleTextChange = useCallback((text: string) => {
        // Text from input is in display format (@name)
        // We need to convert to storage format for the parent component
        const storageText = convertToStorageFormat(text, allos);
        onChangeText(storageText);

        // Check if user is typing a allo
        const cursorPos = cursorPosition;
        const textBeforeCursor = text.substring(0, cursorPos);
        const lastAtSymbol = textBeforeCursor.lastIndexOf("@");

        if (lastAtSymbol !== -1) {
            const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);

            // Check if it's a valid allo query (no spaces)
            const hasSpace = textAfterAt.includes(" ");
            const hasNewline = textAfterAt.includes("\n");

            if (!hasSpace && !hasNewline && textAfterAt.length >= 0) {
                setalloQuery(textAfterAt);
                setShowalloPicker(true);
            } else {
                setShowalloPicker(false);
                setalloQuery("");
            }
        } else {
            setShowalloPicker(false);
            setalloQuery("");
        }
    }, [cursorPosition, onChangeText, allos, convertToStorageFormat]);

    // Handle selection change to track cursor position
    const handleSelectionChange = useCallback((event: any) => {
        setCursorPosition(event.nativeEvent.selection.start);
    }, []);

    // Handle user selection from allo picker
    const handlealloSelect = useCallback((user: alloUser) => {
        // Convert current storage value to display to find @ position
        const currentDisplayValue = convertToDisplayFormat(value, allos);
        const textBeforeCursor = currentDisplayValue.substring(0, cursorPosition);
        const textAfterCursor = currentDisplayValue.substring(cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf("@");

        if (lastAtSymbol !== -1) {
            // Store allo metadata first
            const newallo: alloData = {
                userId: user.id,
                username: user.username,
                displayName: user.name,
            };

            const updatedallos = [...allos, newallo];

            // Display format uses @username (handle)
            const displayalloText = `@${user.username}`;
            // Storage format uses [allo:userId]
            const storagealloText = `[allo:${user.id}]`;

            // Build display text (for cursor positioning)
            const newDisplayText =
                currentDisplayValue.substring(0, lastAtSymbol) +
                displayalloText +
                " " +
                textAfterCursor;

            // Build storage text (what we send to parent)
            // We need to convert the new display text with updated allos
            let storageText = newDisplayText;
            updatedallos.forEach(allo => {
                const displayallo = `@${allo.username}`;
                const storageallo = `[allo:${allo.userId}]`;
                storageText = storageText.replace(displayallo, storageallo);
            });

            setallos(updatedallos);

            // Send storage format to parent
            onChangeText(storageText);

            if (onallosChange) {
                onallosChange(updatedallos);
            }

            // Move cursor after allo in display text
            const newCursorPos = lastAtSymbol + displayalloText.length + 1;
            setCursorPosition(newCursorPos);

            // Set selection after a short delay
            setTimeout(() => {
                textInputRef.current?.setNativeProps?.({
                    selection: { start: newCursorPos, end: newCursorPos },
                });
            }, 10);
        }

        setShowalloPicker(false);
        setalloQuery("");
    }, [value, cursorPosition, allos, onChangeText, onallosChange, convertToDisplayFormat]);

    const handleClosePicker = useCallback(() => {
        setShowalloPicker(false);
        setalloQuery("");
    }, []);

    // Convert storage format to display format for rendering
    const displayValue = convertToDisplayFormat(value, allos);

    return (
        <View style={styles.container}>
            <TextInput
                ref={textInputRef}
                value={displayValue}
                onChangeText={handleTextChange}
                onSelectionChange={handleSelectionChange}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.textTertiary}
                maxLength={maxLength}
                multiline={multiline}
                style={[
                    styles.textInput,
                    { color: theme.colors.text },
                    style,
                ]}
                {...textInputProps}
            />

            {showalloPicker && (
                <View style={styles.pickerContainer}>
                    <alloPicker
                        query={alloQuery}
                        onSelect={handlealloSelect}
                        onClose={handleClosePicker}
                    />
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: "relative",
    },
    textInput: {
        fontSize: 16,
        textAlignVertical: "top",
    },
    pickerContainer: {
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        marginBottom: 8,
        zIndex: 1000,
    },
});

export default alloTextInput;
export type { alloTextInputProps };
