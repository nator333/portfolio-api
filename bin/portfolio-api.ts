#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { WorkoutIngestStack } from '../lib/workout-ingest-stack';

const app = new cdk.App();

// Pinned rather than left to CDK_DEFAULT_REGION, which follows whatever AWS
// profile/region happens to be active locally and can silently drift from
// wherever this app was bootstrapped. Override with `-c region=...` if needed.
const region = (app.node.tryGetContext('region') as string | undefined) ?? 'us-west-1';
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

// Application stack: one instance per stage, selected with `-c stage=dev|prod`.
// CI passes this explicitly; defaults to "dev" for local iteration.
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';

// Prod allows the deployed portfolio-front origins; dev/local iteration needs the
// Angular dev server (`ng serve` default 4200, and portfolio-front's `npm start`
// which pins port 3000).
const allowedOrigins =
  stage === 'prod'
    ? ['https://nakamata.tech', 'https://nator333.github.io']
    : ['http://localhost:4200', 'http://localhost:3000'];

// Exact URLs Cognito may redirect back to after Google sign-in: the app's
// /login page, the single sign-in entry point. GitHub Pages serves the app
// under a repo path, so these are full URLs, not origins.
const authCallbackPaths = ['/login'];
const authCallbackBases =
  stage === 'prod'
    ? ['https://nakamata.tech', 'https://nator333.github.io/portfolio-front']
    : ['http://localhost:4200', 'http://localhost:3000'];
const authCallbackUrls = authCallbackBases.flatMap((base) =>
  authCallbackPaths.map((p) => `${base}${p}`),
);

new PortfolioApiStack(app, `PortfolioApiStack-${stage}`, {
  env,
  stage,
  allowedOrigins,
  authCallbackUrls,
  adminEmails: ['m.nakamata35@gmail.com'],
});

// Workout CSV ingestion lives in us-west-2, where nakamata.tech's SES
// email-receiving is active (owned by kotlin-ses-forward). It appends a receipt
// rule to that repo's existing active rule set, whose name is supplied as context
// so this public repo need not commit it. Only declared when the context is
// present, so plain PortfolioApiStack deploys don't require it.
//
//   npx cdk deploy WorkoutIngestStack-<stage> \
//     -c stage=<stage> -c workoutRuleSetName=<ksf-rule-set-name>
const workoutRuleSetName = app.node.tryGetContext('workoutRuleSetName') as string | undefined;
if (workoutRuleSetName) {
  new WorkoutIngestStack(app, `WorkoutIngestStack-${stage}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' },
    stage,
    ruleSetName: workoutRuleSetName,
    adminEmail: 'm.nakamata35@gmail.com',
  });
}

// One-time, account-wide setup for GitHub Actions OIDC deploys, covering every
// repo in this account rather than just this one. Deploy manually with admin
// credentials, never from CI; see lib/github-oidc-stack.ts.
//
// This repo is public, so kotlin-ses-forward's bucket names — which its README
// deliberately masks — are supplied at synth time instead of being committed:
//
//   npx cdk deploy GithubOidcStack \
//     -c ksfRegion=us-west-2 \
//     -c ksfDeploymentBucket=<DEPLOYMENT_BUCKET> \
//     -c ksfEventBucket=<EVENT_BUCKET>
//
// Synthesising any other stack must not require them, so they are only demanded
// when this stack is actually the target.
// The stack is declared only when that context is present. `cdk deploy
// PortfolioApiStack-*` synthesises the whole app, and the deploy workflows pass
// no OIDC context — throwing on a missing value would break every app deploy to
// configure a stack those runs never touch.
const ksfRegion = app.node.tryGetContext('ksfRegion') as string | undefined;
const ksfDeploymentBucket = app.node.tryGetContext('ksfDeploymentBucket') as string | undefined;
const ksfEventBucket = app.node.tryGetContext('ksfEventBucket') as string | undefined;

if (ksfRegion && ksfDeploymentBucket && ksfEventBucket) {
  new GithubOidcStack(app, 'GithubOidcStack', {
    env,
    githubOrg: 'nator333',
    kotlinSesForwardRegion: ksfRegion,
    kotlinSesForwardDeploymentBucket: ksfDeploymentBucket,
    kotlinSesForwardEventBucket: ksfEventBucket,
    // samconfig.toml in nator333/3-things.
    threeThingsRegion: 'us-east-1',
  });
}
