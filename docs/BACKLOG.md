# Backlog

- **CloudFront price class:** `pulumi-static-site` hard-codes `PriceClass_100` (North America and Europe edges only), so Australian readers are served from distant edges. Add a `price_class` parameter to the fork (v0.3.0) and use `PriceClass_200`, which includes Australia, for this site. This costs a few cents more a month at this traffic level.
- **404 page:** Astro now builds `/404.html`, but with `spa_mode=False` CloudFront still returns S3's 403 XML. Add a `custom_error_responses` option to the fork that maps 403/404 to `/404.html`.
- **Sitemap:** add `@astrojs/sitemap` once there are real pages, then reference it in `robots.txt`.
- **`BucketV2` deprecation:** `pulumi-static-site` uses `aws.s3.BucketV2`, which pulumi-aws 7.x warns is deprecated in favour of `aws.s3.Bucket`. Fix it in the fork, with an alias so existing buckets (yt2txt, this site) aren't replaced.
- **Sitemap and HTML-list adapters** for the 27 reachable sources without feeds (see QUESTIONS #3 for priority).
- **RSS feed of editions:** not requested for v1, but cheap with `@astrojs/rss`.
- **Edition email:** out of scope for v1 (web only).
