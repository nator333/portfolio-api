import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import {
  WORKOUT_RECIPIENT,
  workoutSetsTableName,
  workoutSummaryTableName,
} from '../lambda/workout-schema';

/** Prefix SES writes inbound mail under, so the bucket stays tidy and the event filter is scoped. */
const INBOX_PREFIX = 'inbox/';

export interface WorkoutIngestStackProps extends cdk.StackProps {
  /** Deployment stage, e.g. "dev" or "prod". */
  readonly stage: string;
  /**
   * Name of the *existing, active* SES receipt-rule-set this stack appends its
   * workout rule to. nakamata.tech's inbound mail is owned by kotlin-ses-forward,
   * whose rule set is `kotlin-ses-forward-rule-set-<stage>`. Passed as context so
   * the value (which that public repo deliberately masks) is not committed here.
   */
  readonly ruleSetName: string;
  /** The owner's address: the only accepted sender, and where reports are sent. */
  readonly adminEmail: string;
}

/**
 * us-west-2 stack for the workout CSV pipeline. It must live in us-west-2 because
 * SES email-receiving for nakamata.tech (and thus the S3 drop) is only active
 * there; the public read API stays in us-west-1 and reads the summary table
 * cross-region. See lib/portfolio-api-stack.ts and bin/portfolio-api.ts.
 */
export class WorkoutIngestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkoutIngestStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('stage', props.stage);

    // Retaining named resources is right for prod, but it turns any failed
    // *first* deploy into a dead end: the tables survive the rollback, and the
    // retry then fails with "already exists" because their names are fixed. The
    // workout data is fully reconstructible by re-sending the CSV (every import
    // recomputes from scratch), so outside prod these are disposable.
    const isProd = props.stage === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // Raw inbound MIME messages. Parsed data lives in DynamoDB, so the raw mail
    // is transient — expire it after 90 days to cap storage.
    const mailBucket = new s3.Bucket(this, 'WorkoutMailBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ prefix: INBOX_PREFIX, expiration: cdk.Duration.days(90) }],
      removalPolicy,
      // A retained bucket cannot be emptied by CloudFormation; only ask for
      // auto-delete where the bucket is destroyed anyway.
      autoDeleteObjects: !isProd,
    });

    // Explicit, deterministic names so the us-west-1 query Lambda can reference
    // the summary table by literal name/ARN without a cross-region CFN reference.
    const setsTable = new dynamodb.Table(this, 'WorkoutSetsTable', {
      tableName: workoutSetsTableName(props.stage),
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    const summaryTable = new dynamodb.Table(this, 'WorkoutSummaryTable', {
      tableName: workoutSummaryTableName(props.stage),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    });

    const ingestFn = new lambdaNode.NodejsFunction(this, 'WorkoutIngestFunction', {
      entry: path.join(__dirname, '..', 'lambda', 'workout-ingest.ts'),
      runtime: lambda.Runtime.NODEJS_20_X,
      // The full-history import parses a ~16k-row CSV and does hundreds of
      // BatchWrites, so give it more headroom than the request/response Lambdas.
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: { externalModules: ['@aws-sdk/*'] },
      environment: {
        WORKOUT_SETS_TABLE_NAME: setsTable.tableName,
        WORKOUT_SUMMARY_TABLE_NAME: summaryTable.tableName,
        ADMIN_EMAIL: props.adminEmail,
        MAIL_FROM: WORKOUT_RECIPIENT,
      },
    });

    setsTable.grantReadWriteData(ingestFn);
    summaryTable.grantReadWriteData(ingestFn);
    mailBucket.grantRead(ingestFn);
    ingestFn.addEventSource(
      new S3EventSource(mailBucket, {
        events: [s3.EventType.OBJECT_CREATED],
        filters: [{ prefix: INBOX_PREFIX }],
      }),
    );

    // SendEmail (SESv2) for the import report. The domain identity is verified in
    // this region by kotlin-ses-forward, so no identity is created here.
    ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
      }),
    );

    // Append the workout receipt rule to the rule set owned by kotlin-ses-forward.
    // A receipt rule is an independent resource, so this stack can add its own
    // rule to that shared, externally-managed rule set without conflict — as long
    // as the rule set is already active.
    const ruleSet = ses.ReceiptRuleSet.fromReceiptRuleSetName(
      this,
      'ExistingRuleSet',
      props.ruleSetName,
    );
    new ses.ReceiptRule(this, 'WorkoutReceiptRule', {
      ruleSet,
      receiptRuleName: `workout-import-${props.stage}`,
      recipients: [WORKOUT_RECIPIENT],
      enabled: true,
      scanEnabled: true,
      actions: [new sesActions.S3({ bucket: mailBucket, objectKeyPrefix: INBOX_PREFIX })],
    });

    new cdk.CfnOutput(this, 'MailBucketName', { value: mailBucket.bucketName });
    new cdk.CfnOutput(this, 'WorkoutSummaryTableName', { value: summaryTable.tableName });
  }
}
