import { route, index, type RouteConfig } from '@react-router/dev/routes'
export default [
  index('routes/home.ts'), route('review', 'routes/bookmarks.tsx'),
  route('signin', 'routes/signin.tsx'), route('signout', 'routes/signout.ts'),
  route('accounts/:subject?', 'routes/accounts.tsx'), route('search', 'routes/search.tsx'),
  route('events', 'routes/events.ts'),
] satisfies RouteConfig
