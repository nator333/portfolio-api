# portfolio-api

AWS CDK (TypeScript) infrastructure foundation.

* `bin/portfolio-api.ts` - CDK app entry point
* `lib/portfolio-api-stack.ts` - application stack (deployed per stage: dev/prod)
* `lib/github-oidc-stack.ts` - one-time, account-wide GitHub Actions OIDC setup
* `test/portfolio-api.test.ts` - Jest unit tests

## MCP server

`POST /mcp` exposes the API as a [Model Context Protocol](https://modelcontextprotocol.io)
server so any agent can read the portfolio — and, as the site owner, edit it.

* **Transport** — stateless Streamable HTTP: one JSON-RPC endpoint that answers
  with `application/json` (no SSE; a Lambda behind a REST API has no long-lived
  connection to stream over). Implements `initialize`, `tools/list`,
  `tools/call` and `ping`.
* **Reads are public** — `get_cv`, `get_projects`, `get_blog`, `get_home`,
  `get_workout`, `get_activity`.
* **Writes are admin-only** — `list_media`, `update_cv`, `update_projects`,
  `update_blog`, `update_home`, `update_media`. Each is refused unless the
  request carries `Authorization: Bearer <Cognito ID token>` for an allowlisted
  admin. The gate is verified inside the Lambda (`lambda/mcp.ts`) rather than by
  a gateway authorizer, because the read tools must stay anonymous — so this is
  the one function that both reaches the tables for writes *and* is publicly
  reachable, with the token check, not an IAM boundary, standing in for the
  Cognito-gated `PUT`s. Each tool just delegates to the same handler (and the
  same zod validation) behind those endpoints.
* **Quota** — the endpoint has its own public API key and a daily usage plan,
  like `/workout` and `/chat`, so agent traffic is isolated in both directions.
  The key is a spend cap, not a security boundary; fetch its value from the
  `McpApiKeyId` stack output and send it as `X-Api-Key`.

Point an MCP client at `<ApiUrl>mcp` with the `X-Api-Key` header (and, for
writes, the `Authorization: Bearer` header). For example, a Claude Code remote
server entry:

```jsonc
{
  "portfolio": {
    "type": "http",
    "url": "https://<api-id>.execute-api.<region>.amazonaws.com/<stage>/mcp",
    "headers": {
      "X-Api-Key": "<value of McpApiKeyId>",
      "Authorization": "Bearer <Cognito ID token>" // only needed for the update_ tools
    }
  }
}
```

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
