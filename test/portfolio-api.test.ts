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

/**
 * The MCP server is only declared when its options are supplied — production
 * only, since it needs a custom domain and an in-region certificate. The plain
 * synthStack() above therefore stands in for a dev deploy, and this one for
 * prod.
 */
function synthStackWithMcp(stage = 'test') {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new PortfolioApiStack(app, 'McpTestStack', {
    stage,
    githubUser: 'octocat',
    authCallbackUrls: ['http://localhost:4200/login'],
    adminEmails: ['admin@example.com'],
    mcp: {
      domainName: 'mcp.example.com',
      certificateArn: 'arn:aws:acm:us-west-1:123456789012:certificate/abc-123',
      callbackUrls: ['https://claude.ai/api/mcp/auth_callback'],
    },
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
  // for media (16); the CDK-managed S3 bucket-notifications handler (17);
  // list/update/delete-media for the media library (20); and the draft-returning
  // admin blog reader behind /blog/all (21). The MCP server's three functions
  // are not here: they are only declared when MCP options are supplied.
  template.resourceCountIs('AWS::Lambda::Function', 21);
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

test('GET /blog/all returns drafts and is Cognito-gated with no API key', () => {
  const template = synthStack();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'all' });
  // The draft-returning method: Cognito auth, and no API key so it never draws
  // the public content quota.
  template.hasResourceProperties('AWS::ApiGateway::Method', {
    HttpMethod: 'GET',
    AuthorizationType: 'COGNITO_USER_POOLS',
    ApiKeyRequired: Match.absent(),
  });
  // Its handler is the shared blog reader flipped into draft-returning mode.
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ INCLUDE_DRAFTS: 'true' }) },
  });
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

  // Three keys/plans: content, workout and chat. The MCP server carries no key
  // — a client discovering it through OAuth has no way to learn one.
  template.resourceCountIs('AWS::ApiGateway::ApiKey', 3);
  template.resourceCountIs('AWS::ApiGateway::UsagePlan', 3);

  const daily = Object.values(template.findResources('AWS::ApiGateway::UsagePlan')).filter(
    (p) => p.Properties.Quota?.Period === 'DAY',
  );
  // Content and workout are daily at 350; only chat caps monthly.
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
  // get-workout and get-activity each read it with a Query; the MCP server adds
  // a third reader, but only on a deployment where it is declared.
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

test('no MCP options means no MCP server at all, so a dev deploy needs no certificate', () => {
  const template = synthStack();

  // Nothing MCP-shaped should exist: no second REST API, no custom domain, and
  // no extra user-pool client beyond the SPA's.
  template.resourceCountIs('AWS::ApiGateway::DomainName', 0);
  template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  template.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 0);
});

test('the MCP server gets its own REST API behind a regional custom domain', () => {
  const template = synthStackWithMcp();

  // Its own API, not a route on the content API: a custom domain maps a whole
  // stage, so sharing would answer /cv, /media and /agent on the MCP host too.
  template.resourceCountIs('AWS::ApiGateway::RestApi', 2);
  template.hasResourceProperties('AWS::ApiGateway::DomainName', {
    DomainName: 'mcp.example.com',
    RegionalCertificateArn: 'arn:aws:acm:us-west-1:123456789012:certificate/abc-123',
    EndpointConfiguration: { Types: ['REGIONAL'] },
  });
  // Empty base path, so the stage is absent from the public URL and the
  // well-known documents land at the domain root.
  template.hasResourceProperties('AWS::ApiGateway::BasePathMapping', {
    DomainName: { Ref: Match.anyValue() },
  });
});

test('POST /mcp carries no API key and no Cognito authorizer', () => {
  const template = synthStackWithMcp();

  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'mcp' });

  const methods = template.findResources('AWS::ApiGateway::Method');
  const mcpPosts = Object.values(methods).filter(
    (m) =>
      m.Properties.HttpMethod === 'POST' &&
      JSON.stringify(m.Properties.ResourceId ?? '').includes('mcp'),
  );
  expect(mcpPosts.length).toBe(1);
  // No key: a client discovering this server through OAuth cannot learn one.
  // No gateway authorizer either — the access-token check inside the Lambda is
  // the boundary, and only it can emit the WWW-Authenticate challenge a client
  // needs in order to start the OAuth flow.
  expect(mcpPosts[0].Properties.ApiKeyRequired).toBeFalsy();
  expect(mcpPosts[0].Properties.AuthorizationType).toBe('NONE');
});

test('the OAuth discovery documents are served at the domain root', () => {
  const template = synthStackWithMcp();

  // RFC 9728 puts protected-resource metadata at the domain root, which the
  // default execute-api URL cannot do because its stage is always the first
  // path segment. This is the whole reason for the custom domain.
  template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '.well-known' });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'oauth-protected-resource',
  });
  template.hasResourceProperties('AWS::ApiGateway::Resource', {
    PathPart: 'oauth-authorization-server',
  });

  const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
  const wellKnownGets = methods.filter(
    (m) => m.Properties.HttpMethod === 'GET' && m.Properties.ApiKeyRequired !== true,
  );
  // Discovery must be reachable unauthenticated, or the client can never learn
  // where to authenticate.
  expect(wellKnownGets.length).toBeGreaterThanOrEqual(2);
});

