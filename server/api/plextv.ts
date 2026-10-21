import type { PlexDevice } from '@server/interfaces/api/plexInterfaces';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { randomUUID } from 'node:crypto';
import xml2js from 'xml2js';
import ExternalAPI from './externalapi';

interface PlexAccountResponse {
  user: PlexUser;
}

interface PlexUser {
  id: number;
  uuid: string;
  email: string;
  joined_at: string;
  username: string;
  title: string;
  thumb: string;
  hasPassword: boolean;
  authToken: string;
  subscription: {
    active: boolean;
    status: string;
    plan: string;
    features: string[];
  };
  roles: {
    roles: string[];
  };
  entitlements: string[];
}

interface ConnectionResponse {
  $: {
    protocol: string;
    address: string;
    port: string;
    uri: string;
    local: string;
  };
}

interface DeviceResponse {
  $: {
    name: string;
    product: string;
    productVersion: string;
    platform: string;
    platformVersion: string;
    device: string;
    clientIdentifier: string;
    createdAt: string;
    lastSeenAt: string;
    provides: string;
    owned: string;
    accessToken?: string;
    publicAddress?: string;
    httpsRequired?: string;
    synced?: string;
    relay?: string;
    dnsRebindingProtection?: string;
    natLoopbackSupported?: string;
    publicAddressMatches?: string;
    presence?: string;
    ownerID?: string;
    home?: string;
    sourceTitle?: string;
  };
  Connection: ConnectionResponse[];
}

interface ServerResponse {
  $: {
    id: string;
    serverId: string;
    machineIdentifier: string;
    name: string;
    lastSeenAt: string;
    numLibraries: string;
    owned: string;
  };
}

interface UsersResponse {
  MediaContainer: {
    User: {
      $: {
        id: string;
        title: string;
        username: string;
        email: string;
        thumb: string;
      };
      Server: ServerResponse[];
    }[];
  };
}

interface WatchlistResponse {
  MediaContainer: {
    totalSize: number;
    Metadata?: {
      ratingKey: string;
    }[];
    Video?: {
      ratingKey: string;
    }[];
  };
}

function isWatchlistResponse(data: unknown): data is WatchlistResponse {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('MediaContainer' in data)
  ) {
    return false;
  }

  const { MediaContainer: container } = data as WatchlistResponse;
  return (
    typeof container === 'object' &&
    container !== null &&
    !Array.isArray(container) &&
    typeof container.totalSize === 'number'
  );
}

type PlexMetadataItem = {
  ratingKey: string;
  type: 'movie' | 'show';
  title: string;
  Guid?: {
    id: `imdb://tt${number}` | `tmdb://${number}` | `tvdb://${number}`;
  }[];
};
interface MetadataResponse {
  MediaContainer?: {
    Metadata?: PlexMetadataItem[];
    Video?: PlexMetadataItem[];
  };
}

export interface PlexWatchlistItem {
  ratingKey: string;
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'show';
  title: string;
}

export interface PlexWatchlistCache {
  etag?: string;
  response: WatchlistResponse;
}

type PlexSearchMetadata = PlexMetadataItem & {
  guid: string;
  year?: number;
};

interface DiscoverSearchResponse {
  MediaContainer?: {
    SearchResults?: {
      // The Metadata field has been seen as both a single object and an array.
      SearchResult?: {
        Metadata?: PlexSearchMetadata | PlexSearchMetadata[];
      }[];
    }[];
  };
}

interface UserStateResponse {
  MediaContainer?: {
    UserState?: { watchlistedAt?: number } | { watchlistedAt?: number }[];
  };
}

const PLEX_DISCOVER_URL = 'https://discover.provider.plex.tv';
const PLEX_METADATA_URL = 'https://metadata.provider.plex.tv';

// The TMDB to Plex mapping does not change, so it is kept for a day.
const RATING_KEY_TTL = 86400;

// Search hits whose full metadata is fetched while looking for a TMDB match.
const MAX_RATING_KEY_CANDIDATES = 5;

export const WATCHLIST_METADATA_CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }

      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

class PlexTvAPI extends ExternalAPI {
  private authToken: string;

