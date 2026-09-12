import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as path from 'path';
import {
  workoutSummaryTableName,
  workoutSetsTableName,
  SETS_BY_EXERCISE_INDEX,
  WORKOUT_REGION,
} from '../lambda/workout-schema';
import { workoutPlanTableName } from '../lambda/workout-plan-schema';

/**
 * Hard **daily** cap on content API calls, enforced at the gateway by the usage
 * plan. Roughly 10,500/month — up from a 300/month cap that real traffic
 * exhausted, blanking the blog and projects pages.
 *
 * The period is the security control here, not the limit. The API key is public
 * in the SPA, so anyone can spend this quota, and no usable rate limit protects
 * a *monthly* one: spreading 10,500 calls evenly over a month is 0.004 req/s.
 * A monthly quota drained in an hour leaves the site blank until the 1st,
 * whereas a daily period caps any outage — accidental or malicious — at the
 * remainder of that day and self-heals at midnight UTC.
 *
 * Spend is not the concern: the whole daily quota costs well under a cent.
 */
const CONTENT_DAILY_REQUEST_QUOTA = 350;

/**
 * The workout progress page reads the heaviest endpoint and will be chart-driven,
 * so it gets its own key and quota. Sharing the content plan would let one page
 * starve /cv, /blog and /projects.
 */
const WORKOUT_DAILY_REQUEST_QUOTA = 350;

/**
 * Throttle applied per key, i.e. shared by every visitor using it. The previous
 * 2/s with a burst of 5 was tight enough that a page fetching several endpoints
 * at once, or a few concurrent visitors, could draw spurious 429s. With a daily
 * quota the recovery window is already bounded, so this favours real users.
 */
const API_THROTTLE = { rateLimit: 10, burstLimit: 20 };

/**
 * Hard monthly cap on public chat calls. Together with the request-shape
 * limits in lambda/chat-schema.ts (~$0.008 worst case per call on Haiku),
 * this keeps Bedrock spend under the $5/month budget.
 */
const CHAT_MONTHLY_REQUEST_QUOTA = 500;

/** Bedrock is not offered in us-west-1, so the chat Lambda calls cross-region. */
const BEDROCK_REGION = 'us-west-2';
/**
 * "us." cross-region inference profile: newer Anthropic models reject
 * on-demand invocation of the bare model ID.
 */
const CHAT_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/**
 * Sonnet-class profile for the admin CV agent — writing quality matters there,
 * and the endpoint is Cognito-gated single-user, so the higher per-token price
 * stays within the Bedrock budget.
 */
// Sonnet 5 is listed but not yet invocable for this account; 4.6 is verified working.
const AGENT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
/** Monthly Bedrock spend (USD) that triggers the budget email alert. */
const BEDROCK_BUDGET_USD = 5;

/** SSM parameter holding the Google OAuth client ID (not secret, but env-specific). */
const GOOGLE_CLIENT_ID_PARAM = '/portfolio/cv/google-client-id';
/** Secrets Manager secret holding the Google OAuth client secret (json field: client_secret). */
const GOOGLE_CLIENT_SECRET_NAME = 'cv-google-oauth';

/**
 * Pinned sharp version for the resize Lambda. sharp ships prebuilt native
 * binaries, so the bundling hook cross-installs the Lambda-linux/x64 build for
 * this exact version — no Docker, reproducible on macOS and CI alike. Keep in
 * step with the `sharp` range in package.json.
 */
const SHARP_VERSION = '0.35.3';

export interface PortfolioApiStackProps extends cdk.StackProps {
  /** Deployment stage, e.g. "dev" or "prod". Applied as a tag on all stack resources. */
  readonly stage: string;
  /** Origins allowed to call the API (the deployed portfolio-front site). */
  readonly allowedOrigins?: string[];
  /** Full URLs Cognito may redirect back to after Google login. */
  readonly authCallbackUrls: string[];
  /** Emails allowed to sign in to the CV editor via Google. */
  readonly adminEmails: string[];
  /**
   * GitHub account whose public activity feeds the home-page calendar. Supplied
   * at deploy time rather than committed, like the other identity config. When
   * absent the scheduled ingest is not created and /activity simply serves the
   * blog and gym sources.
   */
  readonly githubUser?: string;
  /**
   * Public MCP server configuration. Supplied only when the MCP endpoint should
   * get its own custom domain and OAuth discovery documents — in practice
   * production only, mirroring how WorkoutIngestStack is declared solely when
   * its context is present. Without it the MCP endpoint is not created at all,
   * so dev deploys need no certificate and no DNS.
   */
  readonly mcp?: McpOptions;
}

