import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

/** Hard monthly cap on total API calls, enforced at the gateway by the usage plan. */
const MONTHLY_REQUEST_QUOTA = 100;

/**
 * Hard monthly cap on public chat calls. Together with the request-shape
 * limits in lambda/chat-schema.ts (~$0.008 worst case per call on Haiku),
 * this keeps Bedrock spend under the $5/month budget.
 */
const CHAT_MONTHLY_REQUEST_QUOTA = 500;

/** Bedrock is not offered in us-west-1, so the chat Lambda calls cross-region. */
const BEDROCK_REGION = 'us-west-2';
/** Bedrock model IDs carry an "anthropic." provider prefix. */
const CHAT_MODEL_ID = 'anthropic.claude-haiku-4-5';
/** Monthly Bedrock spend (USD) that triggers the budget email alert. */
const BEDROCK_BUDGET_USD = 5;

/** SSM parameter holding the Google OAuth client ID (not secret, but env-specific). */
const GOOGLE_CLIENT_ID_PARAM = '/portfolio/cv/google-client-id';
/** Secrets Manager secret holding the Google OAuth client secret (json field: client_secret). */
const GOOGLE_CLIENT_SECRET_NAME = 'cv-google-oauth';

export interface PortfolioApiStackProps extends cdk.StackProps {
  /** Deployment stage, e.g. "dev" or "prod". Applied as a tag on all stack resources. */
  readonly stage: string;
  /** Origins allowed to call the API (the deployed portfolio-front site). */
  readonly allowedOrigins?: string[];
  /** Full URLs Cognito may redirect back to after Google login. */
  readonly authCallbackUrls: string[];
  /** Emails allowed to sign in to the CV editor via Google. */
  readonly adminEmails: string[];
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
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${BEDROCK_REGION}::foundation-model/anthropic.*`,
          // Cross-region inference profiles, in case CHAT_MODEL_ID moves to a "us." profile.
          `arn:aws:bedrock:*:${this.account}:inference-profile/*.anthropic.*`,
        ],
      }),
    );

    // REST API (v1) rather than HTTP API (v2): only REST APIs support usage
    // plans, which enforce the monthly request quota at the gateway.
    const api = new apigateway.RestApi(this, 'PortfolioRestApi', {
      deployOptions: { stageName: props.stage },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'PUT', 'POST', 'OPTIONS'],
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

    // Anonymous visitors chat with the site assistant; the chat key is public
    // in the SPA and is not a security boundary — the usage-plan quota is the
    // spend cap for the Bedrock calls behind it.
    const chatResource = api.root.addResource('chat');
    chatResource.addMethod('POST', new apigateway.LambdaIntegration(chatFn), {
      apiKeyRequired: true,
    });

    const apiKey = api.addApiKey('CvApiKey');
    const usagePlan = api.addUsagePlan('CvUsagePlan', {
      quota: { limit: MONTHLY_REQUEST_QUOTA, period: apigateway.Period.MONTH },
      throttle: { rateLimit: 2, burstLimit: 5 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // Chat gets its own key and quota so visitor chat can't exhaust the CV/projects
    // quota (and vice versa).
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
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}
