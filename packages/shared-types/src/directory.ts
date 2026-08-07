/**
 * The people directory: who somebody is, as Allo is willing to say it.
 *
 * ## Why these types exist rather than the Oxy `User`
 *
 * Today the app asks Oxy directly for a profile, and Oxy answers with its whole
 * `User` document — which carries `email`, `phone`, `address` and `birthday`
 * alongside the handle and the avatar. That is fine in a client holding the
 * viewer's own session, because the API decides what that viewer may see. It is
 * NOT fine coming back out of `api.allo.you`, which asks Oxy as itself: a
 * backend that forwarded the whole document would hand every signed-in user
 * every other user's contact details.
 *
 * So the directory endpoints project. {@link DirectoryUser} is everything Allo
 * draws — a name, a handle, an avatar — and nothing else exists on the wire to
 * be leaked by a future caller that forgets to pick fields.
 *
 * ## Why the avatar arrives twice
 *
 * `avatar` is the Oxy asset id and `avatarUrl` is that id already resolved
 * against the Oxy CDN. Both, because the app has fifteen places that turn an id
 * into a URL and every one of them is a call into the Oxy SDK; once the app no
 * longer carries that SDK it will have no way to build the URL itself. Sending
 * the resolved form alongside the id is what lets those fifteen call sites
 * become a field read instead of a network round trip.
 */

/** One person, as Allo describes them. */
export interface DirectoryUser {
  /** The Oxy account id. A 24-character hexadecimal ObjectId. */
  id: string;
  /** The handle, without the `@`. */
  username: string;
  /** The canonical display string, resolved by Oxy. Never recomposed here. */
  displayName: string;
  /** The given name, or an empty string. Passed through, never recombined. */
  firstName: string;
  /** The family name, or an empty string. */
  lastName: string;
  /** The Oxy asset id of the avatar, when the account has one. */
  avatar?: string;
  /** {@link avatar} resolved against the Oxy CDN. Absent when `avatar` is. */
  avatarUrl?: string;
  /** The short public profile line, when the account has one. */
  bio?: string;
}

/** `GET /api/directory/users` and `GET /api/directory/profiles/search`. */
export interface DirectoryUserListResponse {
  users: DirectoryUser[];
}

/** `GET /api/directory/profiles/search`, which is paginated. */
export interface DirectorySearchResponse extends DirectoryUserListResponse {
  /** How many matches exist in total, as Oxy reports it. */
  total: number;
  /** Whether another page follows the one returned. */
  hasMore: boolean;
}

/**
 * `GET /api/directory/assets/:fileId/url`.
 *
 * A URL and not a redirect. A redirect would make the endpoint unusable from
 * the one place it is needed most — an `<Image source={{ uri }}>` that has to
 * know the address before it starts loading — and would put an Allo hop in
 * front of every avatar the app draws.
 */
export interface DirectoryAssetUrlResponse {
  url: string;
}
