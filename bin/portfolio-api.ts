#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { WorkoutIngestStack } from '../lib/workout-ingest-stack';
import { workoutRecipient } from '../lambda/workout-schema';

const app = new cdk.App();

/**
 * Deploy-time configuration that would otherwise commit a personal email address
 * and custom domains to this public repo.
 *
 * CI sources these from GitHub Actions **secrets**, not variables: a variable is
 * expanded in plain text in the build log, and this repo's logs are public,
 * whereas secret values are masked. Locally, pass them with `-c key=value`.
 */
const context = (key: string): string | undefined =>
  (app.node.tryGetContext(key) as string | undefined) || undefined;

const requireContext = (key: string): string => {
  const value = context(key);
  if (!value) {
    throw new Error(
      `Missing required context "${key}". Pass -c ${key}=<value> locally, or set the matching secret used by the deploy workflow.`,
    );
  }
  return value;
};

// Pinned rather than left to CDK_DEFAULT_REGION, which follows whatever AWS
// profile/region happens to be active locally and can silently drift from
// wherever this app was bootstrapped. Override with `-c region=...` if needed.
const region = context('region') ?? 'us-west-1';
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

// Application stack: one instance per stage, selected with `-c stage=dev|prod`.
// CI passes this explicitly; defaults to "dev" for local iteration.
const stage = context('stage') ?? 'dev';
const isProd = stage === 'prod';

// The single admin identity: the only Google account admitted to the CV editor,
// the budget-alert recipient, and the only accepted sender of workout CSVs.
const adminEmail = requireContext('adminEmail');

// Prod allows the deployed portfolio-front origins; dev/local iteration needs the
// Angular dev server (`ng serve` default 4200, and portfolio-front's `npm start`
// which pins port 3000). The prod hostnames come from context so they stay out of
// this public repo:
//   siteDomain  - apex domain of the site, e.g. "example.com"
//   pagesOrigin - GitHub Pages origin, e.g. "https://<user>.github.io"
const localOrigins = ['http://localhost:4200', 'http://localhost:3000'];
const allowedOrigins = isProd
  ? [`https://${requireContext('siteDomain')}`, requireContext('pagesOrigin')]
  : localOrigins;

// Exact URLs Cognito may redirect back to after Google sign-in: the app's
// /login page, the single sign-in entry point. GitHub Pages serves the app
// under a repo path, so these are full URLs, not origins.
const authCallbackPaths = ['/login'];
const authCallbackBases = isProd
  ? [`https://${requireContext('siteDomain')}`, `${requireContext('pagesOrigin')}/portfolio-front`]
  : localOrigins;
const authCallbackUrls = authCallbackBases.flatMap((base) =>
  authCallbackPaths.map((p) => `${base}${p}`),
);

new PortfolioApiStack(app, `PortfolioApiStack-${stage}`, {
  env,
  stage,
  allowedOrigins,
  authCallbackUrls,
  adminEmails: [adminEmail],
});

// Workout CSV ingestion lives in us-west-2, where the site domain's SES
// email-receiving is active (owned by kotlin-ses-forward). It appends a receipt
// rule to that repo's existing active rule set, whose name is supplied as context
// so this public repo need not commit it. Only declared when the context is
// present, so plain PortfolioApiStack deploys don't require it.
//
//   npx cdk deploy WorkoutIngestStack-<stage> \
//     -c stage=<stage> -c adminEmail=<email> -c siteDomain=<domain> \
//     -c workoutRuleSetName=<ksf-rule-set-name>
const workoutRuleSetName = context('workoutRuleSetName');
if (workoutRuleSetName) {
  new WorkoutIngestStack(app, `WorkoutIngestStack-${stage}`, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' },
    stage,
    ruleSetName: workoutRuleSetName,
    adminEmail,
    recipient: workoutRecipient(requireContext('siteDomain')),
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
//     -c adminEmail=<email> \
//     -c githubOrg=<org> \
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
const ksfRegion = context('ksfRegion');
const ksfDeploymentBucket = context('ksfDeploymentBucket');
const ksfEventBucket = context('ksfEventBucket');

if (ksfRegion && ksfDeploymentBucket && ksfEventBucket) {
  new GithubOidcStack(app, 'GithubOidcStack', {
    env,
    githubOrg: requireContext('githubOrg'),
    kotlinSesForwardRegion: ksfRegion,
    kotlinSesForwardDeploymentBucket: ksfDeploymentBucket,
    kotlinSesForwardEventBucket: ksfEventBucket,
    // samconfig.toml in the 3-things repo.
    threeThingsRegion: 'us-east-1',
  });
}
