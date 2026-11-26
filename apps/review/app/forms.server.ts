// Browser forms and React Router both send URL-encoded fields. Bound the body before decoding it.
export async function fieldsOf(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new Response('Submit the form from this page.', {status: 415})
  const limit = 32 * 1024
  const tooLarge = () => new Response('The submitted form is too large.', {status: 413})
  if (Number(request.headers.get('content-length')) > limit) throw tooLarge()
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    for (;;) {
      const {value, done} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(value)
    }
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
