"""
AI Assurance Signals — static site + one Sydney fetch Lambda.

S3 + CloudFront (+ ACM cert, Route53 A/AAAA aliases) via the shared
pulumi-static-site component. The site itself has no runtime backend: the
weekly pipeline runs in GitHub Actions and publishes static files. The only
compute here is the Sydney fetch Lambda (see below), invoked by CI.

DNS: the Route53 zone for willbright.link lives in the shared ingress stack
(flexo333/flexo333-ingress/prod, defined in flexo333/my-blog under
infra/pulumi-ingress). That stack also owns the GitHub OIDC infra/deploy roles,
whose policies are scoped to resources named `flexo333-*` — so the bucket name
MUST keep that prefix or CI cannot manage/sync it.
"""

import json
import os

import pulumi
import pulumi_aws as aws
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

# ── Sydney fetch Lambda ───────────────────────────────────────────────────────
# Many .gov.au sites (govCMS/Akamai, OAIC, AHRC) reject GitHub's US datacenter
# IPs. This Lambda runs pipeline/ code from ap-southeast-2 so the source check
# (and later the collector's fetch step) can run from an Australian AWS IP.
# No Function URL: only the CI infra role (lambda:* on flexo333-*) can invoke
# it, so it can't be used as an open fetch proxy. Names MUST be flexo333-*.
FETCH_NAME = "flexo333-aisignals-fetch"
sydney = aws.Provider("sydney", region="ap-southeast-2")

pipeline_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "pipeline"))
if not os.path.isdir(os.path.join(pipeline_dir, "node_modules")):
    raise RuntimeError("pipeline/node_modules missing — run `npm ci` in pipeline/ before pulumi")

fetch_role = aws.iam.Role(
    "fetch-role",
    name=f"{FETCH_NAME}-role",
    assume_role_policy=json.dumps({
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Service": "lambda.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }],
    }),
)
aws.iam.RolePolicyAttachment(
    "fetch-role-logs",
    role=fetch_role.name,
    policy_arn="arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
)

fetch_fn = aws.lambda_.Function(
    "fetch",
    name=FETCH_NAME,
    runtime="nodejs22.x",
    handler="lambda/source-check-handler.handler",
    role=fetch_role.arn,
    code=pulumi.FileArchive(pipeline_dir),
    timeout=900,
    memory_size=512,
    architectures=["arm64"],
    opts=pulumi.ResourceOptions(provider=sydney),
)

pulumi.export("fetch_function_name", fetch_fn.name)
pulumi.export("fetch_region", "ap-southeast-2")
pulumi.export("bucket", site.bucket_name)
pulumi.export("distribution_id", site.distribution_id)
pulumi.export("cloudfront_domain", site.distribution_domain.apply(lambda d: f"https://{d}"))
pulumi.export("site_url", f"https://{domain_name}")
pulumi.export("aws_region", pulumi.Config("aws").require("region"))
