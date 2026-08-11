/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/index.ts'],
  // auth-core is published as native ESM (`"type": "module"` + ESNext output),
  // and since auth-core 0.4.0-beta.11 its `jose` dependency is jose 6, which
  // dropped its CommonJS build and is now ESM-only (TBP-225). bridge-express
  // reaches both — auth-core directly, jose transitively through it. Three
  // changes make Jest's CJS runner load them without switching this whole
  // project to ESM (mirrors bridge-nestjs/jest.e2e.config.js, TBP-290/340):
  //
  //   1. `transformIgnorePatterns` whitelists `@nebulr-group/bridge-auth-core`
  //      *and* `jose` so Jest stops skipping them in node_modules. Whitelisting
  //      only auth-core is not enough: auth-core transforms fine and then dies
  //      on `import … from 'jose'`, which resolves to the untransformed
  //      `node_modules/jose/dist/webapi/index.js`.
  //   2. `transform` extends ts-jest to also handle `.js`/`.mjs` files — the
  //      preset only registers `.ts/.tsx` by default, which is why the
  //      whitelist alone isn't enough.
  //   3. `moduleNameMapper` strips `.js` suffixes from auth-core's NodeNext
  //      internal subpath imports so Jest's resolver can find them.
  //
  // Without these, every spec whose module graph reaches auth-core fails at
  // module-load with `SyntaxError: Unexpected token 'export'`.
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { useESM: false, isolatedModules: true }],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@nebulr-group/bridge-auth-core|jose)/)',
  ],
  moduleNameMapper: {
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$': '@nebulr-group/bridge-auth-core/$1',
  },
};
