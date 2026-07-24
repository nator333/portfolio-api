import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * A repo that is allowed to assume a deploy role in this account.
 *
 * `environment` and `jobWorkflowRefs` are the two halves of the trust condition
 * and both matter — see the class docstring for why neither is sufficient alone.
 */
interface DeployRoleSpec {
  /** Construct id. */
  readonly id: string;
  /** IAM role name. Referenced from the repo's workflow as an Actions variable. */
  readonly roleName: string;
  /** Repo name within the org, e.g. "kotlin-ses-forward". */
  readonly repo: string;
  /** GitHub Environment name; must match the `environment:` key in the workflow. */
  readonly environment: string;
  /**
   * Allowed values of the `job_workflow_ref` claim, as StringLike patterns.
   * Format: `<org>/<repo>/.github/workflows/<file>@<ref>`.
   */
  readonly jobWorkflowRefs: string[];
  /** The permissions this role gets once assumed. */
  readonly policy: iam.PolicyDocument;
  readonly description: string;
}

export interface GithubOidcStackProps extends cdk.StackProps {
  /** GitHub organization or user that owns every repo below, supplied at synth time. */
  readonly githubOrg: string;
  /** CDK bootstrap qualifier, only needed if you bootstrapped with a custom --qualifier. */
  readonly cdkQualifier?: string;

  /** Region kotlin-ses-forward deploys into — its serverless.yml `REGION_ID`. */
  readonly kotlinSesForwardRegion: string;
  /** Pre-existing bucket serverless uploads the artifact to (`DEPLOYMENT_BUCKET`). */
  readonly kotlinSesForwardDeploymentBucket: string;
  /** Bucket SES writes inbound mail to, created by the stack (`EVENT_BUCKET`). */
  readonly kotlinSesForwardEventBucket: string;

  /** Region 3-things deploys into — its samconfig.toml `region`. */
  readonly threeThingsRegion: string;
}

/**
 * One-time, account-wide setup that lets GitHub Actions deploy via OIDC (no
 * long-lived AWS keys in GitHub), for every repo in this account.
 *
 * Deploy manually with your own admin credentials — never from CI:
 *
 *   npx cdk deploy GithubOidcStack \
 *     -c ksfRegion=... -c ksfDeploymentBucket=... -c ksfEventBucket=...
 *
 * then copy the role ARNs from the stack outputs into each repo's GitHub Actions
 * variables (Settings > Secrets and variables > Actions > Variables).
 *
 * ## Why the roles live here and not in each repo
 *
 * The trust policy is the security boundary. If an app repo owned the template
 * that defines its own trust policy and permissions, a commit to that repo could
 * widen them — which for a public repo like kotlin-ses-forward is exactly the
 * escalation path we are trying to close. Keeping every trust policy in one
 * admin-deployed stack means an app repo can only ever use the role it was
 * given, never redefine it.
 *
 * ## Why each role is pinned two different ways
 *
 * When a job declares `environment:`, GitHub replaces the ref-based `sub` claim
 * with `repo:<org>/<repo>:environment:<name>` — the branch is *gone* from the
 * claim. So a `sub` condition alone cannot express "only master may deploy";
 * that is enforced entirely by the GitHub Environment's deployment-branch rule,
 * which lives in repo settings rather than in code.
 *
 * So each role additionally pins `job_workflow_ref`, which carries both the
 * workflow file path and the ref it ran from. A branch pushed by an attacker
 * pointing a different workflow at this role then fails at STS, not merely at
 * GitHub's discretion. Both conditions must hold.
 *
 * ## Required manual GitHub configuration
 *
 * For every environment referenced below, in that repo's Settings > Environments:
 *   - Deployment branches and tags -> Selected branches -> the default branch only.
 *   - Required reviewers -> yourself, for the public repos.
 * Without the branch rule the `sub` condition matches from any branch.
 *
 * Requires `npx cdk bootstrap` to have already been run for the portfolio-api
 * roles, which only get permission to assume the bootstrap-created
 * cdk-*-deploy/file-publishing/image-publishing/lookup roles.
 */
