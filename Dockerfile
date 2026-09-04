# Serves the page and its sample images with Caddy. There is nothing to build:
# the site is static files, so the image is just Caddy plus the content.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY assets /srv/assets

EXPOSE 8080
