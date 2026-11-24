// What runs, and what needs someone.
const short = (hash) => (hash === null ? '(not recorded)' : hash === 'mixed' ? 'more than one policy' : hash.slice(0, 12))
const lasting = (ms) => (ms === 'none' ? 'none' : ms >= 86400000 ? `${amount(Math.round(ms / 8640000) / 10)} days` : `${amount(Math.round(ms / 360000) / 10)} hours`)

view('health', 'Health', async (box) => {
  const [policy, disputes] = await Promise.all([api('GET', '/policy'), api('GET', '/disputes')])
  box.append(el('section', {}, el('h3', {}, 'Health'), el('p', { class: 'muted' }, 'What this server runs, as it stands now.')))

  const rules = el('table', {}, el('tr', {}, th('Kind'), th('Weight', 'num'), th('Dilution', 'num'), th('Cap, subjects', 'num'), th('Half-life', 'num'), th('Group'), th('')))
  const kinds = Object.entries(policy.rules.kinds).sort(([x, a], [y, b]) => b.weight - a.weight || (x < y ? -1 : 1))
  for (const [kind, rule] of kinds) {
    rules.append(el('tr', {}, td('', kind), td('num', rule.weight.toFixed(2)), td('num', rule.dilution), td('num', amount(rule.cap)), td('num', lasting(rule.halfLife)), td('', rule.group ?? ''),
      td('', policy.changed.includes(kind) ? el('span', { class: 'chip' }, 'changed from the default') : rule.weight === 0 ? el('span', { class: 'muted' }, 'a note, links nothing') : '')))
  }
  const { same, related, bridge, review } = policy.rules
  const section = el('section', {}, el('h2', {}, 'Policy'))
  if (policy.due) section.append(el('p', { class: 'banner', role: 'alert' }, el('b', {}, 'A rebuild is due. '),
    policy.builtWith === null ? 'It is not recorded which policy the stored clusters were built with. ' : policy.builtWith === 'mixed' ? 'More than one policy has written the stored clusters. ' : `The stored clusters were built with policy ${short(policy.builtWith)}. `,
    `Policy ${short(policy.hash)} runs now. Clusters stay as they were until someone with the service token posts to /rebuild.`))
  section.append(
    el('p', {}, `Running policy ${short(policy.hash)}. Stored clusters built with ${short(policy.builtWith)}.${policy.due ? '' : ' They agree, or there are none yet.'}`),
    el('p', { class: 'muted' }, `Joined at ${percent(same)}, related at ${percent(related)}, one link alone joins two groups at ${percent(bridge)}. Clusters over ${amount(review)} subjects are flagged.`),
    wide('Policy rules by kind', rules))
  box.append(section)

  const table = el('table', {}, el('tr', {}, th('One'), th('The other'), th('Contradictions, all time', 'num'), th('Last report'), th('By')))
  for (const { a, b, last, reversals } of disputes) table.append(el('tr', {}, td('who', open(a)), td('who', open(b)), td('num', reversals), td('', `${last.action === 'separate' ? 'kept apart' : last.action === 'join' ? 'joined' : 'allowed to join'}, ${when(last.at)}`), td('', author(last.by))))
  box.append(el('section', {}, el('h2', {}, 'Pairs systems disagree about'), el('p', { class: 'muted' }, 'Two subjects that systems have reported as one person and as two by turns, three times or more. A separation holds over a join, so the pair may have stayed apart throughout. Find out which system is right, and stop the other from sending.'),
    disputes.length > 0 ? wide('Pairs systems disagree about', table) : el('p', {}, 'None.')))
})
