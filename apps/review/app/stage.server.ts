import { data, redirect } from 'react-router'
import { runtime } from './runtime.server'
import { checkOrigin, current, requireReviewer, openSession, reviewGet } from './auth.server'
import { loadAccounts, changeAccounts } from './account.server'
import { loadReport } from './reports.server'
import { remaining } from './remaining.server'

export function stage() {
  const demo = runtime().stage
  if (!demo) throw new Response('The stage runs with the firm demo.', {status: 404})
  return demo
}

export async function loadStage(request: Request) {
  const demo = stage()
  if (!(await current(request))) {
    const token = 'demo'
    const me = await reviewGet(request, {token}, 'me')
    if (!me.reviewer) throw new Response('The demo reviewer is unavailable.', {status: 503})
    throw redirect('/stage', {status: 303, headers: {'set-cookie': await openSession(request, token, me.reviewer, me.retraction)}})
  }
  const state = demo.state()
  const scene = state.scenes[state.next - 1]
  const path = scene?.stage?.slice(1) || (scene && new URL(scene.see[1]).pathname) || '/board/7'
  const [, view, parameter] = path.split('/')
  const which = parameter && decodeURIComponent(parameter)
  let content
  if (state.ready && !state.running) {
    if (view === 'accounts') content = {accounts: await loadAccounts(request, which)}
    else if (view === 'board' || view === 'journey' || view === 'calls') content = {report: await loadReport(request, view, which)}
    else content = {other: await remaining(request, view)}
  }
  return {state, path, content}
}

export async function changeStage(request: Request) {
  const demo = stage()
  checkOrigin(request)
  await requireReviewer(request)
  const form = await request.clone().formData()
  const intent = String(form.get('intent') ?? '')
  if (!['run','restart'].includes(intent)) return changeAccounts(request)
  if (!/^\d+$/.test(String(form.get('expected')))) return data({error: 'Reopen the current scene.'}, {status: 400})
  const problem = await demo.change(intent, String(form.get('boot')), Number(form.get('expected')))
  if (problem) return data({error: problem}, {status: 409})
  return {saved: ''}
}
