import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as path from 'path';

/** Hard monthly cap on total API calls, enforced at the gateway by the usage plan. */
const MONTHLY_REQUEST_QUOTA = 100;

export interface PortfolioApiStackProps extends cdk.StackProps {
  /** Deployment stage, e.g. "dev" or "prod". Applied as a tag on all stack resources. */
  readonly stage: string;
  /** Origins allowed to call the API (the deployed portfolio-front site). */
  readonly allowedOrigins?: string[];
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

    const userPoolClient = userPool.addClient('CvAdminUserPoolClient', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
    });

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

    // REST API (v1) rather than HTTP API (v2): only REST APIs support usage
    // plans, which enforce the monthly request quota at the gateway.
    const api = new apigateway.RestApi(this, 'PortfolioRestApi', {
      deployOptions: { stageName: props.stage },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ['GET', 'PUT', 'OPTIONS'],
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

    const apiKey = api.addApiKey('CvApiKey');
    const usagePlan = api.addUsagePlan('CvUsagePlan', {
      quota: { limit: MONTHLY_REQUEST_QUOTA, period: apigateway.Period.MONTH },
      throttle: { rateLimit: 2, burstLimit: 5 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'Fetch the key value with: aws apigateway get-api-key --include-value --api-key <id>',
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}
