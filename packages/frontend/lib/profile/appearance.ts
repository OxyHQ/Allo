import { api } from '@/utils/api';

/**
 * Allo's own customization of a person's profile (`/profile/settings/:userId`):
 * a display name override and the cover photo. The backend answers the PUBLIC
 * projection (`PublicProfileAppearanceDto`), never the person's settings, and a
 * person who never saved any gets an empty `profileCustomization` — still a 200.
 */
export interface ProfileAppearance {
  profileHeaderImage?: string;
  profileCustomization?: {
    coverPhotoEnabled?: boolean;
    minimalistMode?: boolean;
    displayName?: string;
    coverImage?: string;
  };
}

export const profileAppearanceQueryKey = (userId: string) => ['profileAppearance', userId] as const;

/**
 * The `{ data: … }` envelope every Allo endpoint wraps its answer in, unwrapped
 * defensively: `api.get` already strips its own layer.
 */
function unwrap(body: unknown): ProfileAppearance | null {
  if (typeof body !== 'object' || body === null) return null;
  const inner = 'data' in body ? (body as { data: unknown }).data : body;
  return typeof inner === 'object' && inner !== null ? (inner as ProfileAppearance) : null;
}

export async function fetchProfileAppearance(userId: string): Promise<ProfileAppearance | null> {
  const response = await api.get<unknown>(`profile/settings/${userId}`);
  return unwrap(response.data);
}
