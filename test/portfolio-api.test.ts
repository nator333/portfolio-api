import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';

function synthStack() {
  const app = new cdk.App();
  const stack = new PortfolioApiStack(app, 'MyTestStack', { stage: 'test' });
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

test('get-cv and update-cv Lambda functions created', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::Lambda::Function', 2);
});

test('HTTP API exposes public GET /cv and authorized PUT /cv routes', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /cv',
    AuthorizationType: 'NONE',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'PUT /cv',
    AuthorizationType: 'JWT',
  });
  template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
});
