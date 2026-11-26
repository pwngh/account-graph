const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="9" fill="#1a1a19"/>
  <g fill="#fff"><circle cx="10.5" cy="11" r="4"/><circle cx="22" cy="13" r="4"/><circle cx="15.5" cy="22.5" r="4"/></g>
</svg>`

export function loader() {
  return new Response(icon, {headers: {'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'"}})
}
