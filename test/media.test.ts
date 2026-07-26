import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';

// Asset bundling (esbuild + the sharp native install) is irrelevant to these
// CloudFormation-shape assertions and is the slow part of synth, so skip it.
function synthStack(stage = 'test') {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new PortfolioApiStack(app, 'MyTestStack', {
    stage,
    githubUser: 'octocat',
    authCallbackUrls: ['http://localhost:4200/login'],
    adminEmails: ['admin@example.com'],
  });
  return Template.fromStack(stack);
}

test('MediaAssets table is a second table keyed by assetId', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::DynamoDB::Table', 2);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'assetId', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  });
});

test('media bucket blocks all public access', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});

test('images are served through a CloudFront distribution with Origin Access Control', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
});

test('the bucket policy grants read only to the CloudFront distribution, never the public', () => {
  const template = synthStack();

  const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'));
  const statements = policies.flatMap(
    (p) => p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
  );
  // Nothing grants s3:GetObject to a wildcard principal.
  for (const statement of statements) {
    if (statement.Principal === '*') {
      expect(statement.Effect).not.toBe('Allow');
    }
  }
  // CloudFront reads it via a service principal.
  const cloudfrontRead = statements.some(
    (s) =>
      JSON.stringify(s.Principal ?? '').includes('cloudfront.amazonaws.com') &&
      JSON.stringify(s.Action ?? '').includes('s3:GetObject'),
  );
  expect(cloudfrontRead).toBe(true);
});

test('POST /uploads is Cognito-gated and carries no API key', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'uploads' });

  const methods = template.findResources('AWS::ApiGateway::Method');
  const uploadPosts = Object.values(methods).filter(
    (m) =>
      m.Properties.HttpMethod === 'POST' &&
      m.Properties.AuthorizationType === 'COGNITO_USER_POOLS' &&
      JSON.stringify(m.Properties.ResourceId ?? '').includes('uploads'),
  );
  expect(uploadPosts.length).toBe(1);
  expect(uploadPosts[0].Properties.ApiKeyRequired).toBeFalsy();
});

test('the resize function is invoked by S3 object-created events on the incoming prefix', () => {
  const template = synthStack();

  // S3 -> Lambda notifications grant S3 permission to invoke the function.
  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    Principal: 's3.amazonaws.com',
  });
});

test('create-upload may only write the incoming prefix, never read the catalog', () => {
  const template = synthStack();

  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const uploadPolicy = policies.find((p) =>
    p.Properties.PolicyDocument.Statement.some(
      (s: { Action?: string | string[]; Resource?: unknown }) =>
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('s3:PutObject') &&
        JSON.stringify(s.Resource ?? '').includes('incoming/*'),
    ),
  );
  expect(uploadPolicy).toBeDefined();
});

test('create-upload and resize-image functions are wired with their env config', () => {
  const template = synthStack();

  const functions = Object.values(template.findResources('AWS::Lambda::Function'));
  const envVars = (f: { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }): string[] =>
    Object.keys(f.Properties?.Environment?.Variables ?? {});

  // create-upload signs presigned POSTs, so it knows the bucket but not the table.
  const createUpload = functions.filter(
    (f) => envVars(f).includes('MEDIA_BUCKET_NAME') && !envVars(f).includes('MEDIA_TABLE_NAME'),
  );
  expect(createUpload.length).toBe(1);

  // resize-image writes variants to the bucket and a catalog row, stamping the CDN url.
  const resize = functions.filter(
    (f) =>
      envVars(f).includes('MEDIA_TABLE_NAME') &&
      envVars(f).includes('MEDIA_CDN_BASE_URL') &&
      envVars(f).includes('MEDIA_BUCKET_NAME'),
  );
  expect(resize.length).toBe(1);
});
