// Quick debug script to test our parsing
const { parseFile } = require('./dist/parser');
const path = require('path');

const file = path.join(__dirname, 'tests/fixtures/realistic-circular.tsx');
console.log('Parsing file:', file);

try {
  const result = parseFile(file);
  console.log('Parsed result:');
  console.log('Hooks:', result.hooks.length);
  
  result.hooks.forEach((hook, i) => {
    console.log(`\nHook ${i + 1}:`);
    console.log(`  Name: ${hook.name}`);
    console.log(`  Line: ${hook.line}`);
    console.log(`  Dependencies: [${hook.dependencies.join(', ')}]`);
  });
  
  console.log('\nVariables map:');
  for (const [varName, deps] of result.variables.entries()) {
    console.log(`  ${varName}: [${Array.from(deps).join(', ')}]`);
  }
} catch (error) {
  console.error('Error:', error);
}