test('a dedicated app client is pre-registered for the MCP client', () => {
  const template = synthStackWithMcp();

  // Cognito has no RFC 7591 dynamic client registration, and this server is
  // single-user, so the client is provisioned here instead. Two clients now:
  // the SPA's and the MCP one.
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    // Public client using authorization-code + PKCE: the Claude apps cannot
    // hold a secret confidentially.
    GenerateSecret: false,
    AllowedOAuthFlows: ['code'],
    CallbackURLs: ['https://claude.ai/api/mcp/auth_callback'],
  });
  // A custom scope is what separates an editing token from a read-only one.
  template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
    Identifier: 'mcp',
    Scopes: [Match.objectLike({ ScopeName: 'admin' })],
  });
});

test('the MCP Lambda validates tokens against this resource, and stays off Bedrock', () => {
  const template = synthStackWithMcp();

  const functions = Object.values(template.findResources('AWS::Lambda::Function'));
  const envVars = (f: { Properties?: { Environment?: { Variables?: Record<string, unknown> } } }) =>
    f.Properties?.Environment?.Variables ?? {};
  const mcp = functions.filter((f) => {
    const keys = Object.keys(envVars(f));
    return keys.includes('MCP_CLIENT_IDS') && keys.includes('MEDIA_TABLE_NAME');
  });
  expect(mcp.length).toBe(1);

  const env = envVars(mcp[0]);
  // The audience check needs the resource URL; the challenge needs the metadata
  // URL; the scope check needs the scope name. Missing any one of them silently
  // weakens the gate rather than failing loudly, so assert all three.
  expect(env.MCP_RESOURCE_URL).toBe('https://mcp.example.com/mcp');
  expect(env.MCP_PRM_URL).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
  expect(env.MCP_ADMIN_SCOPE).toBe('mcp/admin');
  expect(env.USER_POOL_ID).toBeDefined();
  // The private per-set table is what the admin tools exist to reach.
  expect(env.WORKOUT_SETS_TABLE_NAME).toBe('portfolio-workout-sets-test');
});

test('the MCP role reads the private sets table but never invokes Bedrock', () => {
  const template = synthStackWithMcp();

  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const mcpPolicies = policies.filter((p) => {
    const statements = p.Properties.PolicyDocument.Statement as Array<{
      Action?: string | string[];
      Resource?: unknown;
    }>;
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    const readsSets = statements.some((s) =>
      JSON.stringify(s.Resource ?? '').includes('table/portfolio-workout-sets'),
    );
    const invokesBedrock = actions.some((a) => a?.startsWith('bedrock:'));
    return readsSets && !invokesBedrock;
  });
  expect(mcpPolicies.length).toBeGreaterThanOrEqual(1);

  // The sets table is the private training log; nothing may ever write it from
  // here, since ingest owns it.
  for (const policy of mcpPolicies) {
    const statements = policy.Properties.PolicyDocument.Statement as Array<{
      Action?: string | string[];
      Resource?: unknown;
    }>;
    for (const statement of statements) {
      if (!JSON.stringify(statement.Resource ?? '').includes('table/portfolio-workout-sets')) continue;
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      for (const action of actions) {
        expect(action).toMatch(/^dynamodb:(GetItem|Query|BatchGetItem)$/);
      }
    }
  }
});

test('every reader of the workout table is cross-region and read-only', () => {
  // get-workout, get-activity and the MCP server all read it; none may ever
  // write, since the only writer is the ingest Lambda in us-west-2. Synthesised
  // with MCP enabled so the third reader is actually covered.
  const template = synthStackWithMcp('prod');

  const policies = template.findResources('AWS::IAM::Policy');
  const workoutPolicies = Object.values(policies).filter((p) =>
    p.Properties.PolicyDocument.Statement.some((s: { Resource?: unknown }) =>
      JSON.stringify(s.Resource ?? '').includes('table/portfolio-workout-summary'),
    ),
  );
  expect(workoutPolicies.length).toBe(3);

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

test('the MCP role may write the plan table and only read the training log', () => {
  const template = synthStackWithMcp();

  // The plan is the one workout table this API writes. The sets and summary
  // tables must stay read-only here: their sole writer is the ingest Lambda in
  // us-west-2, so a PutItem reaching them would be a second, unaudited path
  // into the training history.
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
  );

  const dynamoWrites = statements.filter((s) => {
    const actions = [s.Action].flat().filter((a): a is string => typeof a === 'string');
    return actions.includes('dynamodb:PutItem');
  });

  const writable = JSON.stringify(dynamoWrites.map((s) => s.Resource));
  expect(writable).toContain('portfolio-workout-plan-test');
  expect(writable).not.toContain('portfolio-workout-sets-test');
  expect(writable).not.toContain('portfolio-workout-summary-test');
});
