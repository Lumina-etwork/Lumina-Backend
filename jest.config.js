module.exports = {
  testEnvironment: 'node',
  testTimeout: 60000,
  transform: {
    '^.+\\.tsx?$': ['babel-jest', { configFile: './babel.config.json' }],
  },
  transformIgnorePatterns: ['/node_modules/'],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.[jt]s',
    '<rootDir>/src/**/tests/**/*.test.[jt]s',
    '<rootDir>/tests/**/*.test.js',
    '<rootDir>/*.test.js',
  ],
};
