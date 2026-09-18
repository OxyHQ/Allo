import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { useTheme } from '@oxy.so/bloom/theme';

interface EmptyDetailProps {
  title: string;
  description?: string;
}

/** The detail pane before anything is chosen in the list beside it. */
export function EmptyDetail({ title, description }: EmptyDetailProps) {
  const theme = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ChatEmptyState title={title} description={description} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
