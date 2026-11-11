// Genera el hash para ADMIN_PASSWORD_HASH.
// Uso: docker compose run --rm -it app node src/hash-password.js
//  (o con la contraseña por stdin: echo -n 'clave' | node src/hash-password.js)
import readline from 'node:readline';
import { hashPassword } from './auth.js';

async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, '');
  }
  const ask = (q) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(s); };
      rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    });
  const a = await ask('Contraseña nueva: ');
  const b = await ask('Repetila: ');
  if (a !== b) throw new Error('No coinciden.');
  return a;
}

const pw = await readPassword().catch((e) => { console.error(e.message); process.exit(1); });
if (!pw || pw.length < 12) {
  console.error('La contraseña tiene que tener al menos 12 caracteres.');
  process.exit(1);
}
const hash = hashPassword(pw);
console.log('\nCopiá esta línea en .env (las comillas simples son necesarias por los "$"):\n');
console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
