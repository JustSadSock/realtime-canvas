export default [
  {
    ignores: ['node_modules/**'],
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2021, sourceType: 'script' }
  },
  {
    files: ['public/embed-png.js'],
    languageOptions: { ecmaVersion: 2021, sourceType: 'module' }
  }
];
