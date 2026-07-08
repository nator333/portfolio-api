import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface GithubOidcStackProps extends cdk.StackProps {
  /** GitHub organization or user that owns the repo, e.g. "nator333". */
  readonly githubOrg: string;
  /** Repo name, e.g. "portfolio-api". */
  readonly githubRepo: string;
  /** GitHub Environment name used by the prod deploy job. Must match the `environment:` key in deploy-prod.yml. */
  readonly prodEnvironment?: string;
  /** GitHub Environment name used by the dev deploy job. Must match the `environment:` key in deploy-dev.yml. */
  readonly devEnvironment?: string;
  /** CDK bootstrap qualifier, only needed if you bootstrapped with a custom --qualifier. */
  readonly cdkQualifier?: string;
}

/**
 * One-time, account-wide setup that lets GitHub Actions deploy this app via OIDC
 * (no long-lived AWS keys in GitHub). Deploy manually with your own credentials:
 *
 *   npx cdk deploy GithubOidcStack
 *
 * then copy the two role ARNs from the stack outputs into the repo's GitHub Actions
 * variables (Settings > Secrets and variables > Actions > Variables):
 *   AWS_DEPLOY_ROLE_ARN_PROD, AWS_DEPLOY_ROLE_ARN_DEV
 *
 * Requires `npx cdk bootstrap` to have already been run in this account/region,
 * since the roles here only get permission to assume the bootstrap-created
 * cdk-*-deploy/file-publishing/image-publishing/lookup roles.
 *
 * If this AWS account already has a GitHub OIDC provider (token.actions.githubusercontent.com),
 * creating a second one will fail — replace the `new iam.OpenIdConnectProvider(...)` below with
 * `iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidcProvider', '<existing-arn>')`.
 */
export class GithubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const prodEnvironment = props.prodEnvironment ?? 'production';
    const devEnvironment = props.devEnvironment ?? 'development';
    const qualifier = props.cdkQualifier ?? 'hnb659fds';
    const repoSlug = `${props.githubOrg}/${props.githubRepo}`;

    const provider = new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    const cdkBootstrapRoleArns = (roleType: string) =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-${roleType}-role-${this.account}-${this.region}`;

    const assumeCdkBootstrapRolesPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          actions: ['sts:AssumeRole'],
          resources: [
            cdkBootstrapRoleArns('deploy'),
            cdkBootstrapRoleArns('file-publishing'),
            cdkBootstrapRoleArns('image-publishing'),
            cdkBootstrapRoleArns('lookup'),
          ],
        }),
      ],
    });

    // GitHub sets the OIDC token's `sub` claim to `repo:<slug>:environment:<name>` whenever
    // the calling job references an `environment:` (which both deploy workflows do, for
    // protection rules) — this takes precedence over the ref/pull_request-based sub claim.
    const prodDeployRole = new iam.Role(this, 'GithubActionsProdDeployRole', {
      roleName: 'github-actions-portfolio-api-prod',
      description: `Assumed by GitHub Actions to deploy production via the "${prodEnvironment}" environment`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${repoSlug}:environment:${prodEnvironment}`,
        },
      }),
      inlinePolicies: { AssumeCdkBootstrapRoles: assumeCdkBootstrapRolesPolicy },
    });

    const devDeployRole = new iam.Role(this, 'GithubActionsDevDeployRole', {
      roleName: 'github-actions-portfolio-api-dev',
      description: `Assumed by GitHub Actions to deploy the dev stack via the "${devEnvironment}" environment`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${repoSlug}:environment:${devEnvironment}`,
        },
      }),
      inlinePolicies: { AssumeCdkBootstrapRoles: assumeCdkBootstrapRolesPolicy },
    });

    new cdk.CfnOutput(this, 'ProdDeployRoleArn', { value: prodDeployRole.roleArn });
    new cdk.CfnOutput(this, 'DevDeployRoleArn', { value: devDeployRole.roleArn });
  }
}
