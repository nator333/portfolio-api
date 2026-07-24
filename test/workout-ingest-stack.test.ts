import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { WorkoutIngestStack } from '../lib/workout-ingest-stack';

function synthStack(stage = 'test') {
  const app = new cdk.App();
  const stack = new WorkoutIngestStack(app, 'WorkoutTestStack', {
    env: { account: '123456789012', region: 'us-west-2' },
    stage,
    ruleSetName: 'ksf-rule-set-test',
    adminEmail: 'admin@example.com',
    recipient: 'workout@example.com',
  });
  return Template.fromStack(stack);
}

test('creates the raw-sets and summary tables with deterministic names', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::DynamoDB::Table', 2);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'portfolio-workout-sets-test',
    KeySchema: [
      { AttributeName: 'date', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'portfolio-workout-summary-test',
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  });
});

test('retains tables in prod but destroys them elsewhere', () => {
  // Non-prod must be destroyable: retained tables have fixed names, so a failed
  // first deploy would otherwise orphan them and block every later retry with
  // "already exists".
  const dev = synthStack('dev');
  for (const table of Object.values(dev.findResources('AWS::DynamoDB::Table'))) {
    expect(table.DeletionPolicy).toBe('Delete');
  }

  const prod = synthStack('prod');
  for (const table of Object.values(prod.findResources('AWS::DynamoDB::Table'))) {
    expect(table.DeletionPolicy).toBe('Retain');
  }
  prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
});

test('creates an S3 mail bucket that SES may write to', () => {
  const template = synthStack();

  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'ses.amazonaws.com' },
          Action: 's3:PutObject',
        }),
      ]),
    },
  });
});

test('appends a receipt rule matching the configured address to the existing rule set', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::SES::ReceiptRule', {
    RuleSetName: 'ksf-rule-set-test',
    Rule: Match.objectLike({
      Recipients: ['workout@example.com'],
      Enabled: true,
      ScanEnabled: true,
      Actions: [Match.objectLike({ S3Action: Match.objectLike({ ObjectKeyPrefix: 'inbox/' }) })],
    }),
  });
});

test('ingest Lambda may send email and is triggered by S3 object creation', () => {
  const template = synthStack();

  // S3 -> Lambda notification wiring is created via the custom resource.
  template.resourceCountIs('Custom::S3BucketNotifications', 1);

  const policies = template.findResources('AWS::IAM::Policy');
  const sesPolicies = Object.values(policies).filter((p) =>
    p.Properties.PolicyDocument.Statement.some(
      (s: { Action?: string | string[] }) =>
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('ses:SendEmail'),
    ),
  );
  expect(sesPolicies.length).toBe(1);
});