/** Custom-domain + certificate inputs for the public MCP server. */
export interface McpOptions {
  /**
   * Host the MCP server answers on, e.g. "mcp.example.com". Supplied at deploy
   * time rather than committed: this repo is public and the site's domain is
   * deliberately kept out of it (see bin/portfolio-api.ts).
   */
  readonly domainName: string;
  /**
   * ARN of an ACM certificate for `domainName`, issued **in this stack's
   * region** — a REGIONAL API Gateway custom domain cannot use an us-east-1
   * certificate. Passed in rather than created here because DNS for the site is
   * not in Route 53, so CDK cannot complete the validation itself; issue the
   * certificate once by hand and pass its ARN.
   */
  readonly certificateArn: string;
  /**
   * Exact URLs Cognito may redirect back to after sign-in for the MCP client.
   * Claude's web, desktop and mobile apps all complete the flow at the same
   * Anthropic callback, so a single entry covers iOS too.
   */
  readonly callbackUrls: string[];
}

export class PortfolioApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortfolioApiStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('stage', props.stage);

    const cvTable = new dynamodb.Table(this, 'CvTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPool = new cognito.UserPool(this, 'CvAdminUserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Federated sign-in would otherwise admit any Google account; this trigger
    // rejects everyone but the allowlisted admin email(s).
    const preSignUpFn = new lambdaNode.NodejsFunction(this, 'PreSignUpFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'pre-signup.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: { ADMIN_EMAILS: props.adminEmails.join(',') },
    });
    userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUpFn);

    const userPoolDomain = userPool.addDomain('CvAuthDomain', {
      cognitoDomain: { domainPrefix: `nakamata-cv-${props.stage}` },
    });

    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdP', {
      userPool,
      clientId: ssm.StringParameter.valueForStringParameter(this, GOOGLE_CLIENT_ID_PARAM),
      clientSecretValue: cdk.SecretValue.secretsManager(GOOGLE_CLIENT_SECRET_NAME, {
        jsonField: 'client_secret',
      }),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
      },
    });

    const userPoolClient = userPool.addClient('CvAdminUserPoolClient', {
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.authCallbackUrls,
        logoutUrls: props.authCallbackUrls,
      },
    });
    userPoolClient.node.addDependency(googleIdp);

    const allowedOrigins = props.allowedOrigins ?? ['http://localhost:4200'];

    // Media (blog eye-catch + project images). Uploads land under `incoming/`
    // via a presigned POST, a resize Lambda writes optimised WebP variants to
    // `public/`, and CloudFront serves `public/` over a locked-down bucket.
    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          // The browser POSTs the file straight to S3 from the admin SPA origin.
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'Location'],
        },
      ],
      lifecycleRules: [
        // Safety net: any raw upload the resize Lambda didn't consume is swept
        // up rather than left to accumulate under the ingest prefix.
        { prefix: 'incoming/', expiration: cdk.Duration.days(1) },
      ],
    });

    // One row per uploaded image; written by the resize Lambda. Kept separate
    // from the single-document CvTable since media is a growing collection.
    const mediaTable = new dynamodb.Table(this, 'MediaAssetsTable', {
      partitionKey: { name: 'assetId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Only the `public/` prefix is web-reachable, via Origin Access Control;
    // the bucket itself stays private (no public policy, no OAI legacy).
    const mediaDistribution = new cloudfront.Distribution(this, 'MediaDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket, {
          originPath: '/public',
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      comment: `portfolio media (${props.stage})`,
    });
    const mediaCdnBaseUrl = `https://${mediaDistribution.distributionDomainName}`;

    const lambdaDefaults: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        CV_TABLE_NAME: cvTable.tableName,
        CORS_ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
    };

    const getCvFn = new lambdaNode.NodejsFunction(this, 'GetCvFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-cv.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantReadData(getCvFn);

    const updateCvFn = new lambdaNode.NodejsFunction(this, 'UpdateCvFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'update-cv.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantWriteData(updateCvFn);

    const getProjectsFn = new lambdaNode.NodejsFunction(this, 'GetProjectsFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-projects.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantReadData(getProjectsFn);

    const updateProjectsFn = new lambdaNode.NodejsFunction(this, 'UpdateProjectsFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'update-projects.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantWriteData(updateProjectsFn);

    const getBlogFn = new lambdaNode.NodejsFunction(this, 'GetBlogFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-blog.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantReadData(getBlogFn);

    // Admin variant of the blog reader: same handler, but INCLUDE_DRAFTS makes
    // it return draft posts too. Wired behind the Cognito-gated /blog/all route
    // so draft content never reaches the public /blog endpoint.
    const getBlogAdminFn = new lambdaNode.NodejsFunction(this, 'GetBlogAdminFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-blog.ts'),
      ...lambdaDefaults,
      environment: { ...lambdaDefaults.environment, INCLUDE_DRAFTS: 'true' },
    });
    cvTable.grantReadData(getBlogAdminFn);

    const updateBlogFn = new lambdaNode.NodejsFunction(this, 'UpdateBlogFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'update-blog.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantWriteData(updateBlogFn);

    const getHomeFn = new lambdaNode.NodejsFunction(this, 'GetHomeFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-home.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantReadData(getHomeFn);

    const updateHomeFn = new lambdaNode.NodejsFunction(this, 'UpdateHomeFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'update-home.ts'),
      ...lambdaDefaults,
    });
    cvTable.grantWriteData(updateHomeFn);

    // Public visitor Q&A: read-only by IAM design — this function never gets a
    // write grant, so no prompt injection can mutate the table.
    const chatFn = new lambdaNode.NodejsFunction(this, 'ChatFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'chat.ts'),
      ...lambdaDefaults,
      // Stay under API Gateway's 29s integration timeout.
      timeout: cdk.Duration.seconds(25),
      memorySize: 256,
      environment: {
        ...lambdaDefaults.environment,
        BEDROCK_REGION,
        CHAT_MODEL_ID,
      },
    });
    cvTable.grantReadData(chatFn);
    // Invoking a "us." inference profile needs permission on the profile in the
    // calling region AND on the underlying foundation models in every region
    // the profile can route to — hence the wildcard-region model ARN.
    const bedrockInvokePolicy = () =>
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${BEDROCK_REGION}:${this.account}:inference-profile/us.anthropic.*`,
          'arn:aws:bedrock:*::foundation-model/anthropic.*',
        ],
      });
    chatFn.addToRolePolicy(bedrockInvokePolicy());

    // Admin CV agent: proposes CV/projects edits but never writes — the only
    // write path stays the Cognito-protected PUT endpoints, so this function
    // gets read grants only.
    const agentFn = new lambdaNode.NodejsFunction(this, 'AgentFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'agent.ts'),
      ...lambdaDefaults,
      timeout: cdk.Duration.seconds(25),
      memorySize: 256,
      environment: {
        ...lambdaDefaults.environment,
        BEDROCK_REGION,
        AGENT_MODEL_ID,
      },
    });
    cvTable.grantReadData(agentFn);
    agentFn.addToRolePolicy(bedrockInvokePolicy());

    // Public read of the workout summaries. The summary table lives in us-west-2
    // with the ingest pipeline (WorkoutIngestStack), so this function reads it
    // cross-region. The table is referenced by its deterministic name + a
    // constructed ARN rather than a cross-region CloudFormation import.
    const workoutSummaryTable = workoutSummaryTableName(props.stage);
    const workoutSummaryArn = `arn:aws:dynamodb:${WORKOUT_REGION}:${this.account}:table/${workoutSummaryTable}`;
    // The per-set table lives beside the summary table in us-west-2. Only the
    // MCP server reads it, and only behind the admin scope: it is the private
    // training log the public summaries deliberately aggregate away.
    const workoutSetsTable = workoutSetsTableName(props.stage);
    const workoutSetsArn = `arn:aws:dynamodb:${WORKOUT_REGION}:${this.account}:table/${workoutSetsTable}`;
    // The training program, beside them in us-west-2 (WorkoutIngestStack). Also
    // MCP-only and admin-gated, and the one workout table this API *writes*:
    // publishing a plan version is an admin tool, so the grant below is split
    // from the read-only one to keep PutItem scoped to this table alone.
    const workoutPlanTable = workoutPlanTableName(props.stage);
    const workoutPlanArn = `arn:aws:dynamodb:${WORKOUT_REGION}:${this.account}:table/${workoutPlanTable}`;
    const getWorkoutFn = new lambdaNode.NodejsFunction(this, 'GetWorkoutFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-workout.ts'),
      ...lambdaDefaults,
      // Five paginated cross-region queries — including ~1,900 monthly e1RM
      // items — overran the 3s/128MB default. More memory buys proportionally
      // more CPU (faster marshalling), and the timeout leaves headroom for the
      // cross-region round trips.
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        ...lambdaDefaults.environment,
        WORKOUT_SUMMARY_TABLE_NAME: workoutSummaryTable,
        WORKOUT_REGION,
      },
    });
    getWorkoutFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
        resources: [workoutSummaryArn],
      }),
    );

    // Planned-versus-actual training volume. The only endpoint that reads the
    // plan table *and* the summary table, because deciding whether a muscle is
    // under or over needs both — which is exactly why every consumer that tried
    // to answer it alone drifted. Reads only; the plan is written by the MCP
    // tools above.
    const muscleVolumeStatusFn = new lambdaNode.NodejsFunction(
      this,
      'GetMuscleVolumeStatusFunction',
      {
        entry: path.join(__dirname, '..', 'lambda', 'get-muscle-volume-status.ts'),
        ...lambdaDefaults,
        // Two small cross-region queries rather than get-workout's five paginated
        // ones, but the round trips are the same distance, so it takes the same
        // headroom rather than the 3s default.
        timeout: cdk.Duration.seconds(15),
        environment: {
          ...lambdaDefaults.environment,
          WORKOUT_SUMMARY_TABLE_NAME: workoutSummaryTable,
          WORKOUT_PLAN_TABLE_NAME: workoutPlanTable,
          WORKOUT_REGION,
        },
      },
    );
    muscleVolumeStatusFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        // Read-only on both, and no PutItem on the plan table: publishing a plan
        // version is an admin write, and this function never does one.
        resources: [workoutSummaryArn, workoutPlanArn],
      }),
    );

    // The weekly set targets, read and written by the admin editor page. These
    // are the only functions outside the MCP server that touch the plan table's
    // target items, and the only REST surface the plan has at all — the menu
    // stays MCP-only, since editing sessions is not something the site does.
    const targetsEnv = {
      ...lambdaDefaults.environment,
      WORKOUT_PLAN_TABLE_NAME: workoutPlanTable,
      WORKOUT_REGION,
    };
    const getWorkoutTargetsFn = new lambdaNode.NodejsFunction(this, 'GetWorkoutTargetsFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-workout-targets.ts'),
      ...lambdaDefaults,
      // Two small cross-region queries; same headroom as the other readers of
      // this table rather than the 3s default.
      timeout: cdk.Duration.seconds(15),
      environment: targetsEnv,
    });
    getWorkoutTargetsFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [workoutPlanArn] }),
    );

    const updateWorkoutTargetsFn = new lambdaNode.NodejsFunction(
      this,
      'UpdateWorkoutTargetsFunction',
      {
        entry: path.join(__dirname, '..', 'lambda', 'update-workout-targets.ts'),
        ...lambdaDefaults,
        timeout: cdk.Duration.seconds(15),
        environment: targetsEnv,
      },
    );
    updateWorkoutTargetsFn.addToRolePolicy(
      new iam.PolicyStatement({
        // Query to read the current menu and target set, PutItem to append the
        // next one. Scoped to the plan table alone: the training log stays
        // untouchable from here, as it is from every reader in this stack.
        actions: ['dynamodb:Query', 'dynamodb:PutItem'],
        resources: [workoutPlanArn],
      }),
    );

    // Unified activity feed: blog and the GitHub snapshot locally, gym sessions
    // cross-region. Merged here so the landing page makes one call rather than
    // three against a quota every visitor shares.
    const getActivityFn = new lambdaNode.NodejsFunction(this, 'GetActivityFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'get-activity.ts'),
      ...lambdaDefaults,
      environment: {
        ...lambdaDefaults.environment,
        WORKOUT_SUMMARY_TABLE_NAME: workoutSummaryTable,
        WORKOUT_REGION,
      },
    });
    cvTable.grantReadData(getActivityFn);
    getActivityFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [workoutSummaryArn],
      }),
    );

    // Presigned-POST issuer for admin image uploads. Cognito-gated at the
    // gateway; signs a short-lived POST to the ingest prefix and nothing more,
    // so it never reads the catalog or the public prefix.
    const createUploadFn = new lambdaNode.NodejsFunction(this, 'CreateUploadFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'create-upload.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        CORS_ALLOWED_ORIGINS: allowedOrigins.join(','),
      },
    });
    mediaBucket.grantPut(createUploadFn, 'incoming/*');

    // Resize pipeline: triggered by ObjectCreated on `incoming/`, emits WebP
    // variants to `public/`, writes the catalog row, deletes the raw upload.
    const resizeImageFn = new lambdaNode.NodejsFunction(this, 'ResizeImageFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'resize-image.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      // sharp decoding of a full-size photo is CPU-bound; more memory buys more
      // CPU, and the timeout covers a couple of variants plus the S3 round trips.
      timeout: cdk.Duration.seconds(60),
      memorySize: 1536,
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        MEDIA_TABLE_NAME: mediaTable.tableName,
        MEDIA_CDN_BASE_URL: mediaCdnBaseUrl,
      },
      bundling: {
        // sharp carries a native binary esbuild must not touch; the hook installs
        // the Lambda-linux/x64 prebuilt into the bundle (no Docker needed).
        externalModules: ['@aws-sdk/*', 'sharp'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // sharp is installed into the bundle by giving it its own manifest in
          // the output dir and pointing npm at that dir with --prefix. Absolute
          // paths only, and no `cd`: CDK runs each hook line as a separate
          // command, so a `cd` would not persist and a bare `package.json`/
          // `npm install` would land in — and clobber — the project root. The
          // platform flags fetch the Lambda linux/x64 prebuilt (no Docker).
          afterBundling: (_inputDir: string, outputDir: string) => [
            `echo '{"dependencies":{"sharp":"${SHARP_VERSION}"}}' > ${outputDir}/package.json`,
            `npm install --prefix ${outputDir} --cpu=x64 --os=linux --libc=glibc --omit=dev`,
          ],
        },
      },
    });
    mediaBucket.grantRead(resizeImageFn, 'incoming/*');
    mediaBucket.grantDelete(resizeImageFn, 'incoming/*');
    mediaBucket.grantPut(resizeImageFn, 'public/*');
    mediaTable.grantWriteData(resizeImageFn);
    mediaBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(resizeImageFn),
      { prefix: 'incoming/' },
    );

    // Media library management (all Cognito-gated). Read-only listing, metadata
    // edits, and delete — the write paths for the admin picker/library UI.
    const mediaLambdaEnv = {
      MEDIA_TABLE_NAME: mediaTable.tableName,
      CORS_ALLOWED_ORIGINS: allowedOrigins.join(','),
    };

    const listMediaFn = new lambdaNode.NodejsFunction(this, 'ListMediaFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'list-media.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: mediaLambdaEnv,
    });
    mediaTable.grantReadData(listMediaFn);

    const updateMediaFn = new lambdaNode.NodejsFunction(this, 'UpdateMediaFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'update-media.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: mediaLambdaEnv,
    });
    mediaTable.grantWriteData(updateMediaFn);

    const deleteMediaFn = new lambdaNode.NodejsFunction(this, 'DeleteMediaFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'delete-media.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      // client-cloudfront is not guaranteed in the Lambda runtime SDK, so bundle
      // it; the heavier s3/dynamodb clients stay external (runtime-provided).
      bundling: {
        externalModules: [
          '@aws-sdk/client-s3',
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
        ],
      },
      environment: {
        ...mediaLambdaEnv,
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        MEDIA_DISTRIBUTION_ID: mediaDistribution.distributionId,
      },
    });
    mediaTable.grantReadWriteData(deleteMediaFn);
    mediaBucket.grantDelete(deleteMediaFn, 'public/*');
    deleteMediaFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${mediaDistribution.distributionId}`,
        ],
      }),
    );

    // Model Context Protocol server. Created only when MCP options are supplied,
    // which in practice means production: the server needs a custom domain (the
    // OAuth discovery documents must sit at a domain root, which the default
    // execute-api URL cannot offer) and therefore a certificate and a DNS
    // record, none of which a dev deploy should demand. Same "declare only when
    // the context is present" shape as WorkoutIngestStack.
    if (props.mcp) {
      const mcpDomainName = props.mcp.domainName;
      const mcpResourceUrl = `https://${mcpDomainName}/mcp`;
      const mcpPrmUrl = `https://${mcpDomainName}/.well-known/oauth-protected-resource`;

      // A resource server gives the pool a custom scope to mint into access
      // tokens, which is what separates a token that may edit the site from one
      // that may only read it.
      const mcpResourceServer = userPool.addResourceServer('McpResourceServer', {
        identifier: 'mcp',
        userPoolResourceServerName: 'Portfolio MCP server',
        scopes: [
          new cognito.ResourceServerScope({
            scopeName: 'admin',
            scopeDescription: 'Read private training data and edit site content',
          }),
        ],
      });
      const mcpAdminScope = 'mcp/admin';

      // Pre-registered app client for the MCP client (the Claude apps). Cognito
      // has no RFC 7591 dynamic client registration, but this server is
      // single-user: one client provisioned here is all that is ever needed, and
      // the pool's pre-signup trigger still restricts sign-in to the owner, so a
      // stolen client ID grants nothing without the owner's own Google login.
      const mcpUserPoolClient = userPool.addClient('McpUserPoolClient', {
        // Public client: the Claude apps use authorization-code + PKCE and
        // cannot hold a secret confidentially.
        generateSecret: false,
        supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [
            cognito.OAuthScope.OPENID,
            cognito.OAuthScope.EMAIL,
            cognito.OAuthScope.PROFILE,
            cognito.OAuthScope.resourceServer(mcpResourceServer, {
              scopeName: 'admin',
              scopeDescription: 'Read private training data and edit site content',
            }),
          ],
          callbackUrls: props.mcp.callbackUrls,
          logoutUrls: props.mcp.callbackUrls,
        },
      });
      mcpUserPoolClient.node.addDependency(googleIdp);
      mcpUserPoolClient.node.addDependency(mcpResourceServer);

      const cognitoIssuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;

      // The MCP tools re-expose the site's own handlers, so this function both
      // reads and writes the content tables. Unlike /chat and /agent — kept
      // write-incapable at the IAM layer precisely because they are anonymous —
      // the boundary here is the access-token check in lambda/mcp.ts, which is
      // why this role does carry the write grants the admin tools need.
      const mcpFn = new lambdaNode.NodejsFunction(this, 'McpFunction', {
        entry: path.join(__dirname, '..', 'lambda', 'mcp.ts'),
        ...lambdaDefaults,
        // get_workout runs the same five cross-region paginated queries as the
        // /workout endpoint, so it inherits that function's headroom.
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        environment: {
          ...lambdaDefaults.environment,
          MEDIA_TABLE_NAME: mediaTable.tableName,
          WORKOUT_SUMMARY_TABLE_NAME: workoutSummaryTable,
          WORKOUT_SETS_TABLE_NAME: workoutSetsTable,
          WORKOUT_PLAN_TABLE_NAME: workoutPlanTable,
          WORKOUT_REGION,
          USER_POOL_ID: userPool.userPoolId,
          // Both clients are accepted: the SPA's, so the site's own editor can
          // drive the same tools, and the MCP client's.
          MCP_CLIENT_IDS: `${mcpUserPoolClient.userPoolClientId},${userPoolClient.userPoolClientId}`,
          MCP_RESOURCE_URL: mcpResourceUrl,
          MCP_PRM_URL: mcpPrmUrl,
          MCP_ADMIN_SCOPE: mcpAdminScope,
        },
      });
      cvTable.grantReadWriteData(mcpFn);
      mediaTable.grantReadWriteData(mcpFn);
      // get_workout / get_activity / list_exercises read the summary table;
      // get_workout_sets reads the per-set table by date and
      // get_exercise_history reads it by exercise, which is a separate resource:
      // a Query against a secondary index is authorized on the index ARN, not
      // the table's, so granting the table alone would fail at runtime.
      // All cross-region and read-only here.
      mcpFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
          resources: [
            workoutSummaryArn,
            workoutSetsArn,
            `${workoutSetsArn}/index/${SETS_BY_EXERCISE_INDEX}`,
          ],
        }),
      );

      // get_workout_plan reads and update_workout_plan appends. PutItem is
      // granted only here, and only on the plan table: the log itself stays
      // read-only to this API, since the sole writer of training history is the
      // ingest Lambda in us-west-2.
      mcpFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'],
          resources: [workoutPlanArn],
        }),
      );

      // Discovery documents. Static apart from the deployment's own URLs, so one
      // small function serves both well-known paths.
      const mcpOAuthEnv = {
        MCP_RESOURCE_URL: mcpResourceUrl,
        COGNITO_AUTH_DOMAIN: userPoolDomain.baseUrl(),
        COGNITO_ISSUER: cognitoIssuer,
        MCP_SCOPES: `openid email profile ${mcpAdminScope}`,
      };
      const mcpPrmFn = new lambdaNode.NodejsFunction(this, 'McpProtectedResourceFunction', {
        entry: path.join(__dirname, '..', 'lambda', 'mcp-oauth.ts'),
        handler: 'protectedResourceHandler',
        ...lambdaDefaults,
        environment: { ...lambdaDefaults.environment, ...mcpOAuthEnv },
      });
      const mcpAsFn = new lambdaNode.NodejsFunction(this, 'McpAuthServerFunction', {
        entry: path.join(__dirname, '..', 'lambda', 'mcp-oauth.ts'),
        handler: 'authorizationServerHandler',
        ...lambdaDefaults,
        environment: { ...lambdaDefaults.environment, ...mcpOAuthEnv },
      });

      // Its own REST API, not a route on the content API. The custom domain maps
      // a whole stage, so mapping the content API here would also answer /cv,
      // /media and /agent on the MCP host; a separate API keeps this domain to
      // exactly the MCP server and its discovery documents. There is no fixed
      // cost to a second REST API, and the MCP Lambda calls the site's handlers
      // in-process regardless of which gateway fronts it.
      const mcpApi = new apigateway.RestApi(this, 'McpRestApi', {
        deployOptions: { stageName: props.stage },
        endpointTypes: [apigateway.EndpointType.REGIONAL],
        domainName: {
          domainName: mcpDomainName,
          certificate: acm.Certificate.fromCertificateArn(
            this,
            'McpCertificate',
            props.mcp.certificateArn,
          ),
          endpointType: apigateway.EndpointType.REGIONAL,
          // Empty base path: the stage is not part of the public URL, so the
          // well-known documents land at the domain root as RFC 9728 requires.
          basePath: '',
        },
        defaultCorsPreflightOptions: {
          allowOrigins: apigateway.Cors.ALL_ORIGINS,
          allowMethods: ['GET', 'POST', 'OPTIONS'],
          allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
        },
      });

      // No API key: an MCP client discovering this server through OAuth has no
      // way to learn one, and the access-token check is the real boundary.
      mcpApi.root
        .addResource('mcp')
        .addMethod('POST', new apigateway.LambdaIntegration(mcpFn));

      const wellKnown = mcpApi.root.addResource('.well-known');
      wellKnown
        .addResource('oauth-protected-resource')
        .addMethod('GET', new apigateway.LambdaIntegration(mcpPrmFn));
      wellKnown
        .addResource('oauth-authorization-server')
        .addMethod('GET', new apigateway.LambdaIntegration(mcpAsFn));

      new cdk.CfnOutput(this, 'McpUrl', {
        value: mcpResourceUrl,
        description: 'MCP server endpoint; add this as a custom connector',
      });
      new cdk.CfnOutput(this, 'McpUserPoolClientId', {
        value: mcpUserPoolClient.userPoolClientId,
        description: "OAuth client ID for the MCP connector's advanced settings",
      });
      new cdk.CfnOutput(this, 'McpDomainTarget', {
        value: mcpApi.domainName!.domainNameAliasDomainName,
        description: `CNAME target for ${mcpDomainName}`,
      });
    }

    // Daily snapshot of public GitHub activity. Scheduled rather than proxied on
    // request: the feed is on the landing page's critical path, and calling
    // GitHub inline would put its rate limit and availability there too.
    if (props.githubUser) {
      const gitHubIngestFn = new lambdaNode.NodejsFunction(this, 'GitHubIngestFunction', {
        entry: path.join(__dirname, '..', 'lambda', 'github-ingest.ts'),
        runtime: lambda.Runtime.NODEJS_20_X,
        bundling: { externalModules: ['@aws-sdk/*'] },
        timeout: cdk.Duration.seconds(30),
        environment: {
          CV_TABLE_NAME: cvTable.tableName,
          GITHUB_USER: props.githubUser,
        },
      });
      cvTable.grantWriteData(gitHubIngestFn);

      new events.Rule(this, 'GitHubIngestSchedule', {
        schedule: events.Schedule.rate(cdk.Duration.days(1)),
        targets: [new eventsTargets.LambdaFunction(gitHubIngestFn)],
        description: 'Refreshes the GitHub activity snapshot for the home-page calendar',
      });
    }

    // REST API (v1) rather than HTTP API (v2): only REST APIs support usage
    // plans, which enforce the monthly request quota at the gateway.
    const api = new apigateway.RestApi(this, 'PortfolioRestApi', {
      deployOptions: { stageName: props.stage },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CvAuthorizer', {
      cognitoUserPools: [userPool],
    });

    const cvResource = api.root.addResource('cv');
    cvResource.addMethod('GET', new apigateway.LambdaIntegration(getCvFn), {
      apiKeyRequired: true,
    });
    cvResource.addMethod('PUT', new apigateway.LambdaIntegration(updateCvFn), {
      apiKeyRequired: true,
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const projectsResource = api.root.addResource('projects');
    projectsResource.addMethod('GET', new apigateway.LambdaIntegration(getProjectsFn), {
      apiKeyRequired: true,
    });
    projectsResource.addMethod('PUT', new apigateway.LambdaIntegration(updateProjectsFn), {
      apiKeyRequired: true,
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const blogResource = api.root.addResource('blog');
    blogResource.addMethod('GET', new apigateway.LambdaIntegration(getBlogFn), {
      apiKeyRequired: true,
    });
    blogResource.addMethod('PUT', new apigateway.LambdaIntegration(updateBlogFn), {
      apiKeyRequired: true,
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    // Full blog including drafts, for the admin editor and logged-in browsing.
    // Cognito is the gate; no API key so it never draws the content quota, same
    // posture as the other admin-only endpoints.
    const blogAllResource = blogResource.addResource('all');
    blogAllResource.addMethod('GET', new apigateway.LambdaIntegration(getBlogAdminFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    const homeResource = api.root.addResource('home');
    homeResource.addMethod('GET', new apigateway.LambdaIntegration(getHomeFn), {
      apiKeyRequired: true,
    });
    homeResource.addMethod('PUT', new apigateway.LambdaIntegration(updateHomeFn), {
      apiKeyRequired: true,
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Anonymous visitors chat with the site assistant; the chat key is public
    // in the SPA and is not a security boundary — the usage-plan quota is the
    // spend cap for the Bedrock calls behind it.
    const chatResource = api.root.addResource('chat');
    chatResource.addMethod('POST', new apigateway.LambdaIntegration(chatFn), {
      apiKeyRequired: true,
    });

    // Admin-only agent: Cognito is the gate; no API key so agent traffic never
    // draws down either usage-plan quota.
    const agentResource = api.root.addResource('agent');
    agentResource.addMethod('POST', new apigateway.LambdaIntegration(agentFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Admin image uploads: Cognito is the gate; no API key so upload traffic
    // never draws down a usage-plan quota, same posture as /agent.
    const uploadsResource = api.root.addResource('uploads');
    uploadsResource.addMethod('POST', new apigateway.LambdaIntegration(createUploadFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Media library: list the catalog, and edit/delete individual assets. All
    // Cognito-gated, no API key — same admin posture as /uploads and /agent.
    const mediaResource = api.root.addResource('media');
    mediaResource.addMethod('GET', new apigateway.LambdaIntegration(listMediaFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    const mediaItemResource = mediaResource.addResource('{id}');
    mediaItemResource.addMethod('PATCH', new apigateway.LambdaIntegration(updateMediaFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    mediaItemResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteMediaFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // Public workout summaries: key only (draws on the shared CvUsagePlan quota),
    // no Cognito — same posture as the other public GETs.
    const workoutResource = api.root.addResource('workout');
    workoutResource.addMethod('GET', new apigateway.LambdaIntegration(getWorkoutFn), {
      apiKeyRequired: true,
    });

    // Muscle-volume status: key only, on the same public posture as /workout.
    // It reads the otherwise admin-only plan table, but returns only that plan's
    // weekly set targets and the rolled-up counts already visible in /workout —
    // not the session and exercise detail that makes the plan document admin
    // only. The progress page has always shown these ranges; what changes is
    // that it now shows the plan's rather than its own copy of them.
    const muscleVolumeResource = api.root.addResource('muscle-volume-status');
    muscleVolumeResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(muscleVolumeStatusFn),
      { apiKeyRequired: true },
    );

    // Public activity feed for the home calendar; same posture as the other
    // public GETs, and drawing on the content quota since the landing page is
    // exactly what that quota is for.
    const activityResource = api.root.addResource('activity');
    activityResource.addMethod('GET', new apigateway.LambdaIntegration(getActivityFn), {
      apiKeyRequired: true,
    });

    // The weekly set targets: Cognito-gated both ways, like the other admin
    // surfaces. No API key — the ID token is the authority, same posture as
    // /media and /uploads.
    const workoutPlanResource = api.root.addResource('workout-plan');
    const workoutTargetsResource = workoutPlanResource.addResource('targets');
    workoutTargetsResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(getWorkoutTargetsFn),
      { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
    );
    workoutTargetsResource.addMethod(
      'PUT',
      new apigateway.LambdaIntegration(updateWorkoutTargetsFn),
      { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO },
    );

    // Note on what a separate plan does and does not buy: a usage plan is bound
    // to the whole stage, not to individual methods, so any valid key can call
    // any key-required endpoint. Which quota is debited follows the key the
    // caller presents, so the separation below is a client convention that the
    // gateway accounts for — not a per-path boundary it enforces.
    const apiKey = api.addApiKey('CvApiKey');
    const usagePlan = api.addUsagePlan('CvUsagePlan', {
      quota: { limit: CONTENT_DAILY_REQUEST_QUOTA, period: apigateway.Period.DAY },
      throttle: API_THROTTLE,
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // The workout progress page gets its own key and daily quota so it cannot
    // starve the content endpoints.
    const workoutApiKey = api.addApiKey('WorkoutApiKey');
    const workoutUsagePlan = api.addUsagePlan('WorkoutUsagePlan', {
      quota: { limit: WORKOUT_DAILY_REQUEST_QUOTA, period: apigateway.Period.DAY },
      throttle: API_THROTTLE,
    });
    workoutUsagePlan.addApiKey(workoutApiKey);
    workoutUsagePlan.addApiStage({ stage: api.deploymentStage });

    // Chat gets its own key and quota so visitor chat can't exhaust the CV/projects
    // quota (and vice versa). Its cap stays monthly: unlike the content plan it
    // guards real spend (~$4 of Bedrock at the limit), and a monthly ceiling is
    // what makes that guarantee.
    const chatApiKey = api.addApiKey('ChatApiKey');
    const chatUsagePlan = api.addUsagePlan('ChatUsagePlan', {
      quota: { limit: CHAT_MONTHLY_REQUEST_QUOTA, period: apigateway.Period.MONTH },
      throttle: { rateLimit: 1, burstLimit: 3 },
    });
    chatUsagePlan.addApiKey(chatApiKey);
    chatUsagePlan.addApiStage({ stage: api.deploymentStage });

    // Backstop for the quota-based cost cap: email when Bedrock spend nears the
    // budget. Prod only — one budget per account is enough, and dev shares it.
    if (props.stage === 'prod') {
      new budgets.CfnBudget(this, 'BedrockBudget', {
        budget: {
          budgetName: 'portfolio-bedrock-monthly',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: BEDROCK_BUDGET_USD, unit: 'USD' },
          costFilters: { Service: ['Amazon Bedrock'] },
        },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.adminEmails[0] }],
        })),
      });
    }

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'AuthDomainUrl', {
      value: userPoolDomain.baseUrl(),
      description: 'Cognito hosted domain the SPA redirects to for Google sign-in',
    });
    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'Fetch the key value with: aws apigateway get-api-key --include-value --api-key <id>',
    });
    new cdk.CfnOutput(this, 'ChatApiKeyId', {
      value: chatApiKey.keyId,
      description: 'API key for POST /chat; fetch the value the same way as ApiKeyId',
    });
    new cdk.CfnOutput(this, 'WorkoutApiKeyId', {
      value: workoutApiKey.keyId,
      description: 'API key for GET /workout; fetch the value the same way as ApiKeyId',
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new cdk.CfnOutput(this, 'MediaCdnBaseUrl', {
      value: mediaCdnBaseUrl,
      description: 'CloudFront base URL for uploaded images; store <base>/<assetId>/<variant>.webp',
    });
  }
}
