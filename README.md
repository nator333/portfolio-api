# portfolio-api

AWS CDK (TypeScript) infrastructure foundation.

* `bin/portfolio-api.ts` - CDK app entry point
* `lib/portfolio-api-stack.ts` - application stack (deployed per stage: dev/prod)
* `lib/github-oidc-stack.ts` - one-time, account-wide GitHub Actions OIDC setup
* `test/portfolio-api.test.ts` - Jest unit tests

## MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
portfolio to MCP clients — including the Claude iOS app — over OAuth 2.1.

* **Transport** — stateless Streamable HTTP: one JSON-RPC endpoint answering
  with `application/json` (no SSE; a Lambda behind a REST API has no long-lived
  connection to stream over). Implements `initialize`, `tools/list`,
  `tools/call` and `ping`.
* **Public read tools** — `get_cv`, `get_projects`, `get_blog`, `get_home`,
  `get_workout`, `get_activity`: the same data the site already serves.
* **Admin tools** — `get_workout_sets` (the private per-set training log),
  `list_media`, and every `update_` tool. Each is refused with `401` and a
  `WWW-Authenticate` challenge unless the request carries an access token issued
  by this user pool, for this resource, bearing the `mcp/admin` scope.

### Why there is no dynamic client registration

The MCP spec allows RFC 7591 dynamic client registration but does not require
it, and Cognito does not implement it. Since this server has exactly one user,
a single app client is pre-provisioned at deploy time instead and supplied to
the client by hand. The pool's pre-signup trigger still admits only the owner's
Google account, so a leaked client ID grants nothing without that sign-in.

### Deploying it

The endpoint is created only when `mcpCertificateArn` context is supplied, which
in practice means production. The OAuth discovery documents must be served from
a domain root — RFC 9728 puts protected-resource metadata there, and the default
`execute-api` URL always has the stage as its first path segment — so the server
needs its own custom domain, and therefore a certificate and a DNS record. Dev
deploys pass no certificate and get no MCP endpoint.

One-time setup:

1. Request an ACM certificate for `mcp.<siteDomain>` **in the stack's region**
   (a REGIONAL API Gateway domain cannot use an us-east-1 certificate) and
   complete its DNS validation.
2. Deploy with `-c mcpCertificateArn=<arn>`, or set the `MCP_CERTIFICATE_ARN`
   Actions secret so the production workflow passes it.
3. Point `mcp.<siteDomain>` at the `McpDomainTarget` stack output with a CNAME.

Then add it in Claude as a custom connector at `https://mcp.<siteDomain>/mcp`,
opening **Advanced settings** and pasting the `McpUserPoolClientId` output as
the OAuth Client ID. Leave the client secret blank — it is a public client using
authorization-code + PKCE. Connectors configured on claude.ai are available in
Claude Desktop and Claude Mobile, so iOS needs no separate registration.

## Useful commands

* `npm run build`        compile TypeScript to JS
* `npm run watch`        watch for changes and compile
* `npm run test`         run the Jest unit tests
* `npm run deploy:dev`   deploy `PortfolioApiStack-dev`
* `npm run deploy:prod`  deploy `PortfolioApiStack-prod`
* `npx cdk diff`         compare deployed stack with current state
* `npx cdk synth`        emit the synthesized CloudFormation template

## CI/CD

GitHub Actions authenticates to AWS via OIDC (no long-lived AWS keys stored in GitHub):

* `.github/workflows/deploy-prod.yml` - deploys `PortfolioApiStack-prod` on every push to `master`
* `.github/workflows/deploy-dev.yml` - deploys `PortfolioApiStack-dev` on pull requests into `master`, skipped for Dependabot PRs

### One-time setup

1. Bootstrap the target AWS account/region with your own credentials (once):
   ```
   npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
   ```
2. Deploy the OIDC provider + deploy roles (once, with your own credentials):
   ```
   npm run deploy:oidc
   ```
   If the account already has a GitHub OIDC provider (`token.actions.githubusercontent.com`) from another project, edit `lib/github-oidc-stack.ts` to import it via `iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(...)` instead of creating a new one, then redeploy.
3. Copy the `ProdDeployRoleArn` / `DevDeployRoleArn` stack outputs into the repo's
   **Settings > Secrets and variables > Actions > Variables**:
   * `AWS_DEPLOY_ROLE_ARN_PROD`
   * `AWS_DEPLOY_ROLE_ARN_DEV`
   * `AWS_REGION` (the region you bootstrapped/deployed to)
4. (Optional but recommended) Create GitHub **Environments** named `production` and `development` to add protection rules (e.g. required reviewers) around the deploy jobs — the workflows already reference these environment names.

Once configured: merging to `master` deploys production; opening/updating a non-Dependabot pull request deploys the dev stack.
