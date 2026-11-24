"""
AI Assurance Signals — static site only.

S3 + CloudFront (+ ACM cert, Route53 A/AAAA aliases) via the shared
pulumi-static-site component. There is deliberately no runtime backend: the
weekly pipeline runs in GitHub Actions and publishes static files.

DNS: the Route53 zone for willbright.link lives in the shared ingress stack
(flexo333/flexo333-ingress/prod, defined in flexo333/my-blog under
infra/pulumi-ingress). That stack also owns the GitHub OIDC infra/deploy roles,
whose policies are scoped to resources named `flexo333-*` — so the bucket name
MUST keep that prefix or CI cannot manage/sync it.
"""

import pulumi
from pulumi_static_site import StaticSite

config = pulumi.Config()
domain_name = config.require("domainName")
bucket_name = config.require("bucketName")
parent_ingress_stack = config.require("parentIngressStack")

if not bucket_name.startswith("flexo333-"):
    raise ValueError("bucketName must start with 'flexo333-' (ingress CI role scope)")

ingress = pulumi.StackReference(parent_ingress_stack)
zone_id = ingress.get_output("zone_id")

site = StaticSite(
    "aisignals",
    domain=domain_name,
    zone_id=zone_id,
    bucket_name=bucket_name,
    # Multi-page Astro build: the component's CloudFront Function rewrites
    # /path/ and /path to /path/index.html. No SPA fallback to index.html.
    spa_mode=False,
)

pulumi.export("bucket", site.bucket_name)
pulumi.export("distribution_id", site.distribution_id)
pulumi.export("cloudfront_domain", site.distribution_domain.apply(lambda d: f"https://{d}"))
pulumi.export("site_url", f"https://{domain_name}")
pulumi.export("aws_region", pulumi.Config("aws").require("region"))
