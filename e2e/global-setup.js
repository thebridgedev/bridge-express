/**
 * JavaScript wrapper for the TypeScript global-setup.
 * Jest's globalSetup runs in a separate process that doesn't go through
 * ts-jest's transform pipeline. This wrapper registers ts-node first.
 */
require('ts-node').register({ project: require('path').join(__dirname, '..', 'tsconfig.e2e.json'), transpileOnly: true });
module.exports = require('./global-setup.ts').default;
