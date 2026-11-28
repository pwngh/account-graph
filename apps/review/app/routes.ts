import { route, index, type RouteConfig } from '@react-router/dev/routes'
export default [
  index('routes/home.ts'), route('review', 'routes/bookmarks.tsx'),
  route('favicon.ico', 'routes/favicon.ts'),
  route('signin', 'routes/signin.tsx'), route('signout', 'routes/signout.ts'),
  route('accounts/:subject?', 'routes/accounts.tsx'), route('search', 'routes/search.tsx'),
  route('stage', 'routes/stage.tsx'), route('stage/scenes', 'routes/scenes.ts'),
  route('journey/:subject?', 'routes/reports.tsx', {id: 'journey'}),
  route('board/:days?', 'routes/reports.tsx', {id: 'board'}),
  route('calls', 'routes/reports.tsx', {id: 'calls'}),
  route('details/:report/:which?', 'routes/detail.tsx'),
  route('card/:report/:which?', 'routes/card.ts'),
  route('health', 'routes/reports.tsx', {id: 'health'}),
  route('decide', 'routes/remaining.tsx', {id: 'decide'}),
  route('channels', 'routes/channels.tsx', {id: 'channels'}), route('channels/csv', 'routes/channels-csv.ts'),
  route('guide/:section', 'routes/guide.tsx'),
  route('events', 'routes/events.ts'), route('find', 'routes/find.ts'),
] satisfies RouteConfig
