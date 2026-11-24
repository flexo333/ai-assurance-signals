# Backlog

- **CloudFront price class:** `pulumi-static-site` hard-codes `PriceClass_100` (North America and Europe edges only), so Australian readers are served from distant edges. Add a `price_class` parameter to the fork (v0.3.0) and use `PriceClass_200`, which includes Australia, for this site. This costs a few cents more a month at this traffic level.
- **404 page:** with `spa_mode=False`, missing paths return S3's 403 XML. Add a `custom_error_responses` option to the fork that maps 403/404 to `/404.html`, and build that page in Astro.
- **Sitemap:** add `@astrojs/sitemap` once there are real pages, then reference it in `robots.txt`.
