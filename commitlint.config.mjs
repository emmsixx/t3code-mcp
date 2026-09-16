export default {
  extends: ['@commitlint/config-conventional'],
  // Every commit must comply, including merges, reverts, and release commits.
  defaultIgnores: false,
  // Generated dependency-update bodies need not wrap prose at a fixed width.
  rules: {
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