export class GithubOidcStack extends cdk.Stack {
  private readonly provider: iam.IOpenIdConnectProvider;
  private readonly org: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    this.org = props.githubOrg;
    const qualifier = props.cdkQualifier ?? 'hnb659fds';

    // Exactly one provider is permitted per account for a given URL, and every
    // repo's roles trust this one. Deleting this stack breaks deploys in all of
    // them, not just portfolio-api.
    this.provider = new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // Both the Serverless and SAM deploy roles must be able to create the Lambda
    // execution role their stack declares, which means iam:CreateRole +
    // iam:PassRole. Scoping those to a name prefix is not enough on its own: the
    // role could still be created *with* an AdministratorAccess policy and then
    // passed to a Lambda. This boundary caps whatever they create, and the
    // deploy policies below refuse to create a role without it.
    const boundary = this.lambdaExecutionBoundary();

    const roles: DeployRoleSpec[] = [
      ...this.portfolioApiRoles(qualifier),
      this.kotlinSesForwardRole(props, boundary),
      this.threeThingsRole(props, boundary),
    ];

    for (const spec of roles) {
      const role = new iam.Role(this, spec.id, {
        roleName: spec.roleName,
        description: spec.description,
        maxSessionDuration: cdk.Duration.hours(1),
        assumedBy: this.githubPrincipal(spec),
        inlinePolicies: { DeployPermissions: spec.policy },
      });
      new cdk.CfnOutput(this, `${spec.id}Arn`, {
        value: role.roleArn,
        description: `Set as AWS_DEPLOY_ROLE_ARN in ${this.org}/${spec.repo}`,
      });
    }

    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: this.provider.openIdConnectProviderArn,
      description: 'Shared GitHub OIDC provider; import with fromOpenIdConnectProviderArn',
    });
    new cdk.CfnOutput(this, 'LambdaExecutionBoundaryArn', {
      value: boundary.managedPolicyArn,
      description: 'Permissions boundary required on roles created by the deploy roles',
    });
  }

  /** Trust policy: exact `aud` + `sub`, plus a `job_workflow_ref` allow-list. */
  private githubPrincipal(spec: DeployRoleSpec): iam.OpenIdConnectPrincipal {
    const claim = 'token.actions.githubusercontent.com';
    return new iam.OpenIdConnectPrincipal(this.provider, {
      StringEquals: {
        [`${claim}:aud`]: 'sts.amazonaws.com',
        [`${claim}:sub`]: `repo:${this.org}/${spec.repo}:environment:${spec.environment}`,
      },
      StringLike: {
        [`${claim}:job_workflow_ref`]: spec.jobWorkflowRefs,
      },
    });
  }

  /**
   * Ceiling for every Lambda execution role the deploy roles create. A boundary
   * is an allow-list, so anything absent here is already denied; the explicit
   * Deny exists so that broadening the Allow list later cannot accidentally
   * hand out IAM or STS.
   */
  private lambdaExecutionBoundary(): iam.ManagedPolicy {
    return new iam.ManagedPolicy(this, 'LambdaExecutionBoundary', {
      managedPolicyName: 'github-actions-lambda-execution-boundary',
      description:
        'Permissions boundary for Lambda execution roles created by GitHub Actions deploy roles',
      document: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'Observability',
            actions: [
              'logs:CreateLogGroup',
              'logs:CreateLogStream',
              'logs:PutLogEvents',
              // Serverless v4 puts logs:TagResource in the execution role it
              // generates; without it here the boundary would cap that away.
              'logs:TagResource',
              'xray:PutTraceSegments',
              'xray:PutTelemetryRecords',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'KotlinSesForwardRuntime',
            actions: ['s3:GetObject', 'ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'ThreeThingsRuntime',
            actions: [
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
              'dynamodb:DeleteItem',
              'dynamodb:Query',
              'dynamodb:Scan',
              'dynamodb:BatchGetItem',
              'dynamodb:BatchWriteItem',
              'dynamodb:ConditionCheckItem',
              'dynamodb:DescribeTable',
              'ssm:GetParameter',
              'ssm:GetParameters',
              'kms:Decrypt',
              'bedrock:InvokeModel',
              'bedrock:InvokeModelWithResponseStream',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'NeverIdentityOrOrgControl',
            effect: iam.Effect.DENY,
            actions: ['iam:*', 'sts:AssumeRole*', 'organizations:*', 'account:*'],
            resources: ['*'],
          }),
        ],
      }),
    });
  }

  /**
   * portfolio-api deploys through the CDK bootstrap roles, so its own permissions
   * stay minimal — it only needs to assume them. Unchanged from the original
   * stack apart from the added job_workflow_ref pin.
   */
  private portfolioApiRoles(qualifier: string): DeployRoleSpec[] {
    const repo = 'portfolio-api';
    // The bootstrap roles are per-region. The app stack lives in this stack's
    // region (us-west-1); WorkoutIngestStack lives in us-west-2, so CI must be
    // able to assume the us-west-2 bootstrap roles too. Both regions therefore
    // need `cdk bootstrap` run once.
    const bootstrapRegions = [this.region, 'us-west-2'];
    const bootstrapRole = (roleType: string, region: string) =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-${roleType}-role-${this.account}-${region}`;
    const bootstrapRoles = bootstrapRegions.flatMap((region) =>
      ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map((roleType) =>
        bootstrapRole(roleType, region),
      ),
    );

    const policy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          actions: ['sts:AssumeRole'],
          resources: bootstrapRoles,
        }),
      ],
    });

    return [
      {
        id: 'GithubActionsProdDeployRole',
        roleName: 'github-actions-portfolio-api-prod',
        repo,
        environment: 'production',
        jobWorkflowRefs: [
          `${this.org}/${repo}/.github/workflows/deploy-prod.yml@refs/heads/master`,
        ],
        policy,
        description: 'Assumed by GitHub Actions to deploy portfolio-api production',
      },
      {
        id: 'GithubActionsDevDeployRole',
        roleName: 'github-actions-portfolio-api-dev',
        repo,
        environment: 'development',
        // Wildcard ref, not refs/heads/master: this workflow runs on pull_request,
        // where job_workflow_ref carries the PR merge ref (refs/pull/<n>/merge).
        // The workflow *file* is still pinned, which is the part that matters.
        jobWorkflowRefs: [`${this.org}/${repo}/.github/workflows/deploy-dev.yml@*`],
        policy,
        description: 'Assumed by GitHub Actions to deploy the portfolio-api dev stack',
      },
    ];
  }

  /**
   * kotlin-ses-forward deploys with the Serverless Framework, so unlike
   * portfolio-api there is no bootstrap role to hide behind — this role talks to
   * CloudFormation and the resource APIs directly, and every statement is scoped
   * to the `kotlin-ses-forward-*` naming its serverless.yml produces.
   */
  private kotlinSesForwardRole(
    props: GithubOidcStackProps,
    boundary: iam.ManagedPolicy,
  ): DeployRoleSpec {
    const repo = 'kotlin-ses-forward';
    const region = props.kotlinSesForwardRegion;
    const service = 'kotlin-ses-forward';
    const deploymentBucket = props.kotlinSesForwardDeploymentBucket;
    const eventBucket = props.kotlinSesForwardEventBucket;

    return {
      id: 'GithubActionsKotlinSesForwardRole',
      roleName: 'github-actions-kotlin-ses-forward-prod',
      repo,
      environment: 'production',
      jobWorkflowRefs: [`${this.org}/${repo}/.github/workflows/deploy.yml@refs/heads/master`],
      description:
        'Assumed by GitHub Actions to deploy kotlin-ses-forward via Serverless Framework',
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'CloudFormationOwnStackOnly',
            actions: [
              'cloudformation:CreateStack',
              'cloudformation:UpdateStack',
              'cloudformation:DeleteStack',
              'cloudformation:DescribeStacks',
              'cloudformation:DescribeStackEvents',
              'cloudformation:DescribeStackResource',
              'cloudformation:DescribeStackResources',
              'cloudformation:ListStackResources',
              'cloudformation:GetTemplate',
              'cloudformation:CreateChangeSet',
              'cloudformation:DescribeChangeSet',
              'cloudformation:ExecuteChangeSet',
              'cloudformation:DeleteChangeSet',
            ],
            resources: [
              `arn:${this.partition}:cloudformation:${region}:${this.account}:stack/${service}-*/*`,
            ],
          }),
          new iam.PolicyStatement({
            // ValidateTemplate and ListStacks have no resource-level support.
            sid: 'CloudFormationAccountWideReads',
            actions: ['cloudformation:ValidateTemplate', 'cloudformation:ListStacks'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'ArtifactUploadToDeploymentBucket',
            actions: [
              's3:PutObject',
              's3:GetObject',
              's3:DeleteObject',
              's3:ListBucket',
              's3:GetBucketLocation',
            ],
            resources: [
              `arn:${this.partition}:s3:::${deploymentBucket}`,
              `arn:${this.partition}:s3:::${deploymentBucket}/*`,
            ],
          }),
          new iam.PolicyStatement({
            // The stack creates this bucket and attaches both the notification
            // and the policy that lets SES write to it.
            sid: 'ManageEventBucket',
            actions: [
              's3:CreateBucket',
              's3:DeleteBucket',
              's3:ListBucket',
              's3:GetBucketLocation',
              's3:PutBucketNotification',
              's3:GetBucketNotification',
              's3:PutBucketPolicy',
              's3:GetBucketPolicy',
              's3:DeleteBucketPolicy',
              's3:PutBucketTagging',
              's3:GetBucketTagging',
              's3:PutBucketPublicAccessBlock',
              's3:GetBucketPublicAccessBlock',
            ],
            resources: [`arn:${this.partition}:s3:::${eventBucket}`],
          }),
          new iam.PolicyStatement({
            sid: 'ManageOwnFunction',
            actions: [
              'lambda:CreateFunction',
              'lambda:DeleteFunction',
              'lambda:GetFunction',
              'lambda:GetFunctionConfiguration',
              'lambda:UpdateFunctionCode',
              'lambda:UpdateFunctionConfiguration',
              'lambda:AddPermission',
              'lambda:RemovePermission',
              'lambda:GetPolicy',
              'lambda:PublishVersion',
              'lambda:ListVersionsByFunction',
              'lambda:TagResource',
              'lambda:UntagResource',
              'lambda:ListTags',
            ],
            resources: [
              `arn:${this.partition}:lambda:${region}:${this.account}:function:${service}-*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'ManageOwnLogGroups',
            actions: [
              'logs:CreateLogGroup',
              'logs:DeleteLogGroup',
              'logs:PutRetentionPolicy',
              'logs:DeleteRetentionPolicy',
              'logs:TagResource',
              'logs:ListTagsForResource',
            ],
            resources: [
              `arn:${this.partition}:logs:${region}:${this.account}:log-group:/aws/lambda/${service}-*`,
              `arn:${this.partition}:logs:${region}:${this.account}:log-group:/aws/lambda/${service}-*:*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'DescribeLogGroupsHasNoResourceScope',
            actions: ['logs:DescribeLogGroups'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            // SES receipt-rule APIs do not support resource-level permissions, so
            // this is as tight as IAM allows. It is confined to the inbound
            // receipt pipeline; sending is not granted to the deploy role.
            sid: 'ManageSesReceiptPipeline',
            actions: [
              'ses:CreateReceiptRuleSet',
              'ses:DeleteReceiptRuleSet',
              'ses:DescribeReceiptRuleSet',
              'ses:CreateReceiptRule',
              'ses:DeleteReceiptRule',
              'ses:UpdateReceiptRule',
              'ses:DescribeReceiptRule',
              'ses:DescribeActiveReceiptRuleSet',
              'ses:SetActiveReceiptRuleSet',
            ],
            resources: ['*'],
          }),
          ...this.lambdaRoleManagementStatements(service, boundary),
        ],
      }),
    };
  }

  /**
   * 3-things deploys with AWS SAM. Beyond its own `three-things` stack it needs
   * the SAM-managed bucket stack, because samconfig.toml sets resolve_s3 = true.
   */
  private threeThingsRole(
    props: GithubOidcStackProps,
    boundary: iam.ManagedPolicy,
  ): DeployRoleSpec {
    const repo = '3-things';
    const region = props.threeThingsRegion;
    const stack = 'three-things';

    return {
      id: 'GithubActionsThreeThingsRole',
      roleName: 'github-actions-3-things-prod',
      repo,
      environment: 'production',
      jobWorkflowRefs: [`${this.org}/${repo}/.github/workflows/deploy.yml@refs/heads/main`],
      description: 'Assumed by GitHub Actions to deploy 3-things via AWS SAM',
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'CloudFormationOwnStackAndSamManagedBucket',
            actions: [
              'cloudformation:CreateStack',
              'cloudformation:UpdateStack',
              'cloudformation:DeleteStack',
              'cloudformation:DescribeStacks',
              'cloudformation:DescribeStackEvents',
              'cloudformation:DescribeStackResource',
              'cloudformation:DescribeStackResources',
              'cloudformation:ListStackResources',
              'cloudformation:GetTemplate',
              'cloudformation:GetTemplateSummary',
              'cloudformation:CreateChangeSet',
              'cloudformation:DescribeChangeSet',
              'cloudformation:ExecuteChangeSet',
              'cloudformation:DeleteChangeSet',
            ],
            resources: [
              `arn:${this.partition}:cloudformation:${region}:${this.account}:stack/${stack}/*`,
              `arn:${this.partition}:cloudformation:${region}:${this.account}:stack/aws-sam-cli-managed-default/*`,
            ],
          }),
          new iam.PolicyStatement({
            // SAM runs the template through the public Serverless transform, and
            // ValidateTemplate/ListStacks have no resource-level support.
            sid: 'CloudFormationAccountWideReads',
            actions: [
              'cloudformation:ValidateTemplate',
              'cloudformation:ListStacks',
              'cloudformation:GetTemplateSummary',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'UseServerlessTransform',
            actions: ['cloudformation:CreateChangeSet'],
            resources: [
              `arn:${this.partition}:cloudformation:${region}:aws:transform/Serverless-2016-10-31`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'SamManagedArtifactBucket',
            actions: [
              's3:PutObject',
              's3:GetObject',
              's3:DeleteObject',
              's3:ListBucket',
              's3:GetBucketLocation',
              's3:CreateBucket',
              's3:PutBucketPolicy',
              's3:GetBucketPolicy',
              's3:PutBucketTagging',
              's3:PutBucketVersioning',
              's3:GetBucketVersioning',
              's3:PutEncryptionConfiguration',
              's3:PutBucketPublicAccessBlock',
            ],
            resources: [
              `arn:${this.partition}:s3:::aws-sam-cli-managed-default-samclisourcebucket-*`,
              `arn:${this.partition}:s3:::aws-sam-cli-managed-default-samclisourcebucket-*/*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'ManageOwnFunction',
            actions: [
              'lambda:CreateFunction',
              'lambda:DeleteFunction',
              'lambda:GetFunction',
              'lambda:GetFunctionConfiguration',
              'lambda:UpdateFunctionCode',
              'lambda:UpdateFunctionConfiguration',
              // The AlexaSkill event source is a resource policy on the function.
              'lambda:AddPermission',
              'lambda:RemovePermission',
              'lambda:GetPolicy',
              'lambda:PublishVersion',
              'lambda:ListVersionsByFunction',
              'lambda:TagResource',
              'lambda:UntagResource',
              'lambda:ListTags',
            ],
            resources: [
              `arn:${this.partition}:lambda:${region}:${this.account}:function:${stack}-*`,
            ],
          }),
          new iam.PolicyStatement({
            // Both tables carry explicit TableNames rather than generated ones.
            sid: 'ManageOwnTables',
            actions: [
              'dynamodb:CreateTable',
              'dynamodb:DeleteTable',
              'dynamodb:DescribeTable',
              'dynamodb:UpdateTable',
              'dynamodb:DescribeTimeToLive',
              'dynamodb:UpdateTimeToLive',
              'dynamodb:TagResource',
              'dynamodb:UntagResource',
              'dynamodb:ListTagsOfResource',
              'dynamodb:DescribeContinuousBackups',
            ],
            resources: [
              `arn:${this.partition}:dynamodb:${region}:${this.account}:table/ThreeThingsTable`,
              `arn:${this.partition}:dynamodb:${region}:${this.account}:table/ThreeThingsPersistentAttributes`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'ManageOwnLogGroups',
            actions: [
              'logs:CreateLogGroup',
              'logs:DeleteLogGroup',
              'logs:PutRetentionPolicy',
              'logs:DeleteRetentionPolicy',
              'logs:TagResource',
              'logs:ListTagsForResource',
            ],
            resources: [
              `arn:${this.partition}:logs:${region}:${this.account}:log-group:/aws/lambda/${stack}-*`,
              `arn:${this.partition}:logs:${region}:${this.account}:log-group:/aws/lambda/${stack}-*:*`,
            ],
          }),
          new iam.PolicyStatement({
            sid: 'DescribeLogGroupsHasNoResourceScope',
            actions: ['logs:DescribeLogGroups'],
            resources: ['*'],
          }),
          ...this.lambdaRoleManagementStatements(stack, boundary),
        ],
      }),
    };
  }

  /**
   * The escalation-sensitive half of both deploy policies: permission to create
   * and pass the stack's own Lambda execution role.
   *
   * Three things keep this from becoming account takeover:
   *   - every resource is confined to the stack's own role name prefix;
   *   - creating or re-permissioning a role requires the boundary be attached,
   *     so the created role can never exceed the ceiling above;
   *   - PassRole is restricted to Lambda, so a created role cannot be handed to
   *     EC2 or another service to escape.
   */
  private lambdaRoleManagementStatements(
    namePrefix: string,
    boundary: iam.ManagedPolicy,
  ): iam.PolicyStatement[] {
    const roleArn = `arn:${this.partition}:iam::${this.account}:role/${namePrefix}-*`;
    return [
      new iam.PolicyStatement({
        // iam:PermissionsBoundary reflects the boundary on the *target* role, so
        // every one of these is refused unless that role carries this exact
        // boundary. PutRolePermissionsBoundary is included so the deploy can
        // attach it in the first place — but only ever to this boundary, never
        // to a weaker one of the caller's choosing.
        sid: 'CreateExecutionRoleOnlyWithBoundary',
        actions: [
          'iam:CreateRole',
          'iam:PutRolePermissionsBoundary',
          'iam:PutRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:DetachRolePolicy',
        ],
        resources: [roleArn],
        conditions: {
          StringEquals: { 'iam:PermissionsBoundary': boundary.managedPolicyArn },
        },
      }),
      new iam.PolicyStatement({
        sid: 'ReadAndRetireExecutionRole',
        actions: [
          'iam:GetRole',
          'iam:GetRolePolicy',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
          'iam:TagRole',
          'iam:UntagRole',
          'iam:DeleteRole',
        ],
        resources: [roleArn],
      }),
      new iam.PolicyStatement({
        sid: 'PassExecutionRoleToLambdaOnly',
        actions: ['iam:PassRole'],
        resources: [roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': `lambda.${this.urlSuffix}` },
        },
      }),
      new iam.PolicyStatement({
        // Without this, the deploy role could detach its own ceiling.
        sid: 'NeverAlterTheBoundaryItself',
        effect: iam.Effect.DENY,
        actions: [
          'iam:DeletePolicy',
          'iam:CreatePolicyVersion',
          'iam:DeletePolicyVersion',
          'iam:SetDefaultPolicyVersion',
          'iam:DeleteRolePermissionsBoundary',
        ],
        resources: [boundary.managedPolicyArn, `arn:${this.partition}:iam::${this.account}:role/*`],
      }),
      new iam.PolicyStatement({
        sid: 'NoServiceLinkedRoleEscape',
        effect: iam.Effect.DENY,
        actions: ['iam:CreateServiceLinkedRole', 'iam:UpdateAssumeRolePolicy'],
        resources: ['*'],
      }),
    ];
  }
}
