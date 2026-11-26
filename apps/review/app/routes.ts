import { route, index, type RouteConfig } from '@react-router/dev/routes'
export default [
  index('routes/home.ts'), route('review', 'routes/bookmarks.tsx'),
  route('signin', 'routes/signin.tsx'), route('signout', 'routes/signout.ts'),
  route('accounts/:subject?', 'routes/accounts.tsx'), route('search', 'routes/search.tsx'),
  route('stage', 'routes/stage.tsx'), route('stage/scenes', 'routes/scenes.ts'),
  route('journey/:subject?', 'routes/reports.tsx', {id: 'journey'}),
  route('board/:days?', 'routes/reports.tsx', {id: 'board'}),
  route('calls', 'routes/reports.tsx', {id: 'calls'}),
  route('details/:report/:which?', 'routes/detail.tsx'),
  route('card/:report/:which?', 'routes/card.ts'),
  ...['decide', 'channels', 'health'].map(name => route(name, 'routes/remaining.tsx', {id: name})),
  route('guide/:section', 'routes/guide.tsx'),
  route('events', 'routes/events.ts'),
] satisfies RouteConfig
