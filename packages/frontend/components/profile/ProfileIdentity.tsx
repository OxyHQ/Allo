import { Avatar, Text, VStack, defineTokens, toElement } from '@oxy.so/bloom-language';

export interface ProfileIdentityProps {
  /** The name, already resolved. Never a handle with an `@` on it. */
  displayName: string;
  /** Drawn with its `@`; pass the bare handle. */
  handle?: string;
  /** An Oxy file id or a URL; the app's image resolver turns an id into a URL. */
  avatar?: string;
  verified?: boolean;
}

/** The profile's portrait, larger than Bloom's avatar rungs. */
const profileTokens = defineTokens({ avatarSize: { portrait: 96 } });

/** Who somebody is: the picture, the name and the handle, centred. Presentational only. */
export function ProfileIdentity({
  displayName,
  handle,
  avatar,
  verified = false,
}: ProfileIdentityProps) {
  return toElement(
    VStack(
      Avatar(avatar, { name: displayName })
        .size(profileTokens.avatarSize.portrait)
        .verified(verified)
        .label(displayName),
      VStack(
        Text(displayName).font('title-2').weight('semibold').textAlign('center'),
        handle ? Text('@', handle).font('body').foreground('muted').textAlign('center') : null,
      )
        .align('center')
        .spacing('2xs'),
    )
      .padding('top', 'sm')
      .align('center')
      .spacing('md'),
  );
}
