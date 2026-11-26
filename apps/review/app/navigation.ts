import { redirect } from 'react-router'

type SubjectView = 'accounts' | 'journey'
export function subjectPath(subject: string, view: SubjectView = 'accounts') {
  // Browsers remove dot segments even when percent-encoded. A real semicolon in an ID is encoded as %3B.
  if (subject === '.' || subject === '..') return '/' + view + '/;id=' + subject
  // The router reserves a literal .data suffix for its own requests.
  return '/' + view + '/' + encodeURIComponent(subject).replace(/\.data$/, '%2Edata')
}

export function subjectAddress(pathname: string) {
  const match = /^(\/(?:details|card))?\/(accounts|journey)\/([^/]+)\/?$/i.exec(pathname)
  if (!match) return
  const [, prefix = '', view, segment] = match
  let subject = segment
  if (segment === ';id=.' || segment === ';id=..') subject = segment.slice(4)
  else try { subject = decodeURIComponent(segment) } catch { /* A literal percent in a pasted ID becomes %25 in the link. */ }
  return { subject, path: prefix.toLowerCase() + subjectPath(subject, view.toLowerCase() as SubjectView) }
}

export function readSubject(url: URL) {
  const route = subjectAddress(url.pathname)
  if (route && route.path !== url.pathname) throw redirect(route.path + url.search)
  return route?.subject
}

// Fragments reach the browser only. Keep the old screen's date ranges and its links to a particular call.
export function oldBookmark(hash: string, pathname: string, legacy: string) {
  if (!hash.startsWith('#') || hash === '#') return
  let raw = hash.slice(1)
  if (raw === '!channels') raw = '/channels'
  if (!raw.startsWith('/')) {
    if (!['/', '/review'].includes(pathname) || raw === 'view') return
    raw = '/accounts/' + raw.replaceAll('/', '%2F')
  }
  const [, view, ...parts] = raw.split('/').map(part => {
    try { return decodeURIComponent(part) } catch { return part }
  })
  const [first, last] = parts
  if (view === 'accounts' || view === 'journey') {
    const path = first ? subjectPath(first, view) : '/' + view
    return view === 'journey' && last ? path + '#call-' + encodeURIComponent(encodeURIComponent(last)) : path
  }
  if (view === 'calls' && first && last && [first, last].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day))) return '/calls?' + new URLSearchParams({from: first, to: last})
  if (view === 'channels' && parts.length) return legacy + '#/channels/' + parts.map(encodeURIComponent).join('/')
  if (view === 'board') return '/board/' + (first && /^\d+$/.test(first) ? first : '90')
  if (view && ['decide', 'calls', 'channels', 'health'].includes(view)) return '/' + view
}

export interface ChangeNotice { views: string[]; subjects: string[] }

export function affectsPage(notice: ChangeNotice, pathname: string, journey: string[]) {
  const [, route, report] = pathname.split('/')
  const view = route === 'details' ? report : route
  if (!view || !['accounts','journey','board','calls','decide','channels','health'].includes(view)) return false
  if (notice.views.includes('*')) return true
  if (!notice.views.includes(view)) return false
  // Accounts includes the global activity rail. A journey can include records whose IDs differ from the address.
  return view !== 'journey' || !journey.length || !notice.subjects.length || journey.some(subject => notice.subjects.includes(subject))
}
