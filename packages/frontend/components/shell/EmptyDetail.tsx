import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { StyleSheet, View } from 'react-native';

interface EmptyDetailProps {
  title: string;
  description?: string;
}

/** The detail pane before anything is chosen in the list beside it. */
export function EmptyDetail({ title, description }: EmptyDetailProps) {
  return (
    <View style={styles.root}>
      <ChatEmptyState title={title} description={description} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
