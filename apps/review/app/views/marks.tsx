// The marks of the screen: one for each view, and one for each kind of event.

export const VIEW_ICONS = {
  accounts: 'M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8ZM2.8 13.4c.5-2.5 2.5-3.8 5.2-3.8s4.7 1.3 5.2 3.8',
  journey: 'M2 8h2.6M11.4 8H14M6.2 8a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0M3.6 3.5v9M12.4 3.5v9',
  board: 'M2.5 3h3v10h-3zM6.8 3h3v6.5h-3zM11 3h3v8.2h-3z',
  decide: 'M8 2.5v11M8 4.2 3.4 5.6M8 4.2l4.6 1.4M1.6 9.4 3.4 5.6l1.8 3.8a1.9 1.9 0 0 1-3.6 0M10.8 9.4l1.8-3.8 1.8 3.8a1.9 1.9 0 0 1-3.6 0',
  calls: 'M3.2 2.8h2.4l1.2 3-1.6 1.1a8 8 0 0 0 3.9 3.9l1.1-1.6 3 1.2v2.4c0 .5-.4.9-.9.9A9.9 9.9 0 0 1 2.3 3.7c0-.5.4-.9.9-.9Z',
  channels: 'M2.5 13.5h11M4 11V7.5M8 11V3M12 11V5.8',
  health: 'M1.8 8.4h2.8l1.7-4.6 3 8.4 1.7-3.8h3.2',
}
export type ViewName = keyof typeof VIEW_ICONS

/** What each kind of event looks like, wherever it is drawn. A call nobody answered is the one kind with two. */
export const GLYPHS = {
  visit: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2ZM2.4 8h11.2M8 2.2c2 1.8 2.6 3.6 2.6 5.8S10 12 8 13.8C6 12 5.4 10.2 5.4 8S6 4 8 2.2',
  sighting: 'M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8ZM6 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  call: VIEW_ICONS.calls,
  missed: 'M5.2 4.6 3.6 5.1c-.7.3-1 1-.9 1.8.5 3.3 3.2 6.1 6.5 6.9.8.2 1.6 0 2-.7l.4-1.5-2.5-1.5-1.3 1.2c-1.3-.6-2.2-1.5-2.8-2.8l1.2-1.3ZM9.8 2.5l3.7 3.7M13.5 2.5 9.8 6.2',
  voicemail: 'M4.6 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM11.4 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM4.6 10.4h6.8',
  text: 'M2.4 3.4h11.2v7.4H7.2L4.2 13.2v-2.4H2.4ZM5 6.2h6M5 8.3h4',
  link: 'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.9-.9',
  outcome: 'M4 14V2.6h7.6l-1.6 2.9 1.6 2.9H4',
  value: 'M8 2.2v11.6M11 4.8c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.3 0 3.2 6.2 1.6 6.2 4.8 0 1.4-1.4 2.3-3.2 2.3-1.5 0-2.7-.6-3.3-1.6',
  consent: 'M8 2 13 4v3.8c0 3-2.1 5.2-5 6.2-2.9-1-5-3.2-5-6.2V4ZM5.6 8l1.8 1.8 3.2-3.5',
  decision: VIEW_ICONS.decide,
  result: 'M3 8.4 6.4 11.8 13 4.6',
}
export type GlyphName = keyof typeof GLYPHS

/** The mark of a view, as the list of views has it. The words beside it say the same. */
export function ViewMark({ name }: { name: ViewName }) {
  return <svg className="mark-view" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d={VIEW_ICONS[name]}/></svg>
}

/** The mark of a kind of event. The words beside it say the same. */
export function Glyph({ kind }: { kind: GlyphName }) {
  return <svg className={'glyph ' + kind} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d={GLYPHS[kind]}/></svg>
}

/** What a row is about, as a mark on a square of its own. */
export function Tile({ kind, tone = '' }: { kind: GlyphName, tone?: string }) {
  return <span className={tone ? 'tile ' + tone : 'tile'} aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d={GLYPHS[kind]}/></svg></span>
}

/** Which mark an event has. Nobody spoke to the caller of a missed call or a voicemail. */
export function looksLike(entry: { kind: string, state?: string }): GlyphName {
  return entry.kind === 'call' && (entry.state === 'missed' || entry.state === 'voicemail') ? 'missed' : entry.kind as GlyphName
}
