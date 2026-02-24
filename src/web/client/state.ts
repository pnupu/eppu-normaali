import { WebSearchResult } from './types';

export const appState = {
  currentGuild: null as string | null,
  authRequired: true,
  localMode: false,
  exposureMode: 'local',
  requireAccessToken: false,
  defaultGuildId: '',
  accessToken: '',
  stateEtag: '',
  latestSearchResults: [] as WebSearchResult[],
  pendingSearchAddUrls: new Set<string>(),
  pollTimer: null as number | null,
  isFetchingState: false,
  dragFromIndex: null as number | null,
  hasFetchedStateSuccessfully: false,
  hasActiveSong: false,
};
