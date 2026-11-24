import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGraph, createMemoryStore, ringing } from '../src/index.ts'
import { recordText } from '../src/texts.ts'
import { fakePhone, holidays, meantEmail, placeholderEmail, sharedMailbox, spanishPlaceholder, spanishStop, texasArea, throwawayEmail } from '../src/lookups.ts'

test('a number that is nobody\'s is told from one that could be', () => {
  const why = { '+15555555555': 'repeated', '+10000000000': 'repeated', '+11234567890': 'counted', '+10123456789': 'counted', '+17139110142': 'never_assigned', '+17130120142': 'never_assigned', '+11136120142': 'never_assigned', '+19116120142': 'never_assigned', '+17135550142': 'never_assigned', '+17135551212': 'never_assigned' }
  for (const [number, reason] of Object.entries(why)) assert.equal(fakePhone(number), reason, number)
  // Real shapes, one digit off a rule, and numbers of other countries.
  for (const number of ['+17138120142', '+17139120142', '+12812222222', '+12222222223', '+17135560142', '+525555555555', '+4420700000000', '', 'x']) assert.equal(fakePhone(number), undefined, number)
})

test('an email made up to fill a field is told from a short one that is somebody\'s', () => {
  for (const email of ['none@none.com', 'NONE@gmail.com ', 'test@test.com', 'a@test.com', 'noemail@firm.org', 'no@no.com', 'sincorreo@hotmail.com', 'pat@example.com', 'pat@host.invalid', 'qwerty@yahoo.com']) assert.equal(placeholderEmail(email), true, email)
  for (const email of ['pat.lee@gmail.com', 'nona@gmail.com', 'na@smithfamily.net', 'abc@firm.org', 'bob@bob.com', 'x@x.com', 'testa@gmail.com', 'lee@contest.com', 'pat@latest.com', 'none', '@none.com', '']) assert.equal(placeholderEmail(email), false, email)
})

test('an office address is shared, and the same name at public mail is a person\'s', () => {
  for (const email of ['info@smithlaw.com', 'FrontDesk@clinic.org', 'recepcion@despacho.mx', 'no-reply@bank.com']) assert.equal(sharedMailbox(email), true, email)
  for (const email of ['info@gmail.com', 'office@yahoo.com.mx', 'pat@smithlaw.com', 'information@smithlaw.com', 'info', '']) assert.equal(sharedMailbox(email), false, email)
})

test('a throwaway address and a misspelled domain are named, and others are left', () => {
  assert.equal(throwawayEmail('x@Mailinator.com'), true)
  assert.equal(throwawayEmail('x@notmailinator.com'), false)
  assert.equal(meantEmail(' Pat.Lee@Gmial.com'), 'Pat.Lee@gmail.com')
  assert.equal(meantEmail('İ@Gmial.com'), 'İ@gmail.com')
  assert.equal(meantEmail('pat@hotmail.con'), 'pat@hotmail.com')
  for (const email of ['pat@gmail.com', 'pat@mail.com', 'pat@ymail.com', 'pat@email.com', 'pat@gmail.co', 'gmial.com', '@gmial.com']) assert.equal(meantEmail(email), undefined, email)
})

test('a Texas area code says where a number is from', () => {
  for (const [number, place] of [['+17138120142', 'Houston'], ['+13468120142', 'Houston'], ['+19568120142', 'Laredo and the Rio Grande Valley'], ['+19158120142', 'El Paso']] as const) assert.equal(texasArea(number), place)
  for (const number of ['+12128120142', '+527138120142', '7138120142', '']) assert.equal(texasArea(number), undefined, number)
})

test('holidays fall on the day they are kept', () => {
  assert.deepEqual(holidays(2026), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'])
  // A Saturday New Year is kept in the year before, and Christmas of 2027 on the Friday.
  assert.deepEqual(holidays(2027).slice(-3), ['2027-11-25', '2027-12-24', '2027-12-31'])
  assert.equal(holidays(2028)[0], '2028-01-17')
  assert.deepEqual(holidays(2026, { texas: true }).filter((each) => !holidays(2026).includes(each)), ['2026-11-27', '2026-12-24'])
  assert.deepEqual(holidays(2023).slice(0, 2), ['2023-01-02', '2023-01-16'])
  assert.deepEqual([holidays(2020).length, holidays(2020).includes('2020-06-19'), holidays(2021).includes('2021-06-18'), holidays(2020).includes('2020-11-26')], [10, false, true, true])
  assert.deepEqual(holidays(9999).slice(-2), ['9999-12-24', '9999-12-31'])
  for (let year = 1986; year < 2100; year++) for (const each of holidays(year, { texas: true })) assert.ok(new Date(each).getUTCDay() % 6 !== 0, each)
  for (const year of [2026.5, 1985]) assert.throws(() => holidays(year), TypeError)
})

test('a Spanish word alone asks to stop, and inside a sentence it does not', () => {
  for (const text of ['ALTO', ' alto. ', '¡Pare!', 'Cancelar', 'baja']) assert.equal(spanishStop(text), true, text)
  for (const text of ['Vivo en la planta baja', 'alto ahí', 'mi hijo es alto', 'no puedo cancelar la cita', 'STOP', 'alta', 'Comenzar', '']) assert.equal(spanishStop(text), false, text)
})

test('what is written where no name is known is not a name', () => {
  for (const name of ['Desconocido', 'SIN NOMBRE', 'no tiene.', 'Cliente']) assert.equal(spanishPlaceholder(name), true, name)
  for (const name of ['Juan Perez', 'Clemente', 'Nadia', 'Socorro', 'Bajo', '']) assert.equal(spanishPlaceholder(name), false, name)
})

test('a Spanish word stops the texts, and a ringing phone says where its number is from', async () => {
  const graph = createGraph(createMemoryStore())
  const at = Date.parse('2026-11-24T15:00:00Z')
  const text = (id: string, what: string) => recordText(graph, { id, from: '+17138120142', to: '+15550100101', at: at + Number(id), text: what })
  assert.ok((await text('1', 'Alto.')).flags.includes('opt_out'))
  assert.ok(!(await text('2', 'mi hijo es alto')).flags.includes('opt_out'))
  assert.ok(!(await text('3', 'Comenzar')).flags.includes('opt_in'))
  assert.equal((await ringing(graph, { from: '(713) 812-0142', to: '+15550100101', at })).area, 'Houston')
  for (const from of ['+12128120142', 'anonymous', undefined]) assert.equal('area' in (await ringing(graph, { ...(from && { from }), to: '+15550100101', at })), false)
})
