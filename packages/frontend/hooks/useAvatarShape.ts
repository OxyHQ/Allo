import { useEffect } from 'react';
import { useAppearanceStore } from '@/store/appearanceStore';
import { AvatarShapeKey, DEFAULT_SHAPE } from '@/components/avatar/avatarShapes';

/**
 * Returns the avatar shape for a given user ID.
 * Triggers a background load if the user's appearance is not yet cached.
 */
export function useAvatarShape(userId?: string): AvatarShapeKey {
  const loadForUser = useAppearanceStore((s) => s.loadForUser);
  const shape = useAppearanceStore((s) => {
    if (!userId) return DEFAULT_SHAPE;
    const userAppearance = s.byUserId[userId];
    return (userAppearance?.profileCustomization?.avatarShape as AvatarShapeKey) ?? DEFAULT_SHAPE;
  });

  useEffect(() => {
    if (userId) {
      loadForUser(userId);
    }
  }, [userId, loadForUser]);

  return shape;
}

/**
 * Returns the current user's avatar shape from their own settings.
 */
export function useMyAvatarShape(): AvatarShapeKey {
  return useAppearanceStore(
    (s) => (s.mySettings?.profileCustomization?.avatarShape as AvatarShapeKey) ?? DEFAULT_SHAPE
  );
}
