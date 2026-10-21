import {
  DuplicateWatchlistRequestError,
  NotFoundError,
  Watchlist,
} from '@server/entity/Watchlist';
import {
  PlexTitleNotFoundError,
  getPlexRatingKey,
  getPlexWatchlistClient,
} from '@server/lib/plexWatchlist';
import logger from '@server/logger';
import { Router } from 'express';
import { QueryFailedError } from 'typeorm';

import { MediaType } from '@server/constants/media';
import { watchlistCreate } from '@server/interfaces/api/watchlistCreate';

const watchlistRoutes = Router();

const updatePlexWatchlist = async (
  action: 'add' | 'remove',
  userId: number,
  tmdbId: number,
  mediaType: MediaType
): Promise<boolean> => {
  const plexTv = await getPlexWatchlistClient(userId);
  if (!plexTv) {
    return false;
  }

  const ratingKey = await getPlexRatingKey(plexTv, tmdbId, mediaType);
  if (action === 'add') {
    await plexTv.addToWatchlist(ratingKey);
  } else {
    await plexTv.removeFromWatchlist(ratingKey);
  }

  return true;
};

watchlistRoutes.post<never, Partial<Watchlist>, Watchlist>(
  '/',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({
          status: 401,
          message: 'You must be logged in to add watchlist.',
        });
      }
      const values = watchlistCreate.parse(req.body);

      if (
        await updatePlexWatchlist(
          'add',
          req.user.id,
          values.tmdbId,
          values.mediaType
        )
      ) {
        return res.status(201).json(values);
      }

      const request = await Watchlist.createWatchlist({
        watchlistRequest: values,
        user: req.user,
      });
      return res.status(201).json(request);
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }
      switch (error.constructor) {
        case PlexTitleNotFoundError:
          return next({ status: 404, message: error.message });
        case QueryFailedError:
          logger.warn('Something wrong with data watchlist', {
            tmdbId: req.body.tmdbId,
            mediaType: req.body.mediaType,
            label: 'Watchlist',
          });
          return next({ status: 409, message: 'Something wrong' });
        case DuplicateWatchlistRequestError:
          return next({ status: 409, message: error.message });
        default:
          return next({ status: 500, message: error.message });
      }
    }
  }
);

watchlistRoutes.delete('/:tmdbId', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 401,
      message: 'You must be logged in to delete watchlist data.',
    });
  }
  try {
    const mediaType = req.query.mediaType;
    if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) {
      return next({
        status: 400,
        message: 'Invalid mediaType query parameter.',
      });
    }

    if (
      await updatePlexWatchlist(
        'remove',
        req.user.id,
        Number(req.params.tmdbId),
        mediaType
      )
    ) {
      return res.status(204).send();
    }

    await Watchlist.deleteWatchlist(
      Number(req.params.tmdbId),
      mediaType,
      req.user
    );
    return res.status(204).send();
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof PlexTitleNotFoundError) {
      return next({
        status: 404,
        message: e.message,
      });
    }
    return next({ status: 500, message: e.message });
  }
});

export default watchlistRoutes;
