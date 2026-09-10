# nginx configuration

`${STOREFRONT_HOST}`, `${ADMIN_HOST}` and `${API_HOST}` are placeholders. nginx
does **not** expand environment variables in configuration files, so substitute
them at deploy time:

```sh
envsubst '${STOREFRONT_HOST} ${ADMIN_HOST} ${API_HOST}' \
  < conf.d/storefront.conf > /etc/nginx/conf.d/storefront.conf
```

Certificates are expected at `/etc/nginx/certs/<service>/{fullchain,privkey,chain}.pem`.

Before reloading, always validate:

```sh
nginx -t && nginx -s reload
```

## Behind Cloudflare

`real_ip_header CF-Connecting-IP` and the `set_real_ip_from` ranges in
`nginx.conf` recover the true client address. Keep the ranges current from
<https://www.cloudflare.com/ips/> — a stale list means rate limiting and audit
records attribute every request to Cloudflare instead of the visitor.

Cloudflare's WAF and rate limiting are worth enabling, but they are additional
layers. Application-level authorisation is mandatory regardless: anything that
can reach the origin directly bypasses Cloudflare entirely.
