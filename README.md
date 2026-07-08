# portfolio-api

AWS CDK (TypeScript) infrastructure foundation.

* `bin/portfolio-api.ts` - CDK app entry point
* `lib/portfolio-api-stack.ts` - application stack (deployed per stage: dev/prod)
* `lib/github-oidc-stack.ts` - one-time, account-wide GitHub Actions OIDC setup
* `test/portfolio-api.test.ts` - Jest unit tests

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
