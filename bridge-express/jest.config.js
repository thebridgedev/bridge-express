/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts'],
  // auth-core is published as native ESM (`"type": "module"` + ESNext output).
  // Three changes make Jest's CJS runner load it without switching this whole
  // project to ESM (mirrors bridge-nestjs/jest.config.js, TBP-290/340):
  //
  //   1. `transformIgnorePatterns` whitelists `@nebulr-group/bridge-auth-core`
  //      so Jest stops skipping it in node_modules.
  //   2. `transform` extends ts-jest to also handle `.js`/`.mjs` files — the
  //      preset only registers `.ts/.tsx` by default, which is why the
  //      whitelist alone isn't enough.
  //   3. `moduleNameMapper` strips `.js` suffixes from auth-core's NodeNext
  //      internal subpath imports so Jest's resolver can find them.
  //
  // Without #2, every spec whose module graph reaches auth-core fails at
  // module-load with `SyntaxError: Unexpected token 'export'`.
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { useESM: false, isolatedModules: true }],
  },
  transformIgnorePatterns: ['node_modules/(?!(@nebulr-group/bridge-auth-core)/)'],
  moduleNameMapper: {
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$': '@nebulr-group/bridge-auth-core/$1',
  },
};
