import React, { useMemo } from 'react';
import { Text, StyleProp, TextStyle, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { linkifyTokens } from '@/lib/text/linkify';
import { profileHref } from '@/lib/profile/handle';

interface LinkifiedTextProps {
  text: string;
  style?: StyleProp<TextStyle>;
  linkStyle?: StyleProp<TextStyle>;
  suffix?: React.ReactNode;
}

/**
 * A message body with its mentions and links made tappable.
 *
 * What counts as either is decided by `lib/text/linkify.ts`, which is where the
 * reasoning lives — including why a `#hashtag` is drawn as ordinary text here.
 *
 * A mention whose handle cannot address a profile is rendered as plain text
 * rather than as a link that goes nowhere: `profileHref` returns `null` for a
 * handle carrying a `/`, `?`, `#` or whitespace, which is exactly the shape a
 * sender would craft to make a mention open something other than the person it
 * names.
 */
export const LinkifiedText: React.FC<LinkifiedTextProps> = ({ text, style, linkStyle, suffix }) => {
  const router = useRouter();
  const theme = useTheme();

  const nodes = useMemo(() => {
    const tokens = linkifyTokens(text);
    const linkColor: StyleProp<TextStyle> = [{ color: theme.colors.primary }, linkStyle];

    return tokens.map((token, index) => {
      if (token.kind === 'text') {
        return <Text key={`t-${index}`}>{token.text}</Text>;
      }

      if (token.kind === 'url') {
        return (
          <Text
            key={`u-${index}`}
            style={linkColor}
            onPress={() => {
              void Linking.openURL(token.href);
            }}
          >
            {token.label}
          </Text>
        );
      }

      const href = profileHref(token.handle);
      if (href === null) {
        return <Text key={`m-${index}`}>{token.label}</Text>;
      }

      return (
        <Text key={`m-${index}`} style={linkColor} onPress={() => router.push(href)}>
          {token.label}
        </Text>
      );
    });
  }, [text, linkStyle, router, theme.colors.primary]);

  if (!text) return null;
  return <Text style={style}>{nodes}{suffix}</Text>;
};

export default LinkifiedText;
