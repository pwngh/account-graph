/** The two kinds of firm the demo can show. Everything that differs between them is here. */

export interface Practice {
  /** The steps of the board between a form and a client, by the part they play in the story. */
  papers: string
  won: string
  /** What a client is first valued at, and what that becomes. */
  value: number
  later: number
  /** What a day of ads costs, next to the family firm's. */
  cost: number
  /** Who is scheduled: the word, which is the tag too. */
  lead: string
  matter: string
  /** The area of law, as the firm's campaigns name it. */
  area: string
  links: { papers: string; papersPage: string; last: string; lastPage: string }
  scenes: Record<'papers' | 'scheduled' | 'lead' | 'lastSent' | 'lastOpened' | 'won' | 'sent' | 'value' | 'apart', [title: string, text: string]>
  told: { lastOpen: string; won: string }
  /** The phone and the firm's site. */
  stage: {
    firm: string
    ask: string
    ad: [string, string]
    captions: Record<string, string>
    texts: { papers: [string, string]; last: [string, string] }
    form: [string, string][]
    papers: { title: string; text: string }
    last: { title: string; text: string; fields: [string, string][]; button: string; busy: string; done: [string, string] }
    signed: [string, string]
  }
}

const family: Practice = {
  papers: 'signed', won: 'client', value: 400, later: 1250, cost: 1,
  lead: 'director',
  matter: 'Divorce, with children',
  area: 'Family law',
  links: { papers: 'documents', papersPage: 'firmar', last: 'payment', lastPage: 'inscripcion' },
  scenes: {
    papers: ['Documents signed', 'Staff text a link to the documents. They open it and sign.'],
    scheduled: ['Director scheduled', 'Staff schedule a call with a director.'],
    lead: ['Director calls', 'On Wednesday the director calls, and is answered.'],
    lastSent: ['Enrollment texted', 'Staff text a signed link to enroll and pay.'],
    lastOpened: ['Enrollment opened', 'They open the link, and have not paid yet.'],
    won: ['Paid', 'They pay. The payment page is the firm’s, and reports the payment.'],
    sent: ['Conversion sent', 'The payment is sent to the ad platform as a conversion of the first ad click.'],
    value: ['Value change', 'The client value is updated from the initial 400 USD and restated at the ad platform.'],
    apart: ['Separation', 'An opposing party shares the family phone and email. The case system separates the two contacts.'],
  },
  told: { lastOpen: 'Not paid yet.', won: 'Payment recorded' },
  stage: {
    firm: 'Tessaly Derecho Familiar', ask: 'abogado de divorcio',
    ad: ['Su familia es lo primero. Hable con nosotros hoy.', 'Divorcio, custodia y manutención. Atención en español.'],
    captions: { signed: 'They have signed', director: 'The director calls', 'text-pay': 'Staff text the enroll-and-pay link', paid: 'They have paid', 'text-sign': 'Staff text the documents', sign: 'They sign the documents' },
    texts: { papers: ['Revise y firme sus documentos:', 'tessaly.example/firmar'], last: ['Inscríbase y pague aquí:', 'tessaly.example/inscripcion'] },
    form: [['Dirección', 'Calle Ejemplo 12'], ['Correo', 'ines@example.org'], ['Hijos', 'Dos']],
    papers: { title: 'Acuerdo de representación', text: 'Revise el documento y firme abajo.' },
    last: { title: 'Inscripción', text: 'Pago inicial de su caso.', fields: [['Total', '$400.00'], ['Pago', 'Tarjeta de prueba']], button: 'Inscribirse y pagar', busy: 'Procesando…', done: ['Pago recibido', '$400.00 · Tarjeta de prueba'] },
    signed: ['Documentos firmados', 'Recibirá una copia.'],
  },
}

/** A client of an injury firm signs and pays nothing then, so the story ends with a signed case, valued at what the firm expects of it. */
const injury: Practice = {
  papers: 'records', won: 'signed', value: 2500, later: 6000, cost: 5,
  lead: 'attorney',
  matter: 'Car accident, passenger',
  area: 'Injury law',
  links: { papers: 'records', papersPage: 'expedientes', last: 'agreement', lastPage: 'acuerdo' },
  scenes: {
    papers: ['Records authorized', 'Staff text a link to the medical records authorization. They open it and sign.'],
    scheduled: ['Attorney scheduled', 'Staff schedule a call with an attorney.'],
    lead: ['Attorney calls', 'On Wednesday the attorney calls, and is answered.'],
    lastSent: ['Agreement texted', 'Staff text a signed link to the representation agreement.'],
    lastOpened: ['Agreement opened', 'They open the link, and have not signed yet.'],
    won: ['Signed', 'They sign. The signing page is the firm’s, and reports the signed case at the value the firm expects.'],
    sent: ['Conversion sent', 'The signed case is sent to the ad platform as a conversion of the first ad click.'],
    value: ['Value change', 'The firm raises the expected value from 2,500 USD, and it is restated at the ad platform.'],
    apart: ['Separation', 'The driver of the car is a relative with the same phone and email, and the claim is against them. The case system separates the two contacts.'],
  },
  told: { lastOpen: 'Not signed yet.', won: 'Signed case recorded' },
  stage: {
    firm: 'Tessaly Lesiones Personales', ask: 'abogado de accidentes',
    ad: ['¿Tuvo un accidente? Hable con nosotros hoy.', 'Accidentes de auto, de camión y de trabajo. Atención en español.'],
    captions: { signed: 'They have signed', director: 'The attorney calls', 'text-pay': 'Staff text the agreement', paid: 'They have signed', 'text-sign': 'Staff text the authorization', sign: 'They sign it' },
    texts: { papers: ['Revise y firme la autorización:', 'tessaly.example/expedientes'], last: ['Lea y firme su acuerdo aquí:', 'tessaly.example/acuerdo'] },
    form: [['Lugar', 'Calle Ejemplo y Avenida 3'], ['Correo', 'ines@example.org'], ['Hospital', 'Clínica Ejemplo']],
    papers: { title: 'Autorización de expedientes', text: 'Revise el documento y firme abajo.' },
    last: { title: 'Acuerdo de representación', text: 'Léalo con calma. Pregunte lo que quiera.', fields: [['Cliente', 'Inés Vega'], ['Asunto', 'Accidente de auto']], button: 'Firmar', busy: 'Firmando…', done: ['Acuerdo firmado', 'Recibirá una copia.'] },
    signed: ['Autorización firmada', 'Recibirá una copia.'],
  },
}

export const PRACTICES: Record<'family' | 'injury', Practice> = { family, injury }
