import type { ProfileVisibility } from './api';

/**
 * WHICH SENTENCE DESCRIBES A VISIBILITY SETTING.
 *
 * Two screens name the same three values — the privacy list, which shows the
 * current one on a row, and the chooser, which shows all three — so the mapping
 * lives here rather than as a `switch` in each. A mapping in two places is how
 * the list ends up saying "Public" next to a chooser with "Followers only"
 * ticked.
 *
 * Returns KEYS, not text: translation belongs to the component that has the `t`.
 * The `Record` is exhaustive by type, so adding a fourth value to the backend's
 * enum fails to compile here instead of rendering a row labelled with its own
 * identifier.
 */

const TITLE_KEYS: Record<ProfileVisibility, string> = {
  public: 'settings.privacy.public',
  followers_only: 'settings.privacy.followersOnly',
  private: 'settings.privacy.private',
};

const DESCRIPTION_KEYS: Record<ProfileVisibility, string> = {
  public: 'settings.privacy.publicDescription',
  followers_only: 'settings.privacy.followersOnlyDescription',
  private: 'settings.privacy.privateDescription',
};

export function profileVisibilityLabelKey(visibility: ProfileVisibility): string {
  return TITLE_KEYS[visibility];
}

export function profileVisibilityDescriptionKey(visibility: ProfileVisibility): string {
  return DESCRIPTION_KEYS[visibility];
}
