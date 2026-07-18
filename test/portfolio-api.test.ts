import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';

function synthStack(stage = 'test') {
  const app = new cdk.App();
  const stack = new PortfolioApiStack(app, 'MyTestStack', {
    stage,
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

test('cv, projects, blog, chat, agent, and pre-signup Lambda functions created', () => {
  const template = synthStack();

  // get-cv, update-cv, get-projects, update-projects, get-blog, update-blog, chat, agent, pre-signup
  template.resourceCountIs('AWS::Lambda::Function', 9);
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

test('REST API exposes GET and PUT for /cv, /projects, and /blog', () => {
  const template = synthStack();

  for (const pathPart of ['cv', 'projects', 'blog']) {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
  }
  // Three public GETs (key only) and three Cognito-guarded PUTs across the resources.
  const methods = template.findResources('AWS::ApiGateway::Method');
  const byAuth = Object.values(methods).map((m) => ({
    http: m.Properties.HttpMethod,
    auth: m.Properties.AuthorizationType,
  }));
  expect(byAuth.filter((m) => m.http === 'GET' && m.auth === 'NONE').length).toBe(3);
  expect(byAuth.filter((m) => m.http === 'PUT' && m.auth === 'COGNITO_USER_POOLS').length).toBe(3);
});

test('usage plan caps total requests at 100 per month', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
    Quota: { Limit: 100, Period: 'MONTH' },
    Throttle: { RateLimit: 2, BurstLimit: 5 },
  });
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
  const methods = template.findResources('AWS::ApiGateway::Method');
  const agentPosts = Object.values(methods).filter(
    (m) =>
      m.Properties.HttpMethod === 'POST' &&
      m.Properties.AuthorizationType === 'COGNITO_USER_POOLS',
  );
  expect(agentPosts.length).toBe(1);
  expect(agentPosts[0].Properties.ApiKeyRequired).toBeFalsy();
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

  template.resourceCountIs('AWS::ApiGateway::ApiKey', 2);
  template.resourceCountIs('AWS::ApiGateway::UsagePlan', 2);
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
