module.exports = {
  testEnvironment: "jest-environment-jsdom",
  testMatch: ["**/tests/**/*.test.js"],
  setupFiles: ["./tests/setup.js"],
  collectCoverageFrom: [
    "shared.js",
    "background.js",
    "build.js"
  ],
  coverageDirectory: "coverage"
};
