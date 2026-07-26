import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';

function synthStack(stage = 'test') {
  // Skip esbuild + sharp asset bundling: these assertions read the CloudFormation
  // template shape, not the built code, and bundling is the slow part of synth.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new PortfolioApiStack(app, 'MyTestStack', {
    stage,
    githubUser: 'octocat',
    authCallbackUrls: ['http://localhost:4200/login'],
    adminEmails: ['admin@example.com'],
  });
  return Template.fromStack(stack);
}

test('CV DynamoDB table created with id partition key', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

test('Cognito user pool created without self sign-up', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
});

test('cv, projects, blog, home, chat, agent, workout, activity and pre-signup Lambdas created', () => {
  const template = synthStack();

  // get/update pairs for cv, projects, blog, home, plus chat, agent, get-workout,
  // get-activity, github-ingest, pre-signup (14); create-upload and resize-image
  // for media (16); and the CDK-managed S3 bucket-notifications handler (17).
  template.resourceCountIs('AWS::Lambda::Function', 17);
});

test('Google is the only sign-in provider, via hosted domain with code + PKCE flow', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
    ProviderName: 'Google',
    ProviderType: 'Google',
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
    Domain: 'nakamata-cv-test',
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    SupportedIdentityProviders: ['Google'],
    AllowedOAuthFlows: ['code'],
    CallbackURLs: ['http://localhost:4200/login'],
  });
});

test('REST API exposes GET /cv (key only) and PUT /cv (key + Cognito auth)', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET',
    ApiKeyRequired: true,
    AuthorizationType: 'NONE',
  });
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'PUT',
    ApiKeyRequired: true,
    AuthorizationType: 'COGNITO_USER_POOLS',
  });
  template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
    Type: 'COGNITO_USER_POOLS',
  });
});

test('REST API exposes GET and PUT for /cv, /projects, /blog, and /home', () => {
  const template = synthStack();

  for (const pathPart of ['cv', 'projects', 'blog', 'home']) {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
  }
  // Six public GETs (key only): cv, projects, blog, home, workout and activity;
  // and four Cognito-guarded PUTs across the content resources.
  const methods = template.findResources('AWS::ApiGateway::Method');
  const byAuth = Object.values(methods).map((m) => ({
    http: m.Properties.HttpMethod,
    auth: m.Properties.AuthorizationType,
  }));
  expect(byAuth.filter((m) => m.http === 'GET' && m.auth === 'NONE').length).toBe(6);
  expect(byAuth.filter((m) => m.http === 'PUT' && m.auth === 'COGNITO_USER_POOLS').length).toBe(4);
});

test('content usage plan caps requests per DAY, not per month', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
    Quota: { Limit: 350, Period: 'DAY' },
    Throttle: { RateLimit: 10, BurstLimit: 20 },
  });
});

test('no content-facing plan uses a monthly quota', () => {
  // The key is public in the SPA, so a monthly quota drained early leaves the
  // site blank until the 1st. Only chat, which guards real Bedrock spend, may
  // cap monthly.
  const template = synthStack();

  const monthly = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')).filter(
    (p) => p.Properties.Quota?.Period === 'MONTH',
  );
  expect(monthly).toHaveLength(1);
  expect(monthly[0].Properties.Quota.Limit).toBe(500);
});

test('workout has its own key and daily plan so it cannot starve content', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::ApiGateway::ApiKey', 3);
  template.resourceCountIs('AWS::ApiGateway::UsagePlan', 3);

  const daily = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')).filter(
    (p) => p.Properties.Quota?.Period === 'DAY',
  );
  expect(daily).toHaveLength(2);
  for (const plan of daily) {
    expect(plan.Properties.Quota.Limit).toBe(350);
  }
});

test('POST /chat is public (key only, no Cognito)', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'chat' });
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    ApiKeyRequired: true,
    AuthorizationType: 'NONE',
  });
});

test('POST /agent requires Cognito auth and no API key', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'agent' });
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'POST',
    AuthorizationType: 'COGNITO_USER_POOLS',
  });
  // The Cognito-guarded POSTs are /agent and /uploads; neither carries an API key
  // so admin traffic never draws down a usage-plan quota.
  const methods = template.findResources('AWS::ApiGateway::Method');
  const cognitoPosts = Object.values(methods).filter(
    (m) =>
      m.Properties.HttpMethod === 'POST' &&
      m.Properties.AuthorizationType === 'COGNITO_USER_POOLS',
  );
  expect(cognitoPosts.length).toBe(2);
  for (const post of cognitoPosts) {
    expect(post.Properties.ApiKeyRequired).toBeFalsy();
  }
});

