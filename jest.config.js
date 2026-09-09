module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // Resolve .ts ahead of .js. Jest's default order puts js first, so any stray
  // compiled output beside a source — from an older checkout, an editor, or a
  // `tsc` that predates --noEmit below — would be imported in preference to the
  // file actually being edited, and the suite would silently assert against
  // stale code. This mirrors the --prefer-ts-exts already passed to ts-node in
  // cdk.json, which is the same hazard in the CDK app's own entry point.
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
