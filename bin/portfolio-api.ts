#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { PortfolioApiStack } from '../lib/portfolio-api-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();

// Pinned rather than left to CDK_DEFAULT_REGION, which follows whatever AWS
// profile/region happens to be active locally and can silently drift from
// wherever this app was bootstrapped. Override with `-c region=...` if needed.
const region = (app.node.tryGetContext('region') as string | undefined) ?? 'us-west-1';
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region };

// Application stack: one instance per stage, selected with `-c stage=dev|prod`.
// CI passes this explicitly; defaults to "dev" for local iteration.
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';

// Prod allows the deployed portfolio-front origins; dev/local iteration only needs the Angular dev server.
const allowedOrigins =
  stage === 'prod'
    ? ['https://nakamata.tech', 'https://nator333.github.io']
    : ['http://localhost:4200'];

// Exact URLs Cognito may redirect back to after Google sign-in. GitHub Pages
// serves the app under a repo path, so these are full URLs, not origins.
const authCallbackUrls =
  stage === 'prod'
    ? ['https://nakamata.tech/cv-editor', 'https://nator333.github.io/portfolio-front/cv-editor']
    : ['http://localhost:4200/cv-editor'];

new PortfolioApiStack(app, `PortfolioApiStack-${stage}`, {
  env,
  stage,
  allowedOrigins,
  authCallbackUrls,
  adminEmails: ['m.nakamata35@gmail.com'],
});

// One-time, account-wide setup for GitHub Actions OIDC deploys.
// Deploy manually once with `npx cdk deploy GithubOidcStack`; see lib/github-oidc-stack.ts.
new GithubOidcStack(app, 'GithubOidcStack', {
  env,
  githubOrg: 'nator333',
  githubRepo: 'portfolio-api',
  prodEnvironment: 'production',
  devEnvironment: 'development',
});