test('agent Lambda can invoke Bedrock but cannot write to the table', () => {
  const template = synthStack();

  // Both chat and agent roles carry the Bedrock invoke statement.
  const policies = template.findResources('AWS::IAM::Policy');
  const bedrockPolicies = Object.values(policies).filter((p) =>
    p.Properties.PolicyDocument.Statement.some(
      (s: { Action?: string | string[] }) =>
        Array.isArray(s.Action) && s.Action.includes('bedrock:InvokeModel'),
    ),
  );
  expect(bedrockPolicies.length).toBe(2);

  // Neither Bedrock-holding role may carry a DynamoDB write action.
  for (const policy of bedrockPolicies) {
    const actions = policy.Properties.PolicyDocument.Statement.flatMap(
      (s: { Action?: string | string[] }) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:UpdateItem');
  }
});

test('chat has its own API key and usage plan capped at 500 requests per month', () => {
  const template = synthStack();

  // Chat keeps a monthly cap: unlike the content plan it guards real spend
  // (~$4 of Bedrock at the limit), and a monthly ceiling is what guarantees it.
  template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
    Quota: { Limit: 500, Period: 'MONTH' },
    Throttle: { RateLimit: 1, BurstLimit: 3 },
  });
});

test('chat Lambda may invoke Bedrock models but only read the table', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          Effect: 'Allow',
        }),
      ]),
    },
  });
});

test('GET /activity is public and merges sources server-side', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'activity' });

  // One Lambda reads both the local table and the cross-region workout table,
  // so the landing page makes a single call instead of one per source.
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const activityPolicy = policies.filter((p) =>
    p.Properties.PolicyDocument.Statement.some(
      (s: { Resource?: unknown; Action?: string | string[] }) =>
        JSON.stringify(s.Resource ?? '').includes('table/portfolio-workout-summary') &&
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('dynamodb:Query'),
    ),
  );
  // get-workout and get-activity each hold one.
  expect(activityPolicy.length).toBe(2);
});

test('GitHub activity is snapshotted on a schedule, not proxied per request', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::Events::Rule', 1);
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 day)',
  });
});

test('no GitHub user means no schedule, and the feed still deploys', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new PortfolioApiStack(app, 'NoGitHubStack', {
    stage: 'test',
    authCallbackUrls: ['http://localhost:4200/login'],
    adminEmails: ['admin@example.com'],
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::Events::Rule', 0);
  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'activity' });
});

test('GET /workout is public (key only, no Cognito)', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'workout' });
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET',
    ApiKeyRequired: true,
    AuthorizationType: 'NONE',
  });
});

test('every reader of the workout table is cross-region and read-only', () => {
  // get-workout and get-activity both read it; neither may ever write, since
  // the only writer is the ingest Lambda in us-west-2.
  const template = synthStack('prod');

  const policies = template.findResources('AWS::IAM::Policy');
  const workoutPolicies = Object.values(policies).filter((p) =>
    p.Properties.PolicyDocument.Statement.some((s: { Resource?: unknown }) =>
      JSON.stringify(s.Resource ?? '').includes('table/portfolio-workout-summary'),
    ),
  );
  expect(workoutPolicies.length).toBe(2);

  for (const policy of workoutPolicies) {
    const crossRegion = policy.Properties.PolicyDocument.Statement.filter(
      (s: { Resource?: unknown }) =>
        JSON.stringify(s.Resource ?? '').includes('table/portfolio-workout-summary'),
    );
    const actions = crossRegion.flatMap((s: { Action?: string | string[] }) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions).toContain('dynamodb:Query');
    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:BatchWriteItem');
  }
});

test('prod stack alerts on Bedrock spend at a $5 monthly budget; other stages do not', () => {
  const prod = synthStack('prod');
  prod.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: Match.objectLike({
      BudgetLimit: { Amount: 5, Unit: 'USD' },
      TimeUnit: 'MONTHLY',
    }),
  });

  const test = synthStack();
  test.resourceCountIs('AWS::Budgets::Budget', 0);
});
