import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import logger from '@server/logger';

export class PlexTitleNotFoundError extends Error {}

/**
 * Returns a Plex.tv client for users with a linked Plex account. Their
 * watchlist lives on Plex, everyone else's is kept in the Seerr database.
 */
export const getPlexWatchlistClient = async (
  userId?: number
): Promise<PlexTvAPI | null> => {
  if (!userId) {
    return null;
  }

  const user = await getRepository(User).findOne({
    where: { id: userId },
    select: ['id', 'plexToken'],
  });

  return user?.plexToken ? new PlexTvAPI(user.plexToken) : null;
};

export const getPlexRatingKey = async (
  plexTv: PlexTvAPI,
  tmdbId: number,
  mediaType: MediaType
): Promise<string> => {
  // Plex is searched with the English title, as the user's locale may differ.
  const tmdb = new TheMovieDb();
  const { title, date } =
    mediaType === MediaType.MOVIE
      ? await tmdb
          .getMovie({ movieId: tmdbId, language: 'en' })
          .then((movie) => ({ title: movie.title, date: movie.release_date }))
      : await tmdb
          .getTvShow({ tvId: tmdbId, language: 'en' })
          .then((tv) => ({ title: tv.name, date: tv.first_air_date }));

  const ratingKey = await plexTv.getDiscoverRatingKey({
    tmdbId,
    type: mediaType === MediaType.MOVIE ? 'movie' : 'show',
    title,
    year: date ? Number(date.slice(0, 4)) : undefined,
  });

  if (!ratingKey) {
    throw new PlexTitleNotFoundError(`${title} could not be found on Plex.`);
  }

  return ratingKey;
};

// Keeps a slow Plex from holding up the movie and series pages.
const WATCHLIST_STATUS_TIMEOUT = 4000;

export const isOnUserWatchlist = async (
  userId: number | undefined,
  tmdbId: number,
  mediaType: MediaType
): Promise<boolean> => {
  const plexTv = await getPlexWatchlistClient(userId);

  if (!plexTv) {
    return getRepository(Watchlist).exist({
      where: { tmdbId, mediaType, requestedBy: { id: userId } },
    });
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      getPlexRatingKey(plexTv, tmdbId, mediaType).then((ratingKey) =>
        plexTv.isOnWatchlist(ratingKey)
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Timed out')),
          WATCHLIST_STATUS_TIMEOUT
        );
      }),
    ]);
  } catch (e) {
    logger.debug('Unable to check the Plex watchlist status', {
      label: 'Plex Watchlist',
      errorMessage: e.message,
      tmdbId,
      mediaType,
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
};
