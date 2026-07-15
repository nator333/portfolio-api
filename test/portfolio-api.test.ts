import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';

function synthStack() {
  const app = new cdk.App();
  const stack = new PortfolioApiStack(app, 'MyTestStack', {
    stage: 'test',
    authCallbackUrls: ['http://localhost:4200/cv-editor'],
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

test('cv, projects, and pre-signup Lambda functions created', () => {
  const template = synthStack();

  // get-cv, update-cv, get-projects, update-projects, pre-signup
  template.resourceCountIs('AWS::Lambda::Function', 5);
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
    CallbackURLs: ['http://localhost:4200/cv-editor'],
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

test('REST API exposes GET and PUT for both /cv and /projects', () => {
  const template = synthStack();

  for (const pathPart of ['cv', 'projects']) {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
  }
  // Two public GETs (key only) and two Cognito-guarded PUTs across the two resources.
  const methods = template.findResources('AWS::ApiGateway::Method');
  const byAuth = Object.values(methods).map((m) => ({
    http: m.Properties.HttpMethod,
    auth: m.Properties.AuthorizationType,
  }));
  expect(byAuth.filter((m) => m.http === 'GET' && m.auth === 'NONE').length).toBe(2);
  expect(byAuth.filter((m) => m.http === 'PUT' && m.auth === 'COGNITO_USER_POOLS').length).toBe(2);
});

test('usage plan caps total requests at 100 per month', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
  template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
    Quota: { Limit: 100, Period: 'MONTH' },
    Throttle: { RateLimit: 2, BurstLimit: 5 },
  });
});