  constructor(authToken: string) {
    super(
      'https://plex.tv',
      {},
      {
        headers: {
          'X-Plex-Token': authToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        nodeCache: cacheManager.getCache('plextv').data,
      }
    );

    this.authToken = authToken;
  }

  public async getDevices(): Promise<PlexDevice[]> {
    try {
      const devicesResp = await this.axios.get(
        '/api/resources?includeHttps=1',
        {
          transformResponse: [],
          responseType: 'text',
        }
      );
      const parsedXml = await xml2js.parseStringPromise(
        devicesResp.data as DeviceResponse
      );
      return parsedXml?.MediaContainer?.Device?.map((pxml: DeviceResponse) => ({
        name: pxml.$.name,
        product: pxml.$.product,
        productVersion: pxml.$.productVersion,
        platform: pxml.$?.platform,
        platformVersion: pxml.$?.platformVersion,
        device: pxml.$?.device,
        clientIdentifier: pxml.$.clientIdentifier,
        createdAt: new Date(parseInt(pxml.$?.createdAt, 10) * 1000),
        lastSeenAt: new Date(parseInt(pxml.$?.lastSeenAt, 10) * 1000),
        provides: pxml.$.provides.split(','),
        owned: pxml.$.owned == '1' ? true : false,
        accessToken: pxml.$?.accessToken,
        publicAddress: pxml.$?.publicAddress,
        publicAddressMatches:
          pxml.$?.publicAddressMatches == '1' ? true : false,
        httpsRequired: pxml.$?.httpsRequired == '1' ? true : false,
        synced: pxml.$?.synced == '1' ? true : false,
        relay: pxml.$?.relay == '1' ? true : false,
        dnsRebindingProtection:
          pxml.$?.dnsRebindingProtection == '1' ? true : false,
        natLoopbackSupported:
          pxml.$?.natLoopbackSupported == '1' ? true : false,
        presence: pxml.$?.presence == '1' ? true : false,
        ownerID: pxml.$?.ownerID,
        home: pxml.$?.home == '1' ? true : false,
        sourceTitle: pxml.$?.sourceTitle,
        connection: pxml?.Connection?.map((conn: ConnectionResponse) => ({
          protocol: conn.$.protocol,
          address: conn.$.address,
          port: parseInt(conn.$.port, 10),
          uri: conn.$.uri,
          local: conn.$.local == '1' ? true : false,
        })),
      }));
    } catch (e) {
      logger.error('Something went wrong getting the devices from plex.tv', {
        label: 'Plex.tv API',
        errorMessage: e.message,
      });
      throw new Error('Invalid auth token', { cause: e });
    }
  }

  public async getUser(): Promise<PlexUser> {
    try {
      const account = await this.axios.get<PlexAccountResponse>(
        '/users/account.json'
      );

      return account.data.user;
    } catch (e) {
      logger.error(
        `Something went wrong while getting the account from plex.tv: ${e.message}`,
        { label: 'Plex.tv API' }
      );
      throw new Error('Invalid auth token', { cause: e });
    }
  }

  public async checkUserAccess(userId: number): Promise<boolean> {
    const settings = getSettings();

    try {
      if (!settings.plex.machineId) {
        throw new Error('Plex is not configured!');
      }

      const usersResponse = await this.getUsers();

      const users = usersResponse.MediaContainer.User;

      const user = users.find((u) => parseInt(u.$.id) === userId);

      if (!user) {
        throw new Error(
          "This user does not exist on the main Plex account's shared list"
        );
      }

      return !!user.Server?.find(
        (server) => server.$.machineIdentifier === settings.plex.machineId
      );
    } catch (e) {
      logger.error(`Error checking user access: ${e.message}`);
      return false;
    }
  }

  public async getUsers(): Promise<UsersResponse> {
    const response = await this.axios.get('/api/users', {
      transformResponse: [],
      responseType: 'text',
    });

    const parsedXml = (await xml2js.parseStringPromise(
      response.data
    )) as UsersResponse;
    return parsedXml;
  }

  private async fetchWatchlistItemMetadata(watchlistItem: {
    ratingKey: string;
  }): Promise<PlexWatchlistItem | null> {
    let detailedResponse: MetadataResponse;
    try {
      detailedResponse = await this.getRolling<MetadataResponse>(
        `/library/metadata/${watchlistItem.ratingKey}`,
        {
          baseURL: 'https://discover.provider.plex.tv',
        }
      );
    } catch (e) {
      if (e.response?.status === 404) {
        logger.warn(
          `Item with ratingKey ${watchlistItem.ratingKey} not found, it may have been removed from the server.`,
          { label: 'Plex.TV Metadata API' }
        );
        return null;
      }

      if (e.code === 'ETIMEDOUT' || e.code === 'ENETUNREACH') {
        logger.warn(
          `Failed to fetch metadata for ratingKey ${watchlistItem.ratingKey}`,
          {
            label: 'Plex.TV Metadata API',
            errorMessage: e.message,
          }
        );
        return null;
      }

      throw e;
    }

    const metadata =
      detailedResponse.MediaContainer?.Metadata?.[0] ??
      detailedResponse.MediaContainer?.Video?.[0];

    if (!metadata) {
      logger.warn(
        `Item with ratingKey ${watchlistItem.ratingKey} returned no metadata, skipping.`,
        { label: 'Plex.TV Metadata API' }
      );
      return null;
    }

    const tmdbString = metadata.Guid?.find((guid) =>
      guid.id.startsWith('tmdb')
    );
    const tvdbString = metadata.Guid?.find((guid) =>
      guid.id.startsWith('tvdb')
    );

    return {
      ratingKey: metadata.ratingKey,
      // This should always be set? But I guess it also cannot be?
      // We will filter out the 0's afterwards
      tmdbId: tmdbString ? Number(tmdbString.id.split('//')[1]) : 0,
      tvdbId: tvdbString ? Number(tvdbString.id.split('//')[1]) : undefined,
      title: metadata.title,
      type: metadata.type,
    };
  }

  public async getWatchlist({
    offset = 0,
    size = 20,
  }: { offset?: number; size?: number } = {}): Promise<{
    offset: number;
    size: number;
    totalSize: number;
    items: PlexWatchlistItem[];
  }> {
    const watchlistCache = cacheManager.getCache('plexwatchlist');
    let cachedWatchlist = watchlistCache.data.get<PlexWatchlistCache>(
      this.authToken
    );

    try {
      // Drop poisoned entries so we don't send If-None-Match for a body
      // without MediaContainer (which would 304 and keep failing).
      if (cachedWatchlist && !isWatchlistResponse(cachedWatchlist.response)) {
        watchlistCache.data.del(this.authToken);
        cachedWatchlist = undefined;
      }

      const response = await this.axios.get<WatchlistResponse>(
        '/library/sections/watchlist/all',
        {
          params: {
            'X-Plex-Container-Start': offset,
            'X-Plex-Container-Size': size,
          },
          headers: cachedWatchlist?.etag
            ? { 'If-None-Match': cachedWatchlist.etag }
            : undefined,
          baseURL: 'https://discover.provider.plex.tv',
          validateStatus: (status) => status < 400, // Allow HTTP 304 to return without error
        }
      );

      // If we don't recieve HTTP 304, the watchlist has been updated and we need to update the cache.
      if (
        response.status >= 200 &&
        response.status <= 299 &&
        isWatchlistResponse(response.data)
      ) {
        cachedWatchlist = {
          etag: response.headers.etag,
          response: response.data,
        };

        watchlistCache.data.set<PlexWatchlistCache>(
          this.authToken,
          cachedWatchlist
        );
      }

      const metadata = cachedWatchlist?.response.MediaContainer.Metadata;
      const video = cachedWatchlist?.response.MediaContainer.Video;
      const watchlistItems = Array.isArray(metadata)
        ? metadata
        : Array.isArray(video)
          ? video
          : [];

      const watchlistDetails = await mapWithConcurrency(
        watchlistItems,
        WATCHLIST_METADATA_CONCURRENCY,
        (watchlistItem) => this.fetchWatchlistItemMetadata(watchlistItem)
      );

      const filteredList = watchlistDetails.filter(
        (detail) => detail?.tmdbId
      ) as PlexWatchlistItem[];

      return {
        offset,
        size,
        totalSize: cachedWatchlist?.response.MediaContainer.totalSize ?? 0,
        items: filteredList,
      };
    } catch (e) {
      logger.error('Failed to retrieve watchlist items', {
        label: 'Plex.TV Metadata API',
        errorMessage: e.message,
      });
      return {
        offset,
        size,
        totalSize: 0,
        items: [],
      };
    }
  }

  /**
   * Finds the Plex Discover ratingKey for a TMDB title. Only an exact TMDB id
   * match is accepted, so a similarly named title is never returned.
   */
  public async getDiscoverRatingKey({
    tmdbId,
    type,
    title,
    year,
  }: {
    tmdbId: number;
    type: 'movie' | 'show';
    title: string;
    year?: number;
  }): Promise<string | null> {
    const cache = cacheManager.getCache('plextv').data;
    const cacheKey = `discover-rating-key:${type}:${tmdbId}`;
    const cachedRatingKey = cache.get<string>(cacheKey);
    if (cachedRatingKey) {
      return cachedRatingKey;
    }

    const response = await this.axios.get<DiscoverSearchResponse>(
      '/library/search',
      {
        baseURL: PLEX_DISCOVER_URL,
        params: {
          query: title,
          searchTypes: type === 'movie' ? 'movies' : 'tv',
          searchProviders: 'discover',
          includeMetadata: 1,
          includeGuids: 1,
          limit: 20,
        },
        timeout: 5000,
      }
    );

    const candidates = (
      response.data.MediaContainer?.SearchResults ?? []
    ).flatMap((hub) =>
      (hub.SearchResult ?? []).flatMap((result) => result.Metadata ?? [])
    );

    const isMatch = (item: PlexMetadataItem) =>
      item.type === type &&
      !!item.Guid?.some((guid) => guid.id === `tmdb://${tmdbId}`);

    // Search hits do not always carry their external ids, so the hits without
    // them get their full metadata fetched, closest release year first.
    let match = candidates.find(isMatch);
    if (!match) {
      const unresolved = candidates
        .filter((item) => item.type === type && !item.Guid)
        .sort(
          (a, b) =>
            Math.abs((a.year ?? 0) - (year ?? 0)) -
            Math.abs((b.year ?? 0) - (year ?? 0))
        )
        .slice(0, MAX_RATING_KEY_CANDIDATES);

      for (const item of unresolved) {
        const metadata = await this.fetchWatchlistItemMetadata(item);
        if (metadata?.tmdbId === tmdbId) {
          match = item;
          break;
        }
      }
    }

    if (!match) {
      return null;
    }

    // The guid looks like plex://movie/5d776825880197001ec967c6
    const ratingKey = match.guid.split('/').pop() || match.ratingKey;
    cache.set(cacheKey, ratingKey, RATING_KEY_TTL);
    return ratingKey;
  }

  public async isOnWatchlist(ratingKey: string): Promise<boolean> {
    const response = await this.axios.get<UserStateResponse>(
      `/library/metadata/${ratingKey}/userState`,
      { baseURL: PLEX_METADATA_URL, timeout: 5000 }
    );

    const userState = [response.data.MediaContainer?.UserState ?? []].flat();
    return userState.some((state) => !!state.watchlistedAt);
  }

  public async addToWatchlist(ratingKey: string): Promise<void> {
    await this.updateWatchlist('addToWatchlist', ratingKey);
  }

  public async removeFromWatchlist(ratingKey: string): Promise<void> {
    await this.updateWatchlist('removeFromWatchlist', ratingKey);
  }

  private async updateWatchlist(
    action: 'addToWatchlist' | 'removeFromWatchlist',
    ratingKey: string
  ): Promise<void> {
    // Plex answers these with a 500 when the JSON Content-Type and Accept
    // headers are sent along with the empty body.
    await this.axios.put(`/actions/${action}`, undefined, {
      baseURL: PLEX_DISCOVER_URL,
      params: { ratingKey },
      headers: { 'Content-Type': false, Accept: false },
      timeout: 10000,
    });

    cacheManager.getCache('plexwatchlist').data.del(this.authToken);
  }

  public async pingToken() {
    try {
      const response = await this.axios.get('/api/v2/ping', {
        headers: {
          'X-Plex-Client-Identifier': randomUUID(),
        },
      });
      if (!response?.data?.pong) {
        throw new Error('No pong response');
      }
    } catch (e) {
      logger.error('Failed to ping token', {
        label: 'Plex Refresh Token',
        errorMessage: e.message,
      });
    }
  }
}

export default PlexTvAPI;
