import { VStack } from '@oxy.so/bloom-language';
import { ChatEmptyState as LChatEmptyState } from '@oxy.so/bloom-language/chat';
import { screen } from '@oxy.so/bloom-language/router';

interface EmptyDetailProps {
  title: string;
  description?: string;
}

/** The detail pane before anything is chosen in the list beside it. */
export const EmptyDetail = screen(function EmptyDetail({ title, description }: EmptyDetailProps) {
  return VStack(LChatEmptyState({ title, description }))
    .padding('all', '2xl')
    .align('center')
    .justify('center')
    .grow()
    .header(false)
    .screenScroll('none');
});